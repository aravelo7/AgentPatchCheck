import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { cleanupEvidenceWorktree } from "../../src/agentpatchcheck/cleanup";
import type { AssessmentReport, EvidenceBundle } from "../../src/agentpatchcheck/types";

const repositoryRoot = resolve("test-fixtures", "cleanup-repo");
const worktreeRoot = join(repositoryRoot, ".agentpatchcheck", "worktrees");
const worktreePath = join(worktreeRoot, "run-1");
const evidencePath = join(repositoryRoot, ".agentpatchcheck", "evidence", "run-1.json");

function createBundle(): EvidenceBundle {
	return {
		version: 1,
		createdAt: "2026-08-08T00:00:00.000Z",
		policy: {
			repositoryRoot,
			baseRef: "HEAD",
			baseCommit: "base",
			worktreeRoot,
			promptLength: 1,
			promptSha256: "hash",
			codexExecutable: null,
			model: null,
			timeoutMs: 1_000,
			sandbox: "read-only",
			allowNetwork: false,
			allowDangerousParameters: false,
			verification: { commands: [], outputLimitBytes: 1_000, allowShell: false, allowNetwork: false },
			verificationProfile: null,
			patchExpectation: "changes-optional",
		},
		repository: { root: repositoryRoot, baseRef: "HEAD", baseCommit: "base" },
		workspace: {
			runId: "run-1",
			repositoryPath: repositoryRoot,
			path: worktreePath,
			baseRef: "HEAD",
			baseCommit: "base",
		},
		agent: {
			executable: "codex",
			args: [],
			exitCode: 0,
			signal: null,
			stdout: "",
			stderr: "",
			durationMs: 1,
			timedOut: false,
		},
		commandVerification: { status: "not-run", cwd: repositoryRoot, commands: [] },
		patch: { changedFiles: [], trackedPatch: "", trackedPatchSha256: "hash" },
		result: { status: "succeeded", durationMs: 1 },
	};
}

function createAssessment(evidencePath: string): AssessmentReport {
	return {
		version: 1,
		createdAt: "2026-08-08T00:01:00.000Z",
		evidence: { path: evidencePath, createdAt: "2026-08-08T00:00:00.000Z" },
		gitPatchVerification: {
			status: "verified",
			evidencePath,
			worktreePath,
			checkedAt: "2026-08-08T00:01:00.000Z",
			durationMs: 1,
			checks: {
				worktreeExists: true,
				headMatchesBaseCommit: true,
				changedFilesMatch: true,
				trackedPatchMatches: true,
				unrecordedUntrackedFiles: [],
			},
			failures: [],
		},
		verdict: { status: "pass", expectation: "changes-optional", reasonCodes: [], reasons: [] },
	};
}

describe("cleanupEvidenceWorktree", () => {
	it("defaults to a dry-run after validating the managed assessed worktree", async () => {
		let removed = false;
		const result = await cleanupEvidenceWorktree(
			{ evidencePath },
			{
				readBundle: async () => createBundle(),
				readAssessment: async () => createAssessment(evidencePath),
				pathExists: async () => true,
				listWorktreePaths: async () => [worktreePath],
				removeWorktree: async () => {
					removed = true;
				},
			},
		);

		expect(result.status).toBe("dry-run");
		expect(removed).toBe(false);
	});

	it("removes only a registered managed worktree when explicitly applied", async () => {
		let removedPath: string | undefined;
		const result = await cleanupEvidenceWorktree(
			{ evidencePath, apply: true },
			{
				readBundle: async () => createBundle(),
				readAssessment: async () => createAssessment(evidencePath),
				pathExists: async () => true,
				listWorktreePaths: async () => [worktreePath],
				removeWorktree: async (_repositoryRoot, worktreePath) => {
					removedPath = worktreePath;
				},
			},
		);

		expect(result.status).toBe("removed");
		expect(removedPath).toBe(worktreePath);
	});

	it("rejects an evidence bundle whose worktree is outside its managed root", async () => {
		const bundle = createBundle();
		bundle.workspace.path = join(repositoryRoot, "other-worktree");
		await expect(
			cleanupEvidenceWorktree(
				{ evidencePath },
				{
					readBundle: async () => bundle,
					readAssessment: async () => createAssessment(evidencePath),
					pathExists: async () => true,
					listWorktreePaths: async () => [],
					removeWorktree: async () => undefined,
				},
			),
		).rejects.toThrow("not the managed path");
	});

	it("rejects cleanup without a matching completed assessment", async () => {
		const assessment = createAssessment(join(repositoryRoot, ".agentpatchcheck", "evidence", "other.json"));
		await expect(
			cleanupEvidenceWorktree(
				{ evidencePath },
				{
					readBundle: async () => createBundle(),
					readAssessment: async () => assessment,
					pathExists: async () => true,
					listWorktreePaths: async () => [],
					removeWorktree: async () => undefined,
				},
			),
		).rejects.toThrow("completed assessment");
	});
});
