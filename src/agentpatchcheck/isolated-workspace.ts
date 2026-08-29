import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { getGitStdout, runGit } from "../workspace/git-utils";
import type { IsolatedWorkspace, PatchSnapshot, UntrackedFileSnapshot } from "./types";

const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const MAX_UNTRACKED_FILE_BYTES = 64 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 256 * 1024;
const SECRET_PATTERN =
	/\b(?:sk|rk|sess)_[a-zA-Z0-9_-]{12,}\b|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password)\b\s*[:=]/iu;

export class IsolatedWorkspaceCollisionError extends Error {
	readonly code = "worktree_collision" as const;

	constructor(
		readonly worktreePath: string,
		readonly collision: "path-exists" | "git-worktree-registered",
	) {
		super(`worktree_collision: ${collision}; worktreePath=${worktreePath}`);
		this.name = "IsolatedWorkspaceCollisionError";
	}
}

function isSafeRelativePath(path: string): boolean {
	return !!path && !path.includes("\0") && !isAbsolute(path) && !path.split(/[\\/]/u).includes("..");
}

async function collectUntrackedSnapshots(worktreePath: string, files: string[]): Promise<UntrackedFileSnapshot[]> {
	const snapshots: UntrackedFileSnapshot[] = [];
	let totalBytes = 0;
	for (const path of files) {
		if (!isSafeRelativePath(path)) continue;
		const absolutePath = join(worktreePath, path);
		const metadata = await lstat(absolutePath);
		if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_UNTRACKED_FILE_BYTES) continue;
		const content = await readFile(absolutePath);
		if (content.includes(0) || totalBytes + content.length > MAX_UNTRACKED_TOTAL_BYTES) continue;
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
		} catch {
			continue;
		}
		if (SECRET_PATTERN.test(text)) continue;
		snapshots.push({
			path,
			content: text,
			sha256: createHash("sha256").update(content).digest("hex"),
			byteLength: content.length,
		});
		totalBytes += content.length;
	}
	return snapshots;
}

function normalizeRunId(runId: string): string {
	const normalized = runId.trim();
	if (!RUN_ID_PATTERN.test(normalized)) {
		throw new Error("Run id must contain 1-64 letters, numbers, underscores, or hyphens.");
	}
	return normalized;
}

function normalizeRepositoryPath(repositoryPath: string): string {
	const normalized = repositoryPath.trim();
	if (!normalized) {
		throw new Error("Repository path is required.");
	}
	return resolve(normalized);
}

function normalizeBaseRef(baseRef: string): string {
	const normalized = baseRef.trim();
	if (!normalized) {
		throw new Error("Base ref is required.");
	}
	return normalized;
}

export function getIsolatedWorkspacePath(repositoryPath: string, runId: string): string {
	const normalizedRepositoryPath = normalizeRepositoryPath(repositoryPath);
	const normalizedRunId = normalizeRunId(runId);
	return join(normalizedRepositoryPath, ".agentpatchcheck", "worktrees", normalizedRunId);
}

async function assertWorkspaceIsUnoccupied(repositoryPath: string, worktreePath: string): Promise<void> {
	try {
		await lstat(worktreePath);
		throw new IsolatedWorkspaceCollisionError(worktreePath, "path-exists");
	} catch (error) {
		if (error instanceof IsolatedWorkspaceCollisionError) throw error;
		if (typeof error === "object" && error !== null && "code" in error && error.code !== "ENOENT") throw error;
	}
	const listed = await runGit(repositoryPath, ["worktree", "list", "--porcelain"]);
	if (!listed.ok) throw new Error(listed.error ?? "Could not inspect registered Git worktrees.");
	const registered = listed.stdout
		.split(/\r?\n/u)
		.some((line) => line.startsWith("worktree ") && resolve(line.slice("worktree ".length)) === worktreePath);
	if (registered) throw new IsolatedWorkspaceCollisionError(worktreePath, "git-worktree-registered");
}

