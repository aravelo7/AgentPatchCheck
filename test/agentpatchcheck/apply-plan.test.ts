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

	it("accepts a changed untracked file when its content snapshot is intact", async () => {
		const bundle = createBundle();
		bundle.patch.changedFiles = ["new.txt"];
		bundle.patch.trackedPatch = "";
		bundle.patch.untrackedFiles = [
			{
				path: "new.txt",
				content: "new file",
				sha256: "b37d2cbfd875891e9ed073fcbe61f35a990bee8eecbdd07f9efc51339d5ffd66",
				byteLength: 8,
			},
		];
		const result = await createApplyPlan(
			{ evidencePath },
			{
				readBundle: async () => bundle,
				readAssessment: async () => createAssessment(),
				resolveRepositoryRoot: async () => "D:\\repo",
				readHeadCommit: async () => "base",
				checkPatch: async () => ({ ok: true, error: null }),
			},
		);
		expect(result.status).toBe("ready");
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

	it("requires explicit approval for a protected patch and accepts a matching approval", async () => {
		const bundle = createBundle();
		bundle.patch.changedFiles = ["package.json"];
		bundle.patch.trackedPatch = "diff --git a/package.json b/package.json\n+++ b/package.json\n";
		const baseDependencies = {
			readBundle: async () => bundle,
			readAssessment: async () => createAssessment(),
			resolveRepositoryRoot: async () => "D:\\repo",
			readHeadCommit: async () => "base",
			checkPatch: async () => ({ ok: true, error: null }),
		};
		const pending = await createApplyPlan({ evidencePath }, { ...baseDependencies, readApproval: async () => null });
		expect(pending).toMatchObject({
			status: "blocked",
			decision: "requires-approval",
			approval: { status: "pending" },
		});
		const approved = await createApplyPlan(
			{ evidencePath },
			{
				...baseDependencies,
				readApproval: async () => ({
					version: 1,
					evidence: { path: evidencePath, createdAt: bundle.createdAt },
					riskFingerprint: pending.risk.fingerprint,
					decision: "approved",
					createdAt: "2026-08-08T01:00:00.000Z",
					reason: null,
				}),
			},
		);
		expect(approved).toMatchObject({ status: "ready", decision: "ready", approval: { status: "approved" } });
	});

	it("prohibits sensitive changes even when an approval record exists", async () => {
		const bundle = createBundle();
		bundle.patch.changedFiles = [".env.production"];
		bundle.patch.trackedPatch = "diff --git a/.env.production b/.env.production\n+++ b/.env.production\n";
		const result = await createApplyPlan(
			{ evidencePath },
			{
				readBundle: async () => bundle,
				readAssessment: async () => createAssessment(),
				readApproval: async () => null,
				resolveRepositoryRoot: async () => "D:\\repo",
				readHeadCommit: async () => "base",
				checkPatch: async () => ({ ok: true, error: null }),
			},
		);
		expect(result).toMatchObject({ status: "blocked", decision: "prohibited", risk: { blocksApply: true } });
	});
});
