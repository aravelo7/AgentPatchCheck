import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getGitStdout } from "../workspace/git-utils";
import { type DeepSeekV4Model, parseDeepSeekV4Model } from "./deepseek-v4-model";
import { findAgentPatchCheckProjectRoot, initializeAgentPatchCheckEnvironment } from "./project-environment";
import {
	createSWEbenchModelNameOrPath,
	createSWEbenchRuntimeConfiguration,
	loadSWEbenchInstance,
	resolveSWEbenchRepositoryRoot,
	runSWEbenchInstance,
	SWE_BENCH_MULTILINGUAL_DATASET,
	SWE_BENCH_STANDARD_BASELINE_TAG,
	type SWEbenchAdapterResult,
} from "./swebench-adapter";

const SWE_BENCH_EVALUATOR_BRIDGE_PATH = fileURLToPath(
	new URL("../../scripts/swebench-verification-bridge.mjs", import.meta.url),
);
const SWE_BENCH_BOOTSTRAP_MANIFEST = join(
	".agentpatchcheck",
	"swebench",
	"datasets",
	"APC-Pilot-10-v1-formal.manifest.json",
);
const SWE_BENCH_EVALUATOR_ROOT_ENV = "AGENTPATCHCHECK_SWEBENCH_EVALUATOR_ROOT";
const SWE_BENCH_EVALUATOR_PYTHON_ENV = "AGENTPATCHCHECK_SWEBENCH_EVALUATOR_PYTHON";
const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u;
const ARTIFACT_SEGMENT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u;

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
	evaluatorVersion: string;
}

interface CliOptions {
	instance: string;
	runId: string;
	variant?: string;
	attempt?: number;
}

export interface SWEbenchBootstrapConfiguration {
	manifestPath: string;
	manifestName: string;
	manifestVersion: string;
	datasetPath: string;
	evaluatorDatasetPath: string;
	evaluatorRevision: string;
	evaluatorTimeoutSeconds: number;
	evaluatorSourceRoot: string;
	evaluatorPythonPath: string;
	deepseekModel: DeepSeekV4Model;
	classification: "formal-frozen" | "engineering-validation";
	engineeringValidation: boolean;
	instanceIds: readonly string[];
}

interface SWEbenchBootstrapManifest {
	name: string;
	version: string;
	fullSubset: { path: string };
	evaluator: { dataset: string; revision: string; timeoutSeconds: number };
	execution: { classification: "formal-frozen" | "engineering-validation"; deepseekModel: string };
	instanceIds: string[];
}

type SWEbenchSourceIdentity =
	| {
			classification: "formal-frozen";
			head: string;
			baselineTag: string;
			dirty: false;
			statusPorcelain: "";
			sourceLabel: string;
	  }
	| {
			classification: "engineering-validation";
			head: string;
			baselineTag: null;
			dirty: boolean;
			statusPorcelain: string;
			sourceLabel: string;
	  };

interface SWEbenchPostRunEvaluatorInput {
	predictionPath: string;
	datasetPath: string;
	instanceId: string;
	configuration: SWEbenchEvaluatorConfiguration;
}

export interface SWEbenchEvaluatorPreflightInput {
	evaluatorPythonPath: string;
	evaluatorSourceRoot: string;
	datasetPath: string;
	expectedRevision: string;
}

export type SWEbenchEvaluatorDependencyProbe = (pythonPath: string) => Promise<boolean>;
export type SWEbenchEvaluatorRevisionProbe = (sourceRoot: string) => Promise<string>;

const defaultSWEbenchEvaluatorDependencyProbe: SWEbenchEvaluatorDependencyProbe = async (pythonPath) =>
	await new Promise<boolean>((resolveProbe) => {
		const child = spawn(pythonPath, ["-c", "import docker"], { shell: false, windowsHide: true, stdio: "ignore" });
		child.once("error", () => resolveProbe(false));
		child.once("close", (exitCode) => resolveProbe(exitCode === 0));
	});

const defaultSWEbenchEvaluatorRevisionProbe: SWEbenchEvaluatorRevisionProbe = async (sourceRoot) =>
	await getGitStdout(["-c", `safe.directory=${resolve(sourceRoot)}`, "rev-parse", "HEAD"], resolve(sourceRoot));

function requireManifestString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`SWE-bench bootstrap manifest ${field} is required.`);
	return value.trim();
}

function requireProjectEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string {
	const value = environment[name]?.trim();
	if (!value) throw new Error(`SWE-bench machine prerequisite is not configured: ${name}`);
	return resolve(value);
}

function resolveManifestPath(manifestDirectory: string, value: unknown, field: string): string {
	const path = requireManifestString(value, field);
	return resolve(manifestDirectory, path);
}

export async function loadSWEbenchBootstrapConfiguration(
	projectRoot: string,
	environment: NodeJS.ProcessEnv = process.env,
): Promise<SWEbenchBootstrapConfiguration> {
	const manifestPath = resolve(projectRoot, SWE_BENCH_BOOTSTRAP_MANIFEST);
	let value: unknown;
	try {
		value = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
	} catch (error) {
		throw new Error(`Could not load canonical SWE-bench bootstrap manifest: ${manifestPath}`, { cause: error });
	}
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("SWE-bench bootstrap manifest must be a JSON object.");
	const manifest = value as Partial<SWEbenchBootstrapManifest>;
	const manifestName = requireManifestString(manifest.name, "name");
	const manifestVersion = requireManifestString(manifest.version, "version");
	if (manifest.fullSubset === undefined || manifest.evaluator === undefined || manifest.execution === undefined)
		throw new Error("SWE-bench bootstrap manifest is missing its dataset, evaluator, or execution contract.");
	if (!Array.isArray(manifest.instanceIds) || manifest.instanceIds.some((instanceId) => typeof instanceId !== "string"))
		throw new Error("SWE-bench bootstrap manifest instanceIds must be an array of strings.");
	const revision = requireManifestString(manifest.evaluator.revision, "evaluator.revision");
	if (!/^[0-9a-f]{40}$/u.test(revision)) throw new Error("SWE-bench bootstrap evaluator revision must be a full commit SHA.");
	if (!Number.isSafeInteger(manifest.evaluator.timeoutSeconds) || manifest.evaluator.timeoutSeconds <= 0)
		throw new Error("SWE-bench bootstrap evaluator timeoutSeconds must be a positive integer.");
	if (manifest.execution.classification !== "formal-frozen" && manifest.execution.classification !== "engineering-validation")
		throw new Error("SWE-bench bootstrap execution classification is invalid.");
	const manifestDirectory = dirname(manifestPath);
	return {
		manifestPath,
		manifestName,
		manifestVersion,
		datasetPath: resolveManifestPath(manifestDirectory, manifest.fullSubset.path, "fullSubset.path"),
		evaluatorDatasetPath: resolveManifestPath(manifestDirectory, manifest.evaluator.dataset, "evaluator.dataset"),
		evaluatorRevision: revision,
		evaluatorTimeoutSeconds: manifest.evaluator.timeoutSeconds,
		evaluatorSourceRoot: requireProjectEnvironmentValue(environment, SWE_BENCH_EVALUATOR_ROOT_ENV),
		evaluatorPythonPath: requireProjectEnvironmentValue(environment, SWE_BENCH_EVALUATOR_PYTHON_ENV),
		deepseekModel: parseDeepSeekV4Model(requireManifestString(manifest.execution.deepseekModel, "execution.deepseekModel")),
		classification: manifest.execution.classification,
		engineeringValidation: manifest.execution.classification === "engineering-validation",
		instanceIds: [...manifest.instanceIds],
	};
}

export class SWEbenchEvaluatorPreflightError extends Error {
	readonly code = "evaluator_preflight_failed" as const;
	readonly failedChecks: readonly string[];
	readonly evaluatorSourceRoot: string;
	readonly expectedRevision: string;
	readonly actualRevision: string | null;

	constructor(
		failedChecks: readonly string[],
		evaluatorSourceRoot: string,
		expectedRevision = "<not-configured>",
		actualRevision: string | null = null,
	) {
		super(
			`evaluator_preflight_failed: ${failedChecks.join(", ")}; evaluatorSourceRoot=${evaluatorSourceRoot}; expectedRevision=${expectedRevision}; actualRevision=${actualRevision ?? "<unavailable>"}`,
		);
		this.name = "SWEbenchEvaluatorPreflightError";
		this.failedChecks = failedChecks;
		this.evaluatorSourceRoot = evaluatorSourceRoot;
		this.expectedRevision = expectedRevision;
		this.actualRevision = actualRevision;
	}
}

