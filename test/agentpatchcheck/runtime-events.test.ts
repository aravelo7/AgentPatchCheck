import { describe, expect, it } from "vitest";

import { deriveHarnessNativeContextViews } from "../../src/agentpatchcheck/context-view";
import { deriveHarnessNativeContinuationContext } from "../../src/agentpatchcheck/continuation-context";
import {
	detectHarnessNativeStuckPattern,
	HarnessNativeRuntimeEventSpine,
} from "../../src/agentpatchcheck/runtime-events";
import type {
	HarnessNativeActivePlanStep,
	HarnessNativeAttemptReview,
	HarnessNativePlanExecutionEvent,
	HarnessNativePlanRevision,
} from "../../src/agentpatchcheck/types";

const revision: HarnessNativePlanRevision = {
	version: 1,
	revision: 1,
	iteration: 1,
	trigger: "initial-observation",
	plan: {
		version: 1,
		objective: "Implement the observed repair",
		steps: [{ step: "Modify the implementation", kind: "implementation", status: "in_progress" }],
	},
};

const activeStep: HarnessNativeActivePlanStep = {
	version: 1,
	executionId: 1,
	revision: 1,
	stepIndex: 0,
	objective: revision.plan.objective,
	step: revision.plan.steps[0]?.step ?? "",
	attempts: 1,
	lastOutcome: "progress",
	executionCheckpoint: "verification-due",
};

const executionEvent: HarnessNativePlanExecutionEvent = {
	version: 1,
	executionId: 1,
	actionId: "attempt-1:iteration-2:action-1",
	revision: 1,
	stepIndex: 0,
	iteration: 2,
	tool: "apply-edit",
	toolStatus: "ok",
	outcome: "progress",
};

const review: HarnessNativeAttemptReview = {
	version: 1,
	attempt: 1,
	decision: "continue",
	reason: "iteration-limit-with-progress",
	successfulMutationCount: 1,
	affectedPaths: ["implementation.ts"],
	latestVerificationOutcome: null,
	executionCheckpoint: "verification-due",
	remainingAttempts: 1,
	remainingTimeMs: 30_000,
};

function eventSpine(): HarnessNativeRuntimeEventSpine {
	const spine = new HarnessNativeRuntimeEventSpine();
	spine.append({
		version: 1,
		attempt: 1,
		iteration: null,
		type: "attempt-started",
		phase: "initial",
		continuationFromAttempt: null,
	});
	spine.append({
		version: 1,
		attempt: 1,
		iteration: 1,
		type: "tool-dispatched",
		actionId: "attempt-1:iteration-1:action-1",
		tool: "read-file",
		arguments: { path: "implementation.ts" },
	});
	spine.append({
		version: 1,
		attempt: 1,
		iteration: 1,
		type: "tool-result",
		actionId: "attempt-1:iteration-1:action-1",
		tool: "read-file",
		arguments: { path: "implementation.ts" },
		status: "ok",
		observation: "implementation content",
		observationSummary: "Read a regular workspace file.",
		facts: {
			kind: "retrieval",
			tool: "read-file",
			path: "implementation.ts",
			query: null,
			inspectedPaths: ["implementation.ts"],
			candidatePaths: [],
			search: null,
		},
	});
	spine.append({ version: 1, attempt: 1, iteration: 1, type: "plan-revised", revision });
	spine.append({
		version: 1,
		attempt: 1,
		iteration: 1,
		type: "plan-execution-updated",
		actionId: null,
		activeStep: { ...activeStep, attempts: 0, lastOutcome: null, executionCheckpoint: null },
		executionEvent: null,
	});
	spine.append({
		version: 1,
		attempt: 1,
		iteration: 2,
		type: "tool-dispatched",
		actionId: executionEvent.actionId ?? "",
		tool: "apply-edit",
		arguments: { path: "implementation.ts" },
	});
	spine.append({
		version: 1,
		attempt: 1,
		iteration: 2,
		type: "tool-result",
		actionId: executionEvent.actionId ?? "",
		tool: "apply-edit",
		arguments: { path: "implementation.ts" },
		status: "ok",
		observation: "Applied one structured edit.",
		observationSummary: "Applied one constrained exact-text replacement.",
		facts: { kind: "mutation", tool: "apply-edit", affectedPaths: ["implementation.ts"] },
	});
	spine.append({
		version: 1,
		attempt: 1,
		iteration: 2,
		type: "plan-execution-updated",
		actionId: executionEvent.actionId,
		activeStep,
		executionEvent,
	});
	spine.append({
		version: 1,
		attempt: 1,
		iteration: 2,
		type: "attempt-ended",
		decision: null,
		status: "failed",
		terminationReason: "iteration-limit",
		iterations: 2,
		toolCalls: 2,
		rejectedToolCalls: 0,
		transportRetries: 0,
	});
	spine.append({ version: 1, attempt: 1, iteration: null, type: "attempt-reviewed", review });
	spine.append({
		version: 1,
		attempt: 2,
		iteration: null,
		type: "attempt-started",
		phase: "attempt-continuation",
		continuationFromAttempt: 1,
	});
	return spine;
}

