import { describe, expect, it } from "vitest";

import { assessEvidenceBundle, getAssessmentReportPath } from "../../src/agentpatchcheck/assessment-report";
import type { AssessmentReport, EvidenceBundle, GitPatchVerification } from "../../src/agentpatchcheck/types";

function createBundle(): EvidenceBundle {
	return {
		version: 1,
		createdAt: "2026-08-07T00:00:00.000Z",
		policy: {
			repositoryRoot: "D:\\repo",
			baseRef: "HEAD",
			baseCommit: "base-commit",
			worktreeRoot: "D:\\repo\\.agentpatchcheck\\worktrees",
			promptLength: 4,
			promptSha256: "hash",
			codexExecutable: null,
			model: null,
			timeoutMs: 1_000,
			sandbox: "read-only",
			allowNetwork: false,
			allowDangerousParameters: false,
			verification: {
				commands: [],
				outputLimitBytes: 1_000,
				allowShell: false,
				allowNetwork: false,
			},
			verificationProfile: null,
			patchExpectation: "changes-required",
		},
		repository: { root: "D:\\repo", baseRef: "HEAD", baseCommit: "base-commit" },
		workspace: {
			runId: "run-1",
			repositoryPath: "D:\\repo",
			path: "D:\\repo\\.agentpatchcheck\\worktrees\\run-1",
			baseRef: "HEAD",
			baseCommit: "base-commit",
		},
		agent: {
			executable: "codex",
			args: ["exec"],
			exitCode: 0,
			signal: null,
			stdout: "done",
			stderr: "",
			durationMs: 1,
			timedOut: false,
		},
		commandVerification: {
			status: "not-run",
			cwd: "D:\\repo\\.agentpatchcheck\\worktrees\\run-1",
			commands: [],
		},
		patch: { changedFiles: ["README.md"], trackedPatch: "diff", trackedPatchSha256: "hash" },
		result: { status: "succeeded", durationMs: 1 },
	};
}

function createVerification(status: GitPatchVerification["status"] = "verified"): GitPatchVerification {
	return {
		status,
		evidencePath: "D:\\repo\\.agentpatchcheck\\evidence\\run-1.json",
		worktreePath: "D:\\repo\\.agentpatchcheck\\worktrees\\run-1",
		checkedAt: "2026-08-07T00:00:01.000Z",
		durationMs: 1,
		checks: {
			worktreeExists: true,
			headMatchesBaseCommit: true,
			changedFilesMatch: true,
			trackedPatchMatches: true,
			unrecordedUntrackedFiles: [],
		},
		failures: [],
	};
}

describe("AssessmentReport", () => {
	it("writes an immutable assessment beside its evidence bundle", async () => {
		const reports: AssessmentReport[] = [];
		const evidencePath = "D:\\repo\\.agentpatchcheck\\evidence\\run-1.json";
		const reference = await assessEvidenceBundle(
			{ evidencePath },
			{
				readBundle: async () => createBundle(),
				verifyGitPatch: async () => createVerification(),
				writeReport: async ({ path, report }) => {
					reports.push(report);
					return { path, createdAt: report.createdAt };
				},
			},
		);

		expect(reference.reference.path).toBe(getAssessmentReportPath(evidencePath));
		expect(reports).toHaveLength(1);
		expect(reports[0]).toMatchObject({
			version: 1,
			evidence: { path: evidencePath, createdAt: "2026-08-07T00:00:00.000Z" },
			gitPatchVerification: { status: "verified" },
			verdict: { status: "pass" },
		});
		expect(reports[0]?.verdict.expectation).toBe("changes-required");
	});

	it("persists the final failure verdict without changing the evidence", async () => {
		const bundle = createBundle();
		bundle.commandVerification.status = "failed";
		let report: AssessmentReport | undefined;
		await assessEvidenceBundle(
			{ evidencePath: "D:\\repo\\.agentpatchcheck\\evidence\\run-1.json", expectation: "changes-required" },
			{
				readBundle: async () => bundle,
				verifyGitPatch: async () => createVerification(),
				writeReport: async ({ path, report: nextReport }) => {
					report = nextReport;
					return { path, createdAt: nextReport.createdAt };
				},
			},
		);

		expect(report?.verdict).toMatchObject({
			status: "fail",
			reasonCodes: ["command-verification-failed"],
		});
		expect(bundle.commandVerification.status).toBe("failed");
	});
});
