import { describe, expect, it } from "vitest";

import { executeAgentPatchCheck } from "../../src/agentpatchcheck/execute";
import { validateTaskPolicy } from "../../src/agentpatchcheck/task-policy";

describe("executeAgentPatchCheck", () => {
	it("returns the agent result and collected patch from an isolated workspace", async () => {
		const policy = await validateTaskPolicy({
			repositoryRoot: process.cwd(),
			prompt: "Create a file",
			runId: "smoke-1",
		});
		const result = await executeAgentPatchCheck(policy, {
			createWorkspace: async () => ({
				runId: "smoke-1",
				repositoryPath: "D:\\repo",
				path: "D:\\repo\\.agentpatchcheck\\worktrees\\smoke-1",
				baseRef: "HEAD",
				baseCommit: "abc123",
			}),
			runAgent: async () => ({
				executable: "codex",
				args: ["exec"],
				exitCode: 0,
				signal: null,
				stdout: "done",
				stderr: "",
				durationMs: 12,
				timedOut: false,
			}),
			collectPatch: async () => ({
				changedFiles: ["README.md"],
				trackedPatch: "diff --git a/README.md b/README.md\n",
			}),
			runVerification: async () => ({
				status: "not-run",
				cwd: "D:\\repo\\.agentpatchcheck\\worktrees\\smoke-1",
				commands: [],
			}),
			assessEvidence: async ({ evidencePath, expectation }) => ({
				report: {
					version: 1,
					createdAt: "2026-08-07T00:00:00.000Z",
					evidence: { path: evidencePath, createdAt: "2026-08-07T00:00:00.000Z" },
					gitPatchVerification: {
						status: "verified",
						evidencePath,
						worktreePath: "D:\\repo\\.agentpatchcheck\\worktrees\\smoke-1",
						checkedAt: "2026-08-07T00:00:00.000Z",
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
					verdict: {
						status: "pass",
						expectation: expectation ?? "changes-required",
						reasonCodes: [],
						reasons: [],
					},
				},
				reference: { path: `${evidencePath}.assessment.json`, createdAt: "2026-08-07T00:00:00.000Z" },
			}),
			writeEvidence: async ({ path, bundle }) => ({
				path,
				createdAt: bundle.createdAt,
			}),
		});

		expect(result.status).toBe("succeeded");
		expect(result.workspace.path).toContain(".agentpatchcheck");
		expect(result.patch.changedFiles).toEqual(["README.md"]);
		expect(result.evidence.path).toContain("evidence");
		expect(result.assessment.report.verdict.status).toBe("pass");
	});
});
