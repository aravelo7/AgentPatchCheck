import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import { getGitStdout } from "../workspace/git-utils";
import { collectPatchSnapshot } from "./isolated-workspace";
import type { EvidenceBundle, GitPatchVerification, PatchSnapshot } from "./types";

export interface GitPatchVerifierDependencies {
	readBundle: (path: string) => Promise<EvidenceBundle>;
	pathExists: (path: string) => Promise<boolean>;
	readHeadCommit: (path: string) => Promise<string>;
	collectPatch: (path: string) => Promise<PatchSnapshot>;
	listUntrackedFiles: (path: string) => Promise<string[]>;
}

export async function readEvidenceBundle(path: string): Promise<EvidenceBundle> {
	const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
	if (!isEvidenceBundle(parsed)) {
		throw new Error(`Invalid EvidenceBundle: ${path}`);
	}
	return parsed;
}

function isEvidenceBundle(value: unknown): value is EvidenceBundle {
	if (!value || typeof value !== "object") {
		return false;
	}
	const bundle = value as Partial<EvidenceBundle>;
	return (
		bundle.version === 1 &&
		typeof bundle.createdAt === "string" &&
		typeof bundle.workspace?.path === "string" &&
		typeof bundle.workspace?.baseCommit === "string" &&
		Array.isArray(bundle.patch?.changedFiles) &&
		typeof bundle.patch?.trackedPatch === "string" &&
		typeof bundle.patch?.trackedPatchSha256 === "string" &&
		(bundle.commandVerification?.status === "passed" ||
			bundle.commandVerification?.status === "failed" ||
			bundle.commandVerification?.status === "not-run")
	);
}

async function pathExists(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function listUntrackedFiles(path: string): Promise<string[]> {
	const output = await getGitStdout(["ls-files", "--others", "--exclude-standard"], path);
	return output
		.split("\n")
		.map((file) => file.trim())
		.filter(Boolean)
		.sort((left, right) => left.localeCompare(right));
}

const defaultDependencies: GitPatchVerifierDependencies = {
	readBundle: readEvidenceBundle,
	pathExists,
	readHeadCommit: (path) => getGitStdout(["rev-parse", "--verify", "HEAD"], path),
	collectPatch: collectPatchSnapshot,
	listUntrackedFiles,
};

function sha256(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function filesMatch(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((file, index) => file === right[index]);
}

export async function verifyGitPatchEvidence(
	evidencePath: string,
	dependencies: GitPatchVerifierDependencies = defaultDependencies,
): Promise<GitPatchVerification> {
	const startedAt = Date.now();
	const checkedAt = new Date().toISOString();
	const bundle = await dependencies.readBundle(evidencePath);
	return await verifyGitPatchBundle(bundle, evidencePath, dependencies, startedAt, checkedAt);
}

export async function verifyGitPatchBundle(
	bundle: EvidenceBundle,
	evidencePath: string,
	dependencies: GitPatchVerifierDependencies = defaultDependencies,
	startedAt = Date.now(),
	checkedAt = new Date().toISOString(),
): Promise<GitPatchVerification> {
	const worktreePath = bundle.workspace.path;
	const worktreeExists = await dependencies.pathExists(worktreePath);
	const failures: string[] = [];

	if (!worktreeExists) {
		failures.push("Worktree does not exist.");
		return {
			status: "failed",
			evidencePath,
			worktreePath,
			checkedAt,
			durationMs: Date.now() - startedAt,
			checks: {
				worktreeExists,
				headMatchesBaseCommit: false,
				changedFilesMatch: false,
				trackedPatchMatches: false,
				unrecordedUntrackedFiles: [],
			},
			failures,
		};
	}

	const [headCommit, patch, currentUntrackedFiles] = await Promise.all([
		dependencies.readHeadCommit(worktreePath),
		dependencies.collectPatch(worktreePath),
		dependencies.listUntrackedFiles(worktreePath),
	]);
	const headMatchesBaseCommit = headCommit === bundle.workspace.baseCommit;
	const changedFilesMatch = filesMatch(patch.changedFiles, bundle.patch.changedFiles);
	const trackedPatchMatches = sha256(patch.trackedPatch) === bundle.patch.trackedPatchSha256;
	const recordedFiles = new Set(bundle.patch.changedFiles);
	const unrecordedUntrackedFiles = currentUntrackedFiles.filter((file) => !recordedFiles.has(file));

	if (!headMatchesBaseCommit) {
		failures.push("Worktree HEAD does not match the recorded base commit.");
	}
	if (!changedFilesMatch) {
		failures.push("Current changed files do not match the recorded patch snapshot.");
	}
	if (!trackedPatchMatches) {
		failures.push("Current tracked diff does not match the recorded patch snapshot.");
	}
	if (unrecordedUntrackedFiles.length > 0) {
		failures.push("Current worktree contains unrecorded untracked files.");
	}

	return {
		status: failures.length === 0 ? "verified" : "failed",
		evidencePath,
		worktreePath,
		checkedAt,
		durationMs: Date.now() - startedAt,
		checks: {
			worktreeExists,
			headMatchesBaseCommit,
			changedFilesMatch,
			trackedPatchMatches,
			unrecordedUntrackedFiles,
		},
		failures,
	};
}
