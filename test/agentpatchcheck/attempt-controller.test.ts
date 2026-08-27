import { describe, expect, it } from "vitest";

import {
	createHarnessNativeAttemptContinuation,
	reviewHarnessNativeAttempt,
} from "../../src/agentpatchcheck/attempt-controller";
import type { HarnessNativeRuntimeResult, HarnessNativeTrajectoryStep } from "../../src/agentpatchcheck/types";

function runtime(
	terminationReason: HarnessNativeRuntimeResult["terminationReason"],
	trajectory: HarnessNativeTrajectoryStep[],
	executionCheckpoint: "verification-due" | "repair-due" | null = null,
): HarnessNativeRuntimeResult {
	return {
		version: 1,
		provider: "test-provider",
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
		status: terminationReason === "finished" ? "succeeded" : "failed",
		terminationReason,
		providerFailure: null,
		iterations: trajectory.length,
		toolCalls: trajectory.filter((step) => step.tool !== null).length,
		rejectedToolCalls: 0,
		transportRetries: 0,
		budget: {
			maxIterations: 2,
			maxToolCalls: 2,
			maxRejectedToolCalls: 2,
			maxObservationBytes: 1024,
			maxTransportRetries: 0,
		},
		usage: { inputTokens: null, outputTokens: null },
		trajectory,
		convergenceCheckpoint: {
			version: 1,
			triggered: false,
			triggerIteration: null,
			discoveryActionsAtTrigger: null,
			successfulFileReadsAtTrigger: null,
			mutationActionsAtTrigger: null,
			targetedRetrieval: null,
			firstMutationIteration: null,
			firstPublicVerificationIteration: null,
			finishIteration: null,
			outcome: "not-triggered",
		},
		workingContext: {
			version: 1,
			phase: "failed",
			inspectedPaths: [],
			candidatePaths: [],
			retrieval: { successfulActions: 0, rejectedActions: 0, recent: [] },
			mutation: { successfulActions: 0, paths: [], firstIteration: null },
			publicVerification: { runs: 0, latestStatus: null, latestIteration: null },
		},
		planExecution: {
			version: 1,
			activeStep:
				executionCheckpoint === null
					? null
					: {
							version: 1,
							executionId: 1,
							revision: 1,
							stepIndex: 0,
							objective: "Repair behavior",
							step: "Implement repair",
							attempts: 1,
							lastOutcome: "progress",
							executionCheckpoint,
						},
			events: [],
		},
	};
}

const mutation: HarnessNativeTrajectoryStep = {
	iteration: 1,
	decision: "tool",
	tool: "apply-edit",
	arguments: { path: "implementation.ts" },
	toolStatus: "ok",
	observationSummary: "Applied one edit.",
	facts: { kind: "mutation", tool: "apply-edit", affectedPaths: ["implementation.ts"] },
};

describe("Harness-native attempt controller", () => {
	it("continues an exhausted attempt with canonical mutation progress", () => {
		const review = reviewHarnessNativeAttempt({
			runtime: runtime("iteration-limit", [mutation], "verification-due"),
			attempt: 1,
			maxAttempts: 2,
			remainingTimeMs: 60_000,
			minContinuationTimeMs: 30_000,
		});

		expect(review).toMatchObject({
			decision: "continue",
			reason: "iteration-limit-with-progress",
			successfulMutationCount: 1,
			affectedPaths: ["implementation.ts"],
			executionCheckpoint: "verification-due",
			remainingAttempts: 1,
		});
		expect(createHarnessNativeAttemptContinuation(review)).toMatchObject({
			attempt: 2,
			previousAttempt: 1,
			reason: "iteration-limit-with-progress",
		});
	});

	it("continues an exhausted retrieval-only attempt but not deterministic terminal failures", () => {
		const retrieval: HarnessNativeTrajectoryStep = {
			iteration: 1,
			decision: "tool",
			tool: "read-file",
			arguments: { path: "implementation.ts" },
			toolStatus: "ok",
			observationSummary: "Read file.",
			facts: {
				kind: "retrieval",
				tool: "read-file",
				path: "implementation.ts",
				query: null,
				inspectedPaths: ["implementation.ts"],
				candidatePaths: [],
				search: null,
			},
		};
		expect(
			reviewHarnessNativeAttempt({
				runtime: runtime("iteration-limit", [retrieval]),
				attempt: 1,
				maxAttempts: 2,
				remainingTimeMs: 60_000,
				minContinuationTimeMs: 30_000,
			}),
		).toMatchObject({ decision: "continue", reason: "iteration-limit-with-progress" });
		expect(
			reviewHarnessNativeAttempt({
				runtime: runtime("model-failed", [mutation]),
				attempt: 1,
				maxAttempts: 2,
				remainingTimeMs: 60_000,
				minContinuationTimeMs: 30_000,
			}),
		).toMatchObject({ decision: "stop", reason: "terminal-termination" });
	});

	it("enforces attempt and shared-time boundaries", () => {
		expect(
			reviewHarnessNativeAttempt({
				runtime: runtime("iteration-limit", [mutation]),
				attempt: 2,
				maxAttempts: 2,
				remainingTimeMs: 60_000,
				minContinuationTimeMs: 30_000,
			}),
		).toMatchObject({ decision: "stop", reason: "max-attempts" });
		expect(
			reviewHarnessNativeAttempt({
				runtime: runtime("iteration-limit", [mutation]),
				attempt: 1,
				maxAttempts: 2,
				remainingTimeMs: 29_999,
				minContinuationTimeMs: 30_000,
			}),
		).toMatchObject({ decision: "stop", reason: "insufficient-time" });
	});
});
