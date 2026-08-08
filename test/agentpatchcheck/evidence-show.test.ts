import { describe, expect, it } from "vitest";

import { showEvidenceBundle } from "../../src/agentpatchcheck/evidence-show";
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
			promptLength: 5,
			promptSha256: "hash",
			codexExecutable: null,
			model: "gpt-5.4",
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
			args: ["exec", "[REDACTED_PROMPT]"],
			exitCode: 0,
			signal: null,
			stdout: "done",
			stderr: "",
			durationMs: 2,
			timedOut: false,
		},
		commandVerification: { status: "not-run", cwd: "D:\\repo", commands: [] },
		patch: { changedFiles: ["README.md"], trackedPatch: "diff", trackedPatchSha256: "patch-hash" },
		result: { status: "succeeded", durationMs: 2 },
	};
}

function createAssessment(): AssessmentReport {
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

describe("showEvidenceBundle", () => {
	it("returns a concise evidence summary without full output or patch content", async () => {
		const result = await showEvidenceBundle(
			{ evidencePath },
			{
				readBundle: async () => createBundle(),
				readAssessment: async () => createAssessment(),
			},
		);

		expect(result).toMatchObject({
			evidence: { path: evidencePath },
			policy: { model: "gpt-5.4", promptSha256: "hash" },
			agent: { executable: "codex", stdoutBytes: 4, stderrBytes: 0 },
			patch: { changedFiles: ["README.md"], trackedPatchSha256: "patch-hash", trackedPatchBytes: 4 },
			assessment: { status: "valid", report: { verdict: { status: "pass" } } },
		});
		expect(JSON.stringify(result)).not.toContain('"stdout"');
		expect(JSON.stringify(result)).not.toContain('"trackedPatch"');
	});

	it("marks a missing assessment without rejecting valid evidence", async () => {
		const result = await showEvidenceBundle(
			{ evidencePath },
			{
				readBundle: async () => createBundle(),
				readAssessment: async () => null,
			},
		);

		expect(result.assessment).toMatchObject({ status: "missing", report: null });
	});
});
