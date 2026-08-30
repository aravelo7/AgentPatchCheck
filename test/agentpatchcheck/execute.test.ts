import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { ProcessTreeTerminationError } from "../../src/agentpatchcheck/codex-runner";
import { executeAgentPatchCheck } from "../../src/agentpatchcheck/execute";
import { getTaskFinalizationPath, readCompletedTaskFinalization } from "../../src/agentpatchcheck/task-finalization";
import { validateTaskPolicy } from "../../src/agentpatchcheck/task-policy";

describe("executeAgentPatchCheck", () => {
	it("does not start post-agent workspace work after a canonical timeout", async () => {
		const policy = await validateTaskPolicy({
			repositoryRoot: process.cwd(),
			prompt: "Wait.",
			runId: "timeout-terminal",
		});
		const calls = { verification: 0, oracle: 0, patch: 0 };
		let durableResult: Awaited<ReturnType<typeof executeAgentPatchCheck>> | null = null;
		const timeoutAgent = {
			executable: "harness-native",
			args: [],
			exitCode: 1,
			signal: null,
			stdout: "",
			stderr: "Harness-native agent stopped: timeout.",
			durationMs: 10,
			timedOut: true,
		};
		const result = await executeAgentPatchCheck(policy, {
			persistTaskDefinition: async () => ({ version: 1, path: "definition.json", sha256: "a".repeat(64) }),
			withTaskFinalizationLock: async (_path, operation) => await operation(),
			readTaskFinalization: async () => durableResult,
			writeTaskFinalization: async ({ result: completed }) => {
				durableResult = completed;
			},
			createWorkspace: async () => ({
				runId: "timeout-terminal",
				repositoryPath: "D:\\repo",
				path: "D:\\worktree",
				baseRef: "HEAD",
				baseCommit: "abc",
			}),
			runAgent: async () => timeoutAgent,
			runVerification: async () => {
				calls.verification += 1;
				return { status: "not-run", cwd: "D:\\worktree", commands: [] };
			},
			runHiddenOracle: async () => {
				calls.oracle += 1;
				return null;
			},
			collectPatch: async () => {
				calls.patch += 1;
				return { changedFiles: [], trackedPatch: "" };
			},
			writeEvidence: async ({ path, bundle }) => ({ path, createdAt: bundle.createdAt }),
			assessEvidence: async ({ evidencePath, expectation }) => ({
				report: {
					version: 1,
					createdAt: "2026-08-30T00:00:00.000Z",
					evidence: { path: evidencePath, createdAt: "2026-08-30T00:00:00.000Z" },
					gitPatchVerification: {
						status: "verified",
						evidencePath,
						worktreePath: "D:\\worktree",
						checkedAt: "2026-08-30T00:00:00.000Z",
						durationMs: 0,
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
						status: "fail",
						expectation: expectation ?? "changes-required",
						reasonCodes: [],
						reasons: [],
					},
				},
				reference: { path: `${evidencePath}.assessment.json`, createdAt: "2026-08-30T00:00:00.000Z" },
			}),
		});
		expect(result.agent).toBe(timeoutAgent);
		expect(result.agent.timedOut).toBe(true);
		expect(result.commandVerification.status).toBe("not-run");
		expect(result.hiddenOracle).toBeNull();
		expect(calls).toEqual({ verification: 0, oracle: 0, patch: 1 });
	});

	it("fails closed on cancellation cleanup failure before post-agent workspace work", async () => {
		const policy = await validateTaskPolicy({
			repositoryRoot: process.cwd(),
			prompt: "Wait.",
			runId: "cleanup-failure",
		});
		const calls = { verification: 0, oracle: 0, patch: 0 };
		await expect(
			executeAgentPatchCheck(policy, {
				persistTaskDefinition: async () => ({ version: 1, path: "definition.json", sha256: "a".repeat(64) }),
				withTaskFinalizationLock: async (_path, operation) => await operation(),
				readTaskFinalization: async () => null,
				createWorkspace: async () => ({
					runId: "cleanup-failure",
					repositoryPath: "D:\\repo",
					path: "D:\\worktree",
					baseRef: "HEAD",
					baseCommit: "abc",
				}),
				runAgent: async () => {
					throw new ProcessTreeTerminationError("cleanup acknowledgement failed");
				},
				runVerification: async () => {
					calls.verification += 1;
					return { status: "not-run", cwd: "D:\\worktree", commands: [] };
				},
				runHiddenOracle: async () => {
					calls.oracle += 1;
					return null;
				},
				collectPatch: async () => {
					calls.patch += 1;
					return { changedFiles: [], trackedPatch: "" };
				},
			}),
		).rejects.toThrow("cleanup acknowledgement failed");
		expect(calls).toEqual({ verification: 0, oracle: 0, patch: 0 });
	});

	it("returns the agent result and collected patch from an isolated workspace", async () => {
		const policy = await validateTaskPolicy({
			repositoryRoot: process.cwd(),
			prompt: "Create a file",
			runId: "smoke-1",
		});
		let observedTaskDefinitionSha256: string | null = null;
		let finalizedResult: Awaited<ReturnType<typeof executeAgentPatchCheck>> | null = null;
		const result = await executeAgentPatchCheck(policy, {
			withTaskFinalizationLock: async (_path, operation) => await operation(),
			readTaskFinalization: async () => finalizedResult,
			writeTaskFinalization: async ({ result: completed }) => {
				finalizedResult = completed;
			},
			persistTaskDefinition: async () => ({
				version: 1,
				path: "D:\\repo\\.agentpatchcheck\\task-definitions\\definition.json",
				sha256: "d".repeat(64),
			}),
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
			writeEvidence: async ({ path, bundle }) => {
				observedTaskDefinitionSha256 = bundle.taskDefinition?.sha256 ?? null;
				return { path, createdAt: bundle.createdAt };
			},
		});

		expect(result.status).toBe("succeeded");
		expect(result.workspace.path).toContain(".agentpatchcheck");
		expect(result.patch.changedFiles).toEqual(["README.md"]);
		expect(result.evidence.path).toContain("evidence");
		expect(observedTaskDefinitionSha256).toBe("d".repeat(64));
		expect(result.assessment.report.verdict.status).toBe("pass");
	});

	it("replays a completed task finalization without repeating execution or finalization", async () => {
		const policy = await validateTaskPolicy({
			repositoryRoot: process.cwd(),
			prompt: "Create a file",
			runId: "terminal-replay",
		});
		let durableResult: Awaited<ReturnType<typeof executeAgentPatchCheck>> | null = null;
		const calls = { workspace: 0, agent: 0, verification: 0, oracle: 0, evidence: 0, assessment: 0 };
		const dependencies: Parameters<typeof executeAgentPatchCheck>[1] = {
			persistTaskDefinition: async () => ({ version: 1, path: "definition.json", sha256: "a".repeat(64) }),
			withTaskFinalizationLock: async (_path, operation) => await operation(),
			readTaskFinalization: async () => durableResult,
			writeTaskFinalization: async ({ result }) => {
				durableResult = result;
			},
			createWorkspace: async () => {
				calls.workspace += 1;
				return {
					runId: "terminal-replay",
					repositoryPath: "D:\\repo",
					path: "D:\\worktree",
					baseRef: "HEAD",
					baseCommit: "abc",
				};
			},
			runAgent: async () => {
				calls.agent += 1;
				return {
					executable: "agent",
					args: [],
					exitCode: 0,
					signal: null,
					stdout: "",
					stderr: "",
					durationMs: 1,
					timedOut: false,
				};
			},
			runVerification: async () => {
				calls.verification += 1;
				return { status: "not-run", cwd: "D:\\worktree", commands: [] };
			},
			runHiddenOracle: async () => {
				calls.oracle += 1;
				return null;
			},
			collectPatch: async () => ({ changedFiles: [], trackedPatch: "" }),
			writeEvidence: async ({ path, bundle }) => {
				calls.evidence += 1;
				return { path, createdAt: bundle.createdAt };
			},
			assessEvidence: async ({ evidencePath }) => {
				calls.assessment += 1;
				const createdAt = "2026-08-24T00:00:00.000Z";
				return {
					report: {
						version: 1,
						createdAt,
						evidence: { path: evidencePath, createdAt },
						gitPatchVerification: {
							status: "verified",
							evidencePath,
							worktreePath: "D:\\worktree",
							checkedAt: createdAt,
							durationMs: 0,
							checks: {
								worktreeExists: true,
								headMatchesBaseCommit: true,
								changedFilesMatch: true,
								trackedPatchMatches: true,
								unrecordedUntrackedFiles: [],
							},
							failures: [],
						},
						verdict: { status: "pass", expectation: "changes-required", reasonCodes: [], reasons: [] },
					},
					reference: { path: `${evidencePath}.assessment.json`, createdAt },
				};
			},
		};
		const first = await executeAgentPatchCheck(policy, dependencies);
		const second = await executeAgentPatchCheck(policy, dependencies);
		expect(second).toEqual(first);
		expect(calls).toEqual({ workspace: 1, agent: 1, verification: 1, oracle: 1, evidence: 1, assessment: 1 });
	});
});

describe("task finalization integrity", () => {
	it("does not treat missing or corrupted finalization as completed", async () => {
		const root = join(process.cwd(), ".agentpatchcheck", `test-finalization-${randomUUID()}`);
		const worktreeRoot = join(root, "worktrees");
		const runId = "integrity-run";
		try {
			const policy = await validateTaskPolicy({
				repositoryRoot: process.cwd(),
				prompt: "Check",
				runId,
				worktreeRoot,
			});
			const options = {
				policy,
				runId,
				taskDefinition: { version: 1 as const, path: "definition.json", sha256: "b".repeat(64) },
			};
			expect(await readCompletedTaskFinalization(options)).toBeNull();
			const finalizationPath = getTaskFinalizationPath(worktreeRoot, runId);
			await mkdir(join(root, "evidence"), { recursive: true });
			await writeFile(finalizationPath, "{not-json", "utf8");
			await expect(readCompletedTaskFinalization(options)).rejects.toThrow("Corrupted task finalization record");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
