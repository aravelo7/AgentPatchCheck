import { fileURLToPath } from "node:url";

import { Command, CommanderError } from "commander";
import { createApplyPlan } from "./apply-plan";
import { applyRecordedPatch } from "./apply-recorded-patch";
import { assessEvidenceBundle } from "./assessment-report";
import { runBenchmark } from "./benchmark-runner";
import { loadBenchmarkSpec } from "./benchmark-spec";
import { cleanupEvidenceWorktree } from "./cleanup";
import { listEvidenceBundles } from "./evidence-list";
import { showEvidenceBundle } from "./evidence-show";
import { executeAgentPatchCheck } from "./execute";
import { validateTaskPolicy } from "./task-policy";
import { loadTaskSpec } from "./task-spec";

export const HEADLESS_CLI_CONTRACT_VERSION = 1;

export type HeadlessCliCommand =
	| "run"
	| "assess"
	| "cleanup"
	| "list"
	| "show"
	| "apply-plan"
	| "apply"
	| "benchmark"
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
			value === "show" ||
			value === "apply-plan" ||
			value === "apply" ||
			value === "benchmark"
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

export function createHeadlessCliProgram(io: HeadlessCliIo = defaultIo): Command {
	const program = new Command();
	program
		.name("agentpatchcheck")
		.description("Run and assess controlled Codex patch tasks in isolated Git worktrees.")
		.exitOverride()
		.configureOutput({ writeErr: () => undefined });

	program
		.command("run")
		.description("Run a controlled Codex patch task in an isolated Git worktree.")
		.requiredOption("--task-spec <path>", "Strict JSON TaskSpec containing the controlled task configuration.")
		.action(async (options: { taskSpec: string }) => {
			const result = await executeAgentPatchCheck(await validateTaskPolicy(await loadTaskSpec(options.taskSpec)));
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
		.action(async (options: { repository: string }) => {
			success(io, "list", await listEvidenceBundles({ repositoryPath: options.repository }));
		});

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
		.action(async (options: { spec: string }) => {
			const result = await runBenchmark(await loadBenchmarkSpec(options.spec));
			if (result.report.summary.failed > 0)
				return failure(io, "benchmark", result, "benchmark-failed", "One or more benchmark tasks did not pass.");
			success(io, "benchmark", result);
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

	return program;
}

export async function runHeadlessCli(argv: string[] = process.argv, io: HeadlessCliIo = defaultIo): Promise<void> {
	try {
		await createHeadlessCliProgram(io).parseAsync(argv);
	} catch (error) {
		const code: HeadlessCliErrorCode = error instanceof CommanderError ? "invalid-arguments" : "operation-failed";
		const message = error instanceof Error ? error.message : String(error);
		failure(io, commandFromArgv(argv), null, code, message, code === "invalid-arguments" ? 2 : 1);
	}
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) void runHeadlessCli();