export async function createIsolatedWorkspace(options: {
	repositoryPath: string;
	runId: string;
	baseRef: string;
	baseCommit: string;
	worktreeRoot: string;
}): Promise<IsolatedWorkspace> {
	const repositoryPath = normalizeRepositoryPath(options.repositoryPath);
	const runId = normalizeRunId(options.runId);
	const baseRef = normalizeBaseRef(options.baseRef);
	const baseCommit = options.baseCommit.trim();
	if (!baseCommit) {
		throw new Error("Base commit is required.");
	}
	const worktreePath = join(resolve(options.worktreeRoot), runId);

	if (!isAbsolute(worktreePath)) {
		throw new Error("Isolated workspace path must be absolute.");
	}

	await assertWorkspaceIsUnoccupied(repositoryPath, worktreePath);
	await mkdir(resolve(options.worktreeRoot), { recursive: true });
	const addResult = await runGit(repositoryPath, ["worktree", "add", "--detach", worktreePath, baseCommit]);
	if (!addResult.ok) {
		throw new Error(addResult.error ?? "Could not create isolated workspace.");
	}

	return {
		runId,
		repositoryPath,
		path: worktreePath,
		baseRef,
		baseCommit,
	};
}

/** Reopens only the exact detached worktree named by a durable Runtime record. */
export async function resumeIsolatedWorkspace(options: {
	repositoryPath: string;
	runId: string;
	baseRef: string;
	baseCommit: string;
	worktreeRoot: string;
}): Promise<IsolatedWorkspace> {
	const repositoryPath = normalizeRepositoryPath(options.repositoryPath);
	const runId = normalizeRunId(options.runId);
	const baseRef = normalizeBaseRef(options.baseRef);
	const baseCommit = options.baseCommit.trim();
	const path = join(resolve(options.worktreeRoot), runId);
	const metadata = await lstat(path);
	if (!metadata.isDirectory() || metadata.isSymbolicLink())
		throw new Error("Durable resume worktree is not a regular directory.");
	if (resolve(await realpath(path)) !== resolve(path))
		throw new Error("Durable resume worktree path resolves through an unexpected alias.");
	const [topLevel, head, commonDirectory] = await Promise.all([
		runGit(path, ["rev-parse", "--show-toplevel"]),
		runGit(path, ["rev-parse", "HEAD"]),
		runGit(path, ["rev-parse", "--git-common-dir"]),
	]);
	if (!topLevel.ok || resolve(topLevel.stdout.trim()) !== resolve(path))
		throw new Error("Durable resume path is not the recorded Git worktree.");
	if (!head.ok || head.stdout.trim() !== baseCommit)
		throw new Error("Durable resume worktree HEAD does not match the task base commit.");
	if (!commonDirectory.ok) throw new Error("Durable resume worktree Git ownership is unavailable.");
	const resolvedCommonDirectory = resolve(path, commonDirectory.stdout.trim());
	const expectedGitDirectory = resolve(repositoryPath, ".git");
	if (resolvedCommonDirectory !== expectedGitDirectory)
		throw new Error("Durable resume worktree belongs to a different repository.");
	return { runId, repositoryPath, path, baseRef, baseCommit };
}

export async function collectPatchSnapshot(worktreePath: string): Promise<PatchSnapshot> {
	const trackedResult = await runGit(worktreePath, ["diff", "--binary", "HEAD", "--"], {
		trimStdout: false,
	});
	if (!trackedResult.ok && trackedResult.exitCode !== 1) {
		throw new Error(trackedResult.error ?? "Could not collect tracked patch.");
	}

	const [trackedFiles, untrackedFiles] = await Promise.all([
		getGitStdout(["diff", "--name-only", "HEAD", "--"], worktreePath),
		getGitStdout(["ls-files", "--others", "--exclude-standard"], worktreePath),
	]);
	const changedFiles = Array.from(
		new Set([...trackedFiles.split("\n"), ...untrackedFiles.split("\n")].map((path) => path.trim()).filter(Boolean)),
	).sort((left, right) => left.localeCompare(right));
	const untrackedFilePaths = untrackedFiles
		.split("\n")
		.map((path) => path.trim())
		.filter(Boolean);

	return {
		changedFiles,
		trackedPatch: trackedResult.stdout,
		untrackedFiles: await collectUntrackedSnapshots(worktreePath, untrackedFilePaths),
	};
}
