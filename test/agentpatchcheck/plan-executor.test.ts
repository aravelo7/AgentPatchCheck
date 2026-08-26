import { describe, expect, it } from "vitest";

import { HarnessNativePlanExecutor } from "../../src/agentpatchcheck/plan-executor";
import type { HarnessNativePlanRevision, HarnessNativePlanStepKind } from "../../src/agentpatchcheck/types";

function revision(
	revisionNumber: number,
	step = "Implement the repair",
	kind: HarnessNativePlanStepKind = "implementation",
): HarnessNativePlanRevision {
	return {
		version: 1,
		revision: revisionNumber,
		iteration: revisionNumber,
		trigger: revisionNumber === 1 ? "initial-observation" : "execution-stalled",
		plan: {
			version: 1,
			objective: "Repair the implementation",
			steps: [{ step, kind, status: "in_progress" }],
		},
	};
}

describe("HarnessNativePlanExecutor", () => {
	it("binds the active plan step and records canonical mutation progress", () => {
		const executor = new HarnessNativePlanExecutor();
		executor.synchronize(revision(1));

		expect(
			executor.record({
				iteration: 2,
				tool: "apply-edit",
				arguments: { path: "src/target.ts" },
				status: "ok",
				facts: { kind: "mutation", tool: "apply-edit", affectedPaths: ["src/target.ts"] },
			}),
		).toBeNull();
		expect(executor.snapshot()).toMatchObject({
			activeStep: {
				executionId: 1,
				revision: 1,
				stepIndex: 0,
				attempts: 1,
				lastOutcome: "progress",
				executionCheckpoint: "verification-due",
			},
			events: [{ executionId: 1, revision: 1, iteration: 2, tool: "apply-edit", outcome: "progress" }],
		});
	});

	it("does not attribute an old step mutation to a new active step", () => {
		const executor = new HarnessNativePlanExecutor();
		executor.synchronize(revision(1, "Implement the first repair"));
		executor.record({
			iteration: 2,
			tool: "apply-edit",
			arguments: { path: "target.ts" },
			status: "ok",
			facts: { kind: "mutation", tool: "apply-edit", affectedPaths: ["target.ts"] },
		});
		expect(executor.activeStep).toMatchObject({ executionId: 1, executionCheckpoint: "verification-due" });

		executor.synchronize(revision(2, "Implement the second repair"));

		expect(executor.activeStep).toMatchObject({
			executionId: 2,
			revision: 2,
			attempts: 0,
			lastOutcome: null,
			executionCheckpoint: null,
		});
	});

	it("preserves lifecycle only for an unchanged active execution step", () => {
		const executor = new HarnessNativePlanExecutor();
		executor.synchronize(revision(1));
		executor.record({
			iteration: 2,
			tool: "apply-edit",
			arguments: { path: "target.ts" },
			status: "ok",
			facts: { kind: "mutation", tool: "apply-edit", affectedPaths: ["target.ts"] },
		});

		executor.synchronize(revision(2));

		expect(executor.activeStep).toMatchObject({
			executionId: 1,
			revision: 2,
			attempts: 0,
			lastOutcome: null,
			executionCheckpoint: "verification-due",
		});
	});

	it("keeps verification and repair facts bound to their execution owner", () => {
		const executor = new HarnessNativePlanExecutor();
		executor.synchronize(revision(1));
		executor.record({
			iteration: 2,
			tool: "apply-edit",
			arguments: { path: "target.ts" },
			status: "ok",
			facts: { kind: "mutation", tool: "apply-edit", affectedPaths: ["target.ts"] },
		});
		executor.record({
			iteration: 3,
			tool: "run-public-verification",
			arguments: { index: 0 },
			status: "ok",
			facts: {
				kind: "verification",
				tool: "run-public-verification",
				commandIndex: 0,
				outcome: "failed",
				exitCode: 1,
				timedOut: false,
				durationMs: 10,
			},
		});
		expect(executor.activeStep).toMatchObject({ executionId: 1, executionCheckpoint: "repair-due" });

		executor.synchronize(revision(2));
		expect(executor.activeStep).toMatchObject({ executionId: 1, executionCheckpoint: "repair-due" });
		executor.synchronize(revision(3, "Implement a revised repair"));
		expect(executor.activeStep).toMatchObject({ executionId: 2, executionCheckpoint: null });
		expect(executor.snapshot().events).toMatchObject([
			{ executionId: 1, iteration: 2, tool: "apply-edit" },
			{ executionId: 1, iteration: 3, tool: "run-public-verification" },
		]);
	});

	it("carries post-mutation verification and repair checkpoints across evidence actions", () => {
		const executor = new HarnessNativePlanExecutor();
		executor.synchronize(revision(1));
		executor.record({
			iteration: 2,
			tool: "apply-edit",
			arguments: { path: "src/target.ts" },
			status: "ok",
			facts: { kind: "mutation", tool: "apply-edit", affectedPaths: ["src/target.ts"] },
		});
		expect(executor.activeStep).toMatchObject({ executionCheckpoint: "verification-due" });

		executor.record({
			iteration: 3,
			tool: "read-file",
			arguments: { path: "src/dependency.ts" },
			status: "ok",
			facts: {
				kind: "retrieval",
				tool: "read-file",
				path: "src/dependency.ts",
				query: null,
				inspectedPaths: ["src/dependency.ts"],
				candidatePaths: [],
				search: null,
			},
		});
		expect(executor.activeStep).toMatchObject({ executionCheckpoint: "verification-due" });

		executor.record({
			iteration: 4,
			tool: "run-public-verification",
			arguments: { index: 0 },
			status: "ok",
			facts: {
				kind: "verification",
				tool: "run-public-verification",
				commandIndex: 0,
				outcome: "failed",
				exitCode: 1,
				timedOut: false,
				durationMs: 10,
			},
		});
		expect(executor.activeStep).toMatchObject({ executionCheckpoint: "repair-due" });

		executor.record({
			iteration: 5,
			tool: "apply-edit",
			arguments: { path: "src/target.ts" },
			status: "ok",
			facts: { kind: "mutation", tool: "apply-edit", affectedPaths: ["src/target.ts"] },
		});
		expect(executor.activeStep).toMatchObject({ executionCheckpoint: "verification-due" });
	});

	it("requests replanning when an active step repeats already observed retrieval", () => {
		const executor = new HarnessNativePlanExecutor();
		const retrieval = {
			tool: "list-directory" as const,
			arguments: { path: "." },
			status: "ok" as const,
			facts: {
				kind: "retrieval" as const,
				tool: "list-directory" as const,
				path: ".",
				query: null,
				inspectedPaths: [],
				candidatePaths: [],
				search: null,
			},
		};

		expect(executor.record({ iteration: 1, ...retrieval })).toBeNull();
		executor.synchronize(revision(1));
		expect(executor.record({ iteration: 2, ...retrieval })).toBe("execution-stalled");
		expect(executor.activeStep).toMatchObject({ attempts: 1, lastOutcome: "stalled" });

		executor.synchronize(revision(2, "Repair using the observed implementation"));
		expect(executor.activeStep).toMatchObject({ revision: 2, attempts: 0, lastOutcome: null });
	});

	it("requests replanning after a rejected active-step action", () => {
		const executor = new HarnessNativePlanExecutor();
		executor.synchronize(revision(1));
		expect(
			executor.record({
				iteration: 2,
				tool: "apply-edit",
				arguments: { path: "src/target.ts" },
				status: "rejected",
				facts: { kind: "mutation", tool: "apply-edit", affectedPaths: [] },
			}),
		).toBe("execution-blocked");
		expect(executor.activeStep).toMatchObject({ attempts: 1, lastOutcome: "blocked" });
	});

	it("records failed verification as evidence for implementation and a blocker for verification", () => {
		const verificationFailure = {
			iteration: 2,
			tool: "run-public-verification" as const,
			arguments: { index: 0 },
			status: "ok" as const,
			facts: {
				kind: "verification" as const,
				tool: "run-public-verification" as const,
				commandIndex: 0,
				outcome: "failed" as const,
				exitCode: 1,
				timedOut: false,
				durationMs: 10,
			},
		};
		const executor = new HarnessNativePlanExecutor();
		executor.synchronize(revision(1));
		expect(executor.record(verificationFailure)).toBeNull();
		expect(executor.activeStep).toMatchObject({ lastOutcome: "evidence" });

		executor.synchronize(revision(2, "Verify repaired behavior", "verification"));
		expect(executor.record({ ...verificationFailure, iteration: 3 })).toBeNull();
		expect(executor.activeStep).toMatchObject({ lastOutcome: "blocked" });
	});
});
