import { createHash } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { getGitStdout, runGit } from "../workspace/git-utils";
import type { IsolatedWorkspace, PatchSnapshot, UntrackedFileSnapshot } from "./types";

const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const MAX_UNTRACKED_FILE_BYTES = 64 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 256 * 1024;
const SECRET_PATTERN =
	/\b(?:sk|rk|sess)_[a-zA-Z0-9_-]{12,}\b|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password)\b\s*[:=]/iu;

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
			text = new TextDecoder("utf-8", { fatal: true }).decode(content);
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