export async function preflightSWEbenchEvaluator(
	input: SWEbenchEvaluatorPreflightInput,
	dependencyProbe: SWEbenchEvaluatorDependencyProbe = defaultSWEbenchEvaluatorDependencyProbe,
	revisionProbe: SWEbenchEvaluatorRevisionProbe = defaultSWEbenchEvaluatorRevisionProbe,
): Promise<void> {
	const evaluatorSourceRoot = resolve(input.evaluatorSourceRoot);
	const evaluatorPythonPath = resolve(input.evaluatorPythonPath);
	const datasetPath = resolve(input.datasetPath);
	const failedChecks: string[] = [];
	let actualRevision: string | null = null;

	try {
		if (!(await stat(evaluatorSourceRoot)).isDirectory()) failedChecks.push("evaluator-source-root-not-directory");
	} catch {
		failedChecks.push("evaluator-source-root-missing");
	}
	try {
		await access(join(evaluatorSourceRoot, "swebench", "harness", "run_evaluation.py"), constants.R_OK);
	} catch {
		failedChecks.push("run_evaluation.py-unreadable");
	}
	try {
		await access(evaluatorPythonPath, constants.F_OK | constants.X_OK);
	} catch {
		failedChecks.push("evaluator-python-unavailable");
	}
	try {
		await access(datasetPath, constants.F_OK | constants.R_OK);
	} catch {
		failedChecks.push("full-evaluator-dataset-unreadable");
	}
	if (failedChecks.length === 0 && !(await dependencyProbe(evaluatorPythonPath)))
		failedChecks.push("evaluator-python-docker-module-unavailable");
	if (!failedChecks.includes("evaluator-source-root-missing") && !failedChecks.includes("evaluator-source-root-not-directory")) {
		try {
			actualRevision = (await revisionProbe(evaluatorSourceRoot)).trim();
			if (actualRevision !== input.expectedRevision) failedChecks.push("evaluator-revision-mismatch");
		} catch {
			failedChecks.push("evaluator-revision-unavailable");
		}
	}

	if (failedChecks.length > 0)
		throw new SWEbenchEvaluatorPreflightError(
			failedChecks,
			evaluatorSourceRoot,
			input.expectedRevision,
			actualRevision,
		);
}

interface SWEbenchCliDependencies {
	initializeEnvironment: typeof initializeAgentPatchCheckEnvironment;
	findProjectRoot: typeof findAgentPatchCheckProjectRoot;
	loadBootstrapConfiguration: typeof loadSWEbenchBootstrapConfiguration;
	getGitStdout: typeof getGitStdout;
	loadInstance: typeof loadSWEbenchInstance;
	resolveRepositoryRoot: typeof resolveSWEbenchRepositoryRoot;
	runEvaluatorPreflight: typeof preflightSWEbenchEvaluator;
	runInstance: typeof runSWEbenchInstance;
	runPostRunEvaluator: typeof runSWEbenchPostRunEvaluator;
}

