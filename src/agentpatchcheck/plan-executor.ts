import type {
	HarnessNativeActivePlanStep,
	HarnessNativePlanExecutionCheckpoint,
	HarnessNativePlanExecutionEvent,
	HarnessNativePlanExecutionOutcome,
	HarnessNativePlanExecutionResult,
	HarnessNativePlanRevision,
	HarnessNativePlanStepKind,
	HarnessNativeRuntimeEvent,
	HarnessNativeToolName,
	HarnessNativeToolResultFacts,
} from "./types";

export type PlanExecutionReplanTrigger = Extract<
	HarnessNativePlanRevision["trigger"],
	"execution-blocked" | "execution-stalled"
>;

interface PlanExecutionObservation {
	actionId?: string;
	iteration: number;
	tool: HarnessNativeToolName;
	arguments: Record<string, unknown>;
	status: "ok" | "rejected" | "error";
	facts: HarnessNativeToolResultFacts;
}

/** Rebuilds Controller state by replaying the same plan and tool facts it originally consumed. */
export function replayHarnessNativePlanExecutor(
	events: readonly HarnessNativeRuntimeEvent[],
	attempt: number,
): HarnessNativePlanExecutor {
	const executor = new HarnessNativePlanExecutor();
	for (const event of events) {
		if (event.attempt !== attempt) continue;
		if (event.type === "plan-revised") {
			executor.synchronize(event.revision);
			continue;
		}
		if (event.type !== "tool-result") continue;
		executor.record({
			actionId: event.actionId,
			iteration: event.iteration,
			tool: event.tool,
			arguments: event.arguments,
			status: event.status,
			facts: event.facts,
		});
	}
	return executor;
}

function retrievalSignature(observation: PlanExecutionObservation): string | null {
	if (observation.facts.kind === "retrieval")
		return JSON.stringify({
			tool: observation.facts.tool,
			path: observation.facts.path,
			query: observation.facts.query,
		});
	if (observation.facts.kind === "other" && (observation.tool === "git-status" || observation.tool === "git-diff"))
		return JSON.stringify({ tool: observation.tool, arguments: observation.arguments });
	return null;
}

function cloneActiveStep(step: HarnessNativeActivePlanStep | null): HarnessNativeActivePlanStep | null {
	return step === null ? null : { ...step };
}

/**
 * Binds a model-owned plan revision to Executor observations. It never selects a
 * tool, path, or patch and derives every outcome from the canonical tool result.
 */
export class HarnessNativePlanExecutor {
	readonly #events: HarnessNativePlanExecutionEvent[] = [];
	readonly #seenEvidenceActions = new Set<string>();
	#activeStep: HarnessNativeActivePlanStep | null = null;
	#activeStepKind: HarnessNativePlanStepKind | null = null;
	#activeStepText: string | null = null;
	#nextExecutionId = 1;

	synchronize(revision: HarnessNativePlanRevision | null): void {
		const activeIndex = revision?.plan.steps.findIndex((step) => step.status === "in_progress") ?? -1;
		if (revision === null || activeIndex < 0) {
			this.#activeStep = null;
			this.#activeStepKind = null;
			this.#activeStepText = null;
			return;
		}
		if (this.#activeStep?.revision === revision.revision && this.#activeStep.stepIndex === activeIndex) return;
		const active = revision.plan.steps[activeIndex];
		if (active === undefined) throw new Error("Active plan step is unavailable.");
		const previousActiveStep = this.#activeStep;
		const continuesActiveExecution =
			previousActiveStep !== null &&
			previousActiveStep.stepIndex === activeIndex &&
			this.#activeStepText === active.step &&
			this.#activeStepKind === active.kind;
		const executionId = continuesActiveExecution ? previousActiveStep.executionId : this.#nextExecutionId++;
		const executionCheckpoint = continuesActiveExecution ? previousActiveStep.executionCheckpoint : null;
		this.#activeStep = {
			version: 1,
			executionId,
			revision: revision.revision,
			stepIndex: activeIndex,
			objective: revision.plan.objective,
			step: active.step,
			attempts: 0,
			lastOutcome: null,
			executionCheckpoint,
		};
		this.#activeStepKind = active.kind;
		this.#activeStepText = active.step;
	}

	get activeStep(): HarnessNativeActivePlanStep | null {
		return cloneActiveStep(this.#activeStep);
	}

	record(observation: PlanExecutionObservation): PlanExecutionReplanTrigger | null {
		const signature = retrievalSignature(observation);
		const repeatedEvidenceAction = signature !== null && this.#seenEvidenceActions.has(signature);
		if (signature !== null) this.#seenEvidenceActions.add(signature);
		if (this.#activeStep === null) return null;

		let outcome: HarnessNativePlanExecutionOutcome;
		let trigger: PlanExecutionReplanTrigger | null = null;
		if (observation.status !== "ok") {
			outcome = "blocked";
			trigger = "execution-blocked";
		} else if (observation.facts.kind === "mutation") {
			outcome = "progress";
		} else if (observation.facts.kind === "verification") {
			if (observation.facts.outcome === "failed")
				outcome = this.#activeStepKind === "implementation" ? "evidence" : "blocked";
			else outcome = "progress";
		} else if (repeatedEvidenceAction) {
			outcome = "stalled";
			trigger = "execution-stalled";
		} else {
			outcome = "evidence";
		}
		let executionCheckpoint: HarnessNativePlanExecutionCheckpoint | null = this.#activeStep.executionCheckpoint;
		if (this.#activeStepKind === "implementation" && observation.status === "ok") {
			if (observation.facts.kind === "mutation") executionCheckpoint = "verification-due";
			else if (observation.facts.kind === "verification" && observation.facts.outcome !== "not-run")
				executionCheckpoint = observation.facts.outcome === "failed" ? "repair-due" : null;
		}

		this.#activeStep = {
			...this.#activeStep,
			attempts: this.#activeStep.attempts + 1,
			lastOutcome: outcome,
			executionCheckpoint,
		};
		this.#events.push({
			version: 1,
			executionId: this.#activeStep.executionId,
			actionId: observation.actionId ?? null,
			revision: this.#activeStep.revision,
			stepIndex: this.#activeStep.stepIndex,
			iteration: observation.iteration,
			tool: observation.tool,
			toolStatus: observation.status,
			outcome,
		});
		return trigger;
	}

	snapshot(): HarnessNativePlanExecutionResult {
		return {
			version: 1,
			activeStep: cloneActiveStep(this.#activeStep),
			events: this.#events.map((event) => ({ ...event })),
		};
	}
}
