import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { getGitStdout, runGit } from "../workspace/git-utils";
import { getAgentAdapter } from "./agent-adapter";
import { type DeepSeekV4Model, parseDeepSeekV4Model } from "./deepseek-v4-model";
import { createIsolatedWorkspace } from "./isolated-workspace";
import {
	createSWEbenchDockerTaskEnvironment,
	type SWEbenchDockerTaskEnvironment,
	type SWEbenchDockerTaskEnvironmentConfiguration,
} from "./swebench-docker-task-environment";
import type { HarnessNativeRepositoryPrimitives } from "./harness-native-runtime";
import { createRunId, type RunIdentity } from "./run-identity";
import { getHarnessNativeRuntimeRecordPath } from "./runtime-record";
import { validateTaskPolicy } from "./task-policy";
import type {
	AgentExecution,
	HarnessNativeAgentInput,
	IsolatedWorkspace,
	TaskPolicy,
	VerificationPolicyInput,
} from "./types";

const INSTANCE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*__[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;
const REPOSITORY_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

export const SWE_BENCH_MULTILINGUAL_DATASET = "swe-bench/SWE-Bench_Multilingual";
export const SWE_BENCH_STANDARD_BASELINE_TAG = "v0.4-swebench-dataset-boundary-baseline";
export const AGENTPATCHCHECK_BASELINE_MODEL = "deepseek-v4-flash";
export const AGENTPATCHCHECK_DEVELOPMENT_MODEL = "deepseek-v4-flash";

/**
 * The only SWE-bench instance data permitted to cross into Agent execution.
 * Evaluator-only fields stay owned by the Benchmark Runner.
 */
export interface SWEbenchAgentSafeInstance {
	instance_id: string;
	repo: string;
	base_commit: string;
	problem_statement: string;
}

export class SWEbenchRepositoryResolutionError extends Error {
	readonly code = "swebench-repository-mismatch" as const;

	constructor(
		readonly instanceId: string,
		readonly expectedRepository: string,
		readonly expectedPath: string,
		readonly resolvedRepository: string,
		readonly resolvedPath: string,
		cause?: unknown,
	) {
		super(
			`SWE-bench repository mismatch for ${instanceId}: expected repository ${expectedRepository} at ${expectedPath}; resolved repository ${resolvedRepository} at ${resolvedPath}.`,
			{ cause },
		);
		this.name = "SWEbenchRepositoryResolutionError";
	}
}

/** @deprecated Use SWEbenchAgentSafeInstance to make the boundary explicit. */
export type SWEbenchInstance = SWEbenchAgentSafeInstance;

export interface SWEbenchPrediction {
	instance_id: string;
	model_patch: string;
	model_name_or_path: string;
}

export interface SWEbenchAdapterFailure {
	stage: "agent-execution" | "prediction-export";
	message: string;
}

/** Final prediction export is restricted to successful Runtime mutation events. */
export function collectSWEbenchMutationPaths(agent: AgentExecution): string[] {
	const paths = new Set<string>();
	for (const event of agent.runtimeEvents ?? []) {
		if (event.type !== "tool-result" || event.status !== "ok" || event.facts.kind !== "mutation") continue;
		for (const path of event.facts.affectedPaths) paths.add(path);
	}
	return [...paths].sort((left, right) => left.localeCompare(right));
}

export interface SWEbenchRuntimeConfiguration {
	model: string;
	nativeAgent: HarnessNativeAgentInput;
	timeoutMs: number;
	/**
	 * Repository-public commands supplied by the development launcher. Formal
	 * SWE-bench runs deliberately do not expose this verification profile.
	 */
	developmentVerification?: VerificationPolicyInput;
	/** Explicit, seen-development profiles; never exposed to formal runs. */
	developmentVerificationProfiles?: Readonly<Record<string, VerificationPolicyInput>>;
	/** Engineering-validation only: one persistent official task container. */
	dockerTaskEnvironment?: SWEbenchDockerTaskEnvironmentConfiguration;
}

export interface SWEbenchAdapterOptions {
	instance: SWEbenchAgentSafeInstance;
	repositoryRoot: string;
	outputPath: string;
	modelNameOrPath?: string;
	sourceLabel?: string;
	runId?: string;
	variant?: string;
	attempt?: number;
	runtime?: SWEbenchRuntimeConfiguration;
}

export interface SWEbenchAdapterResult {
	instance: SWEbenchInstance;
	runId: string;
	runIdentity: RunIdentity;
	workspace: IsolatedWorkspace | null;
	agent: AgentExecution;
	mutationOccurred: boolean;
	changedFiles: string[];
	prediction: SWEbenchPrediction | null;
	predictionPath: string | null;
	predictionError: "prediction_export_failed" | null;
	failure: SWEbenchAdapterFailure | null;
	runtimeRecordPath: string;
}

export interface SWEbenchAdapterDependencies {
	validatePolicy: typeof validateTaskPolicy;
	createWorkspace: typeof createIsolatedWorkspace;
	executeAgent: (
		policy: TaskPolicy,
		worktreePath: string,
		repository?: HarnessNativeRepositoryPrimitives,
	) => Promise<AgentExecution>;
	collectModelPatch: typeof collectSWEbenchModelPatch;
	createDockerTaskEnvironment: typeof createSWEbenchDockerTaskEnvironment;
}

const defaultRuntime: SWEbenchRuntimeConfiguration = {
	model: AGENTPATCHCHECK_BASELINE_MODEL,
	developmentVerificationProfiles: {
		// Repository-public package.json script at axios base commit.
		"axios__axios-4738": { commands: [{ command: "npm", args: ["test"], timeoutMs: 120_000 }] },
		// Repository-public CMake build entrypoint at fmt base commit.
		"fmtlib__fmt-1683": {
			commands: [
				{ command: "cmake", args: ["--build", "build", "--parallel", "2"], timeoutMs: 120_000 },
				{ command: "ctest", args: ["--test-dir", "build", "--output-on-failure"], timeoutMs: 120_000 },
			],
		},
		// Repository-public Go module test entrypoint at gin base commit.
		"gin-gonic__gin-2755": { commands: [{ command: "go", args: ["test", "./..."], timeoutMs: 120_000 }] },
	},
	nativeAgent: {
		provider: "deepseek",
		protocol: "chat-completions",
		thinkingMode: "enabled",
		reasoningEffort: "high",
		baseUrl: "https://api.deepseek.com/v1",
		credentialRef: "deepseek-primary",
		maxIterations: 24,
		maxToolCalls: 48,
		maxRejectedToolCalls: 4,
		maxObservationBytes: 16_384,
		maxTransportRetries: 2,
		maxProtocolRecoveries: 2,
		maxCompletionDeferrals: 2,
		maxPlanRevisions: 4,
		plannerEnabled: false,
	},
	timeoutMs: 1_200_000,
};

export function createSWEbenchRuntimeConfiguration(model: DeepSeekV4Model): SWEbenchRuntimeConfiguration {
	return { ...defaultRuntime, model };
}

function resolveDevelopmentVerification(
	sourceLabel: string | undefined,
	instanceId: string,
	runtime: SWEbenchRuntimeConfiguration,
): VerificationPolicyInput {
	return sourceLabel?.startsWith("engineering-validation-") === true
		? (runtime.developmentVerification ?? runtime.developmentVerificationProfiles?.[instanceId] ?? { commands: [] })
		: { commands: [] };
}

export function createSWEbenchModelNameOrPath(
	model: DeepSeekV4Model,
	sourceLabel = SWE_BENCH_STANDARD_BASELINE_TAG,
): string {
	return `agentpatchcheck/${sourceLabel}/${model}`;
}

function requireString(value: unknown, field: keyof SWEbenchAgentSafeInstance): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`SWE-bench instance field ${field} is required.`);
	return value;
}

