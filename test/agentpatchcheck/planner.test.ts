import { describe, expect, it } from "vitest";

import { DEFAULT_MAX_PLAN_REVISIONS, HarnessNativePlanner } from "../../src/agentpatchcheck/planner";
import type { HarnessNativeExecutionPlan, HarnessNativeWorkingContext } from "../../src/agentpatchcheck/types";

const workingContext: HarnessNativeWorkingContext = {
	version: 1,
	phase: "discovery",
	inspectedPaths: ["src/target.ts"],
	candidatePaths: [],
	retrieval: { successfulActions: 1, rejectedActions: 0, recent: [] },
	mutation: { successfulActions: 0, paths: [], firstIteration: null },
	publicVerification: { runs: 0, latestStatus: null, latestIteration: null },
};

function plan(objective: string): HarnessNativeExecutionPlan {
	return {
		version: 1,
		objective,
		steps: [
			{ step: "Inspect implementation evidence", kind: "diagnosis", status: "completed" },
			{ step: "Implement task repair", kind: "implementation", status: "in_progress" },
			{ step: "Verify repaired behavior", kind: "verification", status: "pending" },
		],
	};
}

describe("HarnessNativePlanner", () => {
	it("maintains bounded model-owned revisions without inferring Runtime facts", async () => {
		const contexts: Array<{ trigger: string; previousObjective: string | null }> = [];
		const planner = new HarnessNativePlanner({
			plan: async (context) => {
				contexts.push({ trigger: context.trigger, previousObjective: context.previousPlan?.objective ?? null });
				return { plan: plan(`Objective ${contexts.length}`) };
			},
		});

		expect(
			planner.triggerFor(
				{
					kind: "retrieval",
					tool: "read-file",
					path: "src/target.ts",
					query: null,
					inspectedPaths: ["src/target.ts"],
					candidatePaths: [],
					search: null,
				},
				"ok",
			),
		).toBe("initial-observation");

		await planner.update({
			prompt: "Repair target.",
			model: "test-model",
			iteration: 1,
			trigger: "initial-observation",
			observations: ["target source"],
			workingContext,
		});
		await planner.update({
			prompt: "Repair target.",
			model: "test-model",
			iteration: 2,
			trigger: "mutation-applied",
			observations: ["patch applied"],
			workingContext,
		});

		expect(contexts).toEqual([
			{ trigger: "initial-observation", previousObjective: null },
			{ trigger: "mutation-applied", previousObjective: "Objective 1" },
		]);
		expect(planner.snapshot()).toMatchObject({
			enabled: true,
			maxRevisions: DEFAULT_MAX_PLAN_REVISIONS,
			currentPlan: { objective: "Objective 2" },
			revisions: [
				{ revision: 1, iteration: 1, trigger: "initial-observation" },
				{ revision: 2, iteration: 2, trigger: "mutation-applied" },
			],
		});
	});

	it("keeps failed verification as execution feedback while implementation remains active", async () => {
		let providerCalls = 0;
		const planner = new HarnessNativePlanner({
			plan: async () => {
				providerCalls += 1;
				return { plan: plan("Implement task repair") };
			},
		});

		await planner.update({
			prompt: "Repair target.",
			model: "test-model",
			iteration: 1,
			trigger: "initial-observation",
			observations: ["target source"],
			workingContext,
		});
		expect(
			planner.triggerFor(
				{
					kind: "verification",
					tool: "run-public-verification",
					commandIndex: 0,
					outcome: "failed",
					exitCode: 1,
					timedOut: false,
					durationMs: 10,
				},
				"ok",
			),
		).toBeNull();
		expect(providerCalls).toBe(1);
		expect(planner.currentPlan).toEqual(plan("Implement task repair"));
	});

	it("requests replanning when failed verification blocks the verification step", async () => {
		const planner = new HarnessNativePlanner({
			plan: async () => ({
				plan: {
					version: 1,
					objective: "Verify repaired behavior",
					steps: [{ step: "Verify repaired behavior", kind: "verification", status: "in_progress" }],
				},
			}),
		});
		await planner.update({
			prompt: "Repair target.",
			model: "test-model",
			iteration: 1,
			trigger: "initial-observation",
			observations: ["implementation changed"],
			workingContext,
		});

		expect(
			planner.triggerFor(
				{
					kind: "verification",
					tool: "run-public-verification",
					commandIndex: 0,
					outcome: "failed",
					exitCode: 1,
					timedOut: false,
					durationMs: 10,
				},
				"ok",
			),
		).toBe("verification-feedback");
	});

	it("allows a failed verification step to advance into implementation repair", async () => {
		let revision = 0;
		const planner = new HarnessNativePlanner({
			plan: async () => {
				revision += 1;
				return revision === 1
					? {
							plan: {
								version: 1,
								objective: "Verify repaired behavior",
								steps: [
									{ step: "Implement task repair", kind: "implementation", status: "completed" },
									{ step: "Verify repaired behavior", kind: "verification", status: "in_progress" },
								],
							},
						}
					: {
							plan: {
								version: 1,
								objective: "Repair failed implementation behavior",
								steps: [
									{
										step: "Repair failed implementation behavior",
										kind: "implementation",
										status: "in_progress",
									},
									{ step: "Rerun verification", kind: "verification", status: "pending" },
								],
							},
						};
			},
		});

		await planner.update({
			prompt: "Repair target.",
			model: "test-model",
			iteration: 1,
			trigger: "initial-observation",
			observations: ["implementation changed"],
			workingContext,
		});
		const update = await planner.update({
			prompt: "Repair target.",
			model: "test-model",
			iteration: 2,
			trigger: "verification-feedback",
			observations: ["acceptance behavior failed"],
			workingContext,
		});

		expect(update?.plan).toMatchObject({
			objective: "Repair failed implementation behavior",
			steps: [
				{ kind: "implementation", status: "in_progress" },
				{ kind: "verification", status: "pending" },
			],
		});
	});
});
