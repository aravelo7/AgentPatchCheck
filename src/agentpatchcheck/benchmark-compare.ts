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
const agentIdentitySchema = z.object({
	requestedExecutable: z.string(),
	launchExecutable: z.string().nullable(),
	version: z.string().nullable(),
});
const modelProviderIdentitySchema = z.object({
	provider: z.enum(["openai", "openai-compatible"]),
	protocol: z.enum(["responses", "chat-completions"]),
	thinkingMode: z.enum(["default", "disabled"]),
	endpointSha256: z.string(),
	credentialRef: z.string(),
	implementation: z.literal("openai-compatible-v1"),
	configuredModel: z.string(),
	actualModel: z.string().nullable(),
});
const modelProviderConfigurationSchema = modelProviderIdentitySchema.pick({
	provider: true,
	protocol: true,
	thinkingMode: true,
	endpointSha256: true,
	credentialRef: true,
	implementation: true,
});
const taskExecutionIdentitySchema = z.object({
	baseCommit: z.string(),
	hiddenOracleSha256: z.string().nullable(),
	agent: agentIdentitySchema.nullable(),
	modelProvider: modelProviderIdentitySchema.nullable().optional(),
});
const repairCycleSchema = z.object({
	attempted: z.boolean(),
	initialVerificationStatus: z.enum(["passed", "failed", "not-run"]),
	finalVerificationStatus: z.enum(["passed", "failed", "not-run"]),
	outcome: z.enum([
		"initial-pass",
		"initial-verification-not-run",
		"repaired",
		"repair-failed",
		"repair-timed-out",
		"initial-agent-failed",
		"initial-agent-timed-out",
	]),
});
const executionIdentitySchema = z.object({
	cliVersion: z.string(),
	coreSchemaVersion: z.literal(1),
	nodeVersion: z.string(),
	platform: z.string(),
	arch: z.string(),
	suite: z.object({ sourceSha256: z.string(), id: z.string().nullable(), fixtureVersion: z.string().nullable() }),
});
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
	executionIdentity: executionIdentitySchema.optional(),
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
				modelProvider: modelProviderConfigurationSchema.nullable().optional(),
				agentAdapter: z.enum(["codex", "script", "harness-native"]),
			}),
			executionIdentity: taskExecutionIdentitySchema.nullable().optional(),
			repairCycle: repairCycleSchema.nullable().optional(),
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

function getTaskConfigurationIdentity(configuration: BenchmarkTaskResult["configuration"]): object {
	return {
		taskSpecSha256: configuration.taskSpecSha256,
		expectedStatus: configuration.expectedStatus,
		verificationProfile:
			configuration.verificationProfile === null
				? null
				: {
						name: configuration.verificationProfile.name,
						sha256: configuration.verificationProfile.sha256,
					},
		riskPolicyProfile:
			configuration.riskPolicyProfile === null
				? null
				: {
						name: configuration.riskPolicyProfile.name,
						sha256: configuration.riskPolicyProfile.sha256,
					},
		model: configuration.model,
		modelProvider: configuration.modelProvider ?? null,
		agentAdapter: configuration.agentAdapter,
	};
}

function hasTaskConfigurationChanged(left: BenchmarkTaskResult, right: BenchmarkTaskResult): boolean {
	return (
		JSON.stringify(getTaskConfigurationIdentity(left.configuration)) !==
		JSON.stringify(getTaskConfigurationIdentity(right.configuration))
	);
}

function compareExecutionIdentity(
	left: BenchmarkReport,
	right: BenchmarkReport,
): BenchmarkReportComparison["compatibility"] {
	if (left.executionIdentity === undefined || right.executionIdentity === undefined)
		return { status: "incomplete", reasons: ["One or both reports lack BenchmarkExecutionIdentity."] };
	const reasons: string[] = [];
	const leftIdentity = left.executionIdentity;
	const rightIdentity = right.executionIdentity;
	if (JSON.stringify(leftIdentity.suite) !== JSON.stringify(rightIdentity.suite))
		reasons.push("Suite manifest or fixture identity changed.");
	if (
		leftIdentity.nodeVersion !== rightIdentity.nodeVersion ||
		leftIdentity.platform !== rightIdentity.platform ||
		leftIdentity.arch !== rightIdentity.arch ||
		leftIdentity.cliVersion !== rightIdentity.cliVersion ||
		leftIdentity.coreSchemaVersion !== rightIdentity.coreSchemaVersion
	)
		reasons.push("Harness environment or core identity changed.");
	const pairs = new Map(left.tasks.map((task) => [task.taskId, task]));
	for (const rightTask of right.tasks) {
		const leftTask = pairs.get(rightTask.taskId);
		if (leftTask === undefined) continue;
		if (hasTaskConfigurationChanged(leftTask, rightTask))
			reasons.push(`Task configuration changed: ${rightTask.taskId}.`);
		if (leftTask.executionIdentity === undefined || rightTask.executionIdentity === undefined) {
			reasons.push(`Task execution identity is incomplete: ${rightTask.taskId}.`);
			continue;
		}
		if (JSON.stringify(leftTask.executionIdentity?.agent) !== JSON.stringify(rightTask.executionIdentity?.agent))
			reasons.push(`Agent identity changed: ${rightTask.taskId}.`);
		if (
			JSON.stringify(leftTask.executionIdentity?.modelProvider ?? null) !==
			JSON.stringify(rightTask.executionIdentity?.modelProvider ?? null)
		)
			reasons.push(`Model provider identity changed: ${rightTask.taskId}.`);
		if (
			leftTask.executionIdentity?.baseCommit !== rightTask.executionIdentity?.baseCommit ||
			leftTask.executionIdentity?.hiddenOracleSha256 !== rightTask.executionIdentity?.hiddenOracleSha256
		)
			reasons.push(`Fixture or Hidden Oracle identity changed: ${rightTask.taskId}.`);
	}
	if (reasons.length === 0) return { status: "comparable", reasons };
	if (reasons.some((reason) => reason.startsWith("Task execution identity is incomplete")))
		return { status: "incomplete", reasons };
	if (
		reasons.some(
			(reason) => reason.includes("Suite") || reason.includes("configuration") || reason.includes("Fixture"),
		)
	)
		return { status: "fixture-or-config-drift", reasons };
	if (reasons.some((reason) => reason.startsWith("Agent") || reason.startsWith("Model provider")))
		return { status: "agent-drift", reasons };
	return { status: "environment-drift", reasons };
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
				leftTask === null || rightTask === null ? null : hasTaskConfigurationChanged(leftTask, rightTask),
			executionIdentityChanged:
				leftTask === null || rightTask === null
					? null
					: JSON.stringify(leftTask.executionIdentity ?? null) !==
						JSON.stringify(rightTask.executionIdentity ?? null),
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
		compatibility: compareExecutionIdentity(left.report, right.report),
		tasks,
		summary,
	};
}
