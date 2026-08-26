import { deriveHarnessNativeResourceLedger } from "./resource-ledger";
import type {
	HarnessNativeResourceLedger,
	HarnessNativeRuntimeEvent,
	HarnessNativeShadowControlPlaneDiagnostic,
	HarnessNativeShadowControlState,
	HarnessNativeShadowControlStateEvolution,
	HarnessNativeShadowStallReason,
	HarnessNativeToolResultFacts,
	HarnessNativeTrajectoryStep,
	HarnessNativeWorkingContext,
} from "./types";

export type HarnessNativeRetrievalTool = HarnessNativeWorkingContext["retrieval"]["recent"][number]["tool"];
export type HarnessNativeMutationTool = Extract<HarnessNativeToolResultFacts, { kind: "mutation" }>["tool"];
const retrievalTools = new Set<HarnessNativeRetrievalTool>([
	"read-file",
	"list-directory",
	"search-text",
	"search-text-recursive",
	"git-status",
	"git-diff",
]);
const mutationTools = new Set<HarnessNativeMutationTool>([
	"apply-edit",
	"apply-patch",
	"apply-patch-batch",
	"apply-edit-batch",
	"create-file",
	"write-file",
]);
const REPEATED_RETRIEVAL_STALL_THRESHOLD = 2;
const RETRIEVAL_WITHOUT_NEW_PATH_STALL_THRESHOLD = 4;
const MAX_RECENT_RETRIEVALS = 8;
export const HARNESS_NATIVE_TRACKED_PATH_LIMIT = 12;

export interface HarnessNativeRuntimeMechanicalReplay {
	version: 1;
	throughEventSequence: number;
	lifecycle: {
		attempt: number | null;
		phase: HarnessNativeWorkingContext["phase"];
		terminal: {
			status: "succeeded" | "failed";
			terminationReason: Extract<HarnessNativeRuntimeEvent, { type: "attempt-ended" }>["terminationReason"];
			providerFailure: Extract<HarnessNativeRuntimeEvent, { type: "attempt-ended" }>["providerFailure"];
		} | null;
	};
	actions: Array<{
		actionId: string;
		attempt: number;
		iteration: number;
		tool: Extract<HarnessNativeRuntimeEvent, { type: "tool-result" }>["tool"];
		status: Extract<HarnessNativeRuntimeEvent, { type: "tool-result" }>["status"];
		facts: HarnessNativeToolResultFacts;
	}>;
	checkpoints: Array<{ actionId: string; worktreeSha256: string }>;
	resources: HarnessNativeResourceLedger;
	workingContext: HarnessNativeWorkingContext;
	shadowControlPlane: HarnessNativeShadowControlPlaneDiagnostic;
}

export function addHarnessNativeRecentPath(paths: string[], path: string): void {
	const normalized = path.replaceAll("\\", "/");
	const existing = paths.indexOf(normalized);
	if (existing >= 0) paths.splice(existing, 1);
	paths.push(normalized);
	if (paths.length > HARNESS_NATIVE_TRACKED_PATH_LIMIT)
		paths.splice(0, paths.length - HARNESS_NATIVE_TRACKED_PATH_LIMIT);
}

export function isHarnessNativeRetrievalTool(tool: string): tool is HarnessNativeRetrievalTool {
	return retrievalTools.has(tool as HarnessNativeRetrievalTool);
}

export function isHarnessNativeMutationTool(tool: string): tool is HarnessNativeMutationTool {
	return mutationTools.has(tool as HarnessNativeMutationTool);
}

interface ReducerAccumulator {
	state: HarnessNativeShadowControlState;
	seenRetrievals: Set<string>;
	lastRetrievalFingerprint: string | null;
	visitedPaths: Set<string>;
	stallSinceIteration: number | null;
}

function createState(): HarnessNativeShadowControlState {
	return {
		version: 1,
		trajectoryStepCount: 0,
		lastIteration: null,
		retrieval: {
			totalActions: 0,
			successfulActions: 0,
			rejectedActions: 0,
			errorActions: 0,
			uniqueActions: 0,
			repeatedActions: 0,
			consecutiveActions: 0,
			consecutiveRepeatedActions: 0,
		},
		mutation: {
			totalActions: 0,
			successfulActions: 0,
			rejectedActions: 0,
			errorActions: 0,
			firstIteration: null,
			affectedPaths: [],
		},
		verification: { runs: 0, latestStatus: null, latestIteration: null },
		visitedPaths: [],
		inspectedPaths: [],
		candidatePaths: [],
		interpretation: {
			progress: {
				lastNewPathIteration: null,
				consecutiveRetrievalsWithoutNewPath: 0,
				stallDetected: false,
				stallReason: null,
				stallSinceIteration: null,
			},
		},
	};
}

