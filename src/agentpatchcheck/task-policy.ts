import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { getGitStdout } from "../workspace/git-utils";
import { isCredentialRef } from "./credential-resolver";
import { DEFAULT_RISK_POLICY_CONFIGURATION } from "./risk-policy";
import {
	type AgentAdapterId,
	type AgentPatchCheckSandbox,
	type HarnessNativeAgentPolicy,
	type HiddenOracleInput,
	type HiddenOracleIsolationLevel,
	type HiddenOraclePolicy,
	type ModelProviderConfiguration,
	type ModelProviderKind,
	type ModelProviderProtocol,
	type ModelProviderThinkingMode,
	type PatchExpectation,
	type RiskPolicy,
	TASK_POLICY_BRAND,
	type TaskPolicy,
	type TaskPolicyInput,
} from "./types";
import { validateVerificationPolicy } from "./verification-policy";

export const DEFAULT_TASK_TIMEOUT_MS = 15 * 60 * 1_000;
export const MAX_TASK_TIMEOUT_MS = 60 * 60 * 1_000;
export const MAX_TASK_PROMPT_LENGTH = 16_000;

const SANDBOXES = new Set<AgentPatchCheckSandbox>(["read-only", "workspace-write"]);
const MODEL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/;
const RUN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const PATCH_EXPECTATIONS = new Set<PatchExpectation>(["changes-required", "changes-optional"]);
const AGENT_ADAPTERS = new Set<AgentAdapterId>(["codex", "script", "harness-native"]);
const HIDDEN_ORACLE_ISOLATION_LEVELS = new Set<HiddenOracleIsolationLevel>(["none", "network", "process", "strict"]);
const DEFAULT_HIDDEN_ORACLE_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;
const DEFAULT_HIDDEN_ORACLE_CPU_RATE_PERCENT = 50;
const DEFAULT_NATIVE_MAX_ITERATIONS = 12;
const DEFAULT_NATIVE_MAX_TOOL_CALLS = 24;
const DEFAULT_NATIVE_MAX_OBSERVATION_BYTES = 16 * 1024;
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const MODEL_PROVIDERS = new Set<ModelProviderKind>(["openai", "openai-compatible"]);
const MODEL_PROVIDER_PROTOCOLS = new Set<ModelProviderProtocol>(["responses", "chat-completions"]);
const MODEL_PROVIDER_THINKING_MODES = new Set<ModelProviderThinkingMode>(["default", "disabled"]);

function assertNoNullBytes(value: string, label: string): void {
	if (value.includes("\0")) {
		throw new Error(`${label} must not contain null bytes.`);
	}
}

function assertPathWithinRoot(root: string, candidate: string, label: string): void {
	const relativePath = relative(root, candidate);
	if (
		!relativePath ||
		relativePath === ".." ||
		relativePath.startsWith("../") ||
		relativePath.startsWith("..\\") ||
		isAbsolute(relativePath)
	) {
		throw new Error(`${label} must be a descendant of the repository root.`);
	}
}

function assertPathOutsideRoot(root: string, candidate: string, label: string): void {
	const relativePath = relative(root, candidate);
	if (
		relativePath === "" ||
		(!relativePath.startsWith("../") && !relativePath.startsWith("..\\") && !isAbsolute(relativePath))
	) {
		throw new Error(`${label} must be outside the repository root.`);
	}
}

async function resolvePathThroughExistingAncestors(path: string): Promise<string> {
	const missingSegments: string[] = [];
	let candidate = path;
	while (true) {
		try {
			return resolve(await realpath(candidate), ...missingSegments);
		} catch {
			const parent = dirname(candidate);
			if (parent === candidate) {
				throw new Error(`Could not resolve worktree root: ${path}`);
			}
			missingSegments.unshift(basename(candidate));
			candidate = parent;
		}
	}
}

