import { describe, expect, it } from "vitest";

import { cleanupEvidenceWorktree } from "../../src/agentpatchcheck/cleanup";
import type { AssessmentReport, EvidenceBundle } from "../../src/agentpatchcheck/types";

function createBundle(): EvidenceBundle {
	return {
		version: 1,
		createdAt: "2026-08-08T00:00:00.000Z",
		policy: {
			repositoryRoot: "D:\\repo",
			baseRef: "HEAD",
			baseCommit: "base",
			worktreeRoot: "D:\\repo\\.agentpatchcheck\\worktrees",
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
		repository: { root: "D:\\repo", baseRef: "HEAD", baseCommit: "base" },
		workspace: {
			runId: "run-1",
			repositoryPath: "D:\\repo",
			path: "D:\\repo\\.agentpatchcheck\\worktrees\\run-1",
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
		commandVerification: { status: "not-run", cwd: "D:\\repo", commands: [] },
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
			worktreePath: "D:\\repo\\.agentpatchcheck\\worktrees\\run-1",
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
	const evidencePath = "D:\\repo\\.agentpatchcheck\\evidence\\run-1.json";

	it("defaults to a dry-run after validating the managed assessed worktree", async () => {
		let removed = false;
		const result = await cleanupEvidenceWorktree(
			{ evidencePath },
			{
				readBundle: async () => createBundle(),
				readAssessment: async () => createAssessment(evidencePath),
				pathExists: async () => true,
				listWorktreePaths: async () => ["D:\\repo\\.agentpatchcheck\\worktrees\\run-1"],
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
				listWorktreePaths: async () => ["D:\\repo\\.agentpatchcheck\\worktrees\\run-1"],
				removeWorktree: async (_repositoryRoot, worktreePath) => {
					removedPath = worktreePath;
				},
			},
		);

		expect(result.status).toBe("removed");
		expect(removedPath).toContain("worktrees\\run-1");
	});

	it("rejects an evidence bundle whose worktree is outside its managed root", async () => {
		const bundle = createBundle();
		bundle.workspace.path = "D:\\repo\\other-worktree";
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
		const assessment = createAssessment("D:\\repo\\.agentpatchcheck\\evidence\\other.json");
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