function parseInstance(value: unknown): SWEbenchAgentSafeInstance {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("SWE-bench dataset row must be an object.");
	}
	const row = value as Record<string, unknown>;
	const instance = {
		instance_id: requireString(row.instance_id, "instance_id"),
		repo: requireString(row.repo, "repo"),
		base_commit: requireString(row.base_commit, "base_commit"),
		problem_statement: requireString(row.problem_statement, "problem_statement"),
	};
	if (!INSTANCE_ID_PATTERN.test(instance.instance_id)) throw new Error("SWE-bench instance_id is invalid.");
	if (!REPOSITORY_PATTERN.test(instance.repo)) throw new Error("SWE-bench repo is invalid.");
	if (!COMMIT_PATTERN.test(instance.base_commit)) throw new Error("SWE-bench base_commit must be a full Git SHA.");
	return instance;
}

export async function loadSWEbenchInstance(
	datasetPath: string,
	instanceId: string,
): Promise<SWEbenchAgentSafeInstance> {
	const requestedId = instanceId.trim();
	if (!INSTANCE_ID_PATTERN.test(requestedId)) throw new Error("Requested SWE-bench instance_id is invalid.");
	const lines = (await readFile(resolve(datasetPath), "utf8")).split(/\r?\n/u).filter((line) => line.trim());
	let match: SWEbenchAgentSafeInstance | null = null;
	for (const line of lines) {
		const raw: unknown = JSON.parse(line);
		if (
			raw !== null &&
			typeof raw === "object" &&
			!Array.isArray(raw) &&
			(raw as Record<string, unknown>).instance_id === requestedId
		) {
			if (match !== null) throw new Error(`Duplicate SWE-bench instance_id: ${requestedId}`);
			match = parseInstance(raw);
		}
	}
	if (match === null) throw new Error(`SWE-bench instance not found: ${requestedId}`);
	return match;
}

