import type { HarnessNativeRuntimeEvent, HarnessNativeTrajectoryStep } from "./types";

export type HarnessNativeRuntimeEventInput = HarnessNativeRuntimeEvent extends infer Event
	? Event extends HarnessNativeRuntimeEvent
		? Omit<Event, "sequence" | "recordedAtMs"> & { recordedAtMs?: number }
		: never
	: never;

export interface HarnessNativeRuntimeEventSink {
	append(event: HarnessNativeRuntimeEvent): void;
}

function cloneEvent<Event extends HarnessNativeRuntimeEvent>(event: Event): Event {
	return structuredClone(event);
}

type HarnessNativeToolDispatchEvent = Extract<HarnessNativeRuntimeEvent, { type: "tool-dispatched" }>;
type HarnessNativeToolResultEvent = Extract<HarnessNativeRuntimeEvent, { type: "tool-result" }>;

interface HarnessNativeCompletedAction {
	dispatch: HarnessNativeToolDispatchEvent;
	result: HarnessNativeToolResultEvent;
}

export type HarnessNativeStuckPattern =
	| "repeated-action-observation"
	| "repeated-action-error"
	| "alternating-action-observation";

const REPEATED_ACTION_OBSERVATION_COUNT = 4;
const REPEATED_ACTION_ERROR_COUNT = 4;
const ALTERNATING_ACTION_OBSERVATION_COUNT = 6;

function argumentsEqual(
	left: Readonly<Record<string, string | number>>,
	right: Readonly<Record<string, string | number>>,
): boolean {
	const leftKeys = Object.keys(left).sort();
	const rightKeys = Object.keys(right).sort();
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
	);
}

function actionsEqual(left: HarnessNativeCompletedAction, right: HarnessNativeCompletedAction): boolean {
	return (
		left.dispatch.tool === right.dispatch.tool && argumentsEqual(left.dispatch.arguments, right.dispatch.arguments)
	);
}

function completedActionsEqual(left: HarnessNativeCompletedAction, right: HarnessNativeCompletedAction): boolean {
	return (
		actionsEqual(left, right) &&
		left.result.status === right.result.status &&
		left.result.observation === right.result.observation
	);
}

function completedActions(
	events: readonly HarnessNativeRuntimeEvent[],
	attempt: number,
): HarnessNativeCompletedAction[] {
	const dispatched = new Map<string, HarnessNativeToolDispatchEvent>();
	const completed: HarnessNativeCompletedAction[] = [];
	for (const event of events) {
		if (event.attempt !== attempt) continue;
		if (event.type === "tool-dispatched") dispatched.set(event.actionId, event);
		else if (event.type === "tool-result" && event.modelVisible !== false) {
			const dispatch = dispatched.get(event.actionId);
			if (dispatch !== undefined) completed.push({ dispatch, result: event });
		}
	}
	return completed;
}

/** Detects only explicit completed action/result event patterns; it never infers intent or selects an action. */
export function detectHarnessNativeStuckPattern(
	events: readonly HarnessNativeRuntimeEvent[],
	attempt: number,
): HarnessNativeStuckPattern | null {
	const actions = completedActions(events, attempt);
	const repeated = actions.slice(-REPEATED_ACTION_OBSERVATION_COUNT);
	if (
		repeated.length === REPEATED_ACTION_OBSERVATION_COUNT &&
		repeated.every((action) => completedActionsEqual(repeated[0] as HarnessNativeCompletedAction, action))
	)
		return "repeated-action-observation";

	const errors = actions.slice(-REPEATED_ACTION_ERROR_COUNT);
	if (
		errors.length === REPEATED_ACTION_ERROR_COUNT &&
		errors.every(
			(action) =>
				action.result.status === "error" && actionsEqual(errors[0] as HarnessNativeCompletedAction, action),
		)
	)
		return "repeated-action-error";

	const alternating = actions.slice(-ALTERNATING_ACTION_OBSERVATION_COUNT);
	if (
		alternating.length === ALTERNATING_ACTION_OBSERVATION_COUNT &&
		!completedActionsEqual(
			alternating[0] as HarnessNativeCompletedAction,
			alternating[1] as HarnessNativeCompletedAction,
		) &&
		alternating
			.slice(2)
			.every((action, index) => completedActionsEqual(alternating[index] as HarnessNativeCompletedAction, action))
	)
		return "alternating-action-observation";
	return null;
}

