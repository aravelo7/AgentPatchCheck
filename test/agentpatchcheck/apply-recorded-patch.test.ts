import { describe, expect, it } from "vitest";

import { applyRecordedPatch } from "../../src/agentpatchcheck/apply-recorded-patch";
import type { ApplyPlanResult, EvidenceBundle } from "../../src/agentpatchcheck/types";

const evidencePath = "D:\\repo\\.agentpatchcheck\\evidence\\run-1.json";
const readyPlan: ApplyPlanResult = {
	status: "ready",
	evidencePath,
	assessmentPath: "D:\\repo\\.agentpatchcheck\\evidence\\run-1.assessment.json",
	repositoryRoot: "D:\\repo",
	baseCommit: "base",
	changedFiles: ["README.md"],
	unmaterializedFiles: [],
	checks: { assessmentPasses: true, headMatchesBaseCommit: true, patchApplies: true },
	failures: [],
};

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
		patch: { changedFiles: ["README.md"], trackedPatch: "diff", trackedPatchSha256: "hash" },
		result: { status: "succeeded", durationMs: 1 },
	};
}

describe("applyRecordedPatch", () => {
	it("requires explicit --apply before invoking git apply", async () => {
		let applied = false;
		const result = await applyRecordedPatch(
			{ evidencePath, repositoryPath: "D:\\repo" },
			{
				createPlan: async () => readyPlan,
				resolveRepositoryRoot: async () => "D:\\repo",
				readBundle: async () => createBundle(),
				applyPatch: async () => {
					applied = true;
				},
				readHeadCommit: async () => "base",
			},
		);
		expect(result.status).toBe("dry-run");
		expect(applied).toBe(false);
	});

	it("applies only a ready plan to the exact recorded repository", async () => {
		let patch = "";
		const result = await applyRecordedPatch(
			{ evidencePath, repositoryPath: "D:\\repo", apply: true },
			{
				createPlan: async () => readyPlan,
				resolveRepositoryRoot: async () => "D:\\repo",
				readBundle: async () => createBundle(),
				applyPatch: async (_root, nextPatch) => {
					patch = nextPatch;
				},
				readHeadCommit: async () => "base",
			},
		);
		expect(result).toMatchObject({ status: "applied", appliedFiles: ["README.md"], headCommit: "base" });
		expect(patch).toBe("diff");
	});

	it("writes recorded untracked snapshots only after the tracked patch succeeds", async () => {
		const bundle = createBundle();
		bundle.patch.untrackedFiles = [{ path: "new.txt", content: "new", sha256: "hash", byteLength: 3 }];
		let wrote = false;
		await applyRecordedPatch(
			{ evidencePath, repositoryPath: "D:\\repo", apply: true },
			{
				createPlan: async () => readyPlan,
				resolveRepositoryRoot: async () => "D:\\repo",
				readBundle: async () => bundle,
				applyPatch: async () => undefined,
				readHeadCommit: async () => "base",
				writeUntrackedFiles: async (_root, recorded) => {
					wrote = recorded.patch.untrackedFiles?.[0]?.path === "new.txt";
				},
			},
		);
		expect(wrote).toBe(true);
	});

	it("writes a ready untracked-only snapshot without invoking git apply for an empty patch", async () => {
		const bundle = createBundle();
		bundle.patch.changedFiles = ["new.txt"];
		bundle.patch.trackedPatch = "";
		bundle.patch.untrackedFiles = [{ path: "new.txt", content: "new", sha256: "hash", byteLength: 3 }];
		let applied = false;
		let wrote = false;
		const result = await applyRecordedPatch(
			{ evidencePath, repositoryPath: "D:\\repo", apply: true },
			{
				createPlan: async () => ({ ...readyPlan, changedFiles: ["new.txt"] }),
				resolveRepositoryRoot: async () => "D:\\repo",
				readBundle: async () => bundle,
				applyPatch: async () => {
					applied = true;
				},
				readHeadCommit: async () => "base",
				writeUntrackedFiles: async () => {
					wrote = true;
				},
			},
		);
		expect(result.status).toBe("applied");
		expect(applied).toBe(false);
		expect(wrote).toBe(true);
	});

	it("blocks a mismatched explicit repository", async () => {
		const result = await applyRecordedPatch(
			{ evidencePath, repositoryPath: "D:\\other", apply: true },
			{
				createPlan: async () => readyPlan,
				resolveRepositoryRoot: async () => "D:\\other",
				readBundle: async () => createBundle(),
				applyPatch: async () => undefined,
				readHeadCommit: async () => "base",
			},
		);
		expect(result.status).toBe("blocked");
		expect(result.failures[0]).toContain("does not match");
	});
});
