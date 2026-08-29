import { createHash } from "node:crypto";
import { appendFileSync, closeSync, createReadStream, existsSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readFile, readlink, realpath, truncate } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { lockedFileSystem } from "../fs/locked-file-system";
import { runGit } from "../workspace/git-utils";
import { type HarnessNativeRuntimeEventSink, HarnessNativeRuntimeEventSpine } from "./runtime-events";
import type { HarnessNativeRuntimeEvent } from "./types";

const RUNTIME_RECORD_DIRECTORY_NAME = "runtime";
const RUNTIME_RECORD_RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u;

export interface HarnessNativeRuntimeRecordIdentity {
	version: 1;
	kind: "agentpatchcheck-runtime";
	runId: string;
	taskSha256: string;
	worktreePath: string;
	repositoryRoot: string;
	baseCommit: string;
	initialWorktreeSha256: string;
	createdAtMs: number;
}

/**
 * Repository state supplied by the Runtime caller. The record layer must not
 * infer whether the worktree is local or container-backed.
 */
export interface HarnessNativeRuntimeRecordWorktree {
	fingerprint(): Promise<string>;
	assertRepositoryState(): Promise<void>;
}

interface RuntimeRecordEventLine {
	kind: "event";
	event: HarnessNativeRuntimeEvent;
	sha256: string;
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function normalizeRunId(runId: string): string {
	const normalized = runId.trim();
	if (!RUNTIME_RECORD_RUN_ID.test(normalized)) throw new Error("Runtime record run id is invalid.");
	return normalized;
}

export function getHarnessNativeRuntimeRecordPath(worktreeRoot: string, runId: string): string {
	return join(dirname(resolve(worktreeRoot)), RUNTIME_RECORD_DIRECTORY_NAME, `${normalizeRunId(runId)}.jsonl`);
}

export function harnessNativeRuntimeRecordExists(path: string): boolean {
	return existsSync(resolve(path));
}

function appendDurably(path: string, line: string): void {
	const descriptor = openSync(path, "a");
	try {
		appendFileSync(descriptor, line, "utf8");
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function eventLine(event: HarnessNativeRuntimeEvent): string {
	const payload = JSON.stringify(event);
	return `${JSON.stringify({ kind: "event", event, sha256: sha256(payload) } satisfies RuntimeRecordEventLine)}\n`;
}

function parseIdentity(value: unknown): HarnessNativeRuntimeRecordIdentity {
	if (value === null || typeof value !== "object") throw new Error("Runtime record header is invalid.");
	const header = value as Partial<HarnessNativeRuntimeRecordIdentity>;
	if (
		header.version !== 1 ||
		header.kind !== "agentpatchcheck-runtime" ||
		typeof header.runId !== "string" ||
		typeof header.taskSha256 !== "string" ||
		typeof header.worktreePath !== "string" ||
		typeof header.repositoryRoot !== "string" ||
		typeof header.baseCommit !== "string" ||
		typeof header.initialWorktreeSha256 !== "string" ||
		typeof header.createdAtMs !== "number"
	)
		throw new Error("Runtime record header is invalid.");
	return structuredClone(header as HarnessNativeRuntimeRecordIdentity);
}

function sameIdentity(
	stored: HarnessNativeRuntimeRecordIdentity,
	expected: Omit<HarnessNativeRuntimeRecordIdentity, "createdAtMs" | "initialWorktreeSha256">,
): boolean {
	return (
		stored.version === expected.version &&
		stored.kind === expected.kind &&
		stored.runId === expected.runId &&
		stored.taskSha256 === expected.taskSha256 &&
		resolve(stored.worktreePath) === resolve(expected.worktreePath) &&
		resolve(stored.repositoryRoot) === resolve(expected.repositoryRoot) &&
		stored.baseCommit === expected.baseCommit
	);
}

async function readCompleteLines(path: string): Promise<string[]> {
	const content = await readFile(path, "utf8");
	if (content.endsWith("\n")) return content.slice(0, -1).split("\n");
	const lastLineBreak = content.lastIndexOf("\n");
	if (lastLineBreak < 0) throw new Error("Runtime record has no complete header.");
	await truncate(path, Buffer.byteLength(content.slice(0, lastLineBreak + 1), "utf8"));
	return content.slice(0, lastLineBreak).split("\n");
}

export async function loadHarnessNativeRuntimeRecord(path: string): Promise<{
	header: HarnessNativeRuntimeRecordIdentity;
	events: HarnessNativeRuntimeEvent[];
}> {
	const lines = await readCompleteLines(resolve(path));
	const headerLine = lines.shift();
	if (headerLine === undefined) throw new Error("Runtime record has no header.");
	const header = parseIdentity(JSON.parse(headerLine) as unknown);
	const events: HarnessNativeRuntimeEvent[] = [];
	for (const line of lines) {
		if (!line) continue;
		const value: unknown = JSON.parse(line);
		if (value === null || typeof value !== "object") throw new Error("Runtime record event line is invalid.");
		const envelope = value as Partial<RuntimeRecordEventLine>;
		if (envelope.kind !== "event" || typeof envelope.sha256 !== "string" || envelope.event === undefined)
			throw new Error("Runtime record event line is invalid.");
		if (sha256(JSON.stringify(envelope.event)) !== envelope.sha256)
			throw new Error("Runtime record event checksum mismatch.");
		events.push(envelope.event);
	}
	return { header, events: new HarnessNativeRuntimeEventSpine(events).snapshot() };
}

export class HarnessNativeRuntimeRecord implements HarnessNativeRuntimeEventSink {
	readonly path: string;
	readonly header: HarnessNativeRuntimeRecordIdentity;
	readonly initialEvents: HarnessNativeRuntimeEvent[];

	private constructor(
		path: string,
		header: HarnessNativeRuntimeRecordIdentity,
		initialEvents: HarnessNativeRuntimeEvent[],
	) {
		this.path = path;
		this.header = structuredClone(header);
		this.initialEvents = initialEvents.map((event) => structuredClone(event));
	}

	static async open(input: {
		path: string;
		identity: Omit<HarnessNativeRuntimeRecordIdentity, "createdAtMs" | "initialWorktreeSha256">;
		worktree: HarnessNativeRuntimeRecordWorktree;
	}): Promise<HarnessNativeRuntimeRecord> {
		const path = resolve(input.path);
		if (existsSync(path)) {
			const loaded = await loadHarnessNativeRuntimeRecord(path);
			if (!sameIdentity(loaded.header, input.identity))
				throw new Error("Runtime record identity does not match the requested task or worktree.");
			await assertHarnessNativeWorktreeResumeSafe(loaded.header, loaded.events, input.worktree);
			return new HarnessNativeRuntimeRecord(path, loaded.header, loaded.events);
		}
		await mkdir(dirname(path), { recursive: true });
		const initialWorktreeSha256 = await input.worktree.fingerprint();
		const header: HarnessNativeRuntimeRecordIdentity = {
			...input.identity,
			initialWorktreeSha256,
			createdAtMs: Date.now(),
		};
		const descriptor = openSync(path, "wx");
		try {
			writeFileSync(descriptor, `${JSON.stringify(header)}\n`, "utf8");
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		return new HarnessNativeRuntimeRecord(path, header, []);
	}

	append(event: HarnessNativeRuntimeEvent): void {
		appendDurably(this.path, eventLine(event));
	}
}

export async function withHarnessNativeRuntimeRecordLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
	return await lockedFileSystem.withLock({ path: resolve(path), type: "file", staleMs: 30_000 }, operation);
}

async function addFileToHash(hash: ReturnType<typeof createHash>, root: string, relativePath: string): Promise<void> {
	const path = resolve(root, relativePath);
	const relativeToRoot = relative(root, path);
	if (!relativeToRoot || relativeToRoot.startsWith("..") || isAbsolute(relativeToRoot))
		throw new Error("Worktree fingerprint path escaped the managed workspace.");
	const metadata = await lstat(path);
	hash.update(relativePath.replaceAll("\\", "/"));
	hash.update("\0");
	if (metadata.isSymbolicLink()) {
		hash.update("link\0");
		hash.update(await readlink(path));
		return;
	}
	if (!metadata.isFile()) {
		hash.update("other\0");
		return;
	}
	hash.update("file\0");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
}

export async function fingerprintHarnessNativeWorktree(worktreePath: string): Promise<string> {
	const root = await realpath(resolve(worktreePath));
	const [diff, untracked] = await Promise.all([
		runGit(root, ["diff", "--binary", "HEAD", "--"], { trimStdout: false }),
		runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"], { trimStdout: false }),
	]);
	if (!diff.ok) throw new Error(diff.error ?? "Could not fingerprint tracked worktree changes.");
	if (!untracked.ok) throw new Error(untracked.error ?? "Could not fingerprint untracked worktree changes.");
	const hash = createHash("sha256");
	hash.update("tracked\0");
	hash.update(diff.stdout);
	for (const path of untracked.stdout
		.split("\0")
		.filter(Boolean)
		.sort((left, right) => left.localeCompare(right)))
		await addFileToHash(hash, root, path);
	return hash.digest("hex");
}

/** Mechanical per-path worktree state used only to attribute one Runtime action. */
export interface HarnessNativeWorktreeMutationSurface {
	readonly pathSha256: ReadonlyMap<string, string>;
}

async function fingerprintMutationSurfacePath(root: string, path: string): Promise<string> {
	const hash = createHash("sha256");
	try {
		await addFileToHash(hash, root, path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		hash.update(path.replaceAll("\\", "/"));
		hash.update("\0missing\0");
	}
	return hash.digest("hex");
}

/** Captures the complete tracked/untracked mutation surface relative to HEAD. */
export async function captureHarnessNativeWorktreeMutationSurface(
	worktreePath: string,
): Promise<HarnessNativeWorktreeMutationSurface> {
	const root = await realpath(resolve(worktreePath));
	const [tracked, untracked] = await Promise.all([
		runGit(root, ["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"], { trimStdout: false }),
		runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"], { trimStdout: false }),
	]);
	if (!tracked.ok) throw new Error(tracked.error ?? "Could not enumerate tracked worktree mutations.");
	if (!untracked.ok) throw new Error(untracked.error ?? "Could not enumerate untracked worktree mutations.");
	const paths = [...new Set([...tracked.stdout.split("\0"), ...untracked.stdout.split("\0")].filter(Boolean))].sort(
		(left, right) => left.localeCompare(right),
	);
	const pathSha256 = new Map<string, string>();
	for (const path of paths) pathSha256.set(path, await fingerprintMutationSurfacePath(root, path));
	return { pathSha256 };
}

/** Returns only paths whose worktree state changed between two action boundaries. */
export function diffHarnessNativeWorktreeMutationSurfaces(
	before: HarnessNativeWorktreeMutationSurface,
	after: HarnessNativeWorktreeMutationSurface,
): string[] {
	return [...new Set([...before.pathSha256.keys(), ...after.pathSha256.keys()])]
		.filter((path) => before.pathSha256.get(path) !== after.pathSha256.get(path))
		.sort((left, right) => left.localeCompare(right));
}

export async function assertHarnessNativeWorktreeResumeSafe(
	header: HarnessNativeRuntimeRecordIdentity,
	events: readonly HarnessNativeRuntimeEvent[],
	worktree: HarnessNativeRuntimeRecordWorktree,
): Promise<void> {
	await worktree.assertRepositoryState();

	const dispatched = new Set(
		events.filter((event) => event.type === "tool-dispatched").map((event) => event.actionId),
	);
	for (const event of events) if (event.type === "tool-result") dispatched.delete(event.actionId);
	if (dispatched.size > 0) throw new Error("Runtime record contains an unresolved tool dispatch; resume is unsafe.");

	const attributedMutations = events.filter(
		(event): event is Extract<HarnessNativeRuntimeEvent, { type: "tool-result" }> =>
			event.type === "tool-result" && event.facts.kind === "mutation",
	);
	const checkpoints = new Map(
		events
			.filter(
				(event): event is Extract<HarnessNativeRuntimeEvent, { type: "worktree-checkpoint" }> =>
					event.type === "worktree-checkpoint",
			)
			.map((event) => [event.actionId, event.worktreeSha256] as const),
	);
	for (const event of attributedMutations)
		if (!checkpoints.has(event.actionId))
			throw new Error("Runtime mutation has no durable worktree checkpoint; resume is unsafe.");
	const expected =
		attributedMutations.length === 0
			? header.initialWorktreeSha256
			: checkpoints.get(attributedMutations.at(-1)?.actionId ?? "");
	if (expected === undefined || (await worktree.fingerprint()) !== expected)
		throw new Error("Runtime worktree contents do not match the latest durable checkpoint.");
}

export function hashHarnessNativeTaskIdentity(input: {
	prompt: string;
	model: string;
	provider: string;
	policy: object;
}): string {
	return sha256(JSON.stringify(input));
}