function createWorkingContext(): HarnessNativeWorkingContext {
	return {
		version: 1,
		phase: "discovery",
		inspectedPaths: [],
		candidatePaths: [],
		retrieval: { successfulActions: 0, rejectedActions: 0, recent: [] },
		mutation: { successfulActions: 0, paths: [], firstIteration: null },
		publicVerification: { runs: 0, latestStatus: null, latestIteration: null },
	};
}

function cloneWorkingContext(context: HarnessNativeWorkingContext): HarnessNativeWorkingContext {
	return {
		...context,
		inspectedPaths: [...context.inspectedPaths],
		candidatePaths: [...context.candidatePaths],
		retrieval: {
			...context.retrieval,
			recent: context.retrieval.recent.map((entry) => ({
				...entry,
				search: entry.search === null ? null : structuredClone(entry.search),
			})),
		},
		mutation: { ...context.mutation, paths: [...context.mutation.paths] },
		publicVerification: { ...context.publicVerification },
	};
}

function resumePhase(state: HarnessNativeShadowControlState): HarnessNativeWorkingContext["phase"] {
	if (state.verification.runs > 0) return "public-verification-completed";
	if (state.mutation.successfulActions > 0) return "mutation-applied";
	return "discovery";
}

function cloneState(state: HarnessNativeShadowControlState): HarnessNativeShadowControlState {
	return {
		...state,
		retrieval: { ...state.retrieval },
		mutation: { ...state.mutation, affectedPaths: [...state.mutation.affectedPaths] },
		verification: { ...state.verification },
		visitedPaths: [...state.visitedPaths],
		inspectedPaths: [...state.inspectedPaths],
		candidatePaths: [...state.candidatePaths],
		interpretation: { progress: { ...state.interpretation.progress } },
	};
}

function addUniquePath(paths: string[], seen: Set<string>, path: string): boolean {
	const normalized = path.replaceAll("\\", "/");
	if (seen.has(normalized)) return false;
	seen.add(normalized);
	paths.push(normalized);
	return true;
}

function incrementStatus(
	counter: { successfulActions: number; rejectedActions: number; errorActions: number },
	status: HarnessNativeTrajectoryStep["toolStatus"],
): void {
	if (status === "ok") counter.successfulActions += 1;
	else if (status === "rejected") counter.rejectedActions += 1;
	else if (status === "error") counter.errorActions += 1;
}

function updateStallSignal(accumulator: ReducerAccumulator, step: HarnessNativeTrajectoryStep): void {
	let reason: HarnessNativeShadowStallReason | null = null;
	if (accumulator.state.retrieval.consecutiveRepeatedActions >= REPEATED_RETRIEVAL_STALL_THRESHOLD)
		reason = "repeated-retrieval";
	else if (
		accumulator.state.interpretation.progress.consecutiveRetrievalsWithoutNewPath >=
		RETRIEVAL_WITHOUT_NEW_PATH_STALL_THRESHOLD
	)
		reason = "retrieval-without-new-path";

	if (reason === null) accumulator.stallSinceIteration = null;
	else if (
		!accumulator.state.interpretation.progress.stallDetected ||
		accumulator.state.interpretation.progress.stallReason !== reason
	)
		accumulator.stallSinceIteration = step.iteration;
	accumulator.state.interpretation.progress.stallDetected = reason !== null;
	accumulator.state.interpretation.progress.stallReason = reason;
	accumulator.state.interpretation.progress.stallSinceIteration = accumulator.stallSinceIteration;
}