function normalizeRepositoryIdentity(value: string): string {
	return value
		.trim()
		.replace(/^git@github\.com:/u, "https://github.com/")
		.replace(/^https?:\/\/github\.com\//u, "")
		.replace(/\.git$/u, "")
		.replace(/\/+$/u, "");
}

export async function validateSWEbenchRepositoryRoot(
	repositoryRoot: string,
	instance: Pick<SWEbenchAgentSafeInstance, "instance_id" | "repo">,
	getStdout: typeof getGitStdout = getGitStdout,
): Promise<string> {
	const expectedPath = resolve(repositoryRoot);
	let resolvedPath = expectedPath;
	let resolvedRepository = "<not-a-git-repository>";
	try {
		resolvedPath = resolve(await getStdout(["rev-parse", "--show-toplevel"], expectedPath));
		resolvedRepository = normalizeRepositoryIdentity(await getStdout(["config", "--get", "remote.origin.url"], resolvedPath));
	} catch (error) {
		throw new SWEbenchRepositoryResolutionError(
			instance.instance_id,
			instance.repo,
			expectedPath,
			resolvedRepository,
			resolvedPath,
			error,
		);
	}
	if (resolvedRepository !== instance.repo) {
		throw new SWEbenchRepositoryResolutionError(
			instance.instance_id,
			instance.repo,
			expectedPath,
			resolvedRepository,
			resolvedPath,
		);
	}
	return resolvedPath;
}

export async function resolveSWEbenchRepositoryRoot(
	projectRoot: string,
	instance: Pick<SWEbenchAgentSafeInstance, "instance_id" | "repo">,
	getStdout: typeof getGitStdout = getGitStdout,
): Promise<string> {
	const repositoryDirectory = instance.repo.replace("/", "__");
	const expectedPath = join(resolve(projectRoot), ".agentpatchcheck", "swebench", "repositories", repositoryDirectory);
	return await validateSWEbenchRepositoryRoot(expectedPath, instance, getStdout);
}

export function createSWEbenchPrediction(
	instanceId: string,
	modelPatch: string,
	modelNameOrPath: string,
): SWEbenchPrediction {
	const normalizedModel = modelNameOrPath.trim();
	if (!normalizedModel) throw new Error("SWE-bench model_name_or_path is required.");
	return { instance_id: instanceId, model_patch: modelPatch, model_name_or_path: normalizedModel };
}

export async function collectSWEbenchModelPatch(
	worktreePath: string,
	baseCommit: string,
	mutationPaths: readonly string[],
): Promise<{ modelPatch: string; changedFiles: string[] }> {
	const paths = [...new Set(mutationPaths)].sort((left, right) => left.localeCompare(right));
	if (paths.length === 0) return { modelPatch: "", changedFiles: [] };
	const [trackedPatch, trackedNames, untrackedNames] = await Promise.all([
		getGitStdout(["diff", "--binary", baseCommit, "--", ...paths], worktreePath, { trimStdout: false }),
		getGitStdout(["diff", "--name-only", baseCommit, "--", ...paths], worktreePath),
		getGitStdout(["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths], worktreePath, {
			trimStdout: false,
		}),
	]);
	const untrackedPaths = untrackedNames.split("\0").filter(Boolean).sort((left, right) => left.localeCompare(right));
	const untrackedPatches: string[] = [];
	for (const path of untrackedPaths) {
		const patch = await runGit(worktreePath, ["diff", "--no-index", "--binary", "--", "/dev/null", path], {
			trimStdout: false,
		});
		if (patch.exitCode !== 0 && patch.exitCode !== 1)
			throw new Error(patch.error ?? `Could not export untracked SWE-bench mutation ${path}.`);
		untrackedPatches.push(patch.stdout);
	}
	const changedFiles = [...new Set([...trackedNames.split("\n").filter(Boolean), ...untrackedPaths])].sort((left, right) =>
		left.localeCompare(right),
	);
	return { modelPatch: `${trackedPatch}${untrackedPatches.join("")}`, changedFiles };
}

const defaultDependencies: SWEbenchAdapterDependencies = {
	validatePolicy: validateTaskPolicy,
	createWorkspace: createIsolatedWorkspace,
	executeAgent: async (policy, worktreePath, repository) =>
		await getAgentAdapter(policy.agentAdapter).execute({
			policy,
			worktreePath,
			repository,
			repairContext: { phase: "initial", publicVerificationFeedback: null, repairInstruction: null },
		}),
	collectModelPatch: collectSWEbenchModelPatch,
	createDockerTaskEnvironment: createSWEbenchDockerTaskEnvironment,
};

export async function runSWEbenchInstance(
	options: SWEbenchAdapterOptions,
	dependencies: Partial<SWEbenchAdapterDependencies> = {},
): Promise<SWEbenchAdapterResult> {
	const resolvedDependencies = { ...defaultDependencies, ...dependencies };
	const instance = options.instance;
	const repositoryRoot = resolve(options.repositoryRoot);
	const runtime = options.runtime ?? defaultRuntime;
	const model = parseDeepSeekV4Model(runtime.model);
	const modelNameOrPath = createSWEbenchModelNameOrPath(model, options.sourceLabel);
	const verification = resolveDevelopmentVerification(options.sourceLabel, instance.instance_id, runtime);
	if (options.modelNameOrPath !== undefined && options.modelNameOrPath !== modelNameOrPath) {
		throw new Error("SWE-bench model_name_or_path is derived from the selected DeepSeek runtime model.");
	}
	const runIdentity = {
		experiment: SWE_BENCH_MULTILINGUAL_DATASET,
		task: instance.instance_id,
		variant: options.variant ?? modelNameOrPath,
		attempt: options.attempt ?? 1,
		repository: instance.repo,
		baseCommit: instance.base_commit,
		model,
		benchmark: SWE_BENCH_MULTILINGUAL_DATASET,
	};
	const runId = options.runId?.trim() || createRunId(runIdentity, "sb");
	const worktreeRoot = join(repositoryRoot, ".agentpatchcheck", "worktrees");
	const policy = await resolvedDependencies.validatePolicy({
		repositoryRoot,
		baseRef: instance.base_commit,
		worktreeRoot,
		runId,
		runIdentity,
		prompt: instance.problem_statement,
		agentAdapter: "harness-native",
		model,
		nativeAgent: runtime.nativeAgent,
		timeoutMs: runtime.timeoutMs,
		sandbox: "workspace-write",
		allowNetwork: false,
		verification,
		patchExpectation: "changes-required",
	});
	const dockerEnabled = options.sourceLabel?.startsWith("engineering-validation-") === true && runtime.dockerTaskEnvironment !== undefined;
	const dockerConfiguration = runtime.dockerTaskEnvironment;
	let dockerEnvironment: SWEbenchDockerTaskEnvironment | null = null;
	if (dockerEnabled) {
		if (dockerConfiguration === undefined)
			throw new Error("Engineering Docker task environment requires an explicit safe image configuration.");
		dockerEnvironment = await resolvedDependencies.createDockerTaskEnvironment({ runId, configuration: dockerConfiguration });
	}
	const workspace = dockerEnvironment === null
		? await resolvedDependencies.createWorkspace({
				repositoryPath: policy.repositoryRoot,
				runId,
				baseRef: policy.baseRef,
				baseCommit: policy.baseCommit,
				worktreeRoot: policy.worktreeRoot,
			})
		: null;
	let agent: AgentExecution | undefined;
	let prediction: SWEbenchPrediction | null = null;
	let predictionPath: string | null = null;
	let changedFiles: string[] = [];
	let predictionError: SWEbenchAdapterResult["predictionError"] = null;
	let failure: SWEbenchAdapterFailure | null = null;
	try {
		agent = await resolvedDependencies.executeAgent(policy, dockerEnvironment?.path ?? workspace?.path ?? "", dockerEnvironment?.repository);
		const mutationPaths = collectSWEbenchMutationPaths(agent);
		const collected = dockerEnvironment === null
			? await resolvedDependencies.collectModelPatch(workspace?.path ?? "", instance.base_commit, mutationPaths)
			: await dockerEnvironment.collectModelPatch(instance.base_commit, mutationPaths);
		changedFiles = collected.changedFiles;
		prediction = createSWEbenchPrediction(instance.instance_id, collected.modelPatch, modelNameOrPath);
		predictionPath = resolve(options.outputPath);
		await mkdir(dirname(predictionPath), { recursive: true });
		await writeFile(predictionPath, `${JSON.stringify(prediction)}\n`, "utf8");
	} catch (error) {
		failure = {
			stage: agent === undefined ? "agent-execution" : "prediction-export",
			message: error instanceof Error ? error.message : String(error),
		};
		predictionError = "prediction_export_failed";
		agent ??= {
			executable: "harness-native",
			args: [],
			exitCode: 1,
			signal: null,
			stdout: "",
			stderr: `SWE-bench candidate environment failed: ${failure.message}`,
			durationMs: 0,
			timedOut: false,
		};
	} finally {
		await dockerEnvironment?.cleanup();
	}
	return {
		instance,
		runId,
		runIdentity: policy.runIdentity,
		workspace,
		agent,
		mutationOccurred: changedFiles.length > 0,
		changedFiles,
		prediction,
		predictionPath,
		predictionError,
		failure,
		runtimeRecordPath: getHarnessNativeRuntimeRecordPath(policy.worktreeRoot, runId),
	};
}
