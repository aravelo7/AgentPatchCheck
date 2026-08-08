import { describe, expect, it } from "vitest";

import { runBenchmark } from "../../src/agentpatchcheck/benchmark-runner";
import { validateTaskPolicy } from "../../src/agentpatchcheck/task-policy";
import type { AgentPatchCheckResult, BenchmarkDefinition, PatchVerdictStatus } from "../../src/agentpatchcheck/types";

function createResult(options: {
	exitCode?: number | null;
	timedOut?: boolean;
	verificationStatus?: "passed" | "failed" | "not-run";
	verdict?: PatchVerdictStatus;
}): AgentPatchCheckResult {
	const exitCode = options.exitCode ?? 0;
	const timedOut = options.timedOut ?? false;
	const verificationStatus = options.verificationStatus ?? "not-run";
	const verdict = options.verdict ?? "pass";
	const evidencePath = "D:\\repo\\.agentpatchcheck\\evidence\\task.json";
	return {
		status: exitCode === 0 && !timedOut ? "succeeded" : "failed",
		workspace: {
			runId: "task",
			repositoryPath: "D:\\repo",
			path: "D:\\repo\\.agentpatchcheck\\worktrees\\task",
			baseRef: "HEAD",
			baseCommit: "base",
		},
		agent: {
			executable: "codex",
			args: [],
			exitCode,
			signal: null,
			stdout: "",
			stderr: "",
			durationMs: 10,
			timedOut,
		},
		patch: { changedFiles: ["README.md"], trackedPatch: "diff" },
		commandVerification: { status: verificationStatus, cwd: "D:\\repo", commands: [] },
		evidence: { path: evidencePath, createdAt: "2026-08-08T00:00:00.000Z" },
		assessment: {
			report: {
				version: 1,
				createdAt: "2026-08-08T00:00:01.000Z",
				evidence: { path: evidencePath, createdAt: "2026-08-08T00:00:00.000Z" },
				gitPatchVerification: {
					status: "verified",
					evidencePath,
					worktreePath: "D:\\repo\\.agentpatchcheck\\worktrees\\task",
					checkedAt: "2026-08-08T00:00:01.000Z",
					durationMs: 1,
					checks: {
						worktreeExists: true,
						headMatchesBaseCommit: true,
						changedFilesMatch: true,
						trackedPatchMatches: true,
						unrecordedUntrackedFiles: [],
					},
					failures: [],
				},
				verdict: { status: verdict, expectation: "changes-required", reasonCodes: [], reasons: [] },
			},
			reference: { path: `${evidencePath}.assessment.json`, createdAt: "2026-08-08T00:00:01.000Z" },
		},
	};
}

describe("Benchmark Runner", () => {
	it("continues after failed tasks and aggregates classifications from Headless Core results", async () => {
		const definition: BenchmarkDefinition = {
			version: 1,
			sourcePath: "D:\\benchmarks\\smoke.json",
			name: "smoke",
			tasks: [
				{ id: "passed", taskSpecPath: "passed.json" },
				{ id: "setup", taskSpecPath: "setup.json" },
				{ id: "timeout", taskSpecPath: "timeout.json" },
				{ id: "agent", taskSpecPath: "agent.json" },
				{ id: "verification", taskSpecPath: "verification.json" },
				{ id: "assessment", taskSpecPath: "assessment.json" },
			],
		};
		const executionOrder: string[] = [];
		const outcomes: Record<string, AgentPatchCheckResult> = {
			passed: createResult({}),
			timeout: createResult({ timedOut: true, exitCode: null, verdict: "fail" }),
			agent: createResult({ exitCode: 1, verdict: "fail" }),
			verification: createResult({ verificationStatus: "failed", verdict: "fail" }),
			assessment: createResult({ verdict: "inconclusive" }),
		};
		let writtenSummary: { total: number; passed: number; failed: number; summaryText: string } | undefined;

		const result = await runBenchmark(definition, {
			loadTaskSpec: async (path) => {
				const taskId = path.replace(".json", "");
				if (taskId === "setup") throw new Error("TaskSpec is invalid.");
				return { repositoryRoot: process.cwd(), prompt: taskId, patchExpectation: "changes-required" };
			},
			validateTaskPolicy,
			execute: async (policy) => {
				executionOrder.push(policy.prompt);
				return outcomes[policy.prompt] as AgentPatchCheckResult;
			},
			writeReport: async ({ path, report }) => {
				writtenSummary = report.summary;
				return { path, createdAt: report.createdAt };
			},
			createRunId: () => "benchmark-test",
		});

		expect(executionOrder).toEqual(["passed", "timeout", "agent", "verification", "assessment"]);
		expect(result.report.tasks.map((task) => task.status)).toEqual([
			"passed",
			"setup-failed",
			"timed-out",
			"agent-failed",
			"verification-failed",
			"assessment-failed",
		]);
		expect(result.report.tasks[0]).toMatchObject({
			evidence: { path: "D:\\repo\\.agentpatchcheck\\evidence\\task.json" },
		});
		expect(result.report.tasks[1]).toMatchObject({ evidence: null, error: { code: "task-failed" } });
		expect(result.report.summary).toEqual({
			total: 6,
			passed: 1,
			failed: 5,
			byStatus: {
				passed: 1,
				"timed-out": 1,
				"agent-failed": 1,
				"verification-failed": 1,
				"assessment-failed": 1,
				"setup-failed": 1,
			},
			summaryText:
				"1/6 tasks passed; 5 failed (timed-out=1, agent-failed=1, verification-failed=1, assessment-failed=1, setup-failed=1).",
		});
		expect(writtenSummary).toMatchObject({
			total: 6,
			passed: 1,
			failed: 5,
			summaryText: result.report.summary.summaryText,
		});
	});
});
