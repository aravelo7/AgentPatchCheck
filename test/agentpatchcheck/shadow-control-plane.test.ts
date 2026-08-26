import { describe, expect, it } from "vitest";

import { HarnessNativeRuntimeEventSpine } from "../../src/agentpatchcheck/runtime-events";
import {
	deriveHarnessNativeShadowControlPlane,
	HarnessNativeShadowControlPlaneReducer,
	replayHarnessNativeRuntimeMechanicalState,
} from "../../src/agentpatchcheck/shadow-control-plane";
import type { HarnessNativeToolResultFacts, HarnessNativeTrajectoryStep } from "../../src/agentpatchcheck/types";

function toolStep(
	iteration: number,
	tool: NonNullable<HarnessNativeTrajectoryStep["tool"]>,
	argumentsValue: NonNullable<HarnessNativeTrajectoryStep["arguments"]>,
	options: {
		status?: NonNullable<HarnessNativeTrajectoryStep["toolStatus"]>;
		observationSummary?: string;
		facts?: HarnessNativeToolResultFacts;
	} = {},
): HarnessNativeTrajectoryStep {
	const path = typeof argumentsValue.path === "string" ? argumentsValue.path.replaceAll("\\", "/") : null;
	const defaultFacts: HarnessNativeToolResultFacts =
		tool === "read-file" ||
		tool === "list-directory" ||
		tool === "search-text" ||
		tool === "search-text-recursive" ||
		tool === "git-status" ||
		tool === "git-diff"
			? {
					kind: "retrieval",
					tool,
					path,
					query: typeof argumentsValue.query === "string" ? argumentsValue.query : null,
					inspectedPaths: tool === "read-file" && path !== null ? [path] : [],
					candidatePaths: [],
					search: null,
				}
			: tool === "apply-edit" ||
					tool === "apply-patch" ||
					tool === "apply-patch-batch" ||
					tool === "apply-edit-batch" ||
					tool === "create-file"
				? { kind: "mutation", tool, affectedPaths: path === null ? [] : [path] }
				: { kind: "other" };
	return {
		iteration,
		decision: "tool",
		tool,
		arguments: argumentsValue,
		toolStatus: options.status ?? "ok",
		observationSummary: options.observationSummary ?? `Completed ${tool}.`,
		facts: options.facts ?? defaultFacts,
	};
}

