import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { runGit } from "../workspace/git-utils";
import type { AgentRuntime } from "./agent-runtime";
import {
	createModelProvider,
	type ModelDecision,
	type ModelProvider,
	ModelProviderFailureError,
} from "./model-provider";
import type {
	AgentExecution,
	HarnessNativeAgentPolicy,
	HarnessNativeProviderFailure,
	HarnessNativeRuntimeResult,
	HarnessNativeToolName,
	HarnessNativeTrajectoryStep,
	RepairContext,
} from "./types";

export type HarnessNativeModelProvider = Pick<ModelProvider, "id" | "decide"> &
	Partial<Pick<ModelProvider, "createSession">>;

const registeredTools: HarnessNativeToolName[] = [
	"read-file",
	"list-directory",
	"search-text",
	"search-text-recursive",
	"git-status",
	"git-diff",
	"apply-patch",
	"apply-patch-batch",
	"create-file",
];

const RECURSIVE_SEARCH_MAX_DEPTH = 4;
const RECURSIVE_SEARCH_MAX_DIRECTORIES = 64;
const RECURSIVE_SEARCH_MAX_FILES = 256;
const RECURSIVE_SEARCH_MAX_FILE_BYTES = 64 * 1024;
const RECURSIVE_SEARCH_MAX_TOTAL_BYTES = 1024 * 1024;
const RECURSIVE_SEARCH_MAX_MATCHES = 64;
const excludedRecursiveSearchDirectories = new Set([
	".agentpatchcheck",
	".cache",
	".git",
	".next",
	"build",
	"coverage",
	"dist",
	"node_modules",
	"out",
]);

function isExcludedRecursiveSearchFile(name: string): boolean {
	const lowerName = name.toLowerCase();
	return (
		lowerName === ".env" ||
		lowerName.startsWith(".env.") ||
		lowerName.endsWith(".key") ||
		lowerName.endsWith(".pem") ||
		lowerName.endsWith(".p12") ||
		lowerName.endsWith(".pfx")
	);
}

export function createHarnessNativeRuntime(providerOverride?: HarnessNativeModelProvider): AgentRuntime {
	return {
		id: "harness-native",
		execute: async ({ policy, worktreePath, repairContext }) => {
			if (policy.nativeAgent === null || policy.model === undefined)
				throw new Error("Harness-native Runtime requires validated native policy and model.");
			const provider = providerOverride ?? createModelProvider(policy.nativeAgent.modelProvider);
			const startedAt = Date.now();
			const runtime = await runHarnessNativeRuntime({
				policy: policy.nativeAgent,
				prompt: policy.prompt,
				model: policy.model,
				worktreePath,
				provider,
				timeoutMs: policy.timeoutMs,
				repairContext,
			});
			const execution: AgentExecution = {
				executable: "harness-native",
				args: [runtime.provider, runtime.model],
				exitCode: runtime.status === "succeeded" ? 0 : 1,
				signal: null,
				stdout: runtime.status === "succeeded" ? "Harness-native agent finished." : "",
				stderr: runtime.status === "succeeded" ? "" : `Harness-native agent stopped: ${runtime.terminationReason}.`,
				durationMs: Date.now() - startedAt,
				timedOut: runtime.terminationReason === "timeout",
				runtime,
			};
			return execution;
		},
	};
}

function validateRelativeToolPath(value: unknown): string {
	if (typeof value !== "string" || !value || value.includes("\0") || isAbsolute(value))
		throw new Error("Tool path is invalid.");
	if (value === ".") return value;
	const segments = value.split(/[\\/]/u);
	if (
		segments.some(
			(segment) =>
				!segment || segment === "." || segment === ".." || segment === ".git" || segment === ".agentpatchcheck",
		)
	)
		throw new Error("Tool path is outside the managed workspace.");
	return value;
}

async function safePath(root: string, value: unknown): Promise<string> {
	const relativeValue = validateRelativeToolPath(value);
	if (relativeValue === ".") return root;
	const candidate = resolve(root, relativeValue);
	const relativePath = relative(root, candidate);
	if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath))
		throw new Error("Tool path is outside the managed workspace.");
	let currentPath = root;
	for (const segment of relativePath.split(/[\\/]/u)) {
		currentPath = join(currentPath, segment);
		if ((await lstat(currentPath)).isSymbolicLink()) throw new Error("Tool path must not traverse a symbolic link.");
	}
	return candidate;
}

