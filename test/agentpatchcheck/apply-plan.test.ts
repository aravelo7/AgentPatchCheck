import { describe, expect, it } from "vitest";

import { createApplyPlan } from "../../src/agentpatchcheck/apply-plan";
import type { AssessmentReport, EvidenceBundle } from "../../src/agentpatchcheck/types";

const evidencePath = "D:\\repo\\.agentpatchcheck\\evidence\\run-1.json";

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
			patchExpectation: "changes-required",
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
		commandVerification: { status: "passed", cwd: "D:\\repo", commands: [] },
		patch: {
			changedFiles: ["README.md"],
			trackedPatch: "diff --git a/README.md b/README.md\n+++ b/README.md\n",
			trackedPatchSha256: "hash",
		},
		result: { status: "succeeded", durationMs: 1 },
	};
}

function createAssessment(status: "pass" | "fail" = "pass"): AssessmentReport {
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
		verdict: { status, expectation: "changes-required", reasonCodes: [], reasons: [] },
	};
}

describe("createApplyPlan", () => {
	it("returns ready only after assessment, base commit, and patch checks pass", async () => {
		let checkedPatch = "";
		const result = await createApplyPlan(
			{ evidencePath },
			{
				readBundle: async () => createBundle(),
				readAssessment: async () => createAssessment(),
				resolveRepositoryRoot: async () => "D:\\repo",
				readHeadCommit: async () => "base",
				checkPatch: async (_root, patch) => {
					checkedPatch = patch;
					return { ok: true, error: null };
				},
			},
		);
		expect(result).toMatchObject({
			status: "ready",
			checks: { assessmentPasses: true, headMatchesBaseCommit: true, patchApplies: true },
		});
		expect(checkedPatch).toContain("README.md");
	});

	it("blocks an unmaterialized changed file without running git apply", async () => {
		const bundle = createBundle();
		bundle.patch.changedFiles.push("new.txt");
		let checked = false;
		const result = await createApplyPlan(
			{ evidencePath },
			{
				readBundle: async () => bundle,
				readAssessment: async () => createAssessment(),
				resolveRepositoryRoot: async () => "D:\\repo",
				readHeadCommit: async () => "base",
				checkPatch: async () => {
					checked = true;
					return { ok: true, error: null };
				},
			},
		);
		expect(result).toMatchObject({ status: "blocked", unmaterializedFiles: ["new.txt"] });
		expect(checked).toBe(false);
	});

	it("blocks a non-passing assessment", async () => {
		const result = await createApplyPlan(
			{ evidencePath },
			{
				readBundle: async () => createBundle(),
				readAssessment: async () => createAssessment("fail"),
				resolveRepositoryRoot: async () => "D:\\repo",
				readHeadCommit: async () => "base",
				checkPatch: async () => ({ ok: true, error: null }),
			},
		);
		expect(result.status).toBe("blocked");
		expect(result.failures).toContain("A matching passing assessment is required.");
	});
});
