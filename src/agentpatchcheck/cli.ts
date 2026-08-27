import { fileURLToPath } from "node:url";

import { Command, CommanderError } from "commander";
import { createApplyPlan } from "./apply-plan";
import { applyRecordedPatch } from "./apply-recorded-patch";
import { recordApprovalDecision } from "./approval";
import { assessEvidenceBundle } from "./assessment-report";
import { compareBenchmarkReports } from "./benchmark-compare";
import { runBenchmark } from "./benchmark-runner";
import { loadBenchmarkSpec } from "./benchmark-spec";
import { cleanupEvidenceWorktree } from "./cleanup";
import { HEADLESS_CLI_VERSION } from "./cli-version";
import { applyDeepSeekV4ModelSelection, parseDeepSeekV4Model } from "./deepseek-v4-model";
import { auditEvidenceBundles } from "./evidence-audit";
import { listEvidenceBundles } from "./evidence-list";
import { manageEvidenceRetention } from "./evidence-retention";
import { showEvidenceBundle } from "./evidence-show";
import { executeAgentPatchCheck } from "./execute";
import { readEvidenceBundle } from "./git-patch-verifier";
import { initializeAgentPatchCheckEnvironment } from "./project-environment";
import { validateTaskPolicy } from "./task-policy";
import { loadTaskSpec } from "./task-spec";

export const HEADLESS_CLI_CONTRACT_VERSION = 1;

export type HeadlessCliCommand =
	| "run"
	| "assess"
	| "cleanup"
	| "list"
	| "evidence-audit"
	| "evidence-retention"
	| "show"
	| "apply-plan"
	| "apply"
	| "approve"
	| "reject"
	| "benchmark"
	| "benchmark-compare"
	| "unknown";
export type HeadlessCliErrorCode =
	| "invalid-arguments"
	| "operation-failed"
	| "execution-failed"
	| "assessment-not-pass"
	| "apply-plan-blocked"
	| "apply-blocked"
	| "benchmark-failed";

export interface HeadlessCliResponse<T> {
	contractVersion: typeof HEADLESS_CLI_CONTRACT_VERSION;
	command: HeadlessCliCommand;
	ok: boolean;
	data: T | null;
	error: { code: HeadlessCliErrorCode; message: string } | null;
}

export interface HeadlessCliIo {
	write: (value: string) => void;
	setExitCode: (code: number) => void;
}

const defaultIo: HeadlessCliIo = {
	write: (value) => process.stdout.write(value),
	setExitCode: (code) => {
		process.exitCode = code;
	},
};

function writeResponse<T>(io: HeadlessCliIo, response: HeadlessCliResponse<T>): void {
	io.write(`${JSON.stringify(response, null, 2)}\n`);
}

function commandFromArgv(argv: string[]): HeadlessCliCommand {
	for (const value of argv) {
		if (
			value === "run" ||
			value === "assess" ||
			value === "cleanup" ||
			value === "list" ||
			value === "evidence-audit" ||
			value === "evidence-retention" ||
			value === "show" ||
			value === "apply-plan" ||
			value === "apply" ||
			value === "approve" ||
			value === "reject" ||
			value === "benchmark" ||
			value === "benchmark-compare"
		)
			return value;
	}
	return "unknown";
}

function failure<T>(
	io: HeadlessCliIo,
	command: HeadlessCliCommand,
	data: T | null,
	code: HeadlessCliErrorCode,
	message: string,
	exitCode = 1,
): void {
	writeResponse(io, {
		contractVersion: HEADLESS_CLI_CONTRACT_VERSION,
		command,
		ok: false,
		data,
		error: { code, message },
	});
	io.setExitCode(exitCode);
}

function success<T>(io: HeadlessCliIo, command: HeadlessCliCommand, data: T): void {
	writeResponse(io, {
		contractVersion: HEADLESS_CLI_CONTRACT_VERSION,
		command,
		ok: true,
		data,
		error: null,
	});
}

function parsePositiveWholeNumber(value: string, label: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 36_500)
		throw new Error(`${label} must be a whole number between 1 and 36500.`);
	return parsed;
}