async function safeNewFile(root: string, value: unknown): Promise<string> {
	const relativeValue = validateRelativeToolPath(value);
	if (relativeValue === ".") throw new Error("New file path is invalid.");
	const parentPath = await safePath(root, dirname(relativeValue));
	const parentMetadata = await lstat(parentPath);
	if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink())
		throw new Error("New file parent is not a regular directory.");
	const path = join(parentPath, basename(relativeValue));
	try {
		await lstat(path);
		throw new Error("New file target already exists.");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return path;
		throw error;
	}
}

async function regularFile(root: string, value: unknown): Promise<string> {
	const path = await safePath(root, value);
	const metadata = await lstat(path);
	if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Tool path is not a regular file.");
	return path;
}

interface ConstrainedPatch {
	path: string;
	expectedText: string;
	replacementText: string;
}

async function preparePatchBatch(
	root: string,
	value: unknown,
): Promise<Array<{ path: string; content: string; replacement: string }>> {
	if (!Array.isArray(value) || value.length < 2 || value.length > 8)
		throw new Error("Patch batch must contain 2-8 patches.");
	const patches: ConstrainedPatch[] = [];
	for (const item of value) {
		if (item === null || typeof item !== "object") throw new Error("Patch batch entry is invalid.");
		const patch = item as Partial<ConstrainedPatch>;
		if (
			typeof patch.expectedText !== "string" ||
			typeof patch.replacementText !== "string" ||
			patch.expectedText.length > 32_768 ||
			patch.replacementText.length > 32_768 ||
			patch.expectedText.includes("\0") ||
			patch.replacementText.includes("\0")
		)
			throw new Error("Patch batch entry content is invalid.");
		patches.push({
			path: await regularFile(root, patch.path),
			expectedText: patch.expectedText,
			replacementText: patch.replacementText,
		});
	}
	if (new Set(patches.map((patch) => patch.path)).size !== patches.length)
		throw new Error("Patch batch must not target the same file twice.");
	const prepared = await Promise.all(
		patches.map(async (patch) => {
			const content = await readFile(patch.path, "utf8");
			if (content.split(patch.expectedText).length !== 2)
				throw new Error("Patch batch expectedText must match each target exactly once.");
			return { path: patch.path, content, replacement: content.replace(patch.expectedText, patch.replacementText) };
		}),
	);
	return prepared;
}

