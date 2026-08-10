import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { compareBenchmarkReports } from "../../src/agentpatchcheck/benchmark-compare";
import type { BenchmarkReport, BenchmarkTaskStatus } from "../../src/agentpatchcheck/types";

function createReport(statuses: Record<string, BenchmarkTaskStatus>): BenchmarkReport {
	return {
		version: 1,
		createdAt: "2026-08-09T00:00:00.000Z",
		benchmark: {
			sourcePath: "D:\\benchmarks\\suite.json",
			sourceSha256: "suite-sha",
			name: "suite",
			suite: { id: "suite", fixtureVersion: "fixture-v1" },
			runId: "run",
		},
		environment: { nodeVersion: "v22.0.0", platform: "win32", arch: "x64", coreSchemaVersion: 1 },
		executionIdentity: {
			cliVersion: "0.1.70",
			coreSchemaVersion: 1,
			nodeVersion: "v22.0.0",
			platform: "win32",
			arch: "x64",
			suite: { sourceSha256: "suite-sha", id: "suite", fixtureVersion: "fixture-v1" },
		},
		tasks: Object.entries(statuses).map(([taskId, status]) => ({
			taskId,
			taskSpecPath: `${taskId}.json`,
			configuration: {
				taskSpecSha256: `${taskId}-sha`,
				expectedStatus: null,
				verificationProfile: null,
				riskPolicyProfile: null,
				codexExecutable: "codex",
				model: null,
				agentAdapter: "codex",
			},
			executionIdentity: {
				baseCommit: "base",
				hiddenOracleSha256: null,
				agent: { requestedExecutable: "codex", launchExecutable: "codex", version: "0.1.0" },
			},
			status,
			durationMs: 1,
			evidence: null,
			assessment: null,
			agent: null,
			verificationStatus: null,
			hiddenOracleStatus: null,
			riskLevel: null,
			approvalStatus: null,
			verdict: null,
			error: null,
		})),
		summary: {
			total: Object.keys(statuses).length,
			passed: Object.values(statuses).filter((status) => status === "passed").length,
			failed: Object.values(statuses).filter((status) => status !== "passed").length,
			byStatus: {
				passed: 0,
				"timed-out": 0,
				"agent-failed": 0,
				"verification-failed": 0,
				"hidden-oracle-failed": 0,
				"hidden-oracle-error": 0,
				"assessment-failed": 0,
				"setup-failed": 0,
			},
			summaryText: "fixture",
		},
	};
}

describe("Benchmark report comparison", () => {
	it("compares persisted reports without running a task and classifies status changes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agentpatchcheck-benchmark-compare-"));
		try {
			const leftPath = join(directory, "left.json");
			const rightPath = join(directory, "right.json");
			await writeFile(
				leftPath,
				JSON.stringify(
					createReport({
						stable: "passed",
						regression: "passed",
						improvement: "agent-failed",
						removed: "timed-out",
					}),
				),
				"utf8",
			);
			await writeFile(
				rightPath,
				JSON.stringify(
					createReport({
						stable: "passed",
						regression: "verification-failed",
						improvement: "passed",
						added: "setup-failed",
					}),
				),
				"utf8",
			);

			const result = await compareBenchmarkReports({ leftReportPath: leftPath, rightReportPath: rightPath });

			expect(result.tasks.map((task) => [task.taskId, task.change])).toEqual([
				["added", "added"],
				["improvement", "improved"],
				["regression", "regressed"],
				["removed", "removed"],
				["stable", "unchanged"],
			]);
			expect(result.summary).toEqual({
				total: 5,
				unchanged: 1,
				improved: 1,
				regressed: 1,
				changed: 0,
				added: 1,
				removed: 1,
				configurationChanged: 0,
			});
			expect(result.compatibility).toEqual({ status: "comparable", reasons: [] });
			expect(result.tasks).toEqual(
				expect.arrayContaining([expect.objectContaining({ taskId: "stable", executionIdentityChanged: false })]),
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("marks agent, task configuration, environment, and incomplete identities as non-comparable", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agentpatchcheck-benchmark-compare-"));
		try {
			const left = createReport({ task: "passed" });
			const right = createReport({ task: "passed" });
			const leftPath = join(directory, "left.json");
			const rightPath = join(directory, "right.json");

			const taskIdentity = right.tasks[0].executionIdentity;
			if (taskIdentity?.agent !== null && taskIdentity?.agent !== undefined) taskIdentity.agent.version = "0.2.0";
			await writeFile(leftPath, JSON.stringify(left), "utf8");
			await writeFile(rightPath, JSON.stringify(right), "utf8");
			expect(
				(await compareBenchmarkReports({ leftReportPath: leftPath, rightReportPath: rightPath })).compatibility
					.status,
			).toBe("agent-drift");

			if (taskIdentity?.agent !== null && taskIdentity?.agent !== undefined) taskIdentity.agent.version = "0.1.0";
			right.tasks[0].configuration.taskSpecSha256 = "changed-task-sha";
			await writeFile(rightPath, JSON.stringify(right), "utf8");
			expect(
				(await compareBenchmarkReports({ leftReportPath: leftPath, rightReportPath: rightPath })).compatibility
					.status,
			).toBe("fixture-or-config-drift");

			right.tasks[0].configuration.taskSpecSha256 = "task-sha";
			if (right.executionIdentity !== undefined) right.executionIdentity.platform = "linux";
			await writeFile(rightPath, JSON.stringify(right), "utf8");
			expect(
				(await compareBenchmarkReports({ leftReportPath: leftPath, rightReportPath: rightPath })).compatibility
					.status,
			).toBe("environment-drift");

			delete right.executionIdentity;
			await writeFile(rightPath, JSON.stringify(right), "utf8");
			expect(
				(await compareBenchmarkReports({ leftReportPath: leftPath, rightReportPath: rightPath })).compatibility
					.status,
			).toBe("incomplete");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