function validateEvents(events: readonly HarnessNativeRuntimeEvent[]): void {
	const knownTypes = new Set<HarnessNativeRuntimeEvent["type"]>([
		"attempt-started",
		"model-call-started",
		"model-call-completed",
		"tool-dispatched",
		"tool-result",
		"worktree-checkpoint",
		"protocol-recovery",
		"completion-evaluated",
		"model-usage",
		"plan-revised",
		"plan-execution-updated",
		"attempt-ended",
		"attempt-reviewed",
	]);
	let previousAttempt = 0;
	const startedAttempts = new Set<number>();
	const endedAttempts = new Set<number>();
	const reviewedAttempts = new Set<number>();
	const dispatchedActions = new Map<string, HarnessNativeToolDispatchEvent>();
	const completedActionIds = new Set<string>();
	const checkpointedActionIds = new Set<string>();
	const startedModelCalls = new Map<string, "executor" | "planner">();
	const completedModelCalls = new Set<string>();
	let previousRecordedAtMs = 0;
	for (const [index, event] of events.entries()) {
		if (event.version !== 1) throw new Error("Runtime event version is unsupported.");
		if (!knownTypes.has(event.type)) throw new Error("Runtime event type is unsupported.");
		if (event.sequence !== index + 1) throw new Error("Runtime event sequence must be contiguous and one-based.");
		if (!Number.isSafeInteger(event.attempt) || event.attempt < 1)
			throw new Error("Runtime event attempt must be a positive integer.");
		if (event.attempt < previousAttempt) throw new Error("Runtime event attempts cannot move backwards.");
		if (event.recordedAtMs !== undefined) {
			if (!Number.isSafeInteger(event.recordedAtMs) || event.recordedAtMs < previousRecordedAtMs)
				throw new Error("Runtime event timestamps must be monotonic non-negative integers.");
			previousRecordedAtMs = event.recordedAtMs;
		}
		if (event.attempt > previousAttempt + 1) throw new Error("Runtime event attempts must be contiguous.");
		if (event.attempt !== previousAttempt && event.type !== "attempt-started")
			throw new Error("Each Runtime attempt must begin with an attempt-started event.");
		if (event.type === "attempt-started") {
			if (startedAttempts.has(event.attempt)) throw new Error("A Runtime attempt can start only once.");
			startedAttempts.add(event.attempt);
		} else if (!startedAttempts.has(event.attempt)) {
			throw new Error("Runtime events require an attempt-started owner.");
		}
		if (endedAttempts.has(event.attempt) && event.type !== "attempt-reviewed")
			throw new Error("Only attempt review may follow a terminal Runtime event in the same attempt.");
		if (event.type === "model-call-started") {
			if (startedModelCalls.has(event.callId)) throw new Error("Runtime model call identities must be unique.");
			startedModelCalls.set(event.callId, event.owner);
		}
		if (event.type === "model-call-completed") {
			if (startedModelCalls.get(event.callId) !== event.owner)
				throw new Error("Runtime model completion must reference its original owner.");
			if (completedModelCalls.has(event.callId)) throw new Error("Runtime model calls can complete only once.");
			completedModelCalls.add(event.callId);
		}
		if (event.type === "tool-dispatched") {
			if (dispatchedActions.has(event.actionId))
				throw new Error("Runtime action correlation identities must be unique.");
			dispatchedActions.set(event.actionId, event);
		}
		if (event.type === "tool-result") {
			const dispatch = dispatchedActions.get(event.actionId);
			if (dispatch === undefined) throw new Error("Runtime action result must reference an earlier tool dispatch.");
			if (
				dispatch.attempt !== event.attempt ||
				dispatch.iteration !== event.iteration ||
				dispatch.tool !== event.tool ||
				!argumentsEqual(dispatch.arguments, event.arguments)
			)
				throw new Error("Runtime action result must match its tool dispatch.");
			if (completedActionIds.has(event.actionId)) throw new Error("Runtime actions can complete only once.");
			completedActionIds.add(event.actionId);
		}
		if (event.type === "worktree-checkpoint") {
			if (!completedActionIds.has(event.actionId))
				throw new Error("Worktree checkpoints must reference an earlier Runtime action result.");
			if (checkpointedActionIds.has(event.actionId))
				throw new Error("Runtime actions can own only one worktree checkpoint.");
			checkpointedActionIds.add(event.actionId);
		}
		if (event.type === "plan-execution-updated" && event.actionId !== null) {
			if (!completedActionIds.has(event.actionId))
				throw new Error("Plan execution must reference an earlier Runtime action.");
			if (event.executionEvent?.actionId !== event.actionId)
				throw new Error("Plan execution correlation must match its Controller event.");
		}
		if (event.type === "attempt-ended") {
			const unresolved = [...dispatchedActions.values()].some(
				(dispatch) => dispatch.attempt === event.attempt && !completedActionIds.has(dispatch.actionId),
			);
			if (unresolved) throw new Error("Runtime attempt cannot end with an unresolved tool dispatch.");
			endedAttempts.add(event.attempt);
		}
		if (event.type === "attempt-reviewed") {
			if (!endedAttempts.has(event.attempt))
				throw new Error("Attempt review requires an earlier terminal Runtime event.");
			if (reviewedAttempts.has(event.attempt)) throw new Error("A Runtime attempt can be reviewed only once.");
			reviewedAttempts.add(event.attempt);
		}
		previousAttempt = event.attempt;
	}
}

