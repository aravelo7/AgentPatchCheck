import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { lockedFileSystem } from "../fs/locked-file-system";
import { getAssessmentReportPath } from "./assessment-report";
import type { GeneralizationBenchmarkManifest, GeneralizationBenchmarkSplit } from "./generalization-benchmark-spec";
import { readEvidenceBundle } from "./git-patch-verifier";
import { deriveHarnessNativeResourceLedger } from "./resource-ledger";
import type { BenchmarkReport, BenchmarkTaskResult, HarnessNativeRuntimeEvent } from "./types";

export type GeneralizationFailureStage =
	| "protocol"
	| "verification"
	| "repair-convergence"
	| "runtime-control-plane"
	| "unclassified";

export interface GeneralizationRunSummary {
	runId: string;
	taskId: string;
	taskFamily: string;
	split: GeneralizationBenchmarkSplit;
	provider: string;
	model: string | null;
	status: BenchmarkTaskResult["status"];
	verdict: BenchmarkTaskResult["verdict"];
	failureStage: GeneralizationFailureStage | null;
	artifacts: { benchmarkReportPath: string; evidencePath: string | null; assessmentPath: string | null };
	lifecycle: {
		attempts: number;
		iterations: number;
		retrievals: number;
		mutations: number;
		firstMutationIteration: number | null;
		verifications: number;
		failedVerifications: number;
		repairMutations: number;
		continuationUsed: boolean;
		planRevisions: number;
		protocolRecoveries: number;
		completionDeferrals: number;
	};
	resources: ReturnType<typeof deriveHarnessNativeResourceLedger> | null;
}

export interface GeneralizationAggregateReport {
	version: 1;
	manifest: { id: string; manifestVersion: string; sourceSha256: string };
	runs: GeneralizationRunSummary[];
	byProvider: Record<string, { total: number; passed: number; failed: number }>;
	byTaskFamily: Record<string, { total: number; passed: number; failed: number }>;
	bySplit: Record<GeneralizationBenchmarkSplit, { total: number; passed: number; failed: number }>;
	failureDistribution: Partial<Record<GeneralizationFailureStage, number>>;
	harnessControlPlaneFailures: { total: number; byStage: Partial<Record<GeneralizationFailureStage, number>> };
}

export function getGeneralizationReportPath(manifestPath: string): string {
	return join(dirname(manifestPath), ".agentpatchcheck", "generalization", "report.json");
}

export async function writeGeneralizationAggregateReport(
	path: string,
	report: GeneralizationAggregateReport,
): Promise<void> {
	await lockedFileSystem.writeJsonFileAtomic(path, report);
}

export function formatGeneralizationReportSummary(report: GeneralizationAggregateReport): string {
	const passed = report.runs.filter((run) => run.status === "passed").length;
	const failures = Object.entries(report.failureDistribution)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([stage, count]) => `${stage}=${count}`)
		.join(", ");
	return `${passed}/${report.runs.length} runs passed; harness-control-plane failures=${report.harnessControlPlaneFailures.total}${failures ? `; failure stages: ${failures}` : ""}.`;
}

type ToolResultEvent = Extract<HarnessNativeRuntimeEvent, { type: "tool-result" }>;

function isSuccessfulToolResult(event: HarnessNativeRuntimeEvent): event is ToolResultEvent {
	return event.type === "tool-result" && event.status === "ok";
}

function eventsFromEvidence(evidence: Awaited<ReturnType<typeof readEvidenceBundle>>): HarnessNativeRuntimeEvent[] {
	const direct = evidence.agent.runtimeEvents ?? evidence.agent.runtime?.runtimeEvents;
	if (direct !== undefined) return direct;
	const events = evidence.agent.attempts?.flatMap((attempt) => attempt.execution.runtimeEvents ?? []) ?? [];
	return [...new Map(events.map((event) => [event.sequence, event])).values()].sort((a, b) => a.sequence - b.sequence);
}

function classifyFailure(
	task: BenchmarkTaskResult,
	events: readonly HarnessNativeRuntimeEvent[],
): GeneralizationFailureStage | null {
	if (task.status === "passed") return null;
	if (task.status === "setup-failed") return "runtime-control-plane";
	if (events.some((event) => event.type === "protocol-recovery" && event.disposition === "exhausted"))
		return "protocol";
	const toolResults = events.filter(isSuccessfulToolResult);
	const mutations = toolResults.filter((event) => event.facts.kind === "mutation");
	const verifications = toolResults.filter((event) => event.facts.kind === "verification");
	const failed = verifications.filter(
		(event) => event.facts.kind === "verification" && event.facts.outcome === "failed",
	);
	if (mutations.length > 0 && verifications.length === 0) return "verification";
	const firstFailedSequence = failed[0]?.sequence;
	if (firstFailedSequence !== undefined && mutations.some((event) => event.sequence > firstFailedSequence))
		return "repair-convergence";
	if (failed.length > 0 || task.status === "verification-failed" || task.status.startsWith("hidden-oracle"))
		return "verification";
	return "unclassified";
}

function increment(
	target: Record<string, { total: number; passed: number; failed: number }>,
	key: string,
	passed: boolean,
): void {
	const value = target[key] ?? { total: 0, passed: 0, failed: 0 };
	value.total += 1;
	value[passed ? "passed" : "failed"] += 1;
	target[key] = value;
}