describe("Shadow Control Plane", () => {
	it("rebuilds deterministic state evolution from a Runtime trajectory", () => {
		const trajectory: HarnessNativeTrajectoryStep[] = [
			toolStep(1, "read-file", { path: "src\\target.ts" }),
			toolStep(2, "read-file", { path: "src\\target.ts" }),
			toolStep(3, "read-file", { path: "src\\target.ts" }),
			toolStep(4, "search-text", { path: "src", query: "needle" }),
			toolStep(
				5,
				"apply-patch",
				{},
				{
					facts: { kind: "mutation", tool: "apply-patch", affectedPaths: ["src/target.ts"] },
				},
			),
			toolStep(
				6,
				"run-public-verification",
				{ index: 0 },
				{
					observationSummary: "Ran TaskSpec-declared public verification command 0: failed.",
					facts: {
						kind: "verification",
						tool: "run-public-verification",
						commandIndex: 0,
						outcome: "failed",
						exitCode: 1,
						timedOut: false,
						durationMs: 12,
					},
				},
			),
			{
				iteration: 7,
				decision: "finish",
				tool: null,
				arguments: null,
				toolStatus: null,
				observationSummary: null,
				facts: null,
			},
		];

		const first = deriveHarnessNativeShadowControlPlane(trajectory);
		const replay = deriveHarnessNativeShadowControlPlane(trajectory);
		const incrementalReducer = new HarnessNativeShadowControlPlaneReducer();
		for (const step of trajectory) incrementalReducer.reduce(step);

		expect(replay).toEqual(first);
		expect(incrementalReducer.diagnostic()).toEqual(first);
		expect(first.evolution).toHaveLength(trajectory.length);
		expect(first.evolution[2]?.state.interpretation.progress).toMatchObject({
			stallDetected: true,
			stallReason: "repeated-retrieval",
			stallSinceIteration: 3,
		});
		expect(first.finalState).toMatchObject({
			trajectoryStepCount: 7,
			lastIteration: 7,
			retrieval: {
				totalActions: 4,
				successfulActions: 4,
				uniqueActions: 2,
				repeatedActions: 2,
			},
			mutation: {
				totalActions: 1,
				successfulActions: 1,
				firstIteration: 5,
				affectedPaths: ["src/target.ts"],
			},
			verification: { runs: 1, latestStatus: "failed", latestIteration: 6 },
			visitedPaths: ["src/target.ts", "src"],
		});
	});

	it("uses structured facts instead of tool names or observation text", () => {
		const diagnostic = deriveHarnessNativeShadowControlPlane([
			{
				...toolStep(1, "read-file", { path: "README.md" }),
				observationSummary: "Public verification command 0 failed.",
				facts: {
					kind: "verification",
					tool: "run-public-verification",
					commandIndex: 0,
					outcome: "passed",
					exitCode: 0,
					timedOut: false,
					durationMs: 4,
				},
			},
		]);

		expect(diagnostic.finalState.retrieval.totalActions).toBe(0);
		expect(diagnostic.finalState.verification).toEqual({
			runs: 1,
			latestStatus: "passed",
			latestIteration: 1,
		});
	});

	it("emits an explicitly disabled empty diagnostic without reducing the trajectory", () => {
		const diagnostic = deriveHarnessNativeShadowControlPlane(
			[toolStep(1, "read-file", { path: "README.md" })],
			false,
		);

		expect(diagnostic.enabled).toBe(false);
		expect(diagnostic.evolution).toEqual([]);
		expect(diagnostic.finalState).toMatchObject({ trajectoryStepCount: 0, visitedPaths: [] });
	});

	it("replays WorkingContext, lifecycle, action ownership, checkpoints, and resources from canonical events", () => {
		const spine = new HarnessNativeRuntimeEventSpine();
		spine.append({
			version: 1,
			recordedAtMs: 10,
			attempt: 1,
			iteration: null,
			type: "attempt-started",
			phase: "initial",
			continuationFromAttempt: null,
		});
		spine.append({
			version: 1,
			recordedAtMs: 11,
			attempt: 1,
			iteration: 1,
			type: "tool-dispatched",
			actionId: "a1",
			tool: "read-file",
			arguments: { path: "src/target.ts" },
		});
		spine.append({
			version: 1,
			recordedAtMs: 12,
			attempt: 1,
			iteration: 1,
			type: "tool-result",
			actionId: "a1",
			tool: "read-file",
			arguments: { path: "src/target.ts" },
			status: "ok",
			observation: "file",
			observationSummary: "read",
			facts: {
				kind: "retrieval",
				tool: "read-file",
				path: "src/target.ts",
				query: null,
				inspectedPaths: ["src/target.ts"],
				candidatePaths: [],
				search: null,
			},
		});
		spine.append({
			version: 1,
			recordedAtMs: 13,
			attempt: 1,
			iteration: 2,
			type: "tool-dispatched",
			actionId: "a2",
			tool: "apply-edit",
			arguments: { path: "src/failed.ts" },
		});
		spine.append({
			version: 1,
			recordedAtMs: 14,
			attempt: 1,
			iteration: 2,
			type: "tool-result",
			actionId: "a2",
			tool: "apply-edit",
			arguments: { path: "src/failed.ts" },
			status: "error",
			observation: "failed",
			observationSummary: "edit failed",
			facts: { kind: "mutation", tool: "apply-edit", affectedPaths: ["src/failed.ts"] },
		});
		spine.append({
			version: 1,
			recordedAtMs: 15,
			attempt: 1,
			iteration: 3,
			type: "tool-dispatched",
			actionId: "a3",
			tool: "apply-edit",
			arguments: { path: "src/target.ts" },
		});
		spine.append({
			version: 1,
			recordedAtMs: 16,
			attempt: 1,
			iteration: 3,
			type: "tool-result",
			actionId: "a3",
			tool: "apply-edit",
			arguments: { path: "src/target.ts" },
			status: "ok",
			observation: "edited",
			observationSummary: "edit applied",
			facts: { kind: "mutation", tool: "apply-edit", affectedPaths: ["src/target.ts"] },
		});
		spine.append({
			version: 1,
			recordedAtMs: 17,
			attempt: 1,
			iteration: 3,
			type: "worktree-checkpoint",
			actionId: "a3",
			worktreeSha256: "abc123",
		});
		spine.append({
			version: 1,
			recordedAtMs: 18,
			attempt: 1,
			iteration: 4,
			type: "tool-dispatched",
			actionId: "a4",
			tool: "run-public-verification",
			arguments: { index: 0 },
		});
		spine.append({
			version: 1,
			recordedAtMs: 19,
			attempt: 1,
			iteration: 4,
			type: "tool-result",
			actionId: "a4",
			tool: "run-public-verification",
			arguments: { index: 0 },
			status: "ok",
			observation: "failed",
			observationSummary: "verification failed",
			facts: {
				kind: "verification",
				tool: "run-public-verification",
				commandIndex: 0,
				outcome: "failed",
				exitCode: 1,
				timedOut: false,
				durationMs: 5,
			},
		});
		spine.append({
			version: 1,
			recordedAtMs: 20,
			attempt: 1,
			iteration: 4,
			type: "attempt-ended",
			decision: "fail",
			status: "failed",
			terminationReason: "iteration-limit",
			providerFailure: null,
			iterations: 4,
			toolCalls: 4,
			rejectedToolCalls: 0,
			transportRetries: 0,
		});

		const events = spine.snapshot();
		const first = replayHarnessNativeRuntimeMechanicalState(events);
		const replay = replayHarnessNativeRuntimeMechanicalState(events);

		expect(replay).toEqual(first);
		expect(spine.snapshot()).toEqual(events);
		expect(first.throughEventSequence).toBe(11);
		expect(first.lifecycle).toEqual({
			attempt: 1,
			phase: "failed",
			terminal: { status: "failed", terminationReason: "iteration-limit", providerFailure: null },
		});
		expect(first.actions).toHaveLength(4);
		expect(first.actions[1]?.facts).toEqual({
			kind: "mutation",
			tool: "apply-edit",
			affectedPaths: ["src/failed.ts"],
		});
		expect(first.checkpoints).toEqual([{ actionId: "a3", worktreeSha256: "abc123" }]);
		expect(first.resources).toMatchObject({ toolCalls: 4, rejectedToolCalls: 0 });
		expect(first.workingContext).toMatchObject({
			phase: "failed",
			inspectedPaths: ["src/target.ts"],
			mutation: { successfulActions: 1, paths: ["src/target.ts"], firstIteration: 3 },
			publicVerification: { runs: 1, latestStatus: "failed", latestIteration: 4 },
		});
		expect(first.shadowControlPlane.finalState.mutation).toMatchObject({
			totalActions: 2,
			successfulActions: 1,
			errorActions: 1,
			affectedPaths: ["src/target.ts"],
		});
	});
});