function summary(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, limit)}\n[truncated]`;
}

async function searchTextRecursively(root: string, value: unknown, query: string, limit: number) {
	const searchRoot = await safePath(root, value);
	const searchRootMetadata = await lstat(searchRoot);
	if (!searchRootMetadata.isDirectory() || searchRootMetadata.isSymbolicLink())
		throw new Error("Recursive search path is not a regular directory.");
	const matches: string[] = [];
	const pendingDirectories: Array<{ path: string; depth: number }> = [{ path: searchRoot, depth: 0 }];
	let visitedDirectories = 0;
	let visitedFiles = 0;
	let readBytes = 0;
	while (pendingDirectories.length > 0 && matches.length < RECURSIVE_SEARCH_MAX_MATCHES) {
		const directory = pendingDirectories.pop();
		if (directory === undefined || visitedDirectories >= RECURSIVE_SEARCH_MAX_DIRECTORIES) break;
		const directoryMetadata = await lstat(directory.path);
		if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) continue;
		visitedDirectories += 1;
		const entries = await readdir(directory.path, { withFileTypes: true });
		for (const entry of entries) {
			if (matches.length >= RECURSIVE_SEARCH_MAX_MATCHES || visitedFiles >= RECURSIVE_SEARCH_MAX_FILES) break;
			const path = join(directory.path, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				if (
					directory.depth < RECURSIVE_SEARCH_MAX_DEPTH &&
					!excludedRecursiveSearchDirectories.has(entry.name.toLowerCase()) &&
					visitedDirectories + pendingDirectories.length < RECURSIVE_SEARCH_MAX_DIRECTORIES
				)
					pendingDirectories.push({ path, depth: directory.depth + 1 });
				continue;
			}
			if (!entry.isFile() || isExcludedRecursiveSearchFile(entry.name)) continue;
			const metadata = await lstat(path);
			if (
				!metadata.isFile() ||
				metadata.isSymbolicLink() ||
				metadata.size > RECURSIVE_SEARCH_MAX_FILE_BYTES ||
				readBytes + metadata.size > RECURSIVE_SEARCH_MAX_TOTAL_BYTES
			)
				continue;
			visitedFiles += 1;
			readBytes += metadata.size;
			const content = await readFile(path, "utf8");
			if (content.includes("\0")) continue;
			const displayPath = relative(searchRoot, path).replaceAll("\\", "/");
			for (const [index, line] of content.split(/\r?\n/u).entries()) {
				if (line.includes(query)) matches.push(`${displayPath}:${index + 1}:${line}`);
				if (matches.length >= RECURSIVE_SEARCH_MAX_MATCHES) break;
			}
		}
	}
	return {
		observation: summary(matches.join("\n"), limit),
		evidence: `Searched ${visitedFiles} bounded recursive workspace files.`,
	};
}

async function executeTool(root: string, request: ModelDecision & { kind: "tool" }, limit: number) {
	const name = request.tool;
	try {
		if (name === "read-file") {
			const content = await readFile(await regularFile(root, request.arguments.path), "utf8");
			return {
				status: "ok" as const,
				observation: summary(content, limit),
				evidence: "Read a regular workspace file.",
			};
		}
		if (name === "list-directory") {
			const path = await safePath(root, request.arguments.path);
			const entries = await readdir(path, { withFileTypes: true });
			return {
				status: "ok" as const,
				observation: entries
					.filter((entry) => entry.name !== ".git" && entry.name !== ".agentpatchcheck")
					.slice(0, 128)
					.map((entry) => `${entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other"}: ${entry.name}`)
					.join("\n"),
				evidence: "Listed a workspace directory.",
			};
		}
		if (name === "search-text") {
			const query = request.arguments.query;
			if (typeof query !== "string" || !query || query.length > 256 || query.includes("\0"))
				throw new Error("Search query is invalid.");
			const path = await safePath(root, request.arguments.path);
			const entries = await readdir(path, { withFileTypes: true });
			const matches: string[] = [];
			for (const entry of entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink()).slice(0, 128)) {
				const content = await readFile(join(path, entry.name), "utf8");
				for (const [index, line] of content.split(/\r?\n/u).entries())
					if (line.includes(query)) matches.push(`${entry.name}:${index + 1}:${line}`);
			}
			return {
				status: "ok" as const,
				observation: summary(matches.slice(0, 64).join("\n"), limit),
				evidence: "Searched direct workspace files.",
			};
		}
		if (name === "search-text-recursive") {
			const query = request.arguments.query;
			if (typeof query !== "string" || !query || query.length > 256 || query.includes("\0"))
				throw new Error("Search query is invalid.");
			const result = await searchTextRecursively(root, request.arguments.path, query, limit);
			return { status: "ok" as const, ...result };
		}
		if (name === "git-status" || name === "git-diff") {
			const result = await runGit(root, name === "git-status" ? ["status", "--short"] : ["diff", "--"], {
				trimStdout: false,
			});
			return result.ok
				? { status: "ok" as const, observation: summary(result.stdout, limit), evidence: `Read ${name}.` }
				: { status: "error" as const, observation: "Git tool failed.", evidence: "Git tool failed." };
		}
		if (name === "apply-patch") {
			const path = await regularFile(root, request.arguments.path);
			const expected = request.arguments.expectedText;
			const replacement = request.arguments.replacementText;
			if (
				typeof expected !== "string" ||
				typeof replacement !== "string" ||
				expected.length > 32_768 ||
				replacement.length > 32_768
			)
				throw new Error("Patch arguments are invalid.");
			const content = await readFile(path, "utf8");
			if (content.split(expected).length !== 2) throw new Error("Patch expectedText must match exactly once.");
			await writeFile(path, content.replace(expected, replacement), "utf8");
			return {
				status: "ok" as const,
				observation: "Patch applied.",
				evidence: "Applied one constrained text replacement.",
			};
		}
		if (name === "apply-patch-batch") {
			const patches = await preparePatchBatch(root, request.arguments.patches);
			for (const patch of patches) await writeFile(patch.path, patch.replacement, "utf8");
			return {
				status: "ok" as const,
				observation: `Patch batch applied to ${patches.length} files.`,
				evidence: `Applied ${patches.length} constrained text replacements after batch preflight.`,
			};
		}
		if (name === "create-file") {
			const content = request.arguments.content;
			if (typeof content !== "string" || content.length > 32_768 || content.includes("\0"))
				throw new Error("New file content is invalid.");
			await writeFile(await safeNewFile(root, request.arguments.path), content, { encoding: "utf8", flag: "wx" });
			return {
				status: "ok" as const,
				observation: "New file created.",
				evidence: "Created one new workspace file exclusively.",
			};
		}
		return {
			status: "rejected" as const,
			observation: "Tool is not registered.",
			evidence: "Rejected an unregistered tool.",
		};
	} catch (error) {
		return {
			status: "rejected" as const,
			observation: "Tool request was rejected by workspace policy.",
			evidence: error instanceof Error ? error.message : "Tool request rejected.",
		};
	}
}