const defaultDependencies: SWEbenchCliDependencies = {
	initializeEnvironment: initializeAgentPatchCheckEnvironment,
	findProjectRoot: findAgentPatchCheckProjectRoot,
	loadBootstrapConfiguration: loadSWEbenchBootstrapConfiguration,
	getGitStdout,
	loadInstance: loadSWEbenchInstance,
	resolveRepositoryRoot: resolveSWEbenchRepositoryRoot,
	runEvaluatorPreflight: preflightSWEbenchEvaluator,
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

const OPERATOR_OPTIONS = new Set(["--instance", "--run-id", "--variant", "--attempt"]);
const CONFIGURED_OPTIONS = new Set([
	"--dataset",
	"--evaluator-dataset",
	"--repository",
	"--output",
	"--deepseek-model",
	"--engineering-validation",
	"--model-name-or-path",
	"--evaluator-python",
	"--evaluator-source-root",
	"--evaluator-artifact-root",
	"--artifact-root",
	"--evaluator-timeout-seconds",
	"--evaluator-version",
]);

function assertCanonicalOperatorArguments(argv: string[]): void {
	for (let index = 0; index < argv.length; index += 2) {
		const name = argv[index];
		if (name === undefined || !name.startsWith("--")) throw new Error(`Unexpected SWE-bench CLI argument: ${name ?? "<missing>"}`);
		if (CONFIGURED_OPTIONS.has(name))
			throw new Error(`${name} is owned by the canonical SWE-bench bootstrap configuration and is no longer accepted.`);
		if (!OPERATOR_OPTIONS.has(name)) throw new Error(`Unknown SWE-bench CLI option: ${name}`);
		const value = argv[index + 1];
		if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for option: ${name}`);
	}
}

function requireArtifactSegment(value: string, label: string, pattern = ARTIFACT_SEGMENT_PATTERN): string {
	const normalized = value.trim();
	if (!pattern.test(normalized)) throw new Error(`${label} is invalid.`);
	return normalized;
}

function parseOptions(argv: string[]): CliOptions {
	assertCanonicalOperatorArguments(argv);
	const runId = requireArtifactSegment(optionValue(argv, "--run-id") as string, "--run-id", RUN_ID_PATTERN);
	const variantValue = optionValue(argv, "--variant", false);
	return {
		instance: optionValue(argv, "--instance") as string,
		runId,
		variant: variantValue === undefined ? undefined : requireArtifactSegment(variantValue, "--variant"),
		attempt: (() => {
			const value = optionValue(argv, "--attempt", false);
			if (value === undefined) return undefined;
			const parsed = Number(value);
			if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("--attempt must be a positive integer.");
			return parsed;
		})(),
	};
}

async function ensureWritableDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true });
	const probePath = join(path, `.apc-write-probe-${randomUUID()}`);
	const probe = await open(probePath, "wx");
	try {
		await probe.sync();
	} finally {
		await probe.close();
		await unlink(probePath).catch(() => undefined);
	}
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

function deriveCandidateValidity(result: SWEbenchAdapterResult, grading: SWEbenchGradingResult): {
	executionValidity: "valid" | "invalid";
	pass1Eligible: boolean;
	predictionStatus: "generated" | "not_generated";
	gradingValidity: "valid" | "grading_invalid" | "not_run";
} {
	const agentStarted = result.agent.runtimeEvents?.some((event) => event.type === "attempt-started") === true;
	const executionValidity = result.failure?.stage === "agent-execution" && !agentStarted ? "invalid" : "valid";
	return {
		executionValidity,
		pass1Eligible: executionValidity === "valid",
		predictionStatus: result.prediction === null ? "not_generated" : "generated",
		gradingValidity:
			grading.normalizedStatus === "infrastructure_error" || grading.normalizedStatus === "grading_error_or_ambiguous"
				? "grading_invalid"
				: grading.normalizedStatus === "not_run"
					? "not_run"
					: "valid",
	};
}

async function resolveSWEbenchSourceIdentity(
	projectRoot: string,
	getStdout: SWEbenchCliDependencies["getGitStdout"],
	engineeringValidation: boolean,
): Promise<SWEbenchSourceIdentity> {
	const currentCommit = await getStdout(["rev-parse", "HEAD"], projectRoot);
	if (engineeringValidation) {
		const statusPorcelain = await getStdout(["status", "--porcelain", "--untracked-files=all"], projectRoot);
		return {
			classification: "engineering-validation",
			head: currentCommit,
			baselineTag: null,
			dirty: statusPorcelain.length > 0,
			statusPorcelain,
			sourceLabel: `engineering-validation-${currentCommit.slice(0, 12)}`,
		};
	}
	const expectedCommit = await getStdout(
		["rev-parse", "--verify", `${SWE_BENCH_STANDARD_BASELINE_TAG}^{commit}`],
		projectRoot,
	);
	if (currentCommit !== expectedCommit) {
		throw new Error(
			`SWE-bench standard mode must run from baseline tag ${SWE_BENCH_STANDARD_BASELINE_TAG} (${expectedCommit}); current HEAD is ${currentCommit}.`,
		);
	}
	const statusPorcelain = await getStdout(["status", "--porcelain", "--untracked-files=no"], projectRoot);
	if (statusPorcelain) {
		throw new Error("SWE-bench standard mode requires a clean tracked source worktree.");
	}
	return {
		classification: "formal-frozen",
		head: currentCommit,
		baselineTag: SWE_BENCH_STANDARD_BASELINE_TAG,
		dirty: false,
		statusPorcelain: "",
		sourceLabel: SWE_BENCH_STANDARD_BASELINE_TAG,
	};
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
	const projectRoot = resolvedDependencies.findProjectRoot();
	const bootstrap = await resolvedDependencies.loadBootstrapConfiguration(projectRoot);
	const options = parseOptions(argv);
	if (!bootstrap.instanceIds.includes(options.instance))
		throw new Error(`SWE-bench instance is not part of ${bootstrap.manifestName} ${bootstrap.manifestVersion}: ${options.instance}`);
	const outputVariant = options.variant ?? `${bootstrap.manifestName}-${bootstrap.manifestVersion}`;
	const outputDirectory = resolve(
		projectRoot,
		".agentpatchcheck",
		"swebench",
		"results",
		outputVariant,
		options.instance,
	);
	const outputPath = join(outputDirectory, `${options.runId}.prediction.jsonl`);
	const artifactRoot = join(outputDirectory, "evaluator-artifacts");
	await ensureWritableDirectory(outputDirectory);
	await ensureWritableDirectory(artifactRoot);
	const evaluator: SWEbenchEvaluatorConfiguration = {
		evaluatorPythonPath: bootstrap.evaluatorPythonPath,
		evaluatorSourceRoot: bootstrap.evaluatorSourceRoot,
		artifactRoot,
		timeoutSeconds: bootstrap.evaluatorTimeoutSeconds,
		evaluatorVersion: bootstrap.evaluatorRevision,
	};
	await resolvedDependencies.runEvaluatorPreflight({
		evaluatorPythonPath: evaluator.evaluatorPythonPath,
		evaluatorSourceRoot: evaluator.evaluatorSourceRoot,
		datasetPath: bootstrap.evaluatorDatasetPath,
		expectedRevision: bootstrap.evaluatorRevision,
	});
	const source = await resolveSWEbenchSourceIdentity(
		projectRoot,
		resolvedDependencies.getGitStdout,
		bootstrap.engineeringValidation,
	);
	const instance = await resolvedDependencies.loadInstance(bootstrap.datasetPath, options.instance);
	const repositoryRoot = await resolvedDependencies.resolveRepositoryRoot(projectRoot, instance, resolvedDependencies.getGitStdout);
	const runtime = createSWEbenchRuntimeConfiguration(bootstrap.deepseekModel);
	if (bootstrap.engineeringValidation) {
		runtime.dockerTaskEnvironment = {
			image: {
				instanceId: instance.instance_id,
				arch: "x86_64",
				namespace: "swebench",
				instanceImageTag: "latest",
			},
		};
	};
	const result = await resolvedDependencies.runInstance({
		instance,
		repositoryRoot,
		outputPath,
		modelNameOrPath: createSWEbenchModelNameOrPath(bootstrap.deepseekModel, source.sourceLabel),
		sourceLabel: source.sourceLabel,
		runtime,
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
				datasetPath: bootstrap.evaluatorDatasetPath,
				instanceId: result.instance.instance_id,
				configuration: evaluator,
			});
		} catch {
			grading = {
				version: 2,
				instanceId: result.instance.instance_id,
				normalizedStatus: "infrastructure_error",
				reason: "post_run_evaluator_invocation_failed",
				officialReportPath: null,
				officialRunId: null,
				evaluatorVersion: evaluator.evaluatorVersion,
			};
		}
	}
	const gradingPath = resolve(outputDirectory, `${result.runId}.swebench-grading.json`);
	await writeFile(gradingPath, `${JSON.stringify(grading, null, 2)}\n`, "utf8");
	const summaryPath = resolve(outputDirectory, `${result.runId}.apc-run.json`);
	await writeFile(
		summaryPath,
		`${JSON.stringify(
			{
				version: 2,
				dataset: SWE_BENCH_MULTILINGUAL_DATASET,
				bootstrapManifest: bootstrap.manifestPath,
				apcBaselineCommit: source.classification === "formal-frozen" ? source.head : null,
				runClassification: source.classification,
				source,
				instanceId: result.instance.instance_id,
				baseCommit: result.instance.base_commit,
				runId: result.runId,
				runIdentity: result.runIdentity,
				repository: result.instance.repo,
				model: result.runIdentity.model,
				runConfiguration: {
					deepseekModel: bootstrap.deepseekModel,
					variant: options.variant ?? null,
					attempt: options.attempt ?? 1,
					evaluatorTimeoutSeconds: evaluator.timeoutSeconds,
					evaluatorVersion: evaluator.evaluatorVersion,
					outputDirectory,
					evaluatorArtifactRoot: artifactRoot,
				},
				workspacePath: result.workspace?.path ?? null,
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
				failure: result.failure,
				candidateValidity: deriveCandidateValidity(result, grading),
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