function validateIsoTimestamp(value: string | undefined, label: string): string | undefined {
	if (value === undefined) return undefined;
	if (!Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO-8601 timestamp.`);
	return value;
}

export function createHeadlessCliProgram(io: HeadlessCliIo = defaultIo): Command {
	const program = new Command();
	program
		.name("agentpatchcheck")
		.description("Run and assess controlled Codex patch tasks in isolated Git worktrees.")
		.version(HEADLESS_CLI_VERSION, "--version", "Print the installed agentpatchcheck CLI version.")
		.exitOverride()
		.configureOutput({ writeErr: () => undefined });

	program
		.command("run")
		.description("Run a controlled Codex patch task in an isolated Git worktree.")
		.requiredOption("--task-spec <path>", "Strict JSON TaskSpec containing the controlled task configuration.")
		.option(
			"--deepseek-model <model>",
			"Run with deepseek-v4-flash or deepseek-v4-pro using the existing DeepSeek provider.",
		)
		.action(async (options: { taskSpec: string; deepseekModel?: string }) => {
			const input = applyDeepSeekV4ModelSelection(
				await loadTaskSpec(options.taskSpec),
				options.deepseekModel === undefined ? undefined : parseDeepSeekV4Model(options.deepseekModel),
			);
			const result = await executeAgentPatchCheck(await validateTaskPolicy(input));
			if (result.status !== "succeeded")
				return failure(io, "run", result, "execution-failed", "Agent execution did not succeed.");
			if (result.assessment.report.verdict.status !== "pass")
				return failure(io, "run", result, "assessment-not-pass", "Assessment verdict is not pass.");
			success(io, "run", result);
		});

	program
		.command("assess")
		.description("Assess an existing EvidenceBundle without launching an agent or creating a worktree.")
		.requiredOption("--evidence <path>", "Path to a persisted EvidenceBundle JSON file.")
		.action(async (options: { evidence: string }) => {
			const result = await assessEvidenceBundle({ evidencePath: options.evidence });
			if (result.report.verdict.status !== "pass")
				return failure(io, "assess", result, "assessment-not-pass", "Assessment verdict is not pass.");
			success(io, "assess", result);
		});

	program
		.command("cleanup")
		.description("Dry-run or remove an assessed managed worktree while preserving its evidence.")
		.requiredOption("--evidence <path>", "Path to a persisted EvidenceBundle JSON file.")
		.option("--apply", "Remove the worktree after all cleanup safety checks pass.")
		.action(async (options: { evidence: string; apply?: boolean }) => {
			success(
				io,
				"cleanup",
				await cleanupEvidenceWorktree({ evidencePath: options.evidence, apply: options.apply === true }),
			);
		});

	program
		.command("list")
		.description("List persisted Headless Core evidence for one local Git repository.")
		.requiredOption("--repository <path>", "Git repository root containing .agentpatchcheck evidence.")
		.option("--status <status>", "Filter by succeeded or failed execution status.")
		.option("--assessment-status <status>", "Filter by missing, valid, or invalid assessment status.")
		.option("--run-id <id>", "Filter by exact managed run id.")
		.option("--created-after <timestamp>", "Filter entries strictly newer than this ISO-8601 timestamp.")
		.option("--created-before <timestamp>", "Filter entries strictly older than this ISO-8601 timestamp.")
		.action(
			async (options: {
				repository: string;
				status?: "succeeded" | "failed";
				assessmentStatus?: "missing" | "valid" | "invalid";
				runId?: string;
				createdAfter?: string;
				createdBefore?: string;
			}) => {
				if (options.status !== undefined && options.status !== "succeeded" && options.status !== "failed")
					throw new Error("status must be succeeded or failed.");
				if (
					options.assessmentStatus !== undefined &&
					options.assessmentStatus !== "missing" &&
					options.assessmentStatus !== "valid" &&
					options.assessmentStatus !== "invalid"
				)
					throw new Error("assessmentStatus must be missing, valid, or invalid.");
				success(
					io,
					"list",
					await listEvidenceBundles({
						repositoryPath: options.repository,
						filter: {
							status: options.status,
							assessmentStatus: options.assessmentStatus,
							runId: options.runId,
							createdAfter: validateIsoTimestamp(options.createdAfter, "createdAfter"),
							createdBefore: validateIsoTimestamp(options.createdBefore, "createdBefore"),
						},
					}),
				);
			},
		);

	program
		.command("evidence-audit")
		.description("Read-only audit of evidence lifecycle state and orphaned approval records.")
		.requiredOption("--repository <path>", "Git repository root containing .agentpatchcheck evidence.")
		.option("--older-than-days <days>", "Expiration threshold; defaults to 30 days.")
		.action(async (options: { repository: string; olderThanDays?: string }) => {
			success(
				io,
				"evidence-audit",
				await auditEvidenceBundles({
					repositoryPath: options.repository,
					olderThanDays:
						options.olderThanDays === undefined
							? undefined
							: parsePositiveWholeNumber(options.olderThanDays, "olderThanDays"),
				}),
			);
		});

	program
		.command("evidence-retention")
		.description("Plan or explicitly remove expired, assessed evidence with no managed worktree.")
		.requiredOption("--repository <path>", "Git repository root containing .agentpatchcheck evidence.")
		.requiredOption("--older-than-days <days>", "Expiration threshold for retention candidates.")
		.requiredOption(
			"--benchmark-report-root <path...>",
			"Directories containing BenchmarkReport JSON files to protect referenced evidence.",
		)
		.option("--apply", "Remove only the planned unreferenced evidence, assessment, and approval files.")
		.action(
			async (options: {
				repository: string;
				olderThanDays: string;
				benchmarkReportRoot: string[];
				apply?: boolean;
			}) => {
				success(
					io,
					"evidence-retention",
					await manageEvidenceRetention({
						repositoryPath: options.repository,
						olderThanDays: parsePositiveWholeNumber(options.olderThanDays, "olderThanDays"),
						benchmarkReportRoots: options.benchmarkReportRoot,
						apply: options.apply === true,
					}),
				);
			},
		);

	program
		.command("show")
		.description("Show a concise, read-only summary of one persisted Headless Core run.")
		.requiredOption("--evidence <path>", "Path to a persisted EvidenceBundle JSON file.")
		.action(async (options: { evidence: string }) => {
			success(io, "show", await showEvidenceBundle({ evidencePath: options.evidence }));
		});

	program
		.command("benchmark")
		.description("Run a strict BenchmarkSpec by orchestrating existing Headless Core task runs.")
		.requiredOption("--spec <path>", "Path to a strict BenchmarkSpec JSON file.")
		.option("--deepseek-model <model>", "Run DeepSeek tasks with deepseek-v4-flash or deepseek-v4-pro.")
		.action(async (options: { spec: string; deepseekModel?: string }) => {
			const result = await runBenchmark(
				await loadBenchmarkSpec(options.spec),
				{},
				{
					deepseekModel:
						options.deepseekModel === undefined ? undefined : parseDeepSeekV4Model(options.deepseekModel),
				},
			);
			if (result.report.summary.failed > 0)
				return failure(io, "benchmark", result, "benchmark-failed", "One or more benchmark tasks did not pass.");
			success(io, "benchmark", result);
		});

	program
		.command("benchmark-compare")
		.description("Read-only comparison of two persisted BenchmarkReport JSON files.")
		.requiredOption("--left <path>", "Path to the baseline BenchmarkReport JSON file.")
		.requiredOption("--right <path>", "Path to the candidate BenchmarkReport JSON file.")
		.action(async (options: { left: string; right: string }) => {
			success(
				io,
				"benchmark-compare",
				await compareBenchmarkReports({ leftReportPath: options.left, rightReportPath: options.right }),
			);
		});

	program
		.command("apply-plan")
		.description("Read-only preflight for applying one assessed recorded patch.")
		.requiredOption("--evidence <path>", "Path to a persisted EvidenceBundle JSON file.")
		.action(async (options: { evidence: string }) => {
			const result = await createApplyPlan({ evidencePath: options.evidence });
			if (result.status === "blocked")
				return failure(io, "apply-plan", result, "apply-plan-blocked", "Patch apply preflight is blocked.");
			success(io, "apply-plan", result);
		});

	program
		.command("apply")
		.description("Apply a ready recorded patch to its exact recorded repository only.")
		.requiredOption("--evidence <path>", "Path to a persisted EvidenceBundle JSON file.")
		.requiredOption("--repository <path>", "Explicit target Git repository root.")
		.option("--apply", "Apply the patch after all safety checks pass.")
		.action(async (options: { evidence: string; repository: string; apply?: boolean }) => {
			const result = await applyRecordedPatch({
				evidencePath: options.evidence,
				repositoryPath: options.repository,
				apply: options.apply === true,
			});
			if (result.status === "blocked")
				return failure(io, "apply", result, "apply-blocked", "Patch application is blocked.");
			success(io, "apply", result);
		});

	for (const approvalCommand of ["approve", "reject"] as const) {
		program
			.command(approvalCommand)
			.description(`${approvalCommand === "approve" ? "Approve" : "Reject"} a risk-gated recorded patch.`)
			.requiredOption("--evidence <path>", "Path to a persisted EvidenceBundle JSON file.")
			.option("--reason <text>", "Optional human decision reason.")
			.action(async (options: { evidence: string; reason?: string }) => {
				const plan = await createApplyPlan({ evidencePath: options.evidence });
				if (approvalCommand === "approve" && plan.risk.blocksApply)
					return failure(io, "approve", plan, "apply-plan-blocked", "Risk policy prohibits approving this patch.");
				const bundle = await readEvidenceBundle(plan.evidencePath);
				const record = await recordApprovalDecision({
					evidence: { path: plan.evidencePath, createdAt: bundle.createdAt },
					risk: plan.risk,
					decision: approvalCommand === "approve" ? "approved" : "rejected",
					reason: options.reason,
				});
				success(io, approvalCommand, { plan, approval: record });
			});
	}

	return program;
}

export async function runHeadlessCli(argv: string[] = process.argv, io: HeadlessCliIo = defaultIo): Promise<void> {
	try {
		await createHeadlessCliProgram(io).parseAsync(argv);
	} catch (error) {
		if (
			error instanceof CommanderError &&
			(error.code === "commander.helpDisplayed" || error.code === "commander.version")
		)
			return;
		const code: HeadlessCliErrorCode = error instanceof CommanderError ? "invalid-arguments" : "operation-failed";
		const message = error instanceof Error ? error.message : String(error);
		failure(io, commandFromArgv(argv), null, code, message, code === "invalid-arguments" ? 2 : 1);
	}
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
	initializeAgentPatchCheckEnvironment();
	void runHeadlessCli();
}
