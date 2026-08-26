import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createHarnessNativeAdapter } from "../../src/agentpatchcheck/agent-adapter";
import {
	executeHarnessNativeTool,
	type HarnessNativeModelProvider,
	runHarnessNativeRuntime,
} from "../../src/agentpatchcheck/harness-native-runtime";
import { createModelProvider, ModelProviderFailureError } from "../../src/agentpatchcheck/model-provider";
import { replayHarnessNativeRuntimeMechanicalState } from "../../src/agentpatchcheck/shadow-control-plane";
import { validateTaskPolicy } from "../../src/agentpatchcheck/task-policy";
import { runGit } from "../../src/workspace/git-utils";

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

describe("Harness-native Agent Runtime", () => {
	it("executes the DSH foreground shell contract in the managed worktree with bounded output", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-dsh-shell-"));
		try {
			const dialect = process.platform === "win32" ? "pwsh" : "bash";
			const result = await executeHarnessNativeTool({
				root: worktree,
				tool: "dsh-shell",
				arguments: {
					command: process.platform === "win32" ? "Write-Output ready" : "printf ready",
					description: "Print runtime readiness marker",
					dialect,
				},
				maxObservationBytes: 1_024,
				verification: undefined,
			});

			expect(result.status).toBe("ok");
			expect(result.observation).toContain("ready");
			expect(result.observation).toContain("[exit code: 0]");
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("executes read-file as a bounded line window and records replay-safe facts", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "large.txt"), "one\ntwo\nthree\nfour\n", "utf8");
			const result = await executeHarnessNativeTool({
				root: worktree,
				tool: "read-file",
				arguments: { path: "large.txt", offset: 2, limit: 2 },
				maxObservationBytes: 1_024,
				verification: undefined,
			});

			expect(result.status).toBe("ok");
			expect(result.observation).toContain("2: two\n3: three");
			expect(result.observation).toContain("Showing lines 2-3 of 4. Use offset=4 to continue.");
			expect(result.facts).toMatchObject({
				kind: "retrieval",
				tool: "read-file",
				path: "large.txt",
				inspectedPaths: ["large.txt"],
				readWindow: {
					offset: 2,
					limit: 2,
					returnedLines: 2,
					totalLines: 4,
					truncatedByBytes: false,
				},
			});

			await writeFile(
				join(worktree, "bounded.txt"),
				Array.from({ length: 100 }, (_, index) => `${index + 1}-${"x".repeat(100)}`).join("\n"),
				"utf8",
			);
			const bounded = await executeHarnessNativeTool({
				root: worktree,
				tool: "read-file",
				arguments: { path: "bounded.txt" },
				maxObservationBytes: 1_024,
				verification: undefined,
			});
			expect(Buffer.byteLength(bounded.observation, "utf8")).toBeLessThanOrEqual(1_024);
			expect(bounded.observation).toContain("Output capped");
			expect(bounded.observation).toContain("Use offset=");
			expect(bounded.facts).toMatchObject({
				kind: "retrieval",
				readWindow: { totalLines: 100, truncatedByBytes: true },
			});
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("can keep investigation and action ownership in one Executor session without invoking the independent Planner", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			let plannerCalls = 0;
			const executorContexts: Array<{
				plannerEnabled: boolean | undefined;
				plan: unknown;
				patchExpectation: string;
			}> = [];
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				plan: async () => {
					plannerCalls += 1;
					throw new Error("The independent Planner must remain disabled.");
				},
				decide: async (context) => {
					executorContexts.push({
						plannerEnabled: context.plannerEnabled,
						plan: context.plan,
						patchExpectation: context.patchExpectation,
					});
					return context.iteration === 1
						? { decision: { kind: "tool", tool: "read-file", arguments: { path: "README.md" } } }
						: { decision: { kind: "finish" } };
				},
			};

			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 2, maxToolCalls: 1, plannerEnabled: false }),
				prompt: "Inspect README.",
				patchExpectation: "changes-optional",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 2_000,
			});

			expect(plannerCalls).toBe(0);
			expect(executorContexts).toEqual([
				{ plannerEnabled: false, plan: null, patchExpectation: "changes-optional" },
				{ plannerEnabled: false, plan: null, patchExpectation: "changes-optional" },
			]);
			expect(result).toMatchObject({ status: "succeeded", terminationReason: "finished" });
			expect(result.planning).toMatchObject({ enabled: false, revisions: [], currentPlan: null });
			expect(result.planExecution).toMatchObject({ activeStep: null, events: [] });
			expect(result.resourceLedger?.provider.planner.calls).toBe(0);
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("terminates an explicit retrieval loop as stuck when the Planner is disabled", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-stuck-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			let plannerCalls = 0;
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				plan: async () => {
					plannerCalls += 1;
					throw new Error("The independent Planner must remain disabled.");
				},
				decide: async () => ({
					decision: { kind: "tool", tool: "read-file", arguments: { path: "README.md" } },
				}),
			};

			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 8, maxToolCalls: 8, plannerEnabled: false }),
				prompt: "Repair README.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 2_000,
			});

			expect(plannerCalls).toBe(0);
			expect(result).toMatchObject({ status: "failed", terminationReason: "stuck", iterations: 4 });
			expect(result.terminationReason).not.toBe("iteration-limit");
			expect(result.runtimeEvents?.at(-1)).toMatchObject({
				type: "attempt-ended",
				status: "failed",
				terminationReason: "stuck",
			});
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("does not classify retrieval followed by mutation as stuck", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-progress-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async (context) => {
					if ((context.iteration ?? 1) <= 3)
						return { decision: { kind: "tool", tool: "read-file", arguments: { path: "README.md" } } };
					if (context.iteration === 4)
						return {
							decision: {
								kind: "tool",
								tool: "apply-edit",
								arguments: {
									path: "README.md",
									expectedText: "before\n",
									replacementText: "after\n",
								},
							},
						};
					return { decision: { kind: "finish" } };
				},
			};

			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 5, maxToolCalls: 4, plannerEnabled: false }),
				prompt: "Repair README.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 2_000,
			});

			expect(result).toMatchObject({ status: "succeeded", terminationReason: "finished", iterations: 5 });
			expect(await readFile(join(worktree, "README.md"), "utf8")).toBe("after\n");
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("replans when the Executor repeats retrieval that cannot advance the active step", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			const planningTriggers: string[] = [];
			const plannerViewSequences: number[] = [];
			const activeSteps: Array<{ revision: number; attempts: number } | null> = [];
			let decision = 0;
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				plan: async (context) => {
					planningTriggers.push(context.trigger);
					plannerViewSequences.push(context.contextView?.throughEventSequence ?? -1);
					return {
						plan: {
							version: 1,
							objective: "Implement the README repair",
							steps: [{ step: "Implement the README repair", kind: "implementation", status: "in_progress" }],
						},
					};
				},
				decide: async (context) => {
					activeSteps.push(
						context.activePlanStep === undefined || context.activePlanStep === null
							? null
							: { revision: context.activePlanStep.revision, attempts: context.activePlanStep.attempts },
					);
					decision += 1;
					if (decision < 3)
						return { decision: { kind: "tool", tool: "read-file", arguments: { path: "README.md" } } };
					return { decision: { kind: "finish" } };
				},
			};

			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 3, maxToolCalls: 2 }),
				prompt: "Repair README.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 2_000,
			});

			expect(planningTriggers).toEqual(["initial-observation", "execution-stalled"]);
			expect(plannerViewSequences.every((sequence) => sequence > 0)).toBe(true);
			expect(activeSteps).toEqual([null, { revision: 1, attempts: 0 }, { revision: 2, attempts: 0 }]);
			expect(result.planExecution).toMatchObject({
				activeStep: { revision: 2, attempts: 0 },
				events: [{ revision: 1, iteration: 2, tool: "read-file", outcome: "stalled" }],
			});
			const toolEvent = result.runtimeEvents?.find((event) => event.type === "tool-result");
			expect(result.runtimeEvents?.map((event) => event.sequence)).toEqual(
				result.runtimeEvents?.map((_, index) => index + 1),
			);
			expect(toolEvent).toMatchObject({ type: "tool-result", actionId: "attempt-1:iteration-1:action-1" });
			expect(result.trajectory[0]?.actionId).toBe(toolEvent?.type === "tool-result" ? toolEvent.actionId : null);
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("keeps a failed verification observation separate from an active implementation plan", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			const planningTriggers: string[] = [];
			const executorObjectives: Array<string | null> = [];
			const executorObservations: string[][] = [];
			let decision = 0;
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				plan: async (context) => {
					planningTriggers.push(context.trigger);
					return {
						plan: {
							version: 1,
							objective: "Implement the README repair",
							steps: [
								{
									step: "Implement the README repair",
									kind: "implementation",
									status: "in_progress",
								},
							],
						},
					};
				},
				decide: async (context) => {
					executorObjectives.push(context.activePlanStep?.objective ?? null);
					executorObservations.push(context.observations);
					decision += 1;
					if (decision === 1)
						return { decision: { kind: "tool", tool: "read-file", arguments: { path: "README.md" } } };
					if (decision === 2)
						return {
							decision: { kind: "tool", tool: "run-public-verification", arguments: { index: 0 } },
						};
					return { decision: { kind: "finish" } };
				},
			};

			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 3, maxToolCalls: 2 }),
				prompt: "Repair README.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 2_000,
				verification: {
					commands: [{ command: process.execPath, args: ["-e", "process.exit(1)"], timeoutMs: 1_000 }],
					outputLimitBytes: 1_024,
					allowShell: false,
					allowNetwork: false,
				},
			});

			expect(planningTriggers).toEqual(["initial-observation"]);
			expect(executorObjectives).toEqual([null, "Implement the README repair", "Implement the README repair"]);
			expect(executorObservations[2]?.at(-1)).toContain("failed");
			expect(result.planning?.revisions).toHaveLength(1);
			expect(result.planExecution).toMatchObject({
				activeStep: { revision: 1, stepIndex: 0, lastOutcome: "evidence" },
				events: [{ revision: 1, iteration: 2, tool: "run-public-verification", outcome: "evidence" }],
			});
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("carries a successful implementation mutation into the verification checkpoint", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			const planningTriggers: string[] = [];
			const executionCheckpoints: Array<string | null> = [];
			let decision = 0;
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				plan: async (context) => {
					planningTriggers.push(context.trigger);
					const completed = context.trigger === "verification-feedback";
					return {
						plan: {
							version: 1,
							objective: completed ? "README repair verified" : "Implement the README repair",
							steps: [
								{
									step: "Implement the README repair",
									kind: "implementation",
									status: completed ? "completed" : "in_progress",
								},
								{
									step: "Verify the README repair",
									kind: "verification",
									status: completed ? "completed" : "pending",
								},
							],
						},
					};
				},
				decide: async (context) => {
					executionCheckpoints.push(context.activePlanStep?.executionCheckpoint ?? null);
					decision += 1;
					if (decision === 1)
						return { decision: { kind: "tool", tool: "read-file", arguments: { path: "README.md" } } };
					if (decision === 2)
						return {
							decision: {
								kind: "tool",
								tool: "apply-patch",
								arguments: { patch: wholeFilePatch("README.md", "before", "after") },
							},
						};
					if (decision === 3)
						return {
							decision: { kind: "tool", tool: "run-public-verification", arguments: { index: 0 } },
						};
					return { decision: { kind: "finish" } };
				},
			};

			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 4, maxToolCalls: 3 }),
				prompt: "Repair README.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 2_000,
				verification: {
					commands: [
						{
							command: process.execPath,
							args: [
								"-e",
								"const fs=require('node:fs');process.exit(fs.readFileSync('README.md','utf8').includes('after')?0:1)",
							],
							timeoutMs: 1_000,
						},
					],
					outputLimitBytes: 1_024,
					allowShell: false,
					allowNetwork: false,
				},
			});

			expect(executionCheckpoints).toEqual([null, null, "verification-due", null]);
			expect(planningTriggers).toEqual(["initial-observation", "mutation-applied", "verification-feedback"]);
			expect(result.status).toBe("succeeded");
			expect(result.planExecution).toMatchObject({
				activeStep: null,
				events: [
					{ iteration: 2, tool: "apply-patch", outcome: "progress" },
					{ iteration: 3, tool: "run-public-verification", outcome: "progress" },
				],
			});
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("creates and progresses a plan at observation, mutation, and verification boundaries", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			const executorPlans: Array<string | null> = [];
			const planningTriggers: string[] = [];
			let decision = 0;
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				plan: async (context) => {
					planningTriggers.push(context.trigger);
					const statuses =
						context.trigger === "initial-observation"
							? (["completed", "in_progress", "pending"] as const)
							: context.trigger === "mutation-applied"
								? (["completed", "completed", "in_progress"] as const)
								: (["completed", "completed", "completed"] as const);
					return {
						plan: {
							version: 1,
							objective: `Repair README after ${context.trigger}`,
							steps: [
								{ step: "Inspect README", kind: "diagnosis", status: statuses[0] },
								{ step: "Implement repair", kind: "implementation", status: statuses[1] },
								{ step: "Verify behavior", kind: "verification", status: statuses[2] },
							],
						},
						usage: { inputTokens: 2, outputTokens: 1 },
					};
				},
				decide: async (context) => {
					executorPlans.push(context.plan?.objective ?? null);
					decision += 1;
					if (decision === 1)
						return { decision: { kind: "tool", tool: "read-file", arguments: { path: "README.md" } } };
					if (decision === 2)
						return {
							decision: {
								kind: "tool",
								tool: "apply-patch",
								arguments: { patch: wholeFilePatch("README.md", "before", "after") },
							},
						};
					if (decision === 3)
						return {
							decision: { kind: "tool", tool: "run-public-verification", arguments: { index: 0 } },
						};
					return { decision: { kind: "finish" } };
				},
			};

			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 4, maxToolCalls: 3 }),
				prompt: "Repair README.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 2_000,
				verification: {
					commands: [
						{
							command: process.execPath,
							args: [
								"-e",
								"const fs=require('node:fs');process.exit(fs.readFileSync('README.md','utf8').includes('after')?0:1)",
							],
							timeoutMs: 1_000,
						},
					],
					outputLimitBytes: 1_024,
					allowShell: false,
					allowNetwork: false,
				},
			});

			expect(planningTriggers).toEqual(["initial-observation", "mutation-applied", "verification-feedback"]);
			expect(executorPlans).toEqual([
				null,
				"Repair README after initial-observation",
				"Repair README after mutation-applied",
				"Repair README after verification-feedback",
			]);
			expect(result.planning?.revisions).toHaveLength(3);
			expect(result.planning?.currentPlan?.steps.every((step) => step.status === "completed")).toBe(true);
			expect(result.usage).toEqual({ inputTokens: 6, outputTokens: 3 });
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("keeps Provider inputs and action trajectory identical with Shadow Control Plane enabled or disabled", async () => {
		const run = async (shadowControlPlane: boolean) => {
			const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
			try {
				await writeFile(join(worktree, "README.md"), "before\n", "utf8");
				const providerInputs: string[] = [];
				const provider: HarnessNativeModelProvider = {
					id: "test-provider",
					decide: async (context) => {
						providerInputs.push(JSON.stringify(context));
						return context.observations.length < 3
							? { decision: { kind: "tool", tool: "read-file", arguments: { path: "README.md" } } }
							: { decision: { kind: "finish" } };
					},
				};
				const result = await runHarnessNativeRuntime({
					policy: testNativePolicy({ maxIterations: 4, maxToolCalls: 3 }),
					prompt: "Inspect README.",
					model: "test-model",
					worktreePath: worktree,
					provider,
					timeoutMs: 1_000,
					shadowControlPlane,
				});
				return { providerInputs, result };
			} finally {
				await rm(worktree, { recursive: true, force: true });
			}
		};

		const enabled = await run(true);
		const disabled = await run(false);

		expect(enabled.providerInputs).toEqual(disabled.providerInputs);
		expect(enabled.result.trajectory).toEqual(disabled.result.trajectory);
		expect(enabled.result.shadowControlPlane).toMatchObject({
			enabled: true,
			finalState: {
				retrieval: { totalActions: 3, repeatedActions: 2 },
				visitedPaths: ["README.md"],
			},
		});
		expect(disabled.result.shadowControlPlane).toMatchObject({ enabled: false, evolution: [] });
	});

	it("keeps provider observations within budget without truncating the canonical Runtime trace", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			await Promise.all(
				Array.from({ length: 10 }, (_, index) =>
					writeFile(join(worktree, `history-${index + 1}.txt`), `observation-${index + 1}\n`, "utf8"),
				),
			);
			const observationCounts: number[] = [];
			let decisions = 0;
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async ({ observations }) => {
					observationCounts.push(observations.length);
					decisions += 1;
					return decisions <= 10
						? {
								decision: {
									kind: "tool",
									tool: "read-file",
									arguments: { path: `history-${decisions}.txt` },
								},
							}
						: { decision: { kind: "finish" } };
				},
			};
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 11, maxToolCalls: 10 }),
				prompt: "Inspect README.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});

			expect(observationCounts).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
			expect(result.trajectory).toHaveLength(11);
			expect(result.historyProjection).toMatchObject({
				canonicalInteractionCount: 10,
				projectedInteractionCount: 10,
				elidedInteractionCount: 0,
			});
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("keeps a direct file observation available while the observation budget permits it", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await Promise.all(Array.from({ length: 11 }, (_, index) => mkdir(join(worktree, `dir-${index + 1}`))));
			await writeFile(
				join(worktree, "target.ts"),
				"export const targetSymbol = true;\nimportant implementation detail\n",
				"utf8",
			);
			let calls = 0;
			let finalObservations: string[] = [];
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async ({ observations }) => {
					calls += 1;
					if (calls <= 3)
						return {
							decision: { kind: "tool", tool: "list-directory", arguments: { path: `dir-${calls}` } },
						};
					if (calls === 4)
						return { decision: { kind: "tool", tool: "read-file", arguments: { path: "target.ts" } } };
					if (calls <= 11)
						return {
							decision: { kind: "tool", tool: "list-directory", arguments: { path: `dir-${calls}` } },
						};
					finalObservations = [...observations];
					return { decision: { kind: "finish" } };
				},
			};

			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 12, maxToolCalls: 11 }),
				prompt: "Inspect targetSymbol.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});

			expect(result).toMatchObject({ status: "succeeded", terminationReason: "finished", toolCalls: 11 });
			expect(finalObservations).toHaveLength(11);
			expect(finalObservations).toEqual(
				expect.arrayContaining([
					expect.stringContaining("1: export const targetSymbol = true;\n2: important implementation detail"),
				]),
			);
			expect(finalObservations.some((observation) => observation.includes("End of file - total 2 lines"))).toBe(
				true,
			);
			expect(result.historyProjection).toMatchObject({
				canonicalInteractionCount: 11,
				projectedInteractionCount: 11,
				elidedInteractionCount: 0,
			});
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("runs a bounded multi-step read, observation, patch, and finish loop", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			const policy = await validateTaskPolicy({
				repositoryRoot: process.cwd(),
				prompt: "Update README.",
				agentAdapter: "harness-native",
				model: "test-model",
				nativeAgent: { credentialRef: "openai-primary", maxIterations: 4, maxToolCalls: 3 },
			});
			const provider: HarnessNativeModelProvider = {
				id: "openai-responses",
				decide: async ({ observations }) => {
					if (observations.length === 0)
						return { decision: { kind: "tool", tool: "read-file", arguments: { path: "README.md" } } };
					if (observations.length === 1 && observations[0]?.includes("before"))
						return {
							decision: { kind: "tool", tool: "search-text", arguments: { path: ".", query: "before" } },
						};
					if (observations.length === 2 && observations[1]?.includes("README.md:1:before"))
						return {
							decision: {
								kind: "tool",
								tool: "apply-patch",
								arguments: { patch: wholeFilePatch("README.md", "before", "after") },
							},
						};
					return { decision: { kind: "finish" } };
				},
			};
			const result = await createHarnessNativeAdapter(provider).execute({
				policy,
				worktreePath: worktree,
				repairContext: { phase: "initial", publicVerificationFeedback: null },
			});
			expect(result).toMatchObject({
				executable: "harness-native",
				exitCode: 0,
				runtime: { iterations: 4, toolCalls: 3, terminationReason: "finished" },
			});
			expect((await readFile(join(worktree, "README.md"), "utf8")).replaceAll("\r\n", "\n")).toBe("after\n");
			expect(result.runtime?.trajectory.map((step) => step.tool)).toEqual([
				"read-file",
				"search-text",
				"apply-patch",
				null,
			]);
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("searches one regular file directly without treating it as a directory", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "target.txt"), "first line\nneedle\n", "utf8");
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 2, maxToolCalls: 1 }),
				prompt: "Find the target text.",
				model: "test-model",
				worktreePath: worktree,
				provider: {
					id: "test-provider",
					decide: async ({ iteration }) =>
						iteration === 1
							? {
									decision: {
										kind: "tool",
										tool: "search-text",
										arguments: { path: "target.txt", query: "needle" },
									},
								}
							: { decision: { kind: "finish" } },
				},
				timeoutMs: 1_000,
			});

			expect(result.trajectory[0]).toMatchObject({ tool: "search-text", toolStatus: "ok" });
			expect(result.workingContext.candidatePaths).toEqual(["target.txt"]);
			expect(result.workingContext.retrieval.recent[0]?.search).toMatchObject({
				coverage: "complete",
				matchCount: 1,
			});
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("charges rejected workspace escapes to their own strict budget", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			const provider: HarnessNativeModelProvider = {
				id: "openai-responses",
				decide: async ({ observations }) =>
					observations.length === 0
						? { decision: { kind: "tool", tool: "read-file", arguments: { path: "../outside.txt" } } }
						: { decision: { kind: "tool", tool: "shell", arguments: {} } },
			};
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 3, maxToolCalls: 2, maxRejectedToolCalls: 2 }),
				prompt: "untrusted",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});
			expect(result).toMatchObject({
				status: "failed",
				terminationReason: "rejected-tool-limit",
				toolCalls: 0,
				rejectedToolCalls: 2,
			});
			expect(result.trajectory.map((step) => step.toolStatus)).toEqual(["rejected", "rejected"]);
			expect(result.runtimeEvents?.at(-1)).toMatchObject({
				type: "attempt-ended",
				terminationReason: "rejected-tool-limit",
			});
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("preserves the effective tool budget after bounded rejected calls", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async ({ observations }) => {
					if (observations.length === 0)
						return {
							decision: { kind: "tool", tool: "create-file", arguments: { path: "README.md", content: "x" } },
						};
					if (observations.length === 1)
						return {
							decision: {
								kind: "tool",
								tool: "apply-patch",
								arguments: { patch: "not a unified diff" },
							},
						};
					if (observations.length === 2)
						return { decision: { kind: "tool", tool: "read-file", arguments: { path: "README.md" } } };
					if (observations.length === 3)
						return {
							decision: {
								kind: "tool",
								tool: "apply-patch",
								arguments: { patch: wholeFilePatch("README.md", "before", "after") },
							},
						};
					return { decision: { kind: "finish" } };
				},
			};
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 5, maxToolCalls: 2, maxRejectedToolCalls: 3 }),
				prompt: "Repair README.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});
			expect(result).toMatchObject({
				status: "succeeded",
				terminationReason: "finished",
				toolCalls: 2,
				rejectedToolCalls: 2,
			});
			expect((await readFile(join(worktree, "README.md"), "utf8")).replaceAll("\r\n", "\n")).toBe("after\n");
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("searches bounded recursive regular workspace files while excluding state and dependency paths", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await mkdir(join(worktree, "src", "feature"), { recursive: true });
			await mkdir(join(worktree, "node_modules", "package"), { recursive: true });
			await mkdir(join(worktree, ".agentpatchcheck", "state"), { recursive: true });
			await mkdir(join(worktree, "depth-1", "depth-2", "depth-3", "depth-4", "depth-5"), {
				recursive: true,
			});
			await writeFile(join(worktree, "src", "feature", "target.ts"), "const needle = true;\n", "utf8");
			await writeFile(join(worktree, "node_modules", "package", "ignored.js"), "needle\n", "utf8");
			await writeFile(join(worktree, ".agentpatchcheck", "state", "ignored.txt"), "needle\n", "utf8");
			await writeFile(join(worktree, ".env"), "SECRET=needle\n", "utf8");
			await writeFile(
				join(worktree, "depth-1", "depth-2", "depth-3", "depth-4", "included.txt"),
				"needle\n",
				"utf8",
			);
			await writeFile(
				join(worktree, "depth-1", "depth-2", "depth-3", "depth-4", "depth-5", "excluded.txt"),
				"needle\n",
				"utf8",
			);
			let observation = "";
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async ({ observations }) => {
					if (observations.length === 0)
						return {
							decision: {
								kind: "tool",
								tool: "search-text-recursive",
								arguments: { path: ".", query: "needle" },
							},
						};
					observation = observations[0] ?? "";
					return { decision: { kind: "finish" } };
				},
			};
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 2, maxToolCalls: 1 }),
				prompt: "Find source occurrences.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});

			expect(result).toMatchObject({ status: "succeeded", toolCalls: 1 });
			expect(result.trajectory[0]).toMatchObject({ tool: "search-text-recursive", toolStatus: "ok" });
			expect(observation).toContain("src/feature/target.ts:1:const needle = true;");
			expect(observation).toContain("depth-1/depth-2/depth-3/depth-4/included.txt:1:needle");
			expect(observation).not.toContain("node_modules");
			expect(observation).not.toContain(".agentpatchcheck");
			expect(observation).not.toContain("SECRET");
			expect(observation).not.toContain("depth-5");
			expect(observation).toContain("Search coverage=partial");
			expect(result.workingContext.candidatePaths).toEqual([
				"src/feature/target.ts",
				"depth-1/depth-2/depth-3/depth-4/included.txt",
			]);
			expect(result.workingContext.retrieval.recent[0]).toMatchObject({
				query: "needle",
				search: {
					matchCount: 2,
					coverage: "partial",
					skippedCount: expect.any(Number),
				},
			});
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("finds a late match in a text file larger than the legacy 64 KiB limit", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "large.txt"), `${"x".repeat(70 * 1024)}\nlate-needle\n`, "utf8");
			let observation = "";
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async ({ observations }) => {
					if (observations.length === 0)
						return {
							decision: {
								kind: "tool",
								tool: "search-text-recursive",
								arguments: { path: ".", query: "late-needle" },
							},
						};
					observation = observations[0] ?? "";
					return { decision: { kind: "finish" } };
				},
			};
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 2, maxToolCalls: 1 }),
				prompt: "Find the late text occurrence.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});

			expect(observation).toContain("Search coverage=complete; matches=1; skipped=0.");
			expect(observation).toContain("large.txt:2:late-needle");
			expect(result.workingContext.candidatePaths).toEqual(["large.txt"]);
			expect(result.workingContext.retrieval.recent[0]?.search).toEqual({
				matchCount: 1,
				coverage: "complete",
				skippedCount: 0,
				skipped: [],
			});
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("distinguishes complete and partial no-match search coverage", async () => {
		const completeWorktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		const partialWorktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(completeWorktree, "small.txt"), "ordinary text\n", "utf8");
			await writeFile(join(partialWorktree, "binary.bin"), Buffer.from([0, 1, 2, 3]));
			const search = async (worktreePath: string) =>
				await runHarnessNativeRuntime({
					policy: testNativePolicy({ maxIterations: 2, maxToolCalls: 1 }),
					prompt: "Find absent text.",
					model: "test-model",
					worktreePath,
					provider: {
						id: "test-provider",
						decide: async ({ observations }) =>
							observations.length === 0
								? {
										decision: {
											kind: "tool",
											tool: "search-text-recursive",
											arguments: { path: ".", query: "absent" },
										},
									}
								: { decision: { kind: "finish" } },
					},
					timeoutMs: 1_000,
				});
			const complete = await search(completeWorktree);
			const partial = await search(partialWorktree);

			expect(complete.workingContext.retrieval.recent[0]?.search).toMatchObject({
				matchCount: 0,
				coverage: "complete",
				skippedCount: 0,
			});
			expect(partial.workingContext.retrieval.recent[0]?.search).toMatchObject({
				matchCount: 0,
				coverage: "partial",
				skipped: [{ path: "binary.bin", reason: "binary" }],
			});
		} finally {
			await rm(completeWorktree, { recursive: true, force: true });
			await rm(partialWorktree, { recursive: true, force: true });
		}
	});

	it("reports partial coverage when the bounded recursive byte budget is exhausted", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "a-prefix.txt"), "a".repeat(800 * 1024), "utf8");
			await writeFile(join(worktree, "b-tail.txt"), `${"b".repeat(300 * 1024)}budget-needle`, "utf8");
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 2, maxToolCalls: 1 }),
				prompt: "Find a bounded text occurrence.",
				model: "test-model",
				worktreePath: worktree,
				provider: {
					id: "test-provider",
					decide: async ({ observations }) =>
						observations.length === 0
							? {
									decision: {
										kind: "tool",
										tool: "search-text-recursive",
										arguments: { path: ".", query: "budget-needle" },
									},
								}
							: { decision: { kind: "finish" } },
				},
				timeoutMs: 1_000,
			});

			expect(result.workingContext.candidatePaths).toEqual([]);
			expect(result.workingContext.retrieval.recent[0]?.search).toMatchObject({
				matchCount: 0,
				coverage: "partial",
				skipped: [{ path: "b-tail.txt", reason: "total-byte-limit" }],
			});
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("creates one new UTF-8 workspace file exclusively", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async ({ observations }) =>
					observations.length === 0
						? {
								decision: {
									kind: "tool",
									tool: "create-file",
									arguments: { path: "new-file.txt", content: "created\\n" },
								},
							}
						: { decision: { kind: "finish" } },
			};
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 2, maxToolCalls: 1 }),
				prompt: "Create one file.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});

			expect(result).toMatchObject({ status: "succeeded", toolCalls: 1 });
			expect(result.trajectory[0]).toMatchObject({
				tool: "create-file",
				toolStatus: "ok",
				facts: { kind: "mutation", affectedPaths: ["new-file.txt"] },
			});
			expect(await readFile(join(worktree, "new-file.txt"), "utf8")).toBe("created\\n");
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("returns bounded redacted failure diagnostics from a TaskPolicy-declared public verification command", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			let verificationObservation = "";
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async ({ observations, tools }) => {
					expect(tools).toContain("run-public-verification");
					if (observations.length === 0)
						return {
							decision: { kind: "tool", tool: "run-public-verification", arguments: { index: 0 } },
						};
					verificationObservation = observations[0] ?? "";
					if (observations.length === 1)
						return {
							decision: {
								kind: "tool",
								tool: "apply-patch",
								arguments: { patch: wholeFilePatch("README.md", "before", "after") },
							},
						};
					return { decision: { kind: "finish" } };
				},
			};
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 3, maxToolCalls: 2 }),
				prompt: "Repair README.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
				verification: {
					commands: [
						{
							command: process.execPath,
							args: [
								"-e",
								"const fs = require('node:fs'); if (fs.readFileSync('README.md', 'utf8').includes('after')) process.exit(0); process.stderr.write('internal verification detail API_KEY=secret'); process.exit(1);",
							],
							timeoutMs: 1_000,
						},
					],
					outputLimitBytes: 1_024,
					allowShell: false,
					allowNetwork: false,
				},
			});

			expect(result).toMatchObject({ status: "succeeded", toolCalls: 2 });
			expect(result.trajectory[0]).toMatchObject({
				tool: "run-public-verification",
				toolStatus: "ok",
				observationSummary: "Ran TaskSpec-declared public verification command 0: failed.",
				facts: {
					kind: "verification",
					outcome: "failed",
					exitCode: 1,
					timedOut: false,
				},
			});
			expect(result.shadowControlPlane?.finalState.verification).toEqual({
				runs: result.workingContext.publicVerification.runs,
				latestStatus: result.workingContext.publicVerification.latestStatus,
				latestIteration: result.workingContext.publicVerification.latestIteration,
			});
			expect(verificationObservation).toContain("Public verification command 0 failed.");
			expect(verificationObservation).toContain("Untrusted public verification diagnostics");
			expect(verificationObservation).toContain("internal verification detail");
			expect(verificationObservation).toContain("API_KEY=[REDACTED_SECRET]");
			expect(verificationObservation).not.toContain("API_KEY=secret");
			expect((await readFile(join(worktree, "README.md"), "utf8")).replaceAll("\r\n", "\n")).toBe("after\n");
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("does not expose public verification when TaskPolicy declares no verifier", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async ({ tools }) => {
					expect(tools).not.toContain("run-public-verification");
					expect(tools).not.toContain("write-file");
					return { decision: { kind: "finish" } };
				},
			};

			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 1, maxToolCalls: 1 }),
				prompt: "Inspect.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});

			expect(result).toMatchObject({ status: "succeeded", toolCalls: 0 });
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("applies one structured exact-text edit without unified diff syntax", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\r\nkeep\r\n", "utf8");
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async ({ observations, tools }) => {
					expect(tools).toContain("apply-edit");
					return observations.length === 0
						? {
								decision: {
									kind: "tool",
									tool: "apply-edit",
									arguments: {
										path: "README.md",
										expectedText: "before\nkeep",
										replacementText: "after\nkeep",
									},
								},
							}
						: { decision: { kind: "finish" } };
				},
			};
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 2, maxToolCalls: 1 }),
				prompt: "Update one text region.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});

			expect(result).toMatchObject({ status: "succeeded", toolCalls: 1 });
			expect(result.trajectory[0]).toMatchObject({
				tool: "apply-edit",
				arguments: { path: "README.md", expectedTextBytes: 11, replacementTextBytes: 10 },
				toolStatus: "ok",
				facts: { kind: "mutation", tool: "apply-edit", affectedPaths: ["README.md"] },
			});
			expect(await readFile(join(worktree, "README.md"), "utf8")).toBe("after\r\nkeep\r\n");
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("rejects a non-unique structured edit before writing the file", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "README.md"), "same\nsame\n", "utf8");
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async ({ observations }) =>
					observations.length === 0
						? {
								decision: {
									kind: "tool",
									tool: "apply-edit",
									arguments: { path: "README.md", expectedText: "same", replacementText: "changed" },
								},
							}
						: { decision: { kind: "finish" } },
			};
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 2, maxToolCalls: 1 }),
				prompt: "Try an ambiguous edit.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});

			expect(result.trajectory[0]).toMatchObject({
				tool: "apply-edit",
				toolStatus: "rejected",
				observationSummary: "Single edit expectedText must match the target exactly once.",
				facts: { kind: "mutation", tool: "apply-edit", affectedPaths: [] },
			});
			expect(await readFile(join(worktree, "README.md"), "utf8")).toBe("same\nsame\n");
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("applies a fully preflighted multi-file patch batch", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "first.txt"), "first-before\n", "utf8");
			await writeFile(join(worktree, "second.txt"), "second-before\n", "utf8");
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async ({ observations }) =>
					observations.length === 0
						? {
								decision: {
									kind: "tool",
									tool: "apply-patch-batch",
									arguments: {
										patches: [
											{ path: "first.txt", expectedText: "first-before", replacementText: "first-after" },
											{ path: "second.txt", expectedText: "second-before", replacementText: "second-after" },
										],
									},
								},
							}
						: { decision: { kind: "finish" } },
			};
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 2, maxToolCalls: 1 }),
				prompt: "Update two files.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});

			expect(result).toMatchObject({ status: "succeeded", toolCalls: 1 });
			expect(result.trajectory[0]).toMatchObject({
				tool: "apply-patch-batch",
				toolStatus: "ok",
				facts: { kind: "mutation", affectedPaths: ["first.txt", "second.txt"] },
			});
			expect(await readFile(join(worktree, "first.txt"), "utf8")).toBe("first-after\n");
			expect(await readFile(join(worktree, "second.txt"), "utf8")).toBe("second-after\n");
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("records safe array counts when an underfilled edit batch is rejected", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async ({ observations }) =>
					observations.length === 0
						? {
								decision: {
									kind: "tool",
									tool: "apply-edit-batch",
									arguments: {
										patches: [{ path: "README.md", expectedText: "before", replacementText: "after" }],
										creates: [],
									},
								},
							}
						: { decision: { kind: "finish" } },
			};

			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 2, maxToolCalls: 1 }),
				prompt: "Try a one-edit batch.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});

			expect(result.trajectory[0]).toMatchObject({
				tool: "apply-edit-batch",
				arguments: { patchesCount: 1, createsCount: 0 },
				toolStatus: "rejected",
				observationSummary: "Edit batch must contain 2-8 edits.",
			});
			expect(await readFile(join(worktree, "README.md"), "utf8")).toBe("before\n");
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("preflights and applies a combined existing-file and new-file edit batch", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await mkdir(join(worktree, "docs"), { recursive: true });
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async ({ observations }) =>
					observations.length === 0
						? {
								decision: {
									kind: "tool",
									tool: "apply-edit-batch",
									arguments: {
										patches: [
											{
												path: "README.md",
												expectedText: "before",
												replacementText: "after",
											},
										],
										creates: [{ path: "docs/usage.md", content: "usage\n" }],
									},
								},
							}
						: { decision: { kind: "finish" } },
			};

			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 2, maxToolCalls: 1 }),
				prompt: "Update README and add usage documentation.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});

			expect(result).toMatchObject({ status: "succeeded", toolCalls: 1 });
			expect(result.trajectory[0]).toMatchObject({
				tool: "apply-edit-batch",
				arguments: { patchesCount: 1, createsCount: 1 },
				toolStatus: "ok",
				facts: { kind: "mutation", affectedPaths: ["README.md", "docs/usage.md"] },
			});
			expect(await readFile(join(worktree, "README.md"), "utf8")).toBe("after\n");
			expect(await readFile(join(worktree, "docs", "usage.md"), "utf8")).toBe("usage\n");
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("rejects a combined edit batch before changing any target when creation preflight fails", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			await writeFile(join(worktree, "existing.md"), "original\n", "utf8");
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async ({ observations }) =>
					observations.length === 0
						? {
								decision: {
									kind: "tool",
									tool: "apply-edit-batch",
									arguments: {
										patches: [
											{
												path: "README.md",
												expectedText: "before",
												replacementText: "after",
											},
										],
										creates: [{ path: "existing.md", content: "overwrite\n" }],
									},
								},
							}
						: { decision: { kind: "finish" } },
			};

			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 2, maxToolCalls: 1 }),
				prompt: "Try an invalid batch.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});

			expect(result.trajectory[0]).toMatchObject({ tool: "apply-edit-batch", toolStatus: "rejected" });
			expect(await readFile(join(worktree, "README.md"), "utf8")).toBe("before\n");
			expect(await readFile(join(worktree, "existing.md"), "utf8")).toBe("original\n");
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("rejects more than eight combined edits before changing any target", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async ({ observations }) =>
					observations.length === 0
						? {
								decision: {
									kind: "tool",
									tool: "apply-edit-batch",
									arguments: {
										patches: [{ path: "README.md", expectedText: "before", replacementText: "after" }],
										creates: Array.from({ length: 8 }, (_, index) => ({
											path: `new-${index}.txt`,
											content: "new\n",
										})),
									},
								},
							}
						: { decision: { kind: "finish" } },
			};

			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 2, maxToolCalls: 1 }),
				prompt: "Try an oversized batch.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});

			expect(result.trajectory[0]).toMatchObject({ tool: "apply-edit-batch", toolStatus: "rejected" });
			expect(await readFile(join(worktree, "README.md"), "utf8")).toBe("before\n");
			await expect(readFile(join(worktree, "new-0.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("applies a multi-line LF request to a CRLF file while preserving CRLF output", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\r\nafter\r\n", "utf8");
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async ({ observations }) =>
					observations.length === 0
						? {
								decision: {
									kind: "tool",
									tool: "apply-patch",
									arguments: { patch: wholeFilePatch("README.md", "before\nafter", "after\nbefore") },
								},
							}
						: { decision: { kind: "finish" } },
			};
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 2, maxToolCalls: 1 }),
				prompt: "Update CRLF file.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});

			expect(result).toMatchObject({ status: "succeeded", toolCalls: 1 });
			expect(await readFile(join(worktree, "README.md"), "utf8")).toBe("after\r\nbefore\r\n");
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("preflights CRLF batch replacements before writing either target", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "first.txt"), "first-before\r\nline\r\n", "utf8");
			await writeFile(join(worktree, "second.txt"), "second-before\r\nline\r\n", "utf8");
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async ({ observations }) =>
					observations.length === 0
						? {
								decision: {
									kind: "tool",
									tool: "apply-patch-batch",
									arguments: {
										patches: [
											{
												path: "first.txt",
												expectedText: "first-before\nline",
												replacementText: "first-after\nline",
											},
											{
												path: "second.txt",
												expectedText: "second-before\nline",
												replacementText: "second-after\nline",
											},
										],
									},
								},
							}
						: { decision: { kind: "finish" } },
			};
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 2, maxToolCalls: 1 }),
				prompt: "Update CRLF files.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});

			expect(result).toMatchObject({ status: "succeeded", toolCalls: 1 });
			expect(await readFile(join(worktree, "first.txt"), "utf8")).toBe("first-after\r\nline\r\n");
			expect(await readFile(join(worktree, "second.txt"), "utf8")).toBe("second-after\r\nline\r\n");
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("rejects an invalid multi-file patch batch without changing any target", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "first.txt"), "first-before\n", "utf8");
			await writeFile(join(worktree, "second.txt"), "second-before\n", "utf8");
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async ({ observations }) =>
					observations.length === 0
						? {
								decision: {
									kind: "tool",
									tool: "apply-patch-batch",
									arguments: {
										patches: [
											{ path: "first.txt", expectedText: "first-before", replacementText: "first-after" },
											{ path: "second.txt", expectedText: "missing", replacementText: "second-after" },
										],
									},
								},
							}
						: { decision: { kind: "finish" } },
			};
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 2, maxToolCalls: 1 }),
				prompt: "Try an invalid batch.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});

			expect(result.trajectory[0]).toMatchObject({ tool: "apply-patch-batch", toolStatus: "rejected" });
			expect(await readFile(join(worktree, "first.txt"), "utf8")).toBe("first-before\n");
			expect(await readFile(join(worktree, "second.txt"), "utf8")).toBe("second-before\n");
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("rejects new-file overwrite, missing-parent, and workspace-escape attempts", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "existing.txt"), "original\\n", "utf8");
			const requests = [
				{ path: "existing.txt", content: "overwrite" },
				{ path: "missing/new.txt", content: "missing parent" },
				{ path: "../outside.txt", content: "escape" },
			];
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async ({ observations }) =>
					observations.length < requests.length
						? {
								decision: {
									kind: "tool",
									tool: "create-file",
									arguments: requests[observations.length] ?? {},
								},
							}
						: { decision: { kind: "finish" } },
			};
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 4, maxToolCalls: 3 }),
				prompt: "Try invalid creates.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});

			expect(result).toMatchObject({ status: "succeeded", toolCalls: 0, rejectedToolCalls: 3 });
			expect(result.trajectory.map((step) => step.toolStatus)).toEqual(["rejected", "rejected", "rejected", null]);
			expect(await readFile(join(worktree, "existing.txt"), "utf8")).toBe("original\\n");
			await expect(readFile(join(worktree, "missing", "new.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("preflights a tool batch, then executes and replays each call sequentially", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			const observedResults: string[] = [];
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async ({ observations }) =>
					observations.length === 0
						? {
								decision: {
									kind: "tool-batch",
									calls: [
										{
											kind: "tool",
											callId: "call-read",
											tool: "read-file",
											arguments: { path: "README.md" },
										},
										{ kind: "tool", callId: "call-status", tool: "git-status", arguments: {} },
									],
								},
							}
						: { decision: { kind: "finish" } },
				createSession: () => ({
					decide: async (context) => provider.decide(context),
					recordToolResults: (results) => observedResults.push(...results.map((result) => result.callId)),
				}),
			};
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 2, maxToolCalls: 2 }),
				prompt: "Inspect.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});

			expect(result).toMatchObject({
				status: "succeeded",
				iterations: 2,
				toolCalls: 2,
				terminationReason: "finished",
			});
			expect(result.trajectory.map((step) => [step.iteration, step.tool])).toEqual([
				[1, "read-file"],
				[1, "git-status"],
				[2, null],
			]);
			expect(observedResults).toEqual(["call-read", "call-status"]);
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("rejects an over-budget batch before executing any call", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async () => ({
					decision: {
						kind: "tool-batch",
						calls: [
							{ kind: "tool", tool: "read-file", arguments: { path: "README.md" } },
							{ kind: "tool", tool: "git-status", arguments: {} },
						],
					},
				}),
			};
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 2, maxToolCalls: 1 }),
				prompt: "Inspect.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});

			expect(result).toMatchObject({
				status: "failed",
				iterations: 1,
				terminationReason: "tool-limit",
				toolCalls: 0,
			});
			expect(result.trajectory.map((step) => [step.tool, step.toolStatus])).toEqual([
				["read-file", "rejected"],
				["git-status", "rejected"],
			]);
			expect(result.runtimeEvents?.at(-1)).toMatchObject({
				type: "attempt-ended",
				terminationReason: "tool-limit",
			});
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("maintains bounded deterministic working context across discovery and mutation", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			const contexts: Array<{ phase: string; inspectedPaths: string[]; candidatePaths: string[] }> = [];
			let calls = 0;
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async ({ workingContext }) => {
					contexts.push({
						phase: workingContext.phase,
						inspectedPaths: [...workingContext.inspectedPaths],
						candidatePaths: [...workingContext.candidatePaths],
					});
					const iteration = calls++;
					if (iteration === 0)
						return { decision: { kind: "tool", tool: "read-file", arguments: { path: "README.md" } } };
					if (iteration === 1)
						return { decision: { kind: "tool", tool: "search-text", arguments: { path: ".", query: "before" } } };
					if (iteration === 2)
						return {
							decision: {
								kind: "tool",
								tool: "apply-patch",
								arguments: { patch: wholeFilePatch("README.md", "before", "after") },
							},
						};
					return { decision: { kind: "finish" } };
				},
			};
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 6, maxToolCalls: 6 }),
				prompt: "Repair README.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});

			expect(result).toMatchObject({ status: "succeeded", terminationReason: "finished", iterations: 4 });
			expect(result.workingContext).toMatchObject({
				phase: "finished",
				inspectedPaths: ["README.md"],
				candidatePaths: ["README.md"],
				mutation: { successfulActions: 1, paths: ["README.md"], firstIteration: 3 },
			});
			expect(result.shadowControlPlane?.finalState).toMatchObject({
				inspectedPaths: result.workingContext.inspectedPaths,
				candidatePaths: result.workingContext.candidatePaths,
				mutation: {
					successfulActions: result.workingContext.mutation.successfulActions,
					firstIteration: result.workingContext.mutation.firstIteration,
					affectedPaths: result.workingContext.mutation.paths,
				},
			});
			const replay = replayHarnessNativeRuntimeMechanicalState(result.runtimeEvents ?? []);
			expect(replay.workingContext).toEqual(result.workingContext);
			expect(replay.shadowControlPlane).toEqual(result.shadowControlPlane);
			expect(contexts).toEqual([
				{ phase: "discovery", inspectedPaths: [], candidatePaths: [] },
				{ phase: "discovery", inspectedPaths: ["README.md"], candidatePaths: [] },
				{ phase: "discovery", inspectedPaths: ["README.md"], candidatePaths: ["README.md"] },
				{ phase: "mutation-applied", inspectedPaths: ["README.md"], candidatePaths: ["README.md"] },
			]);
			expect((await readFile(join(worktree, "README.md"), "utf8")).replaceAll("\r\n", "\n")).toBe("after\n");
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("does not apply legacy checkpoint tool restrictions", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			await Promise.all(Array.from({ length: 6 }, (_, index) => mkdir(join(worktree, `dir-${index + 1}`))));
			let calls = 0;
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async ({ tools }) => {
					const iteration = calls++;
					if (iteration === 0)
						return { decision: { kind: "tool", tool: "read-file", arguments: { path: "README.md" } } };
					if (iteration < 6)
						return {
							decision: { kind: "tool", tool: "list-directory", arguments: { path: `dir-${iteration}` } },
						};
					if (iteration === 6) {
						expect(tools).toContain("list-directory");
						return {
							decision: { kind: "tool", tool: "list-directory", arguments: { path: `dir-${iteration}` } },
						};
					}
					if (iteration === 7)
						return {
							decision: {
								kind: "tool",
								tool: "apply-patch",
								arguments: { patch: wholeFilePatch("README.md", "before", "after") },
							},
						};
					return { decision: { kind: "finish" } };
				},
			};
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 12, maxToolCalls: 8, maxRejectedToolCalls: 2 }),
				prompt: "Repair README.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});

			expect(result).toMatchObject({ status: "succeeded", toolCalls: 8, rejectedToolCalls: 0 });
			expect(result.convergenceCheckpoint.triggered).toBe(false);
			expect(result.trajectory[6]).toMatchObject({ tool: "list-directory", toolStatus: "ok" });
			expect((await readFile(join(worktree, "README.md"), "utf8")).replaceAll("\r\n", "\n")).toBe("after\n");
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("records normalized provider failures without retaining provider error content", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			const transportError = Object.assign(new Error("connection contained secret-value"), {
				cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
			});
			const timeoutProvider = createModelProvider(testProviderConfiguration(), {
				fetcher: async () => {
					throw transportError;
				},
				resolveCredential: () => ({ ok: true, credentialRef: "openai-primary", secret: "test-key" }),
			});
			const timeout = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 1, maxToolCalls: 1 }),
				prompt: "do not retain this prompt",
				model: "test-model",
				worktreePath: worktree,
				provider: timeoutProvider,
				timeoutMs: 1_000,
			});
			expect(timeout).toMatchObject({
				status: "failed",
				terminationReason: "model-failed",
				providerFailure: {
					kind: "timeout",
					code: "UND_ERR_CONNECT_TIMEOUT",
					httpStatus: null,
					requestId: null,
				},
			});
			expect(timeout.runtimeEvents?.at(-1)).toMatchObject({
				type: "attempt-ended",
				terminationReason: "model-failed",
				providerFailure: { kind: "timeout" },
			});
			expect(JSON.stringify(timeout)).not.toContain("secret-value");

			const httpProvider = createModelProvider(testProviderConfiguration(), {
				fetcher: async () =>
					new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "do not retain this" } }), {
						status: 429,
						headers: { "content-type": "application/json", "x-request-id": "req_test-123" },
					}),
				resolveCredential: () => ({ ok: true, credentialRef: "openai-primary", secret: "test-key" }),
			});
			const http = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 1, maxToolCalls: 1 }),
				prompt: "do not retain this prompt",
				model: "test-model",
				worktreePath: worktree,
				provider: httpProvider,
				timeoutMs: 1_000,
			});
			expect(http.providerFailure).toEqual({
				kind: "rate-limited",
				detail: null,
				code: "rate_limit_exceeded",
				httpStatus: 429,
				requestId: "req_test-123",
			});
			expect(JSON.stringify(http)).not.toContain("do not retain this");

			const invalidDecisionProvider = createModelProvider(testProviderConfiguration(), {
				fetcher: async () =>
					new Response(
						JSON.stringify({ output: [{ type: "function_call", name: "read-file", arguments: "not-json" }] }),
					),
				resolveCredential: () => ({ ok: true, credentialRef: "openai-primary", secret: "test-key" }),
			});
			const invalidDecision = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 1, maxToolCalls: 1 }),
				prompt: "do not retain this prompt",
				model: "test-model",
				worktreePath: worktree,
				provider: invalidDecisionProvider,
				timeoutMs: 1_000,
			});
			expect(invalidDecision.providerFailure).toEqual({
				kind: "malformed-response",
				detail: "invalid-tool-arguments",
				code: null,
				httpStatus: null,
				requestId: null,
			});
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("recovers a malformed Executor response inside one coding iteration", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			let calls = 0;
			const recoveryContexts: unknown[] = [];
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async (context) => {
					calls += 1;
					recoveryContexts.push(context.protocolRecovery);
					if (calls === 1) throw new ModelProviderFailureError(protocolFailure("invalid-tool-arguments"));
					if (calls === 2)
						return { decision: { kind: "tool", tool: "read-file", arguments: { path: "README.md" } } };
					return { decision: { kind: "finish" } };
				},
			};

			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 2, maxToolCalls: 1 }),
				prompt: "Inspect README.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 2_000,
			});

			expect(result.status).toBe("succeeded");
			expect(result.iterations).toBe(2);
			expect(calls).toBe(3);
			expect(result.protocolRecoveries).toBe(1);
			expect(recoveryContexts[1]).toMatchObject({
				owner: "executor",
				recovery: 1,
				failure: { kind: "malformed-response", detail: "invalid-tool-arguments" },
			});
			expect(result.runtimeEvents?.filter((event) => event.type === "protocol-recovery")).toEqual([
				expect.objectContaining({ owner: "executor", iteration: 1, disposition: "retrying" }),
			]);
			expect(result.trajectory.map((step) => [step.iteration, step.decision])).toEqual([
				[1, "tool"],
				[2, "finish"],
			]);
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("fails closed after bounded protocol recovery and never retries non-protocol failures", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			let malformedCalls = 0;
			const malformed: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async () => {
					malformedCalls += 1;
					throw new ModelProviderFailureError(protocolFailure("invalid-tool-call-shape"));
				},
			};
			const exhausted = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 4, maxToolCalls: 1, maxProtocolRecoveries: 1 }),
				prompt: "Inspect README.",
				model: "test-model",
				worktreePath: worktree,
				provider: malformed,
				timeoutMs: 2_000,
			});
			expect(malformedCalls).toBe(2);
			expect(exhausted.iterations).toBe(1);
			expect(exhausted.protocolRecoveries).toBe(1);
			expect(
				exhausted.runtimeEvents
					?.filter((event) => event.type === "protocol-recovery")
					.map((event) => event.disposition),
			).toEqual(["retrying", "exhausted"]);

			let authCalls = 0;
			const authFailure: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async () => {
					authCalls += 1;
					throw new ModelProviderFailureError({
						kind: "authentication-failure",
						detail: null,
						code: null,
						httpStatus: 401,
						requestId: null,
					});
				},
			};
			const terminal = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 4, maxToolCalls: 1 }),
				prompt: "Inspect README.",
				model: "test-model",
				worktreePath: worktree,
				provider: authFailure,
				timeoutMs: 2_000,
			});
			expect(authCalls).toBe(1);
			expect(terminal.protocolRecoveries).toBe(0);
			expect(terminal.providerFailure?.kind).toBe("authentication-failure");
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("recovers Planner protocol output without creating a partial revision", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			let decisions = 0;
			let planCalls = 0;
			const plannerRecovery: unknown[] = [];
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async () => {
					decisions += 1;
					return decisions === 1
						? { decision: { kind: "tool", tool: "read-file", arguments: { path: "README.md" } } }
						: { decision: { kind: "finish" } };
				},
				plan: async (context) => {
					planCalls += 1;
					plannerRecovery.push(context.protocolRecovery);
					if (planCalls === 1) throw new ModelProviderFailureError(protocolFailure("invalid-tool-arguments"));
					return {
						plan: {
							version: 1,
							objective: "Inspection complete",
							steps: [{ step: "Inspect README", kind: "diagnosis", status: "completed" }],
						},
					};
				},
			};
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 2, maxToolCalls: 1 }),
				prompt: "Inspect README.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 2_000,
			});
			expect(result.status).toBe("succeeded");
			expect(planCalls).toBe(2);
			expect(result.planning?.revisions).toHaveLength(1);
			expect(plannerRecovery[1]).toMatchObject({ owner: "planner", recovery: 1 });
			expect(result.runtimeEvents).toContainEqual(
				expect.objectContaining({ type: "protocol-recovery", owner: "planner", disposition: "retrying" }),
			);
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("defers finish through implementation verification and accepts it only after plan completion", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			let decision = 0;
			let revision = 0;
			const completionFeedback: Array<string | null> = [];
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async (context) => {
					decision += 1;
					completionFeedback.push(context.contextView?.completionFeedback ?? null);
					if (decision === 1)
						return { decision: { kind: "tool", tool: "read-file", arguments: { path: "README.md" } } };
					if (decision === 2) return { decision: { kind: "finish" } };
					if (decision === 3)
						return {
							decision: {
								kind: "tool",
								tool: "apply-edit",
								arguments: { path: "README.md", expectedText: "before", replacementText: "after" },
							},
						};
					if (decision === 4)
						return {
							decision: { kind: "tool", tool: "run-public-verification", arguments: { index: 0 } },
						};
					return { decision: { kind: "finish" } };
				},
				plan: async () => {
					revision += 1;
					const completed = revision === 3;
					return {
						plan: {
							version: 1,
							objective: "Repair README",
							steps: [
								{
									step: "Repair README",
									kind: "implementation",
									status: completed ? "completed" : "in_progress",
								},
								{
									step: "Verify README",
									kind: "verification",
									status: completed ? "completed" : "pending",
								},
							],
						},
					};
				},
			};
			const result = await runHarnessNativeRuntime({
				policy: { ...testNativePolicy({ maxIterations: 5, maxToolCalls: 3 }), maxPlanRevisions: 3 },
				prompt: "Repair README.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 3_000,
				verification: {
					commands: [{ command: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 1_000 }],
					outputLimitBytes: 1_024,
					allowShell: false,
					allowNetwork: false,
				},
			});
			expect(result.status).toBe("succeeded");
			expect(result.completionDeferrals).toBe(1);
			expect(completionFeedback[2]).toContain("execution plan still contains unresolved steps");
			expect(
				result.runtimeEvents
					?.filter((event) => event.type === "completion-evaluated")
					.map((event) => [event.disposition, event.reason]),
			).toEqual([
				["continue", "plan-incomplete"],
				["accept", "complete"],
			]);
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("terminates repeated premature finish without reporting inner success", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			let decision = 0;
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async () => {
					decision += 1;
					return decision === 1
						? { decision: { kind: "tool", tool: "read-file", arguments: { path: "README.md" } } }
						: { decision: { kind: "finish" } };
				},
				plan: async () => ({
					plan: {
						version: 1,
						objective: "Repair README",
						steps: [{ step: "Repair README", kind: "implementation", status: "in_progress" }],
					},
				}),
			};
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({
					maxIterations: 3,
					maxToolCalls: 1,
					maxCompletionDeferrals: 1,
				}),
				prompt: "Repair README.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 2_000,
			});
			expect(result.status).toBe("failed");
			expect(result.terminationReason).toBe("incomplete-finish");
			expect(result.completionDeferrals).toBe(1);
			expect(
				result.runtimeEvents
					?.filter((event) => event.type === "completion-evaluated")
					.map((event) => event.disposition),
			).toEqual(["continue", "terminal"]);
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("offers code mode as one model action while preserving nested canonical tool facts", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-code-mode-"));
		try {
			await writeFile(join(worktree, "README.md"), "hello\n", "utf8");
			let decisions = 0;
			const observedContexts: Array<{
				tools: readonly string[];
				programmaticTools: readonly { name: string }[] | undefined;
				observations: readonly string[];
			}> = [];
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async (context) => {
					observedContexts.push({
						tools: context.tools,
						programmaticTools: context.programmaticTools,
						observations: context.observations,
					});
					decisions += 1;
					return decisions === 1
						? {
								decision: {
									kind: "tool",
									tool: "run-code",
									arguments: {
										description: "Inspect the repository and target file",
										code: `const listing = await tools.list_directory({ path: "." });\nconst file = await tools.read({ file_path: "README.md" });\nreturn { listing, file };`,
									},
								},
							}
						: { decision: { kind: "finish" } };
				},
			};

			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({
					maxIterations: 2,
					maxToolCalls: 2,
					plannerEnabled: false,
					toolPresentation: "code",
				}),
				prompt: "Inspect README.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 2_000,
			});

			expect(result).toMatchObject({ status: "succeeded", terminationReason: "finished", toolCalls: 2 });
			expect(observedContexts[0]?.tools).toEqual(["run-code"]);
			expect(observedContexts[0]?.programmaticTools?.map((tool) => tool.name)).toEqual(
				expect.arrayContaining(["read", "edit", "write"]),
			);
			expect(observedContexts[1]?.observations).toHaveLength(1);
			expect(observedContexts[1]?.observations[0]).toContain("README.md");
			expect(result.runtimeEvents?.filter((event) => event.type === "tool-result")).toHaveLength(3);
			expect(
				result.runtimeEvents
					?.filter((event) => event.type === "tool-result")
					.map((event) => ({ tool: event.tool, modelVisible: event.modelVisible })),
			).toEqual([
				{ tool: "list-directory", modelVisible: false },
				{ tool: "read-file", modelVisible: false },
				{ tool: "run-code", modelVisible: undefined },
			]);
			expect(result.resourceLedger).toMatchObject({ toolCalls: 3, budgetedToolCalls: 2 });
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("maps the code-mode edit and write facade through canonical mutation tools", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-code-mode-mutation-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			let decisions = 0;
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async () => {
					decisions += 1;
					return decisions === 1
						? {
								decision: {
									kind: "tool",
									tool: "run-code",
									arguments: {
										description: "Read and update workspace files",
										code: `await tools.read({ file_path: "README.md" });\nawait tools.edit({ file_path: "README.md", old_string: "before", new_string: "after" });\nawait tools.write({ file_path: "README.md", content: "final\\n" });\nawait tools.write({ file_path: "notes.txt", content: "done\\n" });\nreturn "updated";`,
									},
								},
							}
						: { decision: { kind: "finish" } };
				},
			};

			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({
					maxIterations: 2,
					maxToolCalls: 4,
					plannerEnabled: false,
					toolPresentation: "code",
				}),
				prompt: "Update README and create notes.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 2_000,
			});

			expect(result.status).toBe("succeeded");
			expect(result.trajectory.map((step) => [step.tool, step.toolStatus])).toEqual([
				["read-file", "ok"],
				["apply-edit", "ok"],
				["write-file", "ok"],
				["write-file", "ok"],
				["run-code", "ok"],
				[null, null],
			]);
			expect(result.toolCalls).toBe(4);
			expect(result.trajectory.map((step) => step.tool)).toEqual([
				"read-file",
				"apply-edit",
				"write-file",
				"write-file",
				"run-code",
				null,
			]);
			expect(await readFile(join(worktree, "README.md"), "utf8")).toBe("final\n");
			expect(await readFile(join(worktree, "notes.txt"), "utf8")).toBe("done\n");
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("runs the DSH-compatible AsyncFunction path and attributes direct worktree mutation", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-dsh-compatible-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			await runGit(worktree, ["init"]);
			await runGit(worktree, ["config", "user.email", "test@example.invalid"]);
			await runGit(worktree, ["config", "user.name", "AgentPatchCheck Test"]);
			await runGit(worktree, ["add", "README.md"]);
			await runGit(worktree, ["commit", "-m", "base"]);
			let decisions = 0;
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async (context) => {
					expect(context.plannerEnabled).toBe(false);
					expect(context.workingDirectory).toBe(worktree);
					decisions += 1;
					return decisions === 1
						? {
								decision: {
									kind: "tool",
									tool: "run_code",
									arguments: {
										description: "Modify the managed worktree directly",
										code: `const fs = await import("node:fs/promises");\nawait fs.writeFile("README.md", "after\\n", "utf8");\nreturn { cwd: process.cwd(), updated: true };`,
									},
								},
							}
						: { decision: { kind: "finish" } };
				},
			};

			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({
					maxIterations: 2,
					maxToolCalls: 2,
					plannerEnabled: false,
					toolPresentation: "dsh-compatible",
				}),
				prompt: "Update README.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 3_000,
			});

			expect(result.status).toBe("succeeded");
			expect(await readFile(join(worktree, "README.md"), "utf8")).toBe("after\n");
			expect(result.trajectory[0]).toMatchObject({
				tool: "run_code",
				toolStatus: "ok",
				facts: { kind: "mutation", affectedPaths: ["README.md"] },
			});
			expect(result.resourceLedger).toMatchObject({ toolCalls: 1, budgetedToolCalls: 0 });
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("gives nested canonical mutation exclusive ownership over the run_code envelope", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-dsh-nested-owner-"));
		try {
			await initializeTrackedWorktree(worktree, { "README.md": "before\n" });
			let decisions = 0;
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({
					maxIterations: 2,
					maxToolCalls: 1,
					plannerEnabled: false,
					toolPresentation: "dsh-compatible",
				}),
				prompt: "Update README.",
				model: "test-model",
				worktreePath: worktree,
				provider: {
					id: "test-provider",
					decide: async () => {
						decisions += 1;
						return decisions === 1
							? {
									decision: {
										kind: "tool",
										tool: "run_code",
										arguments: {
											description: "Edit README through the typed SDK",
											code: 'await tools.edit({ file_path: "README.md", old_string: "before", new_string: "after" }); return true;',
										},
									},
								}
							: { decision: { kind: "finish" } };
					},
				},
				timeoutMs: 3_000,
			});

			const mutationEvents = result.runtimeEvents?.filter(
				(event) => event.type === "tool-result" && event.facts.kind === "mutation",
			);
			expect(mutationEvents).toHaveLength(1);
			expect(mutationEvents?.[0]).toMatchObject({ tool: "apply-edit", facts: { affectedPaths: ["README.md"] } });
			expect(
				result.runtimeEvents?.find((event) => event.type === "tool-result" && event.tool === "run_code"),
			).toMatchObject({ facts: { kind: "other" } });
			expect(result.resourceLedger).toMatchObject({ toolCalls: 2, budgetedToolCalls: 1 });
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("attributes direct run_code mutation from each action-local worktree delta", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-dsh-action-delta-"));
		try {
			await initializeTrackedWorktree(worktree, { "a.txt": "a0\n", "b.txt": "b0\n" });
			let decisions = 0;
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({
					maxIterations: 3,
					maxToolCalls: 1,
					plannerEnabled: false,
					toolPresentation: "dsh-compatible",
				}),
				prompt: "Update both files.",
				model: "test-model",
				worktreePath: worktree,
				provider: {
					id: "test-provider",
					decide: async () => {
						decisions += 1;
						if (decisions === 3) return { decision: { kind: "finish" } };
						const path = decisions === 1 ? "a.txt" : "b.txt";
						return {
							decision: {
								kind: "tool",
								tool: "run_code",
								arguments: {
									description: `Update ${path}`,
									code: `const fs = await import("node:fs/promises"); await fs.writeFile(${JSON.stringify(path)}, "changed\\n", "utf8"); return true;`,
								},
							},
						};
					},
				},
				timeoutMs: 4_000,
			});

			const mutations = result.runtimeEvents?.flatMap((event) =>
				event.type === "tool-result" && event.tool === "run_code" ? [event.facts] : [],
			);
			expect(mutations).toEqual([
				{ kind: "mutation", tool: "run-code", affectedPaths: ["a.txt"] },
				{ kind: "mutation", tool: "run-code", affectedPaths: ["b.txt"] },
			]);
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it.each([
		["exception", 'throw new Error("after mutation");', 3_000],
		["output-limit", 'console.log("x".repeat(4096)); return true;', 3_000],
		["timeout", "await new Promise(() => undefined);", 300],
	] as const)("retains direct mutation facts after run_code %s", async (_kind, tail, timeoutMs) => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-dsh-failed-mutation-"));
		try {
			await initializeTrackedWorktree(worktree, { "README.md": "before\n" });
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({
					maxIterations: 1,
					maxToolCalls: 1,
					plannerEnabled: false,
					toolPresentation: "dsh-compatible",
				}),
				prompt: "Update README.",
				model: "test-model",
				worktreePath: worktree,
				provider: {
					id: "test-provider",
					decide: async () => ({
						decision: {
							kind: "tool",
							tool: "run_code",
							arguments: {
								description: "Mutate before the runtime failure",
								code: `const fs = await import("node:fs/promises"); await fs.writeFile("README.md", "after\\n", "utf8"); ${tail}`,
							},
						},
					}),
				},
				timeoutMs,
			});

			expect(result.runtimeEvents?.find((event) => event.type === "tool-result")).toMatchObject({
				tool: "run_code",
				status: "error",
				facts: { kind: "mutation", affectedPaths: ["README.md"] },
			});
			expect(result.resourceLedger).toMatchObject({ toolCalls: 1, budgetedToolCalls: 0 });
			expect(await readFile(join(worktree, "README.md"), "utf8")).toBe("after\n");
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("records nested budget rejection and terminal attribution in the canonical sequence", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-dsh-nested-budget-"));
		try {
			await initializeTrackedWorktree(worktree, { "README.md": "before\n" });
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({
					maxIterations: 1,
					maxToolCalls: 1,
					plannerEnabled: false,
					toolPresentation: "dsh-compatible",
				}),
				prompt: "Read twice.",
				model: "test-model",
				worktreePath: worktree,
				provider: {
					id: "test-provider",
					decide: async () => ({
						decision: {
							kind: "tool",
							tool: "run_code",
							arguments: {
								description: "Exercise nested budget",
								code: 'await tools.read({ file_path: "README.md" }); await tools.read({ file_path: "README.md" }); return true;',
							},
						},
					}),
				},
				timeoutMs: 3_000,
			});

			const rejected = result.runtimeEvents?.find(
				(event) => event.type === "tool-result" && event.rejectionReason === "tool-budget",
			);
			expect(rejected).toMatchObject({ tool: "read-file", status: "rejected" });
			expect(result.runtimeEvents?.at(-1)).toMatchObject({
				type: "attempt-ended",
				terminationReason: "tool-limit",
			});
			expect(result.resourceLedger).toMatchObject({
				toolCalls: 2,
				budgetedToolCalls: 1,
				rejectedToolCalls: 1,
				budgetedRejectedToolCalls: 1,
			});
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("persists explicit fail, runtime timeout, and iteration-limit as final attempt events", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-terminal-events-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			const base = {
				policy: testNativePolicy({ maxIterations: 1, maxToolCalls: 2, plannerEnabled: false }),
				prompt: "Inspect.",
				model: "test-model",
				worktreePath: worktree,
			};
			const explicitFail = await runHarnessNativeRuntime({
				...base,
				provider: { id: "test-provider", decide: async () => ({ decision: { kind: "fail" } }) },
				timeoutMs: 1_000,
			});
			const timeout = await runHarnessNativeRuntime({
				...base,
				provider: { id: "test-provider", decide: async () => ({ decision: { kind: "finish" } }) },
				timeoutMs: 0,
			});
			const iterationLimit = await runHarnessNativeRuntime({
				...base,
				provider: {
					id: "test-provider",
					decide: async () => ({
						decision: { kind: "tool", tool: "read-file", arguments: { path: "README.md" } },
					}),
				},
				timeoutMs: 1_000,
			});

			for (const [result, terminationReason, decision] of [
				[explicitFail, "model-failed", "fail"],
				[timeout, "timeout", null],
				[iterationLimit, "iteration-limit", null],
			] as const)
				expect(result.runtimeEvents?.at(-1)).toMatchObject({
					type: "attempt-ended",
					terminationReason,
					decision,
				});
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});
});

