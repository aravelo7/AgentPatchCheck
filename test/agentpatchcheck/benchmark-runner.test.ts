import { describe, expect, it } from "vitest";

import { runBenchmark } from "../../src/agentpatchcheck/benchmark-runner";
import { validateTaskPolicy } from "../../src/agentpatchcheck/task-policy";
import type {
	AgentPatchCheckResult,
	BenchmarkDefinition,
	HarnessNativeRuntimeResult,
	PatchVerdictStatus,
} from "../../src/agentpatchcheck/types";

function createResult(options: {
	exitCode?: number | null;
	timedOut?: boolean;
	verificationStatus?: "passed" | "failed" | "not-run";
	hiddenOracleStatus?: "passed" | "failed" | "timed-out" | "error" | "not-run";
	verdict?: PatchVerdictStatus;
}): AgentPatchCheckResult {
	const exitCode = options.exitCode ?? 0;
	const timedOut = options.timedOut ?? false;
	const verificationStatus = options.verificationStatus ?? "not-run";
	const verdict = options.verdict ?? "pass";
	const hiddenOracleStatus = options.hiddenOracleStatus;
	const evidencePath = "D:\\repo\\.agentpatchcheck\\evidence\\task.json";
	return {
		status: exitCode === 0 && !timedOut ? "succeeded" : "failed",
		workspace: {
			runId: "task",
			repositoryPath: "D:\\repo",
			path: "D:\\repo\\.agentpatchcheck\\worktrees\\task",
			baseRef: "HEAD",
			baseCommit: "base",
		},
		agent: {
			executable: "codex",
			args: [],
			exitCode,
			signal: null,
			stdout: "",
			stderr: "",
			durationMs: 10,
			timedOut,
		},
		patch: { changedFiles: ["README.md"], trackedPatch: "diff" },
		commandVerification: { status: verificationStatus, cwd: "D:\\repo", commands: [] },
		hiddenOracle:
			hiddenOracleStatus === undefined
				? null
				: {
						id: "hidden-oracle",
						kind: "hidden-oracle",
						status: hiddenOracleStatus,
						durationMs: 1,
						exitCode: hiddenOracleStatus === "passed" ? 0 : 1,
						signal: null,
						diagnostic: null,
					},
		evidence: { path: evidencePath, createdAt: "2026-08-08T00:00:00.000Z" },
		assessment: {
			report: {
				version: 1,
				createdAt: "2026-08-08T00:00:01.000Z",
				evidence: { path: evidencePath, createdAt: "2026-08-08T00:00:00.000Z" },
				gitPatchVerification: {
					status: "verified",
					evidencePath,
					worktreePath: "D:\\repo\\.agentpatchcheck\\worktrees\\task",
					checkedAt: "2026-08-08T00:00:01.000Z",
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
				verdict: { status: verdict, expectation: "changes-required", reasonCodes: [], reasons: [] },
			},
			reference: { path: `${evidencePath}.assessment.json`, createdAt: "2026-08-08T00:00:01.000Z" },
		},
	};
}

describe("Benchmark Runner", () => {
	it("accepts the Harness-native Adapter through the existing Benchmark policy path", async () => {
		const definition: BenchmarkDefinition = {
			version: 1,
			sourcePath: "D:\\benchmarks\\native.json",
			sourceSha256: "native-benchmark-sha",
			name: "native",
			suite: null,
			tasks: [
				{ id: "native", taskSpecPath: "native.json", taskSpecSha256: "native-task-sha", expectedStatus: "passed" },
			],
		};
		const result = await runBenchmark(definition, {
			loadTaskSpec: async () => ({
				repositoryRoot: process.cwd(),
				prompt: "Update the fixture.",
				agentAdapter: "harness-native",
				model: "test-model",
				nativeAgent: { credentialRef: "openai-secondary" },
				patchExpectation: "changes-required",
			}),
			validateTaskPolicy,
			execute: async () => createResult({}),
			writeReport: async ({ path, report }) => ({ path, createdAt: report.createdAt }),
			createRunId: () => "native-benchmark",
			readAgentVersion: async () => null,
		});
		expect(result.report.tasks[0]?.configuration).toMatchObject({
			agentAdapter: "harness-native",
			model: "test-model",
			modelProvider: { provider: "openai", protocol: "responses", credentialRef: "openai-secondary" },
		});
		expect(result.report.tasks[0]?.executionIdentity?.agent).toMatchObject({
			requestedExecutable: "harness-native",
			version: "test-model",
		});
		expect(result.report.tasks[0]?.executionIdentity?.modelProvider).toMatchObject({
			provider: "openai",
			protocol: "responses",
			credentialRef: "openai-secondary",
			configuredModel: "test-model",
			actualModel: null,
		});
	});

	it("records the bounded Harness-native public-verification repair cycle in task and aggregate results", async () => {
		const definition: BenchmarkDefinition = {
			version: 1,
			sourcePath: "D:\\benchmarks\\native-repair.json",
			sourceSha256: "native-repair-benchmark-sha",
			name: "native-repair",
			suite: { id: "native-repair", fixtureVersion: "v1" },
			tasks: [
				{
					id: "repair",
					taskSpecPath: "repair.json",
					taskSpecSha256: "native-repair-task-sha",
					expectedStatus: "passed",
				},
			],
		};
		const runtime: HarnessNativeRuntimeResult = {
			version: 1,
			provider: "openai:responses",
			providerIdentity: {
				provider: "openai",
				protocol: "responses",
				thinkingMode: "default",
				endpointSha256: "a".repeat(64),
				credentialRef: "openai-primary",
				implementation: "openai-compatible-v1",
				configuredModel: "test-model",
				actualModel: "test-model",
			},
			model: "test-model",
			status: "succeeded",
			terminationReason: "finished",
			providerFailure: null,
			iterations: 2,
			toolCalls: 1,
			rejectedToolCalls: 0,
			transportRetries: 0,
			budget: {
				maxIterations: 3,
				maxToolCalls: 2,
				maxRejectedToolCalls: 4,
				maxObservationBytes: 1024,
				maxTransportRetries: 0,
			},
			usage: { inputTokens: 1, outputTokens: 1 },
			trajectory: [],
		};
		const repaired = createResult({ verificationStatus: "passed" });
		repaired.agent = {
			...repaired.agent,
			runtime,
			attempts: [
				{
					phase: "initial",
					feedback: null,
					execution: { ...repaired.agent, runtime: { ...runtime, iterations: 1, toolCalls: 1 } },
				},
				{
					phase: "public-verification-repair",
					feedback: {
						version: 1,
						status: "failed",
						summary: "Public verification failed.",
						commands: [{ command: "verify", exitCode: 1, signal: null, timedOut: false }],
					},
					execution: { ...repaired.agent, runtime },
				},
			],
		};

		const result = await runBenchmark(definition, {
			loadTaskSpec: async () => ({
				repositoryRoot: process.cwd(),
				prompt: "Repair the failed public verification.",
				agentAdapter: "harness-native",
				model: "test-model",
				nativeAgent: { credentialRef: "openai-primary" },
			}),
			validateTaskPolicy,
			execute: async () => repaired,
			writeReport: async ({ path, report }) => ({ path, createdAt: report.createdAt }),
			createRunId: () => "native-repair-benchmark",
			readAgentVersion: async () => null,
		});

		expect(result.report.tasks[0]?.repairCycle).toEqual({
			attempted: true,
			initialVerificationStatus: "failed",
			finalVerificationStatus: "passed",
			outcome: "repaired",
		});
		expect(result.report.summary.repairCycles).toEqual({
			nativeTasks: 1,
			initialPasses: 0,
			attempted: 1,
			repaired: 1,
			failed: 0,
			timedOut: 0,
		});
		expect(result.report.tasks[0]?.nativeRuntime).toEqual({
			attempts: 2,
			iterations: 3,
			toolCalls: 2,
			rejectedToolCalls: 0,
			transportRetries: 0,
			providerFailureKinds: [],
		});
		expect(result.report.summary.nativeQuality).toEqual({
			nativeTasks: 1,
			initialPublicVerificationPassed: 0,
			publicRepairAttempted: 1,
			publicRepairRecovered: 1,
			finalPublicVerificationPassed: 1,
			hiddenOraclePassed: 0,
			transportRetries: 0,
			rejectedToolCalls: 0,
			providerFailureTasks: 0,
			agentExecutionFailureTasks: 0,
		});
	});

	it("continues after failed tasks and aggregates classifications from Headless Core results", async () => {
		const definition: BenchmarkDefinition = {
			version: 1,
			sourcePath: "D:\\benchmarks\\smoke.json",
			sourceSha256: "benchmark-sha",
			name: "smoke",
			suite: { id: "smoke", fixtureVersion: "1" },
			tasks: [
				"passed",
				"setup",
				"timeout",
				"agent",
				"verification",
				"assessment",
				"oracle-failed",
				"oracle-error",
			].map((id) => ({ id, taskSpecPath: `${id}.json`, taskSpecSha256: `${id}-sha`, expectedStatus: null })),
		};
		const executionOrder: string[] = [];
		const outcomes: Record<string, AgentPatchCheckResult> = {
			passed: createResult({}),
			timeout: createResult({ timedOut: true, exitCode: null, verdict: "fail" }),
			agent: createResult({ exitCode: 1, verdict: "fail" }),
			verification: createResult({ verificationStatus: "failed", verdict: "fail" }),
			assessment: createResult({ verdict: "inconclusive" }),
			"oracle-failed": createResult({ hiddenOracleStatus: "failed", verdict: "fail" }),
			"oracle-error": createResult({ hiddenOracleStatus: "error", verdict: "fail" }),
		};
		let writtenSummary: { total: number; passed: number; failed: number; summaryText: string } | undefined;

		const result = await runBenchmark(definition, {
			loadTaskSpec: async (path) => {
				const taskId = path.replace(".json", "");
				if (taskId === "setup") throw new Error("TaskSpec is invalid.");
				return { repositoryRoot: process.cwd(), prompt: taskId, patchExpectation: "changes-required" };
			},
			validateTaskPolicy,
			execute: async (policy) => {
				executionOrder.push(policy.prompt);
				return outcomes[policy.prompt] as AgentPatchCheckResult;
			},
			writeReport: async ({ path, report }) => {
				writtenSummary = report.summary;
				return { path, createdAt: report.createdAt };
			},
			createRunId: () => "benchmark-test",
			readAgentVersion: async () => "agent-version",
		});

		expect(executionOrder).toEqual([
			"passed",
			"timeout",
			"agent",
			"verification",
			"assessment",
			"oracle-failed",
			"oracle-error",
		]);
		expect(result.report.tasks.map((task) => task.status)).toEqual([
			"passed",
			"setup-failed",
			"timed-out",
			"agent-failed",
			"verification-failed",
			"assessment-failed",
			"hidden-oracle-failed",
			"hidden-oracle-error",
		]);
		expect(result.report.tasks[0]).toMatchObject({
			evidence: { path: "D:\\repo\\.agentpatchcheck\\evidence\\task.json" },
			configuration: { taskSpecSha256: "passed-sha", expectedStatus: null },
			executionIdentity: {
				baseCommit: expect.any(String),
				hiddenOracleSha256: null,
				agent: { requestedExecutable: "codex", launchExecutable: "codex", version: "agent-version" },
			},
		});
		expect(result.report.tasks[1]).toMatchObject({
			evidence: null,
			executionIdentity: null,
			error: { code: "task-failed" },
		});
		expect(result.report.executionIdentity).toMatchObject({
			cliVersion: expect.any(String),
			coreSchemaVersion: 1,
			suite: { sourceSha256: "benchmark-sha", id: "smoke", fixtureVersion: "1" },
		});
		expect(result.report.summary).toEqual({
			total: 8,
			passed: 1,
			failed: 7,
			byStatus: {
				passed: 1,
				"timed-out": 1,
				"agent-failed": 1,
				"verification-failed": 1,
				"hidden-oracle-failed": 1,
				"hidden-oracle-error": 1,
				"assessment-failed": 1,
				"setup-failed": 1,
			},
			summaryText:
				"1/8 tasks passed; 7 failed (timed-out=1, agent-failed=1, verification-failed=1, hidden-oracle-failed=1, hidden-oracle-error=1, assessment-failed=1, setup-failed=1).",
		});
		expect(writtenSummary).toMatchObject({
			total: 8,
			passed: 1,
			failed: 7,
			summaryText: result.report.summary.summaryText,
		});
	});
});