function pathsEqual(left: string, right: string): boolean {
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function normalizeOptionalModel(model: string | undefined): string | undefined {
	if (model === undefined) {
		return undefined;
	}
	const normalized = model.trim();
	if (!MODEL_ID_PATTERN.test(normalized)) {
		throw new Error("Codex model must be a 1-128 character model identifier.");
	}
	return normalized;
}

function normalizeOptionalRunId(runId: string | undefined): string | undefined {
	if (runId === undefined) {
		return undefined;
	}
	const normalized = runId.trim();
	if (!RUN_ID_PATTERN.test(normalized)) {
		throw new Error("Run id must contain 1-64 letters, numbers, underscores, or hyphens.");
	}
	return normalized;
}

function normalizeOptionalExecutable(executable: string | undefined): string | undefined {
	if (executable === undefined) {
		return undefined;
	}
	const normalized = executable.trim();
	if (!normalized || normalized.length > 1_024) {
		throw new Error("Codex executable must contain 1-1024 characters.");
	}
	assertNoNullBytes(normalized, "Codex executable");
	return normalized;
}

function normalizeTimeout(timeoutMs: number | undefined): number {
	const normalized = timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
	if (!Number.isSafeInteger(normalized) || normalized <= 0 || normalized > MAX_TASK_TIMEOUT_MS) {
		throw new Error(`Timeout must be a positive integer no greater than ${MAX_TASK_TIMEOUT_MS} milliseconds.`);
	}
	return normalized;
}

function normalizePrompt(prompt: string): string {
	assertNoNullBytes(prompt, "Prompt");
	if (!prompt.trim()) {
		throw new Error("Prompt is required.");
	}
	if (prompt.length > MAX_TASK_PROMPT_LENGTH) {
		throw new Error(`Prompt must not exceed ${MAX_TASK_PROMPT_LENGTH} characters.`);
	}
	return prompt;
}

function normalizePatchExpectation(expectation: PatchExpectation | undefined): PatchExpectation {
	const normalized = expectation ?? "changes-required";
	if (!PATCH_EXPECTATIONS.has(normalized)) {
		throw new Error('Patch expectation must be "changes-required" or "changes-optional".');
	}
	return normalized;
}

async function normalizeHiddenOracle(
	oracle: HiddenOracleInput | undefined,
	repositoryRoot: string,
): Promise<HiddenOraclePolicy | null> {
	if (oracle === undefined) return null;
	assertNoNullBytes(oracle.scriptPath, "Hidden Oracle script path");
	const scriptPath = await realpath(resolve(oracle.scriptPath));
	const scriptStat = await stat(scriptPath);
	if (!scriptStat.isFile()) throw new Error(`Hidden Oracle script is not a file: ${scriptPath}`);
	assertPathOutsideRoot(repositoryRoot, scriptPath, "Hidden Oracle script");
	const isolation = oracle.isolation ?? "none";
	if (!HIDDEN_ORACLE_ISOLATION_LEVELS.has(isolation)) throw new Error("Hidden Oracle isolation level is invalid.");
	const memoryLimitBytes = oracle.memoryLimitBytes ?? DEFAULT_HIDDEN_ORACLE_MEMORY_LIMIT_BYTES;
	const cpuRatePercent = oracle.cpuRatePercent ?? DEFAULT_HIDDEN_ORACLE_CPU_RATE_PERCENT;
	if (!Number.isSafeInteger(memoryLimitBytes) || memoryLimitBytes < 64 * 1024 * 1024) {
		throw new Error("Hidden Oracle memory limit must be an integer of at least 64 MiB.");
	}
	if (!Number.isSafeInteger(cpuRatePercent) || cpuRatePercent < 1 || cpuRatePercent > 100) {
		throw new Error("Hidden Oracle CPU rate must be an integer between 1 and 100.");
	}
	return { scriptPath, timeoutMs: normalizeTimeout(oracle.timeoutMs), isolation, memoryLimitBytes, cpuRatePercent };
}

async function normalizeAgentScript(
	adapter: AgentAdapterId,
	script: string | undefined,
	repositoryRoot: string,
): Promise<string | null> {
	if (adapter === "codex" || adapter === "harness-native") {
		if (script !== undefined) throw new Error("Codex Adapter must not define an agent script.");
		return null;
	}
	if (script === undefined) throw new Error("Script Adapter requires an agent script.");
	assertNoNullBytes(script, "Agent script path");
	const scriptPath = await realpath(resolve(script));
	if (!(await stat(scriptPath)).isFile()) throw new Error(`Agent script is not a file: ${scriptPath}`);
	assertPathOutsideRoot(repositoryRoot, scriptPath, "Agent script");
	return scriptPath;
}

function normalizeNativeAgent(
	adapter: AgentAdapterId,
	input: TaskPolicyInput["nativeAgent"],
	model: string | undefined,
): HarnessNativeAgentPolicy | null {
	if (adapter !== "harness-native") {
		if (input !== undefined) throw new Error("nativeAgent requires the Harness-native Adapter.");
		return null;
	}
	if (model === undefined) throw new Error("Harness-native Adapter requires a model.");
	if (input?.credentialRef === undefined)
		throw new Error("Harness-native Adapter requires an explicit credentialRef.");
	const maxIterations = input?.maxIterations ?? DEFAULT_NATIVE_MAX_ITERATIONS;
	const maxToolCalls = input?.maxToolCalls ?? DEFAULT_NATIVE_MAX_TOOL_CALLS;
	const maxRejectedToolCalls = input?.maxRejectedToolCalls ?? 4;
	const maxObservationBytes = input?.maxObservationBytes ?? DEFAULT_NATIVE_MAX_OBSERVATION_BYTES;
	const maxTransportRetries = input?.maxTransportRetries ?? 0;
	if (!Number.isSafeInteger(maxIterations) || maxIterations < 1 || maxIterations > 32)
		throw new Error("Harness-native maxIterations must be an integer between 1 and 32.");
	if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls < 1 || maxToolCalls > 64)
		throw new Error("Harness-native maxToolCalls must be an integer between 1 and 64.");
	if (!Number.isSafeInteger(maxRejectedToolCalls) || maxRejectedToolCalls < 1 || maxRejectedToolCalls > 16)
		throw new Error("Harness-native maxRejectedToolCalls must be an integer between 1 and 16.");
	if (!Number.isSafeInteger(maxObservationBytes) || maxObservationBytes < 1_024 || maxObservationBytes > 64 * 1024)
		throw new Error("Harness-native maxObservationBytes must be an integer between 1024 and 65536.");
	if (!Number.isSafeInteger(maxTransportRetries) || maxTransportRetries < 0 || maxTransportRetries > 1)
		throw new Error("Harness-native maxTransportRetries must be an integer between 0 and 1.");
	return {
		modelProvider: normalizeModelProvider(input),
		maxIterations,
		maxToolCalls,
		maxRejectedToolCalls,
		maxObservationBytes,
		maxTransportRetries,
	};
}

