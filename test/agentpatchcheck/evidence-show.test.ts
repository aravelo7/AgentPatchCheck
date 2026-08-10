import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { showEvidenceBundle } from "../../src/agentpatchcheck/evidence-show";
import type { AssessmentReport, EvidenceBundle } from "../../src/agentpatchcheck/types";

const repositoryRoot = resolve("test-fixtures", "evidence-show-repo");
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
			args: ["exec", "[REDACTED_PROMPT]"],
			exitCode: 0,
			signal: null,
			stdout: "done",
			stderr: "",
			durationMs: 2,
			timedOut: false,
		},
		commandVerification: {
			status: "passed",
			cwd: repositoryRoot,
			commands: [
				{
					command: "verify",
					args: ["--quick"],
					exitCode: 0,
					signal: null,
					stdout: "verified",
					stderr: "",
					durationMs: 1,
					timedOut: false,
				},
			],
		},
		patch: {
			changedFiles: ["README.md", "new.txt"],
			trackedPatch: "diff",
			trackedPatchSha256: "patch-hash",
			untrackedFiles: [{ path: "new.txt", content: "new", sha256: "hash", byteLength: 3 }],
		},
		hiddenOracle: {
			id: "hidden-oracle",
			kind: "hidden-oracle",
			status: "passed",
			durationMs: 1,
			exitCode: 0,
			signal: null,
			diagnostic: null,
		},
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
			commandVerification: {
				cwd: repositoryRoot,
				commands: [{ command: "verify", stdoutBytes: 8, stderrBytes: 0 }],
			},
			patch: {
				changedFiles: ["README.md", "new.txt"],
				trackedPatchSha256: "patch-hash",
				trackedPatchBytes: 4,
				untrackedFileCount: 1,
				untrackedFileBytes: 3,
			},
			hiddenOracle: { status: "passed" },
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
