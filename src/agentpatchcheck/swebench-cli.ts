import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getGitStdout } from "../workspace/git-utils";
import { findAgentPatchCheckProjectRoot, initializeAgentPatchCheckEnvironment } from "./project-environment";
import {
	loadSWEbenchInstance,
	runSWEbenchInstance,
	SWE_BENCH_MULTILINGUAL_DATASET,
	SWE_BENCH_STANDARD_BASELINE_TAG,
	type SWEbenchAdapterResult,
} from "./swebench-adapter";

const SWE_BENCH_EVALUATOR_BRIDGE_PATH = fileURLToPath(
	new URL("../../scripts/swebench-verification-bridge.mjs", import.meta.url),
);

type SWEbenchAgentExecutionStatus = "completed" | "model-failed" | "timeout" | "other-runtime-failure";
type SWEbenchGradingStatus =
	| "resolved"
	| "unresolved"
	| "infrastructure_error"
	| "grading_error_or_ambiguous"
	| "not_run";

export interface SWEbenchGradingResult {
	version: number;
	instanceId: string;
	normalizedStatus: SWEbenchGradingStatus;
	reason: string;
	officialReportPath: string | null;
	officialRunId: string | null;
	evaluatorVersion: string | null;
}

interface SWEbenchEvaluatorConfiguration {
	evaluatorPythonPath: string;
	evaluatorSourceRoot: string;
	artifactRoot: string;
	timeoutSeconds: number;
	evaluatorVersion: string | null;
}

interface CliOptions {
	dataset: string;
	instance: string;
	repository: string;
	output: string;
	modelNameOrPath: string;
	runId?: string;
	variant?: string;
	attempt?: number;
	evaluator: SWEbenchEvaluatorConfiguration;
}

interface SWEbenchPostRunEvaluatorInput {
	predictionPath: string;
	datasetPath: string;
	instanceId: string;
	configuration: SWEbenchEvaluatorConfiguration;
}

interface SWEbenchCliDependencies {
	initializeEnvironment: typeof initializeAgentPatchCheckEnvironment;
	findProjectRoot: typeof findAgentPatchCheckProjectRoot;
	getGitStdout: typeof getGitStdout;
	loadInstance: typeof loadSWEbenchInstance;
	runInstance: typeof runSWEbenchInstance;
	runPostRunEvaluator: typeof runSWEbenchPostRunEvaluator;
}

const defaultDependencies: SWEbenchCliDependencies = {
	initializeEnvironment: initializeAgentPatchCheckEnvironment,
	findProjectRoot: findAgentPatchCheckProjectRoot,
	getGitStdout,
	loadInstance: loadSWEbenchInstance,
	runInstance: runSWEbenchInstance,
	runPostRunEvaluator: runSWEbenchPostRunEvaluator,
};

