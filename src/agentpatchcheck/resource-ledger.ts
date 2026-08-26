import type {
	HarnessNativeProviderResourceUsage,
	HarnessNativeResourceLedger,
	HarnessNativeRuntimeEvent,
} from "./types";

function emptyProviderUsage(): HarnessNativeProviderResourceUsage {
	return {
		calls: 0,
		completedCalls: 0,
		failedCalls: 0,
		interruptedCalls: 0,
		unknownUsageCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		transportRetries: 0,
		transportRetriesUnknownCalls: 0,
	};
}

function addProviderUsage(
	target: HarnessNativeProviderResourceUsage,
	input: Omit<HarnessNativeProviderResourceUsage, "calls"> & { calls?: number },
): void {
	target.calls += input.calls ?? 0;
	target.completedCalls += input.completedCalls;
	target.failedCalls += input.failedCalls;
	target.interruptedCalls += input.interruptedCalls;
	target.unknownUsageCalls += input.unknownUsageCalls;
	target.inputTokens += input.inputTokens;
	target.outputTokens += input.outputTokens;
	target.transportRetries += input.transportRetries;
	target.transportRetriesUnknownCalls += input.transportRetriesUnknownCalls;
}

/**
 * Folds one immutable task event prefix into resource consumption. Provider
 * values that were not reported remain explicitly unknown and are never
 * materialized as zero usage.
 */
export function deriveHarnessNativeResourceLedger(
	events: readonly HarnessNativeRuntimeEvent[],
): HarnessNativeResourceLedger {
	const executor = emptyProviderUsage();
	const planner = emptyProviderUsage();
	const startedCalls = new Map<string, "executor" | "planner">();
	const completedCalls = new Set<string>();
	const executorIterations = new Set<string>();
	const attemptStarts = new Map<number, number>();
	const attemptEnds = new Map<number, number>();
	let toolCalls = 0;
	let budgetedToolCalls = 0;
	let rejectedToolCalls = 0;
	let budgetedRejectedToolCalls = 0;
	let planRevisions = 0;
	let protocolRecoveries = 0;
	let completionDeferrals = 0;
	let hasCorrelatedModelCalls = false;

	for (const event of events) {
		if (event.type === "attempt-started" && event.recordedAtMs !== undefined)
			attemptStarts.set(event.attempt, event.recordedAtMs);
		if (event.type === "attempt-ended" && event.recordedAtMs !== undefined)
			attemptEnds.set(event.attempt, event.recordedAtMs);
		if (event.type === "tool-result") {
			if (event.status === "rejected") {
				rejectedToolCalls += 1;
				if (event.countsTowardToolBudget !== false) budgetedRejectedToolCalls += 1;
			} else {
				toolCalls += 1;
				if (event.countsTowardToolBudget !== false) budgetedToolCalls += 1;
			}
		}
		if (event.type === "plan-revised") planRevisions += 1;
		if (event.type === "protocol-recovery" && event.disposition === "retrying") protocolRecoveries += 1;
		if (event.type === "completion-evaluated" && event.disposition === "continue") completionDeferrals += 1;
		if (event.type === "model-call-started") {
			hasCorrelatedModelCalls = true;
			startedCalls.set(event.callId, event.owner);
			const target = event.owner === "executor" ? executor : planner;
			target.calls += 1;
			if (event.owner === "executor") executorIterations.add(`${event.attempt}:${event.iteration}`);
		}
		if (event.type === "model-call-completed") {
			completedCalls.add(event.callId);
			const target = event.owner === "executor" ? executor : planner;
			target.completedCalls += 1;
			if (event.outcome === "failed") target.failedCalls += 1;
			if (event.outcome === "interrupted") target.interruptedCalls += 1;
			if (event.inputTokens === null || event.outputTokens === null) target.unknownUsageCalls += 1;
			if (event.inputTokens !== null) target.inputTokens += event.inputTokens;
			if (event.outputTokens !== null) target.outputTokens += event.outputTokens;
			if (event.transportRetries === null) target.transportRetriesUnknownCalls += 1;
			else target.transportRetries += event.transportRetries;
		}
	}

	for (const [callId, owner] of startedCalls) {
		if (completedCalls.has(callId)) continue;
		const target = owner === "executor" ? executor : planner;
		target.interruptedCalls += 1;
		target.unknownUsageCalls += 1;
		target.transportRetriesUnknownCalls += 1;
	}

	if (!hasCorrelatedModelCalls) {
		for (const event of events) {
			if (event.type !== "model-usage") continue;
			const target = event.owner === "executor" ? executor : planner;
			addProviderUsage(target, {
				calls: 1,
				completedCalls: 1,
				failedCalls: 0,
				interruptedCalls: 0,
				unknownUsageCalls: event.inputTokens === null || event.outputTokens === null ? 1 : 0,
				inputTokens: event.inputTokens ?? 0,
				outputTokens: event.outputTokens ?? 0,
				transportRetries: event.transportRetries,
				transportRetriesUnknownCalls: 0,
			});
			if (event.owner === "executor") executorIterations.add(`${event.attempt}:${event.iteration}`);
		}
	}

	let activeRuntimeMs = 0;
	const finalTimestamp = events.at(-1)?.recordedAtMs;
	for (const [attempt, start] of attemptStarts) {
		const end = attemptEnds.get(attempt) ?? finalTimestamp;
		if (end !== undefined) activeRuntimeMs += Math.max(0, end - start);
	}
	const total = emptyProviderUsage();
	addProviderUsage(total, executor);
	addProviderUsage(total, planner);
	return {
		version: 1,
		throughEventSequence: events.at(-1)?.sequence ?? 0,
		attempts: new Set(events.filter((event) => event.type === "attempt-started").map((event) => event.attempt)).size,
		executorIterations: executorIterations.size,
		toolCalls,
		budgetedToolCalls,
		rejectedToolCalls,
		budgetedRejectedToolCalls,
		planRevisions,
		protocolRecoveries,
		completionDeferrals,
		activeRuntimeMs,
		provider: { total, executor, planner },
	};
}