/**
 * In-memory canonical ordering for one Harness-native execution. It owns only
 * event identity and order; repository facts and lifecycle semantics remain
 * owned by their producers.
 */
export class HarnessNativeRuntimeEventSpine {
	readonly #events: HarnessNativeRuntimeEvent[];
	readonly #sink: HarnessNativeRuntimeEventSink | null;

	constructor(
		initialEvents: readonly HarnessNativeRuntimeEvent[] = [],
		sink: HarnessNativeRuntimeEventSink | null = null,
	) {
		validateEvents(initialEvents);
		this.#events = initialEvents.map((event) => cloneEvent(event));
		this.#sink = sink;
	}

	get nextSequence(): number {
		return this.#events.length + 1;
	}

	append(input: HarnessNativeRuntimeEventInput): HarnessNativeRuntimeEvent {
		const previousRecordedAtMs = this.#events.at(-1)?.recordedAtMs ?? 0;
		const recordedAtMs = Math.max(input.recordedAtMs ?? Date.now(), previousRecordedAtMs);
		const event = cloneEvent({ ...input, sequence: this.nextSequence, recordedAtMs } as HarnessNativeRuntimeEvent);
		validateEvents([...this.#events, event]);
		this.#sink?.append(event);
		this.#events.push(event);
		return cloneEvent(event);
	}

	snapshot(): HarnessNativeRuntimeEvent[] {
		return this.#events.map((event) => cloneEvent(event));
	}

	forAttempt(attempt: number): HarnessNativeRuntimeEvent[] {
		return this.#events.filter((event) => event.attempt === attempt).map((event) => cloneEvent(event));
	}
}

/** Compatibility projection for existing trajectory/Evidence consumers. */
export function deriveHarnessNativeTrajectory(
	events: readonly HarnessNativeRuntimeEvent[],
	attempt?: number,
): HarnessNativeTrajectoryStep[] {
	return events.flatMap((event): HarnessNativeTrajectoryStep[] => {
		if (attempt !== undefined && event.attempt !== attempt) return [];
		if (event.type === "tool-result")
			return [
				{
					actionId: event.actionId,
					iteration: event.iteration,
					decision: "tool",
					tool: event.tool,
					arguments: structuredClone(event.arguments),
					toolStatus: event.status,
					observationSummary: event.observationSummary,
					facts: structuredClone(event.facts),
				},
			];
		if (event.type !== "attempt-ended" || event.decision === null) return [];
		return [
			{
				iteration: event.iteration ?? event.iterations,
				decision: event.decision,
				tool: null,
				arguments: null,
				toolStatus: null,
				observationSummary: null,
				facts: null,
			},
		];
	});
}