function optionValue(argv: string[], name: string, required = true): string | undefined {
	const index = argv.indexOf(name);
	if (index === -1) {
		if (required) throw new Error(`Missing required option: ${name}`);
		return undefined;
	}
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for option: ${name}`);
	return value;
}

function positiveIntegerOption(argv: string[], name: string): number {
	const value = Number(optionValue(argv, name));
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
	return value;
}

function parseOptions(argv: string[]): CliOptions {
	return {
		dataset: optionValue(argv, "--dataset") as string,
		instance: optionValue(argv, "--instance") as string,
		repository: optionValue(argv, "--repository") as string,
		output: optionValue(argv, "--output") as string,
		modelNameOrPath:
			optionValue(argv, "--model-name-or-path", false) ??
			`agentpatchcheck/${SWE_BENCH_STANDARD_BASELINE_TAG}/deepseek-v4-pro`,
		runId: optionValue(argv, "--run-id", false),
		variant: optionValue(argv, "--variant", false),
		attempt: (() => {
			const value = optionValue(argv, "--attempt", false);
			if (value === undefined) return undefined;
			const parsed = Number(value);
			if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("--attempt must be a positive integer.");
			return parsed;
		})(),
		evaluator: {
			evaluatorPythonPath: optionValue(argv, "--evaluator-python") as string,
			evaluatorSourceRoot: optionValue(argv, "--evaluator-source-root") as string,
			artifactRoot: optionValue(argv, "--evaluator-artifact-root") as string,
			timeoutSeconds: positiveIntegerOption(argv, "--evaluator-timeout-seconds"),
			evaluatorVersion: optionValue(argv, "--evaluator-version", false) ?? null,
		},
	};
}

function isGradingStatus(value: unknown): value is SWEbenchGradingStatus {
	return (
		value === "resolved" ||
		value === "unresolved" ||
		value === "infrastructure_error" ||
		value === "grading_error_or_ambiguous" ||
		value === "not_run"
	);
}

function parseGradingResult(stdout: string): SWEbenchGradingResult {
	const line = stdout
		.split(/\r?\n/u)
		.map((entry) => entry.trim())
		.filter(Boolean)
		.at(-1);
	if (line === undefined) throw new Error("SWE-bench evaluator bridge returned no grading result.");
	const value: unknown = JSON.parse(line);
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("SWE-bench evaluator bridge returned an invalid grading result.");
	}
	const result = value as Record<string, unknown>;
	if (
		typeof result.version !== "number" ||
		typeof result.instanceId !== "string" ||
		!isGradingStatus(result.normalizedStatus) ||
		typeof result.reason !== "string" ||
		(result.officialReportPath !== null && typeof result.officialReportPath !== "string") ||
		(result.officialRunId !== null && typeof result.officialRunId !== "string") ||
		(result.evaluatorVersion !== null && typeof result.evaluatorVersion !== "string")
	) {
		throw new Error("SWE-bench evaluator bridge returned an invalid grading result.");
	}
	return result as unknown as SWEbenchGradingResult;
}

function deriveAgentExecutionStatus(result: SWEbenchAdapterResult): SWEbenchAgentExecutionStatus {
	const terminationReason = result.agent.runtime?.terminationReason ?? null;
	if (result.agent.timedOut || terminationReason === "timeout") return "timeout";
	if (terminationReason === "model-failed") return "model-failed";
	return result.agent.exitCode === 0 ? "completed" : "other-runtime-failure";
}

function createNotRunGradingResult(result: SWEbenchAdapterResult): SWEbenchGradingResult {
	return {
		version: 2,
		instanceId: result.instance.instance_id,
		normalizedStatus: "not_run",
		reason: result.predictionError ?? "prediction_not_available",
		officialReportPath: null,
		officialRunId: null,
		evaluatorVersion: null,
	};
}

async function assertSWEbenchBaselineSource(
	projectRoot: string,
	getStdout: SWEbenchCliDependencies["getGitStdout"],
): Promise<string> {
	const expectedCommit = await getStdout(
		["rev-parse", "--verify", `${SWE_BENCH_STANDARD_BASELINE_TAG}^{commit}`],
		projectRoot,
	);
	const currentCommit = await getStdout(["rev-parse", "HEAD"], projectRoot);
	if (currentCommit !== expectedCommit) {
		throw new Error(
			`SWE-bench standard mode must run from baseline tag ${SWE_BENCH_STANDARD_BASELINE_TAG} (${expectedCommit}); current HEAD is ${currentCommit}.`,
		);
	}
	const trackedChanges = await getStdout(["status", "--porcelain", "--untracked-files=no"], projectRoot);
	if (trackedChanges) {
		throw new Error("SWE-bench standard mode requires a clean tracked source worktree.");
	}
	return currentCommit;
}

export async function runSWEbenchPostRunEvaluator(
	input: SWEbenchPostRunEvaluatorInput,
): Promise<SWEbenchGradingResult> {
	const configuration = input.configuration;
	const args = [
		SWE_BENCH_EVALUATOR_BRIDGE_PATH,
		"--dataset",
		resolve(input.datasetPath),
		"--prediction-path",
		resolve(input.predictionPath),
		"--instance-id",
		input.instanceId,
		"--evaluator-python",
		resolve(configuration.evaluatorPythonPath),
		"--evaluator-source-root",
		resolve(configuration.evaluatorSourceRoot),
		"--artifact-root",
		resolve(configuration.artifactRoot),
		"--evaluator-timeout-seconds",
		String(configuration.timeoutSeconds),
	];
	if (configuration.evaluatorVersion !== null) args.push("--evaluator-version", configuration.evaluatorVersion);
	const output = await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>(
		(resolveResult, reject) => {
			const child = spawn(process.execPath, args, { shell: false, windowsHide: true, stdio: "pipe" });
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (chunk: Buffer | string) => {
				stdout += chunk.toString();
			});
			child.stderr?.on("data", (chunk: Buffer | string) => {
				stderr += chunk.toString();
			});
			child.once("error", reject);
			child.once("close", (exitCode) => resolveResult({ exitCode, stdout, stderr }));
		},
	);
	const grading = parseGradingResult(output.stdout);
	if (output.exitCode !== 0 && grading.normalizedStatus !== "infrastructure_error") {
		throw new Error("SWE-bench evaluator bridge exited without an infrastructure grading result.");
	}
	return grading;
}

export async function runSWEbenchCli(
	argv = process.argv.slice(2),
	dependencies: Partial<SWEbenchCliDependencies> = {},
): Promise<void> {
	const resolvedDependencies = { ...defaultDependencies, ...dependencies };
	resolvedDependencies.initializeEnvironment();
	const options = parseOptions(argv);
	const projectRoot = resolvedDependencies.findProjectRoot();
	const sourceCommit = await assertSWEbenchBaselineSource(projectRoot, resolvedDependencies.getGitStdout);
	const instance = await resolvedDependencies.loadInstance(options.dataset, options.instance);
	const result = await resolvedDependencies.runInstance({
		instance,
		repositoryRoot: options.repository,
		outputPath: options.output,
		modelNameOrPath: options.modelNameOrPath,
		runId: options.runId,
		variant: options.variant,
		attempt: options.attempt,
	});
	let grading: SWEbenchGradingResult;
	if (result.prediction === null || result.predictionPath === null) {
		grading = createNotRunGradingResult(result);
	} else {
		try {
			grading = await resolvedDependencies.runPostRunEvaluator({
				predictionPath: result.predictionPath,
				datasetPath: options.dataset,
				instanceId: result.instance.instance_id,
				configuration: options.evaluator,
			});
		} catch {
			grading = {
				version: 2,
				instanceId: result.instance.instance_id,
				normalizedStatus: "infrastructure_error",
				reason: "post_run_evaluator_invocation_failed",
				officialReportPath: null,
				officialRunId: null,
				evaluatorVersion: options.evaluator.evaluatorVersion,
			};
		}
	}
	const outputDirectory = dirname(result.predictionPath ?? resolve(options.output));
	const gradingPath = resolve(outputDirectory, `${result.runId}.swebench-grading.json`);
	await writeFile(gradingPath, `${JSON.stringify(grading, null, 2)}\n`, "utf8");
	const summaryPath = resolve(outputDirectory, `${result.runId}.apc-run.json`);
	await writeFile(
		summaryPath,
		`${JSON.stringify(
			{
				version: 2,
				dataset: SWE_BENCH_MULTILINGUAL_DATASET,
				apcBaselineCommit: sourceCommit,
				instanceId: result.instance.instance_id,
				baseCommit: result.instance.base_commit,
				runId: result.runId,
				runIdentity: result.runIdentity,
				repository: result.instance.repo,
				model: result.runIdentity.model,
				workspacePath: result.workspace.path,
				runtimeRecordPath: result.runtimeRecordPath,
				agent: {
					status: deriveAgentExecutionStatus(result),
					exitCode: result.agent.exitCode,
					signal: result.agent.signal,
					timedOut: result.agent.timedOut,
					durationMs: result.agent.durationMs,
					terminationReason: result.agent.runtime?.terminationReason ?? null,
				},
				grading: { ...grading, path: gradingPath },
				mutationOccurred: result.mutationOccurred,
				changedFiles: result.changedFiles,
				modelPatchBytes:
					result.prediction === null ? null : Buffer.byteLength(result.prediction.model_patch, "utf8"),
				predictionPath: result.predictionPath,
				predictionError: result.predictionError,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	process.stdout.write(
		`${JSON.stringify({
			instance_id: result.instance.instance_id,
			model_name_or_path: result.prediction?.model_name_or_path ?? null,
			predictionPath: result.predictionPath,
			summaryPath,
			gradingPath,
			agentStatus: deriveAgentExecutionStatus(result),
			gradingStatus: grading.normalizedStatus,
		})}\n`,
	);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	void runSWEbenchCli().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