function normalizeModelProvider(input: TaskPolicyInput["nativeAgent"]): ModelProviderConfiguration {
	const provider = input?.provider ?? "openai";
	if (!MODEL_PROVIDERS.has(provider)) throw new Error("Harness-native model provider is invalid.");
	const protocol = input?.protocol ?? "responses";
	if (!MODEL_PROVIDER_PROTOCOLS.has(protocol)) throw new Error("Harness-native model provider protocol is invalid.");
	const thinkingMode = input?.thinkingMode ?? "default";
	if (!MODEL_PROVIDER_THINKING_MODES.has(thinkingMode))
		throw new Error("Harness-native model provider thinkingMode is invalid.");
	if (thinkingMode !== "default" && (provider !== "openai-compatible" || protocol !== "chat-completions"))
		throw new Error("Harness-native model provider thinkingMode requires OpenAI-compatible Chat Completions.");
	const credentialRef = input?.credentialRef;
	if (credentialRef === undefined) throw new Error("Harness-native Adapter requires an explicit credentialRef.");
	if (!isCredentialRef(credentialRef)) throw new Error("Harness-native credentialRef is invalid.");
	const requestedBaseUrl = input?.baseUrl?.trim();
	if (provider === "openai" && requestedBaseUrl !== undefined && requestedBaseUrl !== DEFAULT_OPENAI_BASE_URL)
		throw new Error("The official OpenAI provider must use its fixed API endpoint.");
	if (provider === "openai-compatible" && requestedBaseUrl === undefined)
		throw new Error("The OpenAI-compatible provider requires baseUrl.");
	const baseUrl = normalizeProviderBaseUrl(requestedBaseUrl ?? DEFAULT_OPENAI_BASE_URL);
	return {
		provider,
		protocol,
		thinkingMode,
		baseUrl,
		endpointSha256: createHash("sha256").update(baseUrl, "utf8").digest("hex"),
		credentialRef,
		implementation: "openai-compatible-v1",
	};
}

function normalizeProviderBaseUrl(value: string): string {
	assertNoNullBytes(value, "Model provider baseUrl");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Model provider baseUrl must be an absolute URL.");
	}
	const localHttp = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
	if (url.protocol !== "https:" && !localHttp)
		throw new Error("Model provider baseUrl must use HTTPS, except for local test endpoints.");
	if (url.username || url.password || url.search || url.hash)
		throw new Error("Model provider baseUrl must not contain credentials, a query, or a fragment.");
	url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
	return url.toString().replace(/\/$/u, "");
}