async function initializeTrackedWorktree(worktree: string, files: Record<string, string>): Promise<void> {
	for (const [path, content] of Object.entries(files)) await writeFile(join(worktree, path), content, "utf8");
	for (const args of [
		["init"],
		["config", "user.email", "test@example.invalid"],
		["config", "user.name", "AgentPatchCheck Test"],
		["add", "."],
		["commit", "-m", "base"],
	] as const) {
		const result = await runGit(worktree, [...args]);
		if (!result.ok) throw new Error(result.error ?? `git ${args.join(" ")} failed`);
	}
}

function protocolFailure(detail: "invalid-tool-arguments" | "invalid-tool-call-shape") {
	return {
		kind: "malformed-response" as const,
		detail,
		code: null,
		httpStatus: null,
		requestId: null,
	};
}

function testProviderConfiguration() {
	return {
		provider: "openai" as const,
		protocol: "responses" as const,
		thinkingMode: "default" as const,
		baseUrl: "https://api.openai.com/v1",
		endpointSha256: "a".repeat(64),
		credentialRef: "openai-primary",
		implementation: "openai-compatible-v1" as const,
	};
}

function testNativePolicy(options: {
	maxIterations: number;
	maxToolCalls: number;
	maxRejectedToolCalls?: number;
	maxProtocolRecoveries?: number;
	maxCompletionDeferrals?: number;
	plannerEnabled?: boolean;
	toolPresentation?: "native" | "code" | "dsh-compatible";
}) {
	return {
		modelProvider: testProviderConfiguration(),
		maxIterations: options.maxIterations,
		maxToolCalls: options.maxToolCalls,
		maxRejectedToolCalls: options.maxRejectedToolCalls ?? 4,
		maxObservationBytes: 1024,
		maxTransportRetries: 0,
		maxProtocolRecoveries: options.maxProtocolRecoveries ?? 2,
		maxCompletionDeferrals: options.maxCompletionDeferrals ?? 2,
		maxPlanRevisions: 4,
		plannerEnabled: options.plannerEnabled ?? true,
		toolPresentation: options.toolPresentation ?? "native",
		maxAttempts: 1,
		minContinuationTimeMs: 1,
	};
}
