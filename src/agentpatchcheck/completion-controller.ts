import type {
	HarnessNativeCompletionDecision,
	HarnessNativeCompletionReason,
	HarnessNativePlanExecutionResult,
	HarnessNativePlanningResult,
} from "./types";

export const DEFAULT_MAX_COMPLETION_DEFERRALS = 2;
export const MAX_COMPLETION_DEFERRALS = 4;

export interface HarnessNativeCompletionInput {
	planning: HarnessNativePlanningResult;
	planExecution: HarnessNativePlanExecutionResult;
}

function incompleteReason(
	input: HarnessNativeCompletionInput,
): Exclude<HarnessNativeCompletionReason, "complete" | "deferral-limit"> | null {
	const checkpoint = input.planExecution.activeStep?.executionCheckpoint;
	if (checkpoint === "verification-due") return "verification-due";
	if (checkpoint === "repair-due") return "repair-due";
	const plan = input.planning.currentPlan;
	if (plan?.steps.some((step) => step.status !== "completed")) return "plan-incomplete";
	return null;
}

function feedback(reason: Exclude<HarnessNativeCompletionReason, "complete" | "deferral-limit">): string {
	if (reason === "verification-due")
		return "Finish was not accepted because the current execution has a successful mutation that still requires verification. Continue the current lifecycle; the concrete next action remains yours.";
	if (reason === "repair-due")
		return "Finish was not accepted because the latest verification left the current execution repair-due. Continue the current lifecycle; the concrete repair action remains yours.";
	return "Finish was not accepted because the current execution plan still contains unresolved steps. Continue or revise that plan before requesting completion; concrete actions remain yours.";
}

/** Owns only the finish boundary. It never judges code semantics or chooses an action. */
export class HarnessNativeCompletionController {
	readonly #maxDeferrals: number;
	#consecutiveDeferrals = 0;

	constructor(maxDeferrals = DEFAULT_MAX_COMPLETION_DEFERRALS, consecutiveDeferrals = 0) {
		if (!Number.isSafeInteger(maxDeferrals) || maxDeferrals < 1 || maxDeferrals > MAX_COMPLETION_DEFERRALS)
			throw new Error(`Completion maxDeferrals must be an integer between 1 and ${MAX_COMPLETION_DEFERRALS}.`);
		this.#maxDeferrals = maxDeferrals;
		if (!Number.isSafeInteger(consecutiveDeferrals) || consecutiveDeferrals < 0)
			throw new Error("Completion consecutiveDeferrals must be a non-negative integer.");
		this.#consecutiveDeferrals = consecutiveDeferrals;
	}

	evaluate(input: HarnessNativeCompletionInput): HarnessNativeCompletionDecision {
		const reason = incompleteReason(input);
		if (reason === null) {
			this.#consecutiveDeferrals = 0;
			return { disposition: "accept", reason: "complete", feedback: null };
		}
		this.#consecutiveDeferrals += 1;
		if (this.#consecutiveDeferrals > this.#maxDeferrals)
			return {
				disposition: "terminal",
				reason: "deferral-limit",
				feedback:
					"Finish remained incompatible with the unresolved execution lifecycle after bounded continuation.",
			};
		return { disposition: "continue", reason, feedback: feedback(reason) };
	}

	recordExecution(): void {
		this.#consecutiveDeferrals = 0;
	}
}