function reduceStep(accumulator: ReducerAccumulator, step: HarnessNativeTrajectoryStep): void {
	const state = accumulator.state;
	state.trajectoryStepCount += 1;
	state.lastIteration = step.iteration;
	if (step.decision !== "tool" || step.tool === null) {
		state.retrieval.consecutiveActions = 0;
		state.retrieval.consecutiveRepeatedActions = 0;
		updateStallSignal(accumulator, step);
		return;
	}

	if (step.facts?.kind === "retrieval") {
		state.retrieval.totalActions += 1;
		state.retrieval.consecutiveActions += 1;
		incrementStatus(state.retrieval, step.toolStatus);
		const fingerprint = JSON.stringify([step.facts.tool, step.facts.path, step.facts.query]);
		const repeated = accumulator.seenRetrievals.has(fingerprint);
		if (repeated) state.retrieval.repeatedActions += 1;
		else {
			state.retrieval.uniqueActions += 1;
			accumulator.seenRetrievals.add(fingerprint);
		}
		state.retrieval.consecutiveRepeatedActions =
			repeated && accumulator.lastRetrievalFingerprint === fingerprint
				? state.retrieval.consecutiveRepeatedActions + 1
				: 0;
		accumulator.lastRetrievalFingerprint = fingerprint;

		const newPath =
			step.facts.path !== null && addUniquePath(state.visitedPaths, accumulator.visitedPaths, step.facts.path);
		if (newPath) {
			state.interpretation.progress.lastNewPathIteration = step.iteration;
			state.interpretation.progress.consecutiveRetrievalsWithoutNewPath = 0;
		} else state.interpretation.progress.consecutiveRetrievalsWithoutNewPath += 1;
		for (const path of step.facts.inspectedPaths) addHarnessNativeRecentPath(state.inspectedPaths, path);
		for (const path of step.facts.candidatePaths) addHarnessNativeRecentPath(state.candidatePaths, path);
	} else {
		state.retrieval.consecutiveActions = 0;
		state.retrieval.consecutiveRepeatedActions = 0;
		accumulator.lastRetrievalFingerprint = null;
	}

	if (step.facts?.kind === "mutation") {
		state.mutation.totalActions += 1;
		incrementStatus(state.mutation, step.toolStatus);
		if (step.toolStatus === "ok") {
			if (state.mutation.firstIteration === null) state.mutation.firstIteration = step.iteration;
			for (const path of step.facts.affectedPaths) addHarnessNativeRecentPath(state.mutation.affectedPaths, path);
		}
	}
	if (step.facts?.kind === "verification" && step.facts.outcome !== "not-run") {
		state.verification.runs += 1;
		state.verification.latestStatus = step.facts.outcome;
		state.verification.latestIteration = step.iteration;
	}
	updateStallSignal(accumulator, step);
}

/**
 * Replays the canonical Runtime trajectory into an observation-only diagnostic.
 * The result is derived data: it is never used for Provider input or action selection.
 */
function createAccumulator(): ReducerAccumulator {
	return {
		state: createState(),
		seenRetrievals: new Set(),
		lastRetrievalFingerprint: null,
		visitedPaths: new Set(),
		stallSinceIteration: null,
	};
}

function toolResultStep(
	event: Extract<HarnessNativeRuntimeEvent, { type: "tool-result" }>,
): HarnessNativeTrajectoryStep {
	return {
		actionId: event.actionId,
		iteration: event.iteration,
		decision: "tool",
		tool: event.tool,
		arguments: structuredClone(event.arguments),
		toolStatus: event.status,
		observationSummary: event.observationSummary,
		facts: structuredClone(event.facts),
	};
}

export class HarnessNativeShadowControlPlaneReducer {
	readonly #accumulator = createAccumulator();
	readonly #evolution: HarnessNativeShadowControlStateEvolution[] = [];
	readonly #workingContext = createWorkingContext();

	reduce(step: HarnessNativeTrajectoryStep): HarnessNativeShadowControlState {
		reduceStep(this.#accumulator, step);
		const state = cloneState(this.#accumulator.state);
		this.#evolution.push({
			trajectoryStep: state.trajectoryStepCount,
			iteration: step.iteration,
			state,
		});
		return cloneState(state);
	}

