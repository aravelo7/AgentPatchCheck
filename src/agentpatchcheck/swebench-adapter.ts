import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { getGitStdout, runGit } from "../workspace/git-utils";
import { getAgentAdapter } from "./agent-adapter";
import { type DeepSeekV4Model, parseDeepSeekV4Model } from "./deepseek-v4-model";
import { createIsolatedWorkspace } from "./isolated-workspace";
import { createRunId, type RunIdentity } from "./run-identity";
import { getHarnessNativeRuntimeRecordPath } from "./runtime-record";
import { validateTaskPolicy } from "./task-policy";
import type { AgentExecution, HarnessNativeAgentInput, IsolatedWorkspace, TaskPolicy } from "./types";

const INSTANCE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*__[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;
const REPOSITORY_PATTERN = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;

export const SWE_BENCH_MULTILINGUAL_DATASET = "swe-bench/SWE-Bench_Multilingual";
export const SWE_BENCH_STANDARD_BASELINE_TAG = "v0.4-swebench-dataset-boundary-baseline";
export const AGENTPATCHCHECK_BASELINE_MODEL = "deepseek-v4-pro";

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

/** @deprecated Use SWEbenchAgentSafeInstance to make the boundary explicit. */
export type SWEbenchInstance = SWEbenchAgentSafeInstance;

export interface SWEbenchPrediction {
	instance_id: string;
	model_patch: string;
	model_name_or_path: string;
}

export interface SWEbenchRuntimeConfiguration {
	model: string;
	nativeAgent: HarnessNativeAgentInput;
	timeoutMs: number;
}

export interface SWEbenchAdapterOptions {
	instance: SWEbenchAgentSafeInstance;
	repositoryRoot: string;
	outputPath: string;
	modelNameOrPath?: string;
	runId?: string;
	variant?: string;
	attempt?: number;
	runtime?: SWEbenchRuntimeConfiguration;
}

export interface SWEbenchAdapterResult {
	instance: SWEbenchInstance;
	runId: string;
	runIdentity: RunIdentity;
	workspace: IsolatedWorkspace;
	agent: AgentExecution;
	mutationOccurred: boolean;
	changedFiles: string[];
	prediction: SWEbenchPrediction | null;
	predictionPath: string | null;
	predictionError: "prediction_export_failed" | null;
	runtimeRecordPath: string;
}

export interface SWEbenchAdapterDependencies {
	validatePolicy: typeof validateTaskPolicy;
	createWorkspace: typeof createIsolatedWorkspace;
	executeAgent: (policy: TaskPolicy, worktreePath: string) => Promise<AgentExecution>;
	collectModelPatch: typeof collectSWEbenchModelPatch;
}

const defaultRuntime: SWEbenchRuntimeConfiguration = {
	model: AGENTPATCHCHECK_BASELINE_MODEL,
	nativeAgent: {
		provider: "deepseek",
		protocol: "chat-completions",
		thinkingMode: "enabled",
		reasoningEffort: "high",
		baseUrl: "https://api.deepseek.com/v1",
		credentialRef: "deepseek-primary",
		maxIterations: 12,
		maxToolCalls: 48,
		maxRejectedToolCalls: 4,
		maxObservationBytes: 16_384,
		maxTransportRetries: 1,
		maxProtocolRecoveries: 2,
		maxCompletionDeferrals: 2,
		maxPlanRevisions: 4,
		plannerEnabled: false,
	},
	timeoutMs: 600_000,
};

export function createSWEbenchRuntimeConfiguration(model: DeepSeekV4Model): SWEbenchRuntimeConfiguration {
	return { ...defaultRuntime, model };
}

export function createSWEbenchModelNameOrPath(model: DeepSeekV4Model): string {
	return `agentpatchcheck/${SWE_BENCH_STANDARD_BASELINE_TAG}/${model}`;
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
): Promise<{ modelPatch: string; changedFiles: string[] }> {
	const addResult = await runGit(worktreePath, ["add", "-A"]);
	if (!addResult.ok) throw new Error(addResult.error ?? "Could not stage the SWE-bench worktree for patch export.");
	const [modelPatch, changedFileOutput] = await Promise.all([
		getGitStdout(["diff", "--binary", "--cached", baseCommit, "--"], worktreePath, { trimStdout: false }),
		getGitStdout(["diff", "--name-only", "--cached", baseCommit, "--"], worktreePath),
	]);
	const changedFiles = changedFileOutput
		.split("\n")
		.map((file) => file.trim())
		.filter(Boolean)
		.sort((left, right) => left.localeCompare(right));
	return { modelPatch, changedFiles };
}

const defaultDependencies: SWEbenchAdapterDependencies = {
	validatePolicy: validateTaskPolicy,
	createWorkspace: createIsolatedWorkspace,
	executeAgent: async (policy, worktreePath) =>
		await getAgentAdapter(policy.agentAdapter).execute({
			policy,
			worktreePath,
			repairContext: { phase: "initial", publicVerificationFeedback: null, repairInstruction: null },
		}),
	collectModelPatch: collectSWEbenchModelPatch,
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
	const modelNameOrPath = createSWEbenchModelNameOrPath(model);
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
		verification: { commands: [] },
		patchExpectation: "changes-required",
	});
	const workspace = await resolvedDependencies.createWorkspace({
		repositoryPath: policy.repositoryRoot,
		runId,
		baseRef: policy.baseRef,
		baseCommit: policy.baseCommit,
		worktreeRoot: policy.worktreeRoot,
	});
	const agent = await resolvedDependencies.executeAgent(policy, workspace.path);
	let prediction: SWEbenchPrediction | null = null;
	let predictionPath: string | null = null;
	let changedFiles: string[] = [];
	let predictionError: SWEbenchAdapterResult["predictionError"] = null;
	try {
		const collected = await resolvedDependencies.collectModelPatch(workspace.path, instance.base_commit);
		changedFiles = collected.changedFiles;
		prediction = createSWEbenchPrediction(instance.instance_id, collected.modelPatch, modelNameOrPath);
		predictionPath = resolve(options.outputPath);
		await mkdir(dirname(predictionPath), { recursive: true });
		await writeFile(predictionPath, `${JSON.stringify(prediction)}\n`, "utf8");
	} catch {
		predictionError = "prediction_export_failed";
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
		runtimeRecordPath: getHarnessNativeRuntimeRecordPath(policy.worktreeRoot, runId),
	};
}