async function normalizeRiskPolicy(
	riskPolicy: TaskPolicyInput["riskPolicy"],
	repositoryRoot: string,
): Promise<RiskPolicy> {
	if (riskPolicy === undefined) return { configuration: { ...DEFAULT_RISK_POLICY_CONFIGURATION }, profile: null };
	assertNoNullBytes(riskPolicy.profile.path, "RiskPolicy Profile path");
	const profilePath = await realpath(resolve(riskPolicy.profile.path));
	const profileStat = await stat(profilePath);
	if (!profileStat.isFile()) throw new Error("RiskPolicy Profile is not a file.");
	assertPathOutsideRoot(repositoryRoot, profilePath, "RiskPolicy Profile");
	if (riskPolicy.configuration.maxChangedFiles > DEFAULT_RISK_POLICY_CONFIGURATION.maxChangedFiles)
		throw new Error("RiskPolicy Profile maxChangedFiles may not exceed the built-in safety limit.");
	if (riskPolicy.configuration.maxTrackedPatchBytes > DEFAULT_RISK_POLICY_CONFIGURATION.maxTrackedPatchBytes)
		throw new Error("RiskPolicy Profile maxTrackedPatchBytes may not exceed the built-in safety limit.");
	return {
		configuration: riskPolicy.configuration,
		profile: { ...riskPolicy.profile, path: profilePath },
	};
}

export async function validateTaskPolicy(input: TaskPolicyInput): Promise<TaskPolicy> {
	if (input.allowDangerousParameters === true) {
		throw new Error("Dangerous Codex parameters are not supported by Headless Core.");
	}

	const requestedRepositoryRoot = input.repositoryRoot.trim();
	if (!requestedRepositoryRoot) {
		throw new Error("Repository root is required.");
	}
	assertNoNullBytes(requestedRepositoryRoot, "Repository root");
	const repositoryPath = resolve(requestedRepositoryRoot);
	const repositoryStat = await stat(repositoryPath);
	if (!repositoryStat.isDirectory()) {
		throw new Error(`Repository root is not a directory: ${repositoryPath}`);
	}

	const gitRepositoryRoot = await getGitStdout(["rev-parse", "--show-toplevel"], repositoryPath);
	const repositoryRoot = await realpath(repositoryPath);
	const canonicalGitRepositoryRoot = await realpath(gitRepositoryRoot);
	if (!pathsEqual(repositoryRoot, canonicalGitRepositoryRoot)) {
		throw new Error("Repository root must be the Git repository root, not a nested directory.");
	}

	const baseRef = (input.baseRef ?? "HEAD").trim();
	if (!baseRef) {
		throw new Error("Base ref is required.");
	}
	assertNoNullBytes(baseRef, "Base ref");
	if (baseRef.startsWith("-")) {
		throw new Error("Base ref must not begin with a dash.");
	}
	const baseCommit = await getGitStdout(["rev-parse", "--verify", `${baseRef}^{commit}`], repositoryRoot);

	const requestedWorktreeRoot = input.worktreeRoot?.trim() || join(repositoryRoot, ".agentpatchcheck", "worktrees");
	assertNoNullBytes(requestedWorktreeRoot, "Worktree root");
	const worktreeRoot = await resolvePathThroughExistingAncestors(resolve(requestedWorktreeRoot));
	assertPathWithinRoot(repositoryRoot, worktreeRoot, "Worktree root");

	const sandbox = input.sandbox ?? "workspace-write";
	if (!SANDBOXES.has(sandbox)) {
		throw new Error('Sandbox must be "read-only" or "workspace-write".');
	}
	const agentAdapter = input.agentAdapter ?? "codex";
	if (!AGENT_ADAPTERS.has(agentAdapter))
		throw new Error('Agent Adapter must be "codex", "script", or "harness-native".');
	const model = normalizeOptionalModel(input.model);

	return {
		[TASK_POLICY_BRAND]: true,
		repositoryRoot,
		baseRef,
		baseCommit,
		worktreeRoot,
		prompt: normalizePrompt(input.prompt),
		runId: normalizeOptionalRunId(input.runId),
		codexExecutable: normalizeOptionalExecutable(input.codexExecutable),
		agentAdapter,
		agentScript: await normalizeAgentScript(agentAdapter, input.agentScript, repositoryRoot),
		nativeAgent: normalizeNativeAgent(agentAdapter, input.nativeAgent, model),
		model,
		timeoutMs: normalizeTimeout(input.timeoutMs),
		sandbox,
		allowNetwork: input.allowNetwork === true,
		allowDangerousParameters: false,
		verification: validateVerificationPolicy(input.verification),
		verificationProfile: input.verificationProfile ?? null,
		riskPolicy: await normalizeRiskPolicy(input.riskPolicy, repositoryRoot),
		hiddenOracle: await normalizeHiddenOracle(input.hiddenOracle, repositoryRoot),
		patchExpectation: normalizePatchExpectation(input.patchExpectation),
	};
}