	reduceEvent(event: HarnessNativeRuntimeEvent): HarnessNativeShadowControlState {
		if (event.type === "attempt-started") {
			this.#workingContext.phase = resumePhase(this.#accumulator.state);
			return cloneState(this.#accumulator.state);
		}
		if (event.type === "attempt-ended") {
			if (event.decision !== null)
				this.reduce({
					iteration: event.iteration ?? event.iterations,
					decision: event.decision,
					tool: null,
					arguments: null,
					toolStatus: null,
					observationSummary: null,
					facts: null,
				});
			this.#workingContext.phase = event.status === "succeeded" ? "finished" : "failed";
			return cloneState(this.#accumulator.state);
		}
		if (event.type !== "tool-result") return cloneState(this.#accumulator.state);

		const state = this.reduce(toolResultStep(event));
		const facts = event.facts;
		if (facts.kind === "retrieval") {
			this.#workingContext.retrieval.recent.push({
				iteration: event.iteration,
				tool: facts.tool,
				status: event.status,
				path: facts.path,
				query: facts.query,
				summary: event.status === "ok" ? `Completed ${facts.tool}.` : "Retrieval was not accepted.",
				search: facts.search === null ? null : structuredClone(facts.search),
			});
			if (this.#workingContext.retrieval.recent.length > MAX_RECENT_RETRIEVALS)
				this.#workingContext.retrieval.recent.splice(
					0,
					this.#workingContext.retrieval.recent.length - MAX_RECENT_RETRIEVALS,
				);
		}
		if (event.status === "ok" && facts.kind === "mutation") this.#workingContext.phase = "mutation-applied";
		if (event.status === "ok" && facts.kind === "verification" && facts.outcome !== "not-run")
			this.#workingContext.phase = "public-verification-completed";
		return state;
	}

	workingContext(): HarnessNativeWorkingContext {
		const state = this.#accumulator.state;
		const context = cloneWorkingContext(this.#workingContext);
		context.inspectedPaths = [...state.inspectedPaths];
		context.candidatePaths = [...state.candidatePaths];
		context.retrieval.successfulActions = state.retrieval.successfulActions;
		context.retrieval.rejectedActions = state.retrieval.rejectedActions + state.retrieval.errorActions;
		context.mutation = {
			successfulActions: state.mutation.successfulActions,
			paths: [...state.mutation.affectedPaths],
			firstIteration: state.mutation.firstIteration,
		};
		context.publicVerification = {
			runs: state.verification.runs,
			latestStatus: state.verification.latestStatus,
			latestIteration: state.verification.latestIteration,
		};
		return context;
	}

	diagnostic(enabled = true): HarnessNativeShadowControlPlaneDiagnostic {
		if (!enabled)
			return {
				version: 1,
				source: "runtime-trajectory",
				enabled: false,
				finalState: createState(),
				evolution: [],
			};
		return {
			version: 1,
			source: "runtime-trajectory",
			enabled: true,
			finalState: cloneState(this.#accumulator.state),
			evolution: this.#evolution.map((entry) => ({ ...entry, state: cloneState(entry.state) })),
		};
	}
}

/**
 * Replays authoritative Runtime Events into mechanical Runtime state and its
 * compatibility projections. The returned state never owns facts independently
 * of the supplied event sequence.
 */
export function replayHarnessNativeRuntimeMechanicalState(
	events: readonly HarnessNativeRuntimeEvent[],
	shadowEnabled = true,
): HarnessNativeRuntimeMechanicalReplay {
	const reducer = new HarnessNativeShadowControlPlaneReducer();
	const actions: HarnessNativeRuntimeMechanicalReplay["actions"] = [];
	const checkpoints: HarnessNativeRuntimeMechanicalReplay["checkpoints"] = [];
	let attempt: number | null = null;
	let terminal: HarnessNativeRuntimeMechanicalReplay["lifecycle"]["terminal"] = null;

	for (const event of events) {
		reducer.reduceEvent(event);
		if (event.type === "attempt-started") {
			attempt = event.attempt;
			terminal = null;
		} else if (event.type === "tool-result") {
			actions.push({
				actionId: event.actionId,
				attempt: event.attempt,
				iteration: event.iteration,
				tool: event.tool,
				status: event.status,
				facts: structuredClone(event.facts),
			});
		} else if (event.type === "worktree-checkpoint") {
			checkpoints.push({ actionId: event.actionId, worktreeSha256: event.worktreeSha256 });
		} else if (event.type === "attempt-ended") {
			attempt = event.attempt;
			terminal = {
				status: event.status,
				terminationReason: event.terminationReason,
				providerFailure: event.providerFailure ?? null,
			};
		}
	}

	const workingContext = reducer.workingContext();
	return {
		version: 1,
		throughEventSequence: events.at(-1)?.sequence ?? 0,
		lifecycle: { attempt, phase: workingContext.phase, terminal },
		actions,
		checkpoints,
		resources: deriveHarnessNativeResourceLedger(events),
		workingContext,
		shadowControlPlane: reducer.diagnostic(shadowEnabled),
	};
}

export function deriveHarnessNativeShadowControlPlane(
	trajectory: readonly HarnessNativeTrajectoryStep[],
	enabled = true,
): HarnessNativeShadowControlPlaneDiagnostic {
	if (!enabled)
		return {
			version: 1,
			source: "runtime-trajectory",
			enabled: false,
			finalState: createState(),
			evolution: [],
		};
	const reducer = new HarnessNativeShadowControlPlaneReducer();
	for (const step of trajectory) reducer.reduce(step);
	return reducer.diagnostic();
}
