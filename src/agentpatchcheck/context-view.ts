import { deriveHarnessNativeContinuationContext } from "./continuation-context";
import { projectHistory } from "./history-projection";
import { createProtocolRecoveryFeedback } from "./protocol-recovery";
import { HarnessNativeRuntimeEventSpine } from "./runtime-events";
import { replayHarnessNativeRuntimeMechanicalState } from "./shadow-control-plane";
import type {
	HarnessNativeActivePlanStep,
	HarnessNativeContextViews,
	HarnessNativeExecutionPlan,
	HarnessNativeHistoryProjectionInteraction,
	HarnessNativeProtocolRecoveryFeedback,
	HarnessNativeRuntimeEvent,
} from "./types";

function planForAttempt(
	events: readonly HarnessNativeRuntimeEvent[],
	attempt: number,
): HarnessNativeExecutionPlan | null {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.attempt === attempt && event.type === "plan-revised") return structuredClone(event.revision.plan);
	}
	return null;
}

function activeStepForAttempt(
	events: readonly HarnessNativeRuntimeEvent[],
	attempt: number,
): HarnessNativeActivePlanStep | null {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.attempt === attempt && event.type === "plan-execution-updated")
			return event.activeStep === null ? null : structuredClone(event.activeStep);
	}
	return null;
}

function protocolRecoveryForAttempt(
	events: readonly HarnessNativeRuntimeEvent[],
	attempt: number,
): HarnessNativeProtocolRecoveryFeedback | null {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.attempt !== attempt) continue;
		if (event.type === "completion-evaluated" || event.type === "tool-dispatched" || event.type === "tool-result")
			return null;
		if (event.type === "model-call-completed" && event.outcome === "succeeded") return null;
		if (event.type === "protocol-recovery")
			return event.disposition === "retrying"
				? createProtocolRecoveryFeedback(event.owner, event.failure, event.recovery, event.maxRecoveries)
				: null;
	}
	return null;
}

function completionFeedbackForAttempt(events: readonly HarnessNativeRuntimeEvent[], attempt: number): string | null {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event?.attempt !== attempt) continue;
		if (event.type === "tool-dispatched" || event.type === "tool-result") return null;
		if (event.type === "completion-evaluated") return event.disposition === "continue" ? event.feedback : null;
	}
	return null;
}

/** Builds immutable Planner, Executor, and continuation views from one event sequence. */
export function deriveHarnessNativeContextViews(
	inputEvents: readonly HarnessNativeRuntimeEvent[],
	attempt: number,
): HarnessNativeContextViews {
	if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Context view attempt must be positive.");
	const events = new HarnessNativeRuntimeEventSpine(inputEvents)
		.snapshot()
		.filter((event) => event.attempt <= attempt);
	const dispatchedActions = new Map(
		events
			.filter(
				(event): event is Extract<HarnessNativeRuntimeEvent, { type: "tool-dispatched" }> =>
					event.type === "tool-dispatched" && event.attempt === attempt,
			)
			.map((event) => [event.actionId, event] as const),
	);
	const interactions: HarnessNativeHistoryProjectionInteraction[] = events.flatMap((event) =>
		event.type === "tool-result" && event.attempt === attempt && event.modelVisible !== false
			? [
					{
						sequence: event.sequence,
						iteration: event.iteration,
						actionId: event.actionId,
						tool: event.tool,
						arguments: structuredClone(dispatchedActions.get(event.actionId)?.arguments ?? event.arguments),
						status: event.status,
						observation: event.observation,
						facts: structuredClone(event.facts),
					},
				]
			: [],
	);
	const projectedHistory = projectHistory(interactions);
	const workingContext = replayHarnessNativeRuntimeMechanicalState(events).workingContext;
	const currentPlan = planForAttempt(events, attempt);
	const currentActiveStep = activeStepForAttempt(events, attempt);
	const continuation = deriveHarnessNativeContinuationContext(events, attempt);
	const protocolRecovery = protocolRecoveryForAttempt(events, attempt);
	const completionFeedback = completionFeedbackForAttempt(events, attempt);
	const throughEventSequence = events.at(-1)?.sequence ?? 0;
	const base = {
		version: 1 as const,
		throughEventSequence,
		attempt,
		interactions: projectedHistory.interactions,
		observations: projectedHistory.interactions.map((interaction) => interaction.observation),
		historyProjection: projectedHistory.metadata,
		workingContext,
		continuation,
		protocolRecovery,
		completionFeedback,
	};
	return {
		version: 1,
		planner: {
			...structuredClone(base),
			previousPlan: currentPlan ?? continuation?.plan ?? null,
		},
		executor: {
			...structuredClone(base),
			plan: currentPlan,
			activePlanStep: currentActiveStep,
		},
		continuation: continuation === null ? null : structuredClone(continuation),
	};
}
