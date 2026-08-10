import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import type {
	BenchmarkComparisonChange,
	BenchmarkReport,
	BenchmarkReportComparison,
	BenchmarkTaskResult,
} from "./types";

const benchmarkTaskStatusSchema = z.enum([
	"passed",
	"timed-out",
	"agent-failed",
	"verification-failed",
	"hidden-oracle-failed",
	"hidden-oracle-error",
	"assessment-failed",
	"setup-failed",
]);

const profileSchema = z.object({ path: z.string(), name: z.string().nullable(), sha256: z.string() });
const riskProfileSchema = z.object({ path: z.string(), name: z.string(), sha256: z.string() });
const benchmarkReportSchema = z.object({
	version: z.literal(1),
	createdAt: z.string(),
	benchmark: z.object({
		sourcePath: z.string(),
		sourceSha256: z.string(),
		name: z.string().nullable(),
		suite: z.object({ id: z.string(), fixtureVersion: z.string() }).nullable(),
		runId: z.string(),
	}),
	environment: z.object({
		nodeVersion: z.string(),
		platform: z.string(),
		arch: z.string(),
		coreSchemaVersion: z.literal(1),
	}),
	tasks: z.array(
		z.object({
			taskId: z.string(),
			status: benchmarkTaskStatusSchema,
			configuration: z.object({
				taskSpecSha256: z.string(),
				expectedStatus: benchmarkTaskStatusSchema.nullable(),
				verificationProfile: profileSchema.nullable(),
				riskPolicyProfile: riskProfileSchema.nullable(),
				codexExecutable: z.string().nullable(),
				model: z.string().nullable(),
				agentAdapter: z.enum(["codex", "script"]),
			}),
		}),
	),
});

async function readBenchmarkReport(path: string): Promise<{ path: string; report: BenchmarkReport }> {
	const resolvedPath = resolve(path);
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(await readFile(resolvedPath, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read BenchmarkReport ${resolvedPath}: ${message}`);
	}
	const parsed = benchmarkReportSchema.safeParse(parsedJson);
	if (!parsed.success) throw new Error(`Invalid BenchmarkReport ${resolvedPath}: ${parsed.error.message}`);
	return { path: resolvedPath, report: parsed.data as BenchmarkReport };
}

function compareStatus(
	left: BenchmarkTaskResult["status"] | null,
	right: BenchmarkTaskResult["status"] | null,
): BenchmarkComparisonChange {
	if (left === null) return "added";
	if (right === null) return "removed";
	if (left === right) return "unchanged";
	if (left !== "passed" && right === "passed") return "improved";
	if (left === "passed" && right !== "passed") return "regressed";
	return "changed";
}

export async function compareBenchmarkReports(options: {
	leftReportPath: string;
	rightReportPath: string;
}): Promise<BenchmarkReportComparison> {
	const [left, right] = await Promise.all([
		readBenchmarkReport(options.leftReportPath),
		readBenchmarkReport(options.rightReportPath),
	]);
	const leftByTaskId = new Map(left.report.tasks.map((task) => [task.taskId, task]));
	const rightByTaskId = new Map(right.report.tasks.map((task) => [task.taskId, task]));
	const taskIds = [...new Set([...leftByTaskId.keys(), ...rightByTaskId.keys()])].sort((first, second) =>
		first.localeCompare(second),
	);
	const tasks = taskIds.map((taskId) => {
		const leftTask = leftByTaskId.get(taskId) ?? null;
		const rightTask = rightByTaskId.get(taskId) ?? null;
		return {
			taskId,
			change: compareStatus(leftTask?.status ?? null, rightTask?.status ?? null),
			configurationChanged:
				leftTask === null || rightTask === null
					? null
					: JSON.stringify(leftTask.configuration) !== JSON.stringify(rightTask.configuration),
			left: leftTask === null ? null : { status: leftTask.status, configuration: leftTask.configuration },
			right: rightTask === null ? null : { status: rightTask.status, configuration: rightTask.configuration },
		};
	});
	const summary = {
		total: tasks.length,
		unchanged: 0,
		improved: 0,
		regressed: 0,
		changed: 0,
		added: 0,
		removed: 0,
		configurationChanged: 0,
	};
	for (const task of tasks) {
		summary[task.change] += 1;
		if (task.configurationChanged === true) summary.configurationChanged += 1;
	}
	return {
		version: 1,
		left: { path: left.path, createdAt: left.report.createdAt, benchmark: left.report.benchmark },
		right: { path: right.path, createdAt: right.report.createdAt, benchmark: right.report.benchmark },
		tasks,
		summary,
	};
}
