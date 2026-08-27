import type { HarnessNativeAttemptContinuation, HarnessNativeAttemptReview, HarnessNativeRuntimeResult } from "./types";

export interface HarnessNativeAttemptReviewInput {
	runtime: HarnessNativeRuntimeResult;
	attempt: number;
	maxAttempts: number;
	remainingTimeMs: number;
	minContinuationTimeMs: number;
}

function mutationProgress(runtime: HarnessNativeRuntimeResult): { count: number; affectedPaths: string[] } {
	const affectedPaths = new Set<string>();
	let count = 0;
	for (const step of runtime.trajectory) {
		if (step.toolStatus !== "ok" || step.facts?.kind !== "mutation") continue;
		count += 1;
		for (const path of step.facts.affectedPaths) affectedPaths.add(path);
	}
	return { count, affectedPaths: [...affectedPaths] };
}

function latestVerificationOutcome(
	runtime: HarnessNativeRuntimeResult,
): HarnessNativeAttemptReview["latestVerificationOutcome"] {
	for (let index = runtime.trajectory.length - 1; index >= 0; index -= 1) {
		const step = runtime.trajectory[index];
		if (step === undefined) continue;
		if (step.toolStatus === "ok" && step.facts?.kind === "verification") return step.facts.outcome;
	}
	return null;
}

/**
 * Reviews a completed inner-loop attempt without choosing any coding action.
 * Iteration exhaustion is eligible for bounded continuation while the existing
 * attempt and shared-time boundaries remain available. Mutation progress and a
 * pending implementation checkpoint are recorded for the continuation context,
 * but neither is a prerequisite for starting the next attempt.
 */
export function reviewHarnessNativeAttempt(input: HarnessNativeAttemptReviewInput): HarnessNativeAttemptReview {
	const progress = mutationProgress(input.runtime);
	const executionCheckpoint = input.runtime.planExecution?.activeStep?.executionCheckpoint ?? null;
	const remainingAttempts = Math.max(0, input.maxAttempts - input.attempt);
	let decision: HarnessNativeAttemptReview["decision"] = "stop";
	let reason: HarnessNativeAttemptReview["reason"];

	if (input.runtime.status === "succeeded") reason = "completed";
	else if (input.runtime.terminationReason !== "iteration-limit") reason = "terminal-termination";
	else if (remainingAttempts === 0) reason = "max-attempts";
	else if (input.remainingTimeMs < input.minContinuationTimeMs) reason = "insufficient-time";
	else {
		decision = "continue";
		reason = "iteration-limit-with-progress";
	}

	return {
		version: 1,
		attempt: input.attempt,
		decision,
		reason,
		successfulMutationCount: progress.count,
		affectedPaths: progress.affectedPaths,
		latestVerificationOutcome: latestVerificationOutcome(input.runtime),
		executionCheckpoint,
		remainingAttempts,
		remainingTimeMs: Math.max(0, input.remainingTimeMs),
	};
}

export function createHarnessNativeAttemptContinuation(
	review: HarnessNativeAttemptReview,
): HarnessNativeAttemptContinuation {
	if (review.decision !== "continue" || review.reason !== "iteration-limit-with-progress")
		throw new Error("A stopped attempt cannot create continuation context.");
	return {
		version: 1,
		attempt: review.attempt + 1,
		previousAttempt: review.attempt,
		reason: review.reason,
		successfulMutationCount: review.successfulMutationCount,
		affectedPaths: [...review.affectedPaths],
		latestVerificationOutcome: review.latestVerificationOutcome,
		executionCheckpoint: review.executionCheckpoint,
	};
}
