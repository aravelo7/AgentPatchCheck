import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { getGitStdout } from "../workspace/git-utils";
import {
	type AgentPatchCheckSandbox,
	type HiddenOracleInput,
	type HiddenOraclePolicy,
	type PatchExpectation,
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
	return { scriptPath, timeoutMs: normalizeTimeout(oracle.timeoutMs) };
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

	return {
		[TASK_POLICY_BRAND]: true,
		repositoryRoot,
		baseRef,
		baseCommit,
		worktreeRoot,
		prompt: normalizePrompt(input.prompt),
		runId: normalizeOptionalRunId(input.runId),
		codexExecutable: normalizeOptionalExecutable(input.codexExecutable),
		model: normalizeOptionalModel(input.model),
		timeoutMs: normalizeTimeout(input.timeoutMs),
		sandbox,
		allowNetwork: input.allowNetwork === true,
		allowDangerousParameters: false,
		verification: validateVerificationPolicy(input.verification),
		verificationProfile: input.verificationProfile ?? null,
		hiddenOracle: await normalizeHiddenOracle(input.hiddenOracle, repositoryRoot),
		patchExpectation: normalizePatchExpectation(input.patchExpectation),
	};
}
