import { describe, expect, it } from "vitest";

import { HarnessNativeCompletionController } from "../../src/agentpatchcheck/completion-controller";
import {
	createProtocolRecoveryFeedback,
	isRecoverableProtocolFailure,
} from "../../src/agentpatchcheck/protocol-recovery";
import type {
	HarnessNativePlanExecutionResult,
	HarnessNativePlanningResult,
	HarnessNativeProviderFailure,
} from "../../src/agentpatchcheck/types";

function planning(status: "pending" | "in_progress" | "completed"): HarnessNativePlanningResult {
	return {
		version: 1,
		enabled: true,
		maxRevisions: 4,
		revisions: [],
		currentPlan: {
			version: 1,
			objective: "Repair implementation",
			steps: [{ step: "Repair implementation", kind: "implementation", status }],
		},
	};
}

function execution(checkpoint: "verification-due" | "repair-due" | null): HarnessNativePlanExecutionResult {
	return {
		version: 1,
		activeStep: {
			version: 1,
			executionId: 7,
			revision: 2,
			stepIndex: 0,
			objective: "Repair implementation",
			step: "Repair implementation",
			attempts: 1,
			lastOutcome: "progress",
			executionCheckpoint: checkpoint,
		},
		events: [],
	};
}

describe("Harness-native Runtime control", () => {
	it("gives execution checkpoints priority over generic plan incompleteness", () => {
		const verification = new HarnessNativeCompletionController().evaluate({
			planning: planning("in_progress"),
			planExecution: execution("verification-due"),
		});
		const repair = new HarnessNativeCompletionController().evaluate({
			planning: planning("in_progress"),
			planExecution: execution("repair-due"),
		});
		expect(verification).toMatchObject({ disposition: "continue", reason: "verification-due" });
		expect(repair).toMatchObject({ disposition: "continue", reason: "repair-due" });
	});

	it("accepts a completed lifecycle and bounds consecutive premature finish requests", () => {
		const completed = new HarnessNativeCompletionController().evaluate({
			planning: planning("completed"),
			planExecution: { version: 1, activeStep: null, events: [] },
		});
		expect(completed).toEqual({ disposition: "accept", reason: "complete", feedback: null });

		const controller = new HarnessNativeCompletionController(1);
		const input = { planning: planning("in_progress"), planExecution: execution(null) };
		expect(controller.evaluate(input).disposition).toBe("continue");
		controller.recordExecution();
		expect(controller.evaluate(input).disposition).toBe("continue");
		expect(controller.evaluate(input)).toMatchObject({ disposition: "terminal", reason: "deferral-limit" });
	});

	it("recovers only normalized protocol failures and emits value-free correction metadata", () => {
		const malformed: HarnessNativeProviderFailure = {
			kind: "malformed-response",
			detail: "invalid-tool-arguments",
			code: null,
			httpStatus: null,
			requestId: null,
			validationIssue: {
				path: "$.plan[1].status",
				issue: "invalid-enum",
				receivedType: "string",
				constraint: "plan-step-status",
			},
		};
		const unavailable: HarnessNativeProviderFailure = {
			kind: "provider-unavailable",
			detail: null,
			code: null,
			httpStatus: 503,
			requestId: null,
		};
		expect(isRecoverableProtocolFailure(malformed)).toBe(true);
		expect(isRecoverableProtocolFailure(unavailable)).toBe(false);
		const feedback = createProtocolRecoveryFeedback("planner", malformed, 1, 2);
		expect(feedback).toMatchObject({ owner: "planner", recovery: 1, maxRecoveries: 2 });
		expect(feedback.correction).toContain("$.plan[1].status");
		expect(JSON.stringify(feedback)).not.toContain("private plan text");
	});
});
