import type {
	HarnessNativeAttemptContinuation,
	HarnessNativeExecutionPlan,
	HarnessNativePlannerContextView,
	HarnessNativePlanningResult,
	HarnessNativePlanRevision,
	HarnessNativeProtocolRecoveryFeedback,
	HarnessNativeToolResultFacts,
	HarnessNativeWorkingContext,
} from "./types";

export type PlannerTrigger = HarnessNativePlanRevision["trigger"];

export interface PlannerProviderContext {
	prompt: string;
	model: string;
	iteration: number;
	trigger: PlannerTrigger;
	observations: string[];
	workingContext: HarnessNativeWorkingContext;
	previousPlan: HarnessNativeExecutionPlan | null;
	attemptContinuation?: HarnessNativeAttemptContinuation | null;
	/** Preferred event-derived projection. Legacy fields remain for Provider compatibility. */
	contextView?: HarnessNativePlannerContextView;
	/** Safe same-decision correction derived from the latest protocol-recovery event. */
	protocolRecovery?: HarnessNativeProtocolRecoveryFeedback | null;
}

export interface PlannerProviderResult {
	plan: HarnessNativeExecutionPlan;
	usage?: { inputTokens?: number; outputTokens?: number };
	actualModel?: string;
	transportRetries?: number;
}

export interface PlannerProvider {
	plan: (context: PlannerProviderContext) => Promise<PlannerProviderResult>;
}

export const DEFAULT_MAX_PLAN_REVISIONS = 4;
export const MAX_PLAN_REVISIONS = 8;

function clonePlan(plan: HarnessNativeExecutionPlan): HarnessNativeExecutionPlan {
	return { ...plan, steps: plan.steps.map((step) => ({ ...step })) };
}

/**
 * Model-owned planning lifecycle. Runtime facts are inputs only; this component
 * never infers repository facts or chooses an Executor action.
 */
export class HarnessNativePlanner {
	readonly #provider: PlannerProvider | null;
	readonly #maxRevisions: number;
	readonly #revisions: HarnessNativePlanRevision[] = [];
	readonly #initialPlan: HarnessNativeExecutionPlan | null;
	#firstMutationPlanned = false;

	constructor(
		provider: PlannerProvider | null,
		maxRevisions = DEFAULT_MAX_PLAN_REVISIONS,
		initialPlan: HarnessNativeExecutionPlan | null = null,
		initialRevisions: readonly HarnessNativePlanRevision[] = [],
	) {
		if (!Number.isSafeInteger(maxRevisions) || maxRevisions < 1 || maxRevisions > MAX_PLAN_REVISIONS)
			throw new Error(`Planner maxRevisions must be an integer between 1 and ${MAX_PLAN_REVISIONS}.`);
		this.#provider = provider;
		this.#maxRevisions = maxRevisions;
		this.#initialPlan = initialPlan === null ? null : clonePlan(initialPlan);
		for (const [index, revision] of initialRevisions.entries()) {
			if (revision.revision !== index + 1) throw new Error("Restored Planner revisions must be contiguous.");
			this.#revisions.push({ ...revision, plan: clonePlan(revision.plan) });
			if (revision.trigger === "mutation-applied") this.#firstMutationPlanned = true;
		}
	}

	get currentPlan(): HarnessNativeExecutionPlan | null {
		const current = this.#revisions.at(-1)?.plan;
		return current === undefined ? null : clonePlan(current);
	}

	get currentRevision(): HarnessNativePlanRevision | null {
		const current = this.#revisions.at(-1);
		return current === undefined ? null : { ...current, plan: clonePlan(current.plan) };
	}

	triggerFor(facts: HarnessNativeToolResultFacts, status: "ok" | "rejected" | "error"): PlannerTrigger | null {
		if (this.#provider === null || status !== "ok" || this.#revisions.length >= this.#maxRevisions) return null;
		if (this.#revisions.length === 0 && facts.kind === "retrieval") return "initial-observation";
		if (facts.kind === "mutation" && !this.#firstMutationPlanned) return "mutation-applied";
		if (facts.kind === "verification" && facts.outcome !== "not-run") {
			const activeStep = this.currentPlan?.steps.find((step) => step.status === "in_progress");
			if (facts.outcome === "failed" && activeStep?.kind === "implementation") return null;
			return "verification-feedback";
		}
		return null;
	}

	async update(context: Omit<PlannerProviderContext, "previousPlan">): Promise<PlannerProviderResult | null> {
		if (this.#provider === null || this.#revisions.length >= this.#maxRevisions) return null;
		const previousPlan = this.currentPlan ?? (this.#initialPlan === null ? null : clonePlan(this.#initialPlan));
		const result = await this.#provider.plan({ ...context, previousPlan });
		const plan = clonePlan(result.plan);
		if (context.trigger === "mutation-applied") this.#firstMutationPlanned = true;
		this.#revisions.push({
			version: 1,
			revision: this.#revisions.length + 1,
			iteration: context.iteration,
			trigger: context.trigger,
			plan,
		});
		return { ...result, plan: clonePlan(plan) };
	}

	snapshot(): HarnessNativePlanningResult {
		return {
			version: 1,
			enabled: this.#provider !== null,
			maxRevisions: this.#maxRevisions,
			revisions: this.#revisions.map((revision) => ({ ...revision, plan: clonePlan(revision.plan) })),
			currentPlan: this.currentPlan,
		};
	}
}