function patternSpine(
	pattern: ReadonlyArray<{ path: string; status: "ok" | "error"; observation: string }>,
): HarnessNativeRuntimeEventSpine {
	const spine = new HarnessNativeRuntimeEventSpine();
	spine.append({
		version: 1,
		attempt: 1,
		iteration: null,
		type: "attempt-started",
		phase: "initial",
		continuationFromAttempt: null,
	});
	for (const [index, item] of pattern.entries()) {
		const iteration = index + 1;
		const actionId = `pattern-${iteration}`;
		spine.append({
			version: 1,
			attempt: 1,
			iteration,
			type: "tool-dispatched",
			actionId,
			tool: "read-file",
			arguments: { path: item.path },
		});
		spine.append({
			version: 1,
			attempt: 1,
			iteration,
			type: "tool-result",
			actionId,
			tool: "read-file",
			arguments: { path: item.path },
			status: item.status,
			observation: item.observation,
			observationSummary: item.observation,
			facts: { kind: "other" },
		});
	}
	return spine;
}

describe("Harness-native Runtime Event Spine", () => {
	it("keeps event order and action correlation stable", () => {
		const events = eventSpine().snapshot();
		expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
		expect(events[6]).toMatchObject({ type: "tool-result", actionId: executionEvent.actionId });
		expect(events[7]).toMatchObject({
			type: "plan-execution-updated",
			actionId: executionEvent.actionId,
			executionEvent: { actionId: executionEvent.actionId },
		});
	});

	it("deterministically derives read-only Planner, Executor, and continuation views", () => {
		const events = eventSpine().snapshot();
		const before = structuredClone(events);
		const firstAttempt = deriveHarnessNativeContextViews(events, 1);
		const first = deriveHarnessNativeContextViews(events, 2);
		const second = deriveHarnessNativeContextViews(events, 2);

		expect(first).toEqual(second);
		expect(events).toEqual(before);
		expect(firstAttempt.executor.interactions?.[0]).toMatchObject({
			actionId: "attempt-1:iteration-1:action-1",
			tool: "read-file",
			arguments: { path: "implementation.ts" },
			status: "ok",
			observation: "implementation content",
			facts: { kind: "retrieval" },
		});
		expect(first.executor.observations).toEqual([]);
		expect(first.executor.workingContext).toMatchObject({
			phase: "mutation-applied",
			inspectedPaths: ["implementation.ts"],
			mutation: { successfulActions: 1, paths: ["implementation.ts"], firstIteration: 2 },
		});
		expect(first.continuation).toMatchObject({
			version: 2,
			previousAttempt: 1,
			terminationReason: "iteration-limit",
			review: { decision: "continue" },
			plan: { objective: revision.plan.objective },
			activePlanStep: { executionCheckpoint: "verification-due" },
			unresolvedWork: {
				step: "Modify the implementation",
				previousExecutionId: 1,
				executionCheckpoint: "verification-due",
			},
			evidence: [
				{ sequence: 3, kind: "repository", observation: "implementation content" },
				{ sequence: 7, kind: "mutation", observation: "Applied one structured edit." },
			],
		});
		expect(first.continuation?.sourceEventSequences).toEqual([1, 3, 4, 7, 8, 9, 10]);
		expect(first.continuation?.retention.renderedBytes).toBeLessThanOrEqual(
			first.continuation?.retention.maxBytes ?? 0,
		);
		expect(first.planner.previousPlan?.objective).toBe(revision.plan.objective);
		expect(first.executor.plan).toBeNull();
		expect(first.executor.activePlanStep).toBeNull();
	});

	it("rejects non-contiguous replay input", () => {
		const events = eventSpine().snapshot();
		const second = events[1];
		if (second === undefined) throw new Error("Expected a second Runtime event.");
		events[1] = { ...second, sequence: 7 };
		expect(() => new HarnessNativeRuntimeEventSpine(events)).toThrow("contiguous");
	});

	it("rejects ordinary execution events after attempt terminal", () => {
		const spine = eventSpine();
		expect(() =>
			spine.append({
				version: 1,
				attempt: 2,
				iteration: 1,
				type: "tool-dispatched",
				actionId: "late-action",
				tool: "read-file",
				arguments: { path: "late.ts" },
			}),
		).not.toThrow();
		spine.append({
			version: 1,
			attempt: 2,
			iteration: 1,
			type: "tool-result",
			actionId: "late-action",
			tool: "read-file",
			arguments: { path: "late.ts" },
			status: "ok",
			observation: "late",
			observationSummary: "late",
			facts: {
				kind: "retrieval",
				tool: "read-file",
				path: "late.ts",
				query: null,
				inspectedPaths: ["late.ts"],
				candidatePaths: [],
				search: null,
			},
		});
		spine.append({
			version: 1,
			attempt: 2,
			iteration: 1,
			type: "attempt-ended",
			decision: null,
			status: "failed",
			terminationReason: "iteration-limit",
			iterations: 1,
			toolCalls: 1,
			rejectedToolCalls: 0,
			transportRetries: 0,
		});
		expect(() =>
			spine.append({
				version: 1,
				attempt: 2,
				iteration: 2,
				type: "tool-dispatched",
				actionId: "too-late",
				tool: "read-file",
				arguments: { path: "too-late.ts" },
			}),
		).toThrow("Only attempt review may follow");
	});

	it("rejects an action result without a matching dispatch or with mismatched public arguments", () => {
		const spine = new HarnessNativeRuntimeEventSpine();
		spine.append({
			version: 1,
			attempt: 1,
			iteration: null,
			type: "attempt-started",
			phase: "initial",
			continuationFromAttempt: null,
		});
		expect(() =>
			spine.append({
				version: 1,
				attempt: 1,
				iteration: 1,
				type: "tool-result",
				actionId: "missing",
				tool: "read-file",
				arguments: { path: "missing.ts" },
				status: "error",
				observation: "missing",
				observationSummary: "missing",
				facts: { kind: "other" },
			}),
		).toThrow("earlier tool dispatch");
		spine.append({
			version: 1,
			attempt: 1,
			iteration: 1,
			type: "tool-dispatched",
			actionId: "mismatch",
			tool: "read-file",
			arguments: { path: "before.ts" },
		});
		expect(() =>
			spine.append({
				version: 1,
				attempt: 1,
				iteration: 1,
				type: "tool-result",
				actionId: "mismatch",
				tool: "read-file",
				arguments: { path: "after.ts" },
				status: "ok",
				observation: "after",
				observationSummary: "after",
				facts: { kind: "other" },
			}),
		).toThrow("match its tool dispatch");
		expect(() =>
			spine.append({
				version: 1,
				attempt: 1,
				iteration: 1,
				type: "attempt-ended",
				decision: null,
				status: "failed",
				terminationReason: "iteration-limit",
				iterations: 1,
				toolCalls: 0,
				rejectedToolCalls: 0,
				transportRetries: 0,
			}),
		).toThrow("unresolved tool dispatch");
	});

	it("detects explicit repeated and alternating completed action patterns", () => {
		const spine = new HarnessNativeRuntimeEventSpine();
		spine.append({
			version: 1,
			attempt: 1,
			iteration: null,
			type: "attempt-started",
			phase: "initial",
			continuationFromAttempt: null,
		});
		for (let iteration = 1; iteration <= 4; iteration += 1) {
			const actionId = `repeat-${iteration}`;
			spine.append({
				version: 1,
				attempt: 1,
				iteration,
				type: "tool-dispatched",
				actionId,
				tool: "read-file",
				arguments: { path: "same.ts" },
			});
			spine.append({
				version: 1,
				attempt: 1,
				iteration,
				type: "tool-result",
				actionId,
				tool: "read-file",
				arguments: { path: "same.ts" },
				status: "ok",
				observation: "same",
				observationSummary: "same",
				facts: { kind: "other" },
			});
		}
		expect(detectHarnessNativeStuckPattern(spine.snapshot(), 1)).toBe("repeated-action-observation");

		const errors = patternSpine(
			Array.from({ length: 4 }, (_, index) => ({
				path: "same.ts",
				status: "error" as const,
				observation: `error-${index + 1}`,
			})),
		);
		expect(detectHarnessNativeStuckPattern(errors.snapshot(), 1)).toBe("repeated-action-error");

		const alternating = patternSpine(
			Array.from({ length: 6 }, (_, index) => ({
				path: index % 2 === 0 ? "a.ts" : "b.ts",
				status: "ok" as const,
				observation: index % 2 === 0 ? "A" : "B",
			})),
		);
		expect(detectHarnessNativeStuckPattern(alternating.snapshot(), 1)).toBe("alternating-action-observation");
	});

	it("derives protocol correction and completion feedback only from the latest control event", () => {
		const spine = eventSpine();
		spine.append({
			version: 1,
			attempt: 2,
			iteration: 1,
			type: "protocol-recovery",
			owner: "executor",
			failure: {
				kind: "malformed-response",
				detail: "invalid-tool-arguments",
				code: null,
				httpStatus: null,
				requestId: null,
			},
			recovery: 1,
			maxRecoveries: 2,
			disposition: "retrying",
		});
		const protocolEvents = spine.snapshot();
		const protocolView = deriveHarnessNativeContextViews(protocolEvents, 2);
		expect(protocolView.executor.protocolRecovery).toMatchObject({
			owner: "executor",
			recovery: 1,
			correction: expect.stringContaining("JSON object"),
		});
		expect(protocolEvents).toEqual(spine.snapshot());

		spine.append({
			version: 1,
			attempt: 2,
			iteration: 1,
			type: "completion-evaluated",
			disposition: "continue",
			reason: "verification-due",
			feedback: "Verification remains due.",
			activeExecutionId: 1,
			planRevision: 1,
		});
		const completionView = deriveHarnessNativeContextViews(spine.snapshot(), 2);
		expect(completionView.executor.protocolRecovery).toBeNull();
		expect(completionView.executor.completionFeedback).toBe("Verification remains due.");
	});

	it("builds an exact byte-bounded Unicode-safe checkpoint without mutating canonical events", () => {
		const events = eventSpine().snapshot();
		const retrieval = events[2];
		const mutation = events[6];
		if (retrieval?.type !== "tool-result" || mutation?.type !== "tool-result")
			throw new Error("Expected fixture tool events.");
		retrieval.observation = `implementation-${"界".repeat(500)}`;
		mutation.observation = `mutation-${"修".repeat(500)}`;
		const before = structuredClone(events);

		const first = deriveHarnessNativeContinuationContext(events, 2, 4_096);
		const second = deriveHarnessNativeContinuationContext(events, 2, 4_096);

		expect(first).toEqual(second);
		expect(events).toEqual(before);
		expect(first?.retention.renderedBytes).toBeLessThanOrEqual(4_096);
		expect(first?.retention.truncatedEvidenceCount).toBe(2);
		expect(first?.retention.omittedObservationBytes).toBeGreaterThan(0);
		expect(first?.evidence.every((entry) => entry.observation.includes("omitted"))).toBe(true);
		expect(first?.evidence.every((entry) => !entry.observation.includes("�"))).toBe(true);
	});
});
