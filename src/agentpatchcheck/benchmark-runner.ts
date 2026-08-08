import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

import { lockedFileSystem } from "../fs/locked-file-system";
import { executeAgentPatchCheck } from "./execute";
import { validateTaskPolicy } from "./task-policy";
import { loadTaskSpec } from "./task-spec";
import type {
	AgentPatchCheckResult,
	BenchmarkDefinition,
	BenchmarkReport,
	BenchmarkReportReference,
	BenchmarkResult,
	BenchmarkTaskResult,
	BenchmarkTaskStatus,
	TaskPolicyInput,
} from "./types";

interface BenchmarkDependencies {
	loadTaskSpec: (path: string) => Promise<TaskPolicyInput>;
	validateTaskPolicy: typeof validateTaskPolicy;
	execute: typeof executeAgentPatchCheck;
	writeReport: typeof writeBenchmarkReport;
	createRunId: () => string;
}

const allStatuses: BenchmarkTaskStatus[] = [
	"passed",
	"timed-out",
	"agent-failed",
	"verification-failed",
	"assessment-failed",
	"setup-failed",
];

function createRunId(): string {
	return `benchmark-${randomUUID().slice(0, 12)}`;
}

function createTaskRunId(benchmarkRunId: string, taskId: string): string {
	return `${benchmarkRunId}-${taskId}`;
}

function classifyTask(result: AgentPatchCheckResult): BenchmarkTaskStatus {
	if (result.agent.timedOut) return "timed-out";
	if (result.status !== "succeeded") return "agent-failed";
	if (result.commandVerification.status === "failed") return "verification-failed";
	if (result.assessment.report.verdict.status !== "pass") return "assessment-failed";
	return "passed";
}

function createSummary(tasks: BenchmarkTaskResult[]): BenchmarkReport["summary"] {
	const byStatus = Object.fromEntries(allStatuses.map((status) => [status, 0])) as Record<BenchmarkTaskStatus, number>;
	for (const task of tasks) byStatus[task.status] += 1;
	const failures = allStatuses
		.filter((status) => status !== "passed" && byStatus[status] > 0)
		.map((status) => `${status}=${byStatus[status]}`);
	return {
		total: tasks.length,
		passed: byStatus.passed,
		failed: tasks.length - byStatus.passed,
		byStatus,
		summaryText:
			failures.length === 0
				? `${byStatus.passed}/${tasks.length} tasks passed.`
				: `${byStatus.passed}/${tasks.length} tasks passed; ${tasks.length - byStatus.passed} failed (${failures.join(", ")}).`,
	};
}

export function getBenchmarkReportPath(sourcePath: string, runId: string): string {
	return join(dirname(sourcePath), ".agentpatchcheck", "benchmarks", `${runId}.json`);
}

export async function writeBenchmarkReport(options: {
	path: string;
	report: BenchmarkReport;
}): Promise<BenchmarkReportReference> {
	await lockedFileSystem.writeJsonFileAtomic(options.path, options.report);
	return { path: options.path, createdAt: options.report.createdAt };
}

const defaultDependencies: BenchmarkDependencies = {
	loadTaskSpec,
	validateTaskPolicy,
	execute: executeAgentPatchCheck,
	writeReport: writeBenchmarkReport,
	createRunId,
};

export async function runBenchmark(
	definition: BenchmarkDefinition,
	dependencies: BenchmarkDependencies = defaultDependencies,
): Promise<BenchmarkResult> {
	const runId = dependencies.createRunId();
	const tasks: BenchmarkTaskResult[] = [];
	for (const task of definition.tasks) {
		const startedAt = Date.now();
		try {
			const input = await dependencies.loadTaskSpec(task.taskSpecPath);
			const policy = await dependencies.validateTaskPolicy({
				...input,
				runId: input.runId ?? createTaskRunId(runId, task.id),
			});
			const result = await dependencies.execute(policy);
			tasks.push({
				taskId: task.id,
				taskSpecPath: task.taskSpecPath,
				status: classifyTask(result),
				durationMs: Date.now() - startedAt,
				evidence: result.evidence,
				assessment: result.assessment.reference,
				agent: {
					exitCode: result.agent.exitCode,
					signal: result.agent.signal,
					durationMs: result.agent.durationMs,
					timedOut: result.agent.timedOut,
				},
				verificationStatus: result.commandVerification.status,
				verdict: result.assessment.report.verdict.status,
				error: null,
			});
		} catch (error) {
			tasks.push({
				taskId: task.id,
				taskSpecPath: task.taskSpecPath,
				status: "setup-failed",
				durationMs: Date.now() - startedAt,
				evidence: null,
				assessment: null,
				agent: null,
				verificationStatus: null,
				verdict: null,
				error: { code: "task-failed", message: error instanceof Error ? error.message : String(error) },
			});
		}
	}
	const report: BenchmarkReport = {
		version: 1,
		createdAt: new Date().toISOString(),
		benchmark: { sourcePath: definition.sourcePath, name: definition.name, runId },
		tasks,
		summary: createSummary(tasks),
	};
	return {
		report,
		reference: await dependencies.writeReport({ path: getBenchmarkReportPath(definition.sourcePath, runId), report }),
	};
}