function safeArguments(value: Record<string, unknown>): Record<string, string | number> {
	return Object.fromEntries(
		Object.entries(value).flatMap(([key, item]) =>
			typeof item === "string" || typeof item === "number" ? [[key, item]] : [],
		),
	);
}

export async function runHarnessNativeRuntime(options: {
	policy: HarnessNativeAgentPolicy;
	prompt: string;
	model: string;
	worktreePath: string;
	provider: HarnessNativeModelProvider;
	timeoutMs: number;
	/** Direct runtime callers default to an initial execution; the Headless Core always passes this explicitly. */
	repairContext?: RepairContext;
}): Promise<HarnessNativeRuntimeResult> {
	const startedAt = Date.now();
	const repairContext = options.repairContext ?? { phase: "initial", publicVerificationFeedback: null };
	const trajectory: HarnessNativeTrajectoryStep[] = [];
	const observations: string[] = [];
	const session = options.provider.createSession?.() ?? {
		decide: options.provider.decide,
		recordToolResults: () => undefined,
	};
	let toolCalls = 0;
	let iterations = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let actualModel: string | null = null;
	const fail = (
		terminationReason: HarnessNativeRuntimeResult["terminationReason"],
		failure: HarnessNativeProviderFailure | null = null,
	): HarnessNativeRuntimeResult => ({
		version: 1,
		provider: options.provider.id,
		providerIdentity: {
			provider: options.policy.modelProvider.provider,
			protocol: options.policy.modelProvider.protocol,
			thinkingMode: options.policy.modelProvider.thinkingMode,
			endpointSha256: options.policy.modelProvider.endpointSha256,
			credentialRef: options.policy.modelProvider.credentialRef,
			implementation: options.policy.modelProvider.implementation,
			configuredModel: options.model,
			actualModel,
		},
		model: options.model,
		status: "failed",
		terminationReason,
		providerFailure: failure,
		iterations,
		toolCalls,
		budget: {
			maxIterations: options.policy.maxIterations,
			maxToolCalls: options.policy.maxToolCalls,
			maxObservationBytes: options.policy.maxObservationBytes,
		},
		usage: { inputTokens: inputTokens || null, outputTokens: outputTokens || null },
		trajectory,
	});
	for (let iteration = 1; iteration <= options.policy.maxIterations; iteration += 1) {
		if (Date.now() - startedAt >= options.timeoutMs) return fail("timeout");
		let answer: Awaited<ReturnType<HarnessNativeModelProvider["decide"]>>;
		try {
			iterations += 1;
			answer = await session.decide({
				prompt: options.prompt,
				observations,
				tools: registeredTools,
				model: options.model,
				repairContext,
			});
		} catch (error) {
			return fail("model-failed", error instanceof ModelProviderFailureError ? error.failure : null);
		}
		actualModel = answer.actualModel ?? actualModel;
		inputTokens += answer.usage?.inputTokens ?? 0;
		outputTokens += answer.usage?.outputTokens ?? 0;
		if (answer.decision.kind === "finish") {
			trajectory.push({
				iteration,
				decision: "finish",
				tool: null,
				arguments: null,
				toolStatus: null,
				observationSummary: null,
			});
			return { ...fail("finished"), status: "succeeded", terminationReason: "finished" };
		}
		if (answer.decision.kind === "fail") {
			trajectory.push({
				iteration,
				decision: "fail",
				tool: null,
				arguments: null,
				toolStatus: null,
				observationSummary: null,
			});
			return fail("model-failed");
		}
		const requests =
			answer.decision.kind === "tool"
				? [answer.decision]
				: answer.decision.kind === "tool-batch"
					? answer.decision.calls
					: [];
		if (requests.length === 0) return fail("invalid-decision");
		if (toolCalls + requests.length > options.policy.maxToolCalls) return fail("tool-limit");
		for (const request of requests) {
			toolCalls += 1;
			const tool = await executeTool(options.worktreePath, request, options.policy.maxObservationBytes);
			trajectory.push({
				iteration,
				decision: "tool",
				tool: registeredTools.includes(request.tool as HarnessNativeToolName)
					? (request.tool as HarnessNativeToolName)
					: null,
				arguments: safeArguments(request.arguments),
				toolStatus: tool.status,
				observationSummary: tool.evidence,
			});
			observations.push(tool.observation);
			if (request.callId === undefined) continue;
			session.recordToolResults([
				{
					callId: request.callId,
					tool: request.tool as HarnessNativeToolName,
					status: tool.status === "ok" ? "ok" : "error",
					observation: tool.observation,
				},
			]);
		}
	}
	return fail("iteration-limit");
}
