import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createHarnessNativeAdapter } from "../../src/agentpatchcheck/agent-adapter";
import { runBenchmark } from "../../src/agentpatchcheck/benchmark-runner";
import { showEvidenceBundle } from "../../src/agentpatchcheck/evidence-show";
import { executeAgentPatchCheck } from "../../src/agentpatchcheck/execute";
import { readEvidenceBundle } from "../../src/agentpatchcheck/git-patch-verifier";
import type { HarnessNativeModelProvider } from "../../src/agentpatchcheck/harness-native-runtime";
import { validateTaskPolicy } from "../../src/agentpatchcheck/task-policy";
import type { BenchmarkDefinition, CommandVerification, TaskPolicyInput } from "../../src/agentpatchcheck/types";

const execFile = promisify(execFileCallback);

async function git(repository: string, args: string[]): Promise<void> {
	await execFile("git", args, { cwd: repository, windowsHide: true });
}

function wholeFilePatch(path: string, before: string, after: string): string {
	const beforeLines = before.replaceAll("\r\n", "\n").split("\n");
	const afterLines = after.replaceAll("\r\n", "\n").split("\n");
	return [
		`diff --git a/${path} b/${path}`,
		`--- a/${path}`,
		`+++ b/${path}`,
		`@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
		...beforeLines.map((line) => `-${line}`),
		...afterLines.map((line) => `+${line}`),
		"",
	].join("\n");
}

function commandVerification(cwd: string, status: "passed" | "failed"): CommandVerification {
	return {
		status,
		cwd,
		commands: [
			{
				command: process.execPath,
				args: [],
				exitCode: status === "passed" ? 0 : 1,
				signal: null,
				stdout: "",
				stderr: "",
				durationMs: 1,
				timedOut: false,
			},
		],
	};
}

const provider: HarnessNativeModelProvider = {
	id: "openai-responses",
	decide: async ({ observations }) => {
		if (observations.length === 0)
			return { decision: { kind: "tool", tool: "read-file", arguments: { path: "README.md" } } };
		if (observations.length === 1 && observations[0]?.includes("before"))
			return { decision: { kind: "tool", tool: "search-text", arguments: { path: ".", query: "before" } } };
		if (observations.length === 2 && observations[1]?.includes("README.md:1:before"))
			return {
				decision: {
					kind: "tool",
					tool: "apply-patch",
					arguments: { patch: wholeFilePatch("README.md", "before", "after") },
				},
			};
		if (observations.length === 3)
			return { decision: { kind: "tool", tool: "run-public-verification", arguments: { index: 0 } } };
		return { decision: { kind: "finish" } };
	},
};

describe("Harness-native Headless Core E2E", () => {
	it("uses the existing workspace, patch, Evidence, Assessment, show, and Benchmark paths", async () => {
		const repository = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-headless-"));
		try {
			await writeFile(join(repository, "README.md"), "before\n", "utf8");
			await git(repository, ["init"]);
			await git(repository, ["config", "user.email", "fixture@example.invalid"]);
			await git(repository, ["config", "user.name", "Fixture"]);
			await git(repository, ["add", "."]);
			await git(repository, ["commit", "-m", "base"]);
			const input: TaskPolicyInput = {
				repositoryRoot: repository,
				prompt: "Update the existing README.",
				agentAdapter: "harness-native",
				model: "test-model",
				nativeAgent: { credentialRef: "openai-primary", maxIterations: 5, maxToolCalls: 4 },
				patchExpectation: "changes-required",
				verification: {
					commands: [
						{
							command: process.execPath,
							args: [
								"-e",
								"const fs=require('node:fs');process.exit(fs.readFileSync('README.md','utf8').startsWith('after')?0:1)",
							],
						},
					],
				},
			};
			const definition: BenchmarkDefinition = {
				version: 1,
				sourcePath: join(repository, "native-benchmark.json"),
				sourceSha256: "native-e2e-benchmark",
				name: "native-e2e",
				suite: { id: "native-e2e", fixtureVersion: "v1" },
				tasks: [
					{
						id: "native",
						taskSpecPath: "native.json",
						taskSpecSha256: "native-e2e-task",
						expectedStatus: "passed",
					},
				],
			};
			const result = await runBenchmark(definition, {
				loadTaskSpec: async () => input,
				validateTaskPolicy,
				execute: async (policy) =>
					await executeAgentPatchCheck(policy, {
						runAgent: async (nativePolicy, worktreePath) =>
							await createHarnessNativeAdapter(provider).execute({
								policy: nativePolicy,
								worktreePath,
								repairContext: { phase: "initial", publicVerificationFeedback: null },
							}),
					}),
				readAgentVersion: async () => null,
			});
			const task = result.report.tasks[0];
			if (task?.evidence === null || task?.evidence === undefined)
				throw new Error("Native benchmark did not write Evidence.");
			const evidence = await readEvidenceBundle(task.evidence.path);
			const shown = await showEvidenceBundle({ evidencePath: task.evidence.path });
			expect(result.report.tasks[0]).toMatchObject({
				status: "passed",
				configuration: { agentAdapter: "harness-native" },
			});
			expect(evidence.patch.changedFiles).toEqual(["README.md"]);
			expect(evidence.agent.runtime?.trajectory.map((step) => step.tool)).toEqual([
				"read-file",
				"search-text",
				"apply-patch",
				"run-public-verification",
				null,
			]);
			expect(shown.agent.runtime).toMatchObject({ terminationReason: "finished", toolCalls: 4 });
			expect((await readFile(join(evidence.workspace.path, "README.md"), "utf8")).replaceAll("\r\n", "\n")).toBe(
				"after\n",
			);
		} finally {
			await rm(repository, { recursive: true, force: true });
		}
	}, 30_000);

	it("continues one exhausted inner attempt from an event-derived continuation view", async () => {
		const repository = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-continuation-"));
		try {
			await writeFile(join(repository, "README.md"), "before\n", "utf8");
			await git(repository, ["init"]);
			await git(repository, ["config", "user.email", "fixture@example.invalid"]);
			await git(repository, ["config", "user.name", "Fixture"]);
			await git(repository, ["add", "."]);
			await git(repository, ["commit", "-m", "base"]);
			const policy = await validateTaskPolicy({
				repositoryRoot: repository,
				prompt: "Update the existing README.",
				agentAdapter: "harness-native",
				model: "test-model",
				nativeAgent: {
					credentialRef: "openai-primary",
					maxIterations: 3,
					maxToolCalls: 3,
					maxAttempts: 2,
					minContinuationTimeMs: 1,
				},
				patchExpectation: "changes-required",
				verification: {
					commands: [
						{
							command: process.execPath,
							args: [
								"-e",
								"const fs=require('node:fs');process.exit(fs.readFileSync('README.md','utf8').startsWith('after')?0:1)",
							],
						},
					],
				},
			});
			const continuationContexts: unknown[] = [];
			const continuationObservationCounts: number[] = [];
			let sessionsCreated = 0;
			const decide: HarnessNativeModelProvider["decide"] = async () => ({ decision: { kind: "fail" } });
			const continuationProvider: HarnessNativeModelProvider = {
				id: "openai-responses",
				decide,
				createSession: () => {
					sessionsCreated += 1;
					const session = sessionsCreated;
					let turn = 0;
					return {
						decide: async (context) => {
							turn += 1;
							if (session === 1)
								return turn === 1
									? { decision: { kind: "tool", tool: "read-file", arguments: { path: "README.md" } } }
									: turn === 2
										? { decision: { kind: "tool", tool: "git-status", arguments: {} } }
										: { decision: { kind: "tool", tool: "read-file", arguments: { path: "README.md" } } };
							continuationContexts.push(context.contextView?.continuation ?? null);
							continuationObservationCounts.push(context.contextView?.observations.length ?? -1);
							return turn === 1
								? {
										decision: {
											kind: "tool",
											tool: "apply-patch",
											arguments: { patch: wholeFilePatch("README.md", "before", "after") },
										},
									}
								: turn === 2
									? { decision: { kind: "tool", tool: "run-public-verification", arguments: { index: 0 } } }
									: { decision: { kind: "finish" } };
						},
						recordToolResults: () => undefined,
					};
				},
			};

			const result = await executeAgentPatchCheck(policy, {
				runAgent: async (nativePolicy, worktreePath, repairContext) =>
					await createHarnessNativeAdapter(continuationProvider).execute({
						policy: nativePolicy,
						worktreePath,
						repairContext,
					}),
			});

			expect(result.status).toBe("succeeded");
			expect(result.agent.attempts).toHaveLength(2);
			expect(result.agent.attempts?.map((attempt) => attempt.phase)).toEqual(["initial", "attempt-continuation"]);
			expect(result.agent.attempts?.[0]?.review).toMatchObject({
				decision: "continue",
				reason: "iteration-limit-with-progress",
				successfulMutationCount: 0,
				affectedPaths: [],
			});
			expect(result.agent.attempts?.[1]?.continuation).toMatchObject({
				attempt: 2,
				previousAttempt: 1,
				affectedPaths: [],
			});
			expect(result.agent.attempts?.[1]?.execution.runtime?.trajectory[0]?.tool).toBe("apply-patch");
			expect(continuationContexts).toHaveLength(3);
			expect(continuationContexts[0]).toMatchObject({
				version: 2,
				previousAttempt: 1,
				review: { decision: "continue" },
				evidence: expect.arrayContaining([expect.objectContaining({ kind: "repository", paths: ["README.md"] })]),
			});
			// Prior-attempt observations are condensed into the correlated checkpoint,
			// not replayed as the fresh attempt's current conversation tail.
			expect(continuationObservationCounts[0]).toBe(0);
			expect(sessionsCreated).toBe(2);
			expect(result.agent.runtimeEvents?.filter((event) => event.type === "attempt-started")).toHaveLength(2);
			const evidence = await readEvidenceBundle(result.evidence.path);
			expect(evidence).toMatchObject({
				agent: {
					attempts: [
						{ review: { decision: "continue" } },
						{ continuation: { previousAttempt: 1 }, review: { decision: "stop", reason: "completed" } },
					],
				},
			});
			expect(evidence.agent.runtimeEvents?.find((event) => event.type === "tool-result")).toMatchObject({
				observation: "[REDACTED_RUNTIME_OBSERVATION]",
			});
			expect((await readFile(join(result.workspace.path, "README.md"), "utf8")).replaceAll("\r\n", "\n")).toBe(
				"after\n",
			);
		} finally {
			await rm(repository, { recursive: true, force: true });
		}
	}, 30_000);

	it("rejects direct finish after a mutation in the previous attempt until verification passes", async () => {
		const repository = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-cross-attempt-verification-"));
		try {
			await writeFile(join(repository, "README.md"), "before\n", "utf8");
			await git(repository, ["init"]);
			await git(repository, ["config", "user.email", "fixture@example.invalid"]);
			await git(repository, ["config", "user.name", "Fixture"]);
			await git(repository, ["add", "."]);
			await git(repository, ["commit", "-m", "base"]);
			const policy = await validateTaskPolicy({
				repositoryRoot: repository,
				prompt: "Update the existing README.",
				agentAdapter: "harness-native",
				model: "test-model",
				nativeAgent: {
					credentialRef: "openai-primary",
					maxIterations: 3,
					maxToolCalls: 3,
					maxAttempts: 2,
					minContinuationTimeMs: 1,
				},
				patchExpectation: "changes-required",
				verification: {
					commands: [
						{
							command: process.execPath,
							args: [
								"-e",
								"const fs=require('node:fs');process.exit(fs.readFileSync('README.md','utf8').startsWith('after')?0:1)",
							],
						},
					],
				},
			});
			let sessionsCreated = 0;
			const crossAttemptProvider: HarnessNativeModelProvider = {
				id: "openai-responses",
				decide: async () => ({ decision: { kind: "fail" } }),
				createSession: () => {
					sessionsCreated += 1;
					const session = sessionsCreated;
					let turn = 0;
					return {
						decide: async () => {
							turn += 1;
							if (session === 1) {
								if (turn === 1)
									return {
										decision: {
											kind: "tool",
											tool: "apply-patch",
											arguments: { patch: wholeFilePatch("README.md", "before", "after") },
										},
									};
								if (turn === 2) return { decision: { kind: "tool", tool: "git-status", arguments: {} } };
								return { decision: { kind: "tool", tool: "read-file", arguments: { path: "README.md" } } };
							}
							if (turn === 1) return { decision: { kind: "finish" } };
							if (turn === 2)
								return {
									decision: { kind: "tool", tool: "run-public-verification", arguments: { index: 0 } },
								};
							return { decision: { kind: "finish" } };
						},
						recordToolResults: () => undefined,
					};
				},
			};

			const result = await executeAgentPatchCheck(policy, {
				runAgent: async (nativePolicy, worktreePath, repairContext) =>
					await createHarnessNativeAdapter(crossAttemptProvider).execute({
						policy: nativePolicy,
						worktreePath,
						repairContext,
					}),
			});

			expect(result.status).toBe("succeeded");
			expect(result.commandVerification.status).toBe("passed");
			expect(result.agent.attempts?.[0]?.review).toMatchObject({
				decision: "continue",
				successfulMutationCount: 1,
				latestVerificationOutcome: null,
			});
			const completions = result.agent.runtimeEvents?.filter(
				(event) => event.attempt === 2 && event.type === "completion-evaluated",
			);
			expect(completions).toMatchObject([
				{ disposition: "continue", reason: "verification-due" },
				{ disposition: "accept", reason: "complete" },
			]);
			expect(
				result.agent.runtimeEvents?.some(
					(event) =>
						event.attempt === 2 &&
						event.type === "tool-result" &&
						event.facts.kind === "verification" &&
						event.facts.outcome === "passed",
				),
			).toBe(true);
		} finally {
			await rm(repository, { recursive: true, force: true });
		}
	}, 30_000);

	it("requires repair and reverification after a failed verification in the previous attempt", async () => {
		const repository = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-cross-attempt-repair-"));
		try {
			await writeFile(join(repository, "README.md"), "before\n", "utf8");
			await git(repository, ["init"]);
			await git(repository, ["config", "user.email", "fixture@example.invalid"]);
			await git(repository, ["config", "user.name", "Fixture"]);
			await git(repository, ["add", "."]);
			await git(repository, ["commit", "-m", "base"]);
			const policy = await validateTaskPolicy({
				repositoryRoot: repository,
				prompt: "Update the existing README.",
				agentAdapter: "harness-native",
				model: "test-model",
				nativeAgent: {
					credentialRef: "openai-primary",
					maxIterations: 5,
					maxToolCalls: 5,
					maxAttempts: 2,
					minContinuationTimeMs: 1,
				},
				patchExpectation: "changes-required",
				verification: {
					commands: [
						{
							command: process.execPath,
							args: [
								"-e",
								"const fs=require('node:fs');process.exit(fs.readFileSync('README.md','utf8').startsWith('after')?0:1)",
							],
						},
					],
				},
			});
			let sessionsCreated = 0;
			const repairContinuationProvider: HarnessNativeModelProvider = {
				id: "openai-responses",
				decide: async () => ({ decision: { kind: "fail" } }),
				createSession: () => {
					sessionsCreated += 1;
					const session = sessionsCreated;
					let turn = 0;
					return {
						decide: async () => {
							turn += 1;
							if (session === 1) {
								if (turn === 1)
									return {
										decision: {
											kind: "tool",
											tool: "apply-patch",
											arguments: { patch: wholeFilePatch("README.md", "before", "invalid") },
										},
									};
								if (turn === 2)
									return {
										decision: {
											kind: "tool",
											tool: "run-public-verification",
											arguments: { index: 0 },
										},
									};
								if (turn === 3) return { decision: { kind: "tool", tool: "git-status", arguments: {} } };
								if (turn === 4)
									return { decision: { kind: "tool", tool: "read-file", arguments: { path: "README.md" } } };
								return { decision: { kind: "tool", tool: "git-diff", arguments: {} } };
							}
							if (turn === 1 || turn === 3) return { decision: { kind: "finish" } };
							if (turn === 2)
								return {
									decision: {
										kind: "tool",
										tool: "apply-patch",
										arguments: { patch: wholeFilePatch("README.md", "invalid", "after") },
									},
								};
							if (turn === 4)
								return {
									decision: {
										kind: "tool",
										tool: "run-public-verification",
										arguments: { index: 0 },
									},
								};
							return { decision: { kind: "finish" } };
						},
						recordToolResults: () => undefined,
					};
				},
			};

			const result = await executeAgentPatchCheck(policy, {
				runAgent: async (nativePolicy, worktreePath, repairContext) =>
					await createHarnessNativeAdapter(repairContinuationProvider).execute({
						policy: nativePolicy,
						worktreePath,
						repairContext,
					}),
			});

			expect(result.status).toBe("succeeded");
			expect(result.commandVerification.status).toBe("passed");
			expect(result.agent.attempts?.[0]?.review).toMatchObject({
				decision: "continue",
				latestVerificationOutcome: "failed",
			});
			const completions = result.agent.runtimeEvents?.filter(
				(event) => event.attempt === 2 && event.type === "completion-evaluated",
			);
			expect(completions).toMatchObject([
				{ disposition: "continue", reason: "repair-due" },
				{ disposition: "continue", reason: "verification-due" },
				{ disposition: "accept", reason: "complete" },
			]);
			expect((await readFile(join(result.workspace.path, "README.md"), "utf8")).replaceAll("\r\n", "\n")).toBe(
				"after\n",
			);
		} finally {
			await rm(repository, { recursive: true, force: true });
		}
	}, 30_000);

	it("repairs a public verification failure once before the Hidden Oracle runs", async () => {
		const repository = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-repair-"));
		const oracleDirectory = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-oracle-"));
		try {
			await writeFile(join(repository, "README.md"), "before\n", "utf8");
			await writeFile(
				join(oracleDirectory, "oracle.mjs"),
				"import { readFileSync } from 'node:fs'; const path = process.env.AGENTPATCHCHECK_ORACLE_WORKTREE + '/README.md'; process.exit(readFileSync(path, 'utf8').startsWith('after') ? 0 : 1);\n",
				"utf8",
			);
			await git(repository, ["init"]);
			await git(repository, ["config", "user.email", "fixture@example.invalid"]);
			await git(repository, ["config", "user.name", "Fixture"]);
			await git(repository, ["add", "."]);
			await git(repository, ["commit", "-m", "base"]);
			const policy = await validateTaskPolicy({
				repositoryRoot: repository,
				prompt: "Update the existing README.",
				agentAdapter: "harness-native",
				model: "test-model",
				nativeAgent: { credentialRef: "openai-primary", maxIterations: 4, maxToolCalls: 2 },
				patchExpectation: "changes-required",
				verification: {
					commands: [
						{
							command: process.execPath,
							args: ["-e", "process.exit(0)"],
						},
					],
				},
				hiddenOracle: { scriptPath: join(oracleDirectory, "oracle.mjs") },
			});
			let repairDecisions = 0;
			let prematureRepairFinishes = 0;
			const repairProvider: HarnessNativeModelProvider = {
				id: "openai-responses",
				decide: async ({ observations, repairContext }) => {
					if (observations.length === 0) {
						if (repairContext.phase === "initial")
							return {
								decision: {
									kind: "tool",
									tool: "apply-patch",
									arguments: { patch: wholeFilePatch("README.md", "before", "invalid") },
								},
							};
						if (prematureRepairFinishes === 0) {
							prematureRepairFinishes += 1;
							return { decision: { kind: "finish" } };
						}
						repairDecisions += 1;
						return {
							decision: {
								kind: "tool",
								tool: "apply-patch",
								arguments: { patch: wholeFilePatch("README.md", "invalid", "after") },
							},
						};
					}
					return observations.length === 1
						? { decision: { kind: "tool", tool: "run-public-verification", arguments: { index: 0 } } }
						: { decision: { kind: "finish" } };
				},
			};
			let outerVerificationRuns = 0;
			const result = await executeAgentPatchCheck(policy, {
				runAgent: async (nativePolicy, worktreePath, repairContext) =>
					await createHarnessNativeAdapter(repairProvider).execute({
						policy: nativePolicy,
						worktreePath,
						repairContext,
					}),
				runVerification: async (_verification, cwd) => {
					outerVerificationRuns += 1;
					return commandVerification(cwd, outerVerificationRuns === 1 ? "failed" : "passed");
				},
			});

			expect(repairDecisions).toBe(1);
			expect(prematureRepairFinishes).toBe(1);
			expect(result.commandVerification.status).toBe("passed");
			expect(result.hiddenOracle).toMatchObject({ status: "passed" });
			expect(result.agent.attempts).toHaveLength(2);
			expect(result.agent.attempts?.map((attempt) => attempt.phase)).toEqual([
				"initial",
				"public-verification-repair",
			]);
			expect(result.agent.attempts?.[1]?.feedback).toMatchObject({
				status: "failed",
				commands: [{ exitCode: 1 }],
			});
			expect(result.agent.publicVerificationRepair).toEqual({
				eligible: true,
				reason: "public-verification-failed",
				initialChangedFiles: ["README.md"],
			});
			expect(
				result.agent.runtimeEvents?.find(
					(event) => event.type === "completion-evaluated" && event.disposition === "continue",
				),
			).toMatchObject({ reason: "repair-due" });
			expect((await readFile(join(result.workspace.path, "README.md"), "utf8")).replaceAll("\r\n", "\n")).toBe(
				"after\n",
			);
			const benchmark = await runBenchmark(
				{
					version: 1,
					sourcePath: join(repository, "native-repair-benchmark.json"),
					sourceSha256: "native-repair-e2e-benchmark",
					name: "native-repair-e2e",
					suite: { id: "native-repair-e2e", fixtureVersion: "v1" },
					tasks: [
						{
							id: "repair",
							taskSpecPath: "native-repair.json",
							taskSpecSha256: "native-repair-e2e-task",
							expectedStatus: "passed",
						},
					],
				},
				{
					loadTaskSpec: async () => ({
						repositoryRoot: repository,
						prompt: "Update the existing README.",
						agentAdapter: "harness-native",
						model: "test-model",
						nativeAgent: { credentialRef: "openai-primary", maxIterations: 3, maxToolCalls: 1 },
					}),
					validateTaskPolicy,
					execute: async () => result,
					readAgentVersion: async () => null,
				},
			);
			expect(benchmark.report.tasks[0]?.repairCycle).toMatchObject({
				attempted: true,
				initialVerificationStatus: "failed",
				finalVerificationStatus: "passed",
				outcome: "repaired",
				decision: { reason: "public-verification-failed", initialChangedFiles: ["README.md"] },
			});
			expect(benchmark.report.summary.repairCycles).toMatchObject({
				nativeTasks: 1,
				attempted: 1,
				repaired: 1,
			});
		} finally {
			await rm(repository, { recursive: true, force: true });
			await rm(oracleDirectory, { recursive: true, force: true });
		}
	}, 30_000);

	it("does not retry a second time when the one public repair still fails verification", async () => {
		const repository = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-repair-limit-"));
		try {
			await writeFile(join(repository, "README.md"), "before\n", "utf8");
			await git(repository, ["init"]);
			await git(repository, ["config", "user.email", "fixture@example.invalid"]);
			await git(repository, ["config", "user.name", "Fixture"]);
			await git(repository, ["add", "."]);
			await git(repository, ["commit", "-m", "base"]);
			const policy = await validateTaskPolicy({
				repositoryRoot: repository,
				prompt: "Update the existing README.",
				agentAdapter: "harness-native",
				model: "test-model",
				nativeAgent: { credentialRef: "openai-primary", maxIterations: 3, maxToolCalls: 2 },
				verification: {
					commands: [
						{
							command: process.execPath,
							args: ["-e", "process.exit(0)"],
						},
					],
				},
			});
			let repairDecisions = 0;
			const provider: HarnessNativeModelProvider = {
				id: "openai-responses",
				decide: async ({ observations, repairContext }) => {
					if (observations.length === 1)
						return {
							decision: { kind: "tool", tool: "run-public-verification", arguments: { index: 0 } },
						};
					if (observations.length > 1) return { decision: { kind: "finish" } };
					if (repairContext.phase === "initial")
						return {
							decision: {
								kind: "tool",
								tool: "apply-patch",
								arguments: { patch: wholeFilePatch("README.md", "before", "invalid") },
							},
						};
					repairDecisions += 1;
					return {
						decision: {
							kind: "tool",
							tool: "apply-patch",
							arguments: { patch: wholeFilePatch("README.md", "invalid", "still-invalid") },
						},
					};
				},
			};
			const result = await executeAgentPatchCheck(policy, {
				runAgent: async (nativePolicy, worktreePath, repairContext) =>
					await createHarnessNativeAdapter(provider).execute({
						policy: nativePolicy,
						worktreePath,
						repairContext,
					}),
				runVerification: async (_verification, cwd) => commandVerification(cwd, "failed"),
			});

			expect(repairDecisions).toBe(1);
			expect(result.commandVerification.status).toBe("failed");
			expect(result.agent.attempts).toHaveLength(2);
		} finally {
			await rm(repository, { recursive: true, force: true });
		}
	}, 30_000);
});