async function readBenchmarkReport(path: string): Promise<BenchmarkReport> {
	const value: unknown = JSON.parse(await readFile(path, "utf8"));
	if (
		typeof value !== "object" ||
		value === null ||
		(value as Partial<BenchmarkReport>).version !== 1 ||
		!Array.isArray((value as Partial<BenchmarkReport>).tasks)
	)
		throw new Error(`Invalid BenchmarkReport: ${path}`);
	return value as BenchmarkReport;
}

export async function aggregateGeneralizationReports(options: {
	manifest: GeneralizationBenchmarkManifest;
	benchmarkReportPaths: string[];
}): Promise<GeneralizationAggregateReport> {
	const tasks = new Map(options.manifest.tasks.map((task) => [task.id, task]));
	const runs: GeneralizationRunSummary[] = [];
	for (const reportPath of options.benchmarkReportPaths) {
		const report = await readBenchmarkReport(reportPath);
		for (const result of report.tasks) {
			const task = tasks.get(result.taskId);
			if (task === undefined)
				throw new Error(`BenchmarkReport contains task not present in manifest: ${result.taskId}`);
			if (result.configuration.taskSpecSha256 !== task.taskSpec.sha256)
				throw new Error(`Task specification drift: ${result.taskId}`);
			const evidence = result.evidence === null ? null : await readEvidenceBundle(result.evidence.path);
			if (
				evidence !== null &&
				(evidence.repository.root !== task.repository.root ||
					evidence.repository.baseCommit !== task.repository.baseCommit)
			)
				throw new Error(`Repository identity drift: ${result.taskId}`);
			const events = evidence === null ? [] : eventsFromEvidence(evidence);
			const toolResults = events.filter(isSuccessfulToolResult);
			const retrievals = toolResults.filter((event) => event.facts.kind === "retrieval");
			const mutations = toolResults.filter((event) => event.facts.kind === "mutation");
			const verifications = toolResults.filter((event) => event.facts.kind === "verification");
			const firstFailed = verifications.find(
				(event) => event.facts.kind === "verification" && event.facts.outcome === "failed",
			);
			const providerIdentity = result.executionIdentity?.modelProvider;
			runs.push({
				runId: report.benchmark.runId,
				taskId: task.id,
				taskFamily: task.family,
				split: task.split,
				provider:
					providerIdentity?.provider ??
					result.configuration.modelProvider?.provider ??
					result.configuration.agentAdapter,
				model: providerIdentity?.actualModel ?? providerIdentity?.configuredModel ?? result.configuration.model,
				status: result.status,
				verdict: result.verdict,
				failureStage:
					result.evidence === null && result.status !== "passed"
						? "runtime-control-plane"
						: classifyFailure(result, events),
				artifacts: {
					benchmarkReportPath: reportPath,
					evidencePath: result.evidence?.path ?? null,
					assessmentPath:
						result.assessment?.path ??
						(result.evidence === null ? null : getAssessmentReportPath(result.evidence.path)),
				},
				lifecycle: {
					attempts: new Set(events.map((event) => event.attempt)).size,
					iterations: new Set(
						events
							.filter((event) => event.iteration !== null)
							.map((event) => `${event.attempt}:${event.iteration}`),
					).size,
					retrievals: retrievals.length,
					mutations: mutations.length,
					firstMutationIteration: mutations[0]?.iteration ?? null,
					verifications: verifications.length,
					failedVerifications: verifications.filter(
						(event) => event.facts.kind === "verification" && event.facts.outcome === "failed",
					).length,
					repairMutations:
						firstFailed === undefined
							? 0
							: mutations.filter((event) => event.sequence > firstFailed.sequence).length,
					continuationUsed: events.some(
						(event) => event.type === "attempt-started" && event.continuationFromAttempt !== null,
					),
					planRevisions: events.filter((event) => event.type === "plan-revised").length,
					protocolRecoveries: events.filter(
						(event) => event.type === "protocol-recovery" && event.disposition === "retrying",
					).length,
					completionDeferrals: events.filter(
						(event) => event.type === "completion-evaluated" && event.disposition === "continue",
					).length,
				},
				resources: events.length === 0 ? null : deriveHarnessNativeResourceLedger(events),
			});
		}
	}
	const byProvider: GeneralizationAggregateReport["byProvider"] = {};
	const byTaskFamily: GeneralizationAggregateReport["byTaskFamily"] = {};
	const bySplit = {
		development: { total: 0, passed: 0, failed: 0 },
		validation: { total: 0, passed: 0, failed: 0 },
		"held-out": { total: 0, passed: 0, failed: 0 },
	};
	const failureDistribution: GeneralizationAggregateReport["failureDistribution"] = {};
	for (const run of runs) {
		const passed = run.status === "passed";
		increment(byProvider, run.provider, passed);
		increment(byTaskFamily, run.taskFamily, passed);
		increment(bySplit, run.split, passed);
		if (run.failureStage !== null)
			failureDistribution[run.failureStage] = (failureDistribution[run.failureStage] ?? 0) + 1;
	}
	const controlStages = new Set<GeneralizationFailureStage>(["protocol", "runtime-control-plane"]);
	const byStage = Object.fromEntries(
		Object.entries(failureDistribution).filter(([stage]) => controlStages.has(stage as GeneralizationFailureStage)),
	);
	return {
		version: 1,
		manifest: {
			id: options.manifest.id,
			manifestVersion: options.manifest.manifestVersion,
			sourceSha256: options.manifest.sourceSha256,
		},
		runs,
		byProvider,
		byTaskFamily,
		bySplit,
		failureDistribution,
		harnessControlPlaneFailures: {
			total: Object.values(byStage).reduce((sum, count) => sum + (count ?? 0), 0),
			byStage,
		},
	};
}
