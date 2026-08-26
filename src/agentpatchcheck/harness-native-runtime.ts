import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import { runGit } from "../workspace/git-utils";
import type { AgentRuntime } from "./agent-runtime";
import { createHarnessNativeAttemptContinuation, reviewHarnessNativeAttempt } from "./attempt-controller";
import { runVerificationCommand } from "./command-verifier";
import { HarnessNativeCompletionController } from "./completion-controller";
import { deriveHarnessNativeContextViews } from "./context-view";
import { type DshCodeJsonValue, runDshCompatibleCode } from "./dsh-compatible-code-runtime";
import {
	createModelProvider,
	type ModelDecision,
	type ModelProvider,
	ModelProviderFailureError,
} from "./model-provider";
import { applyManagedMutationPatch, MutationPatchError } from "./mutation-patch";
import { HarnessNativePlanExecutor, replayHarnessNativePlanExecutor } from "./plan-executor";
import { HarnessNativePlanner, type PlannerTrigger } from "./planner";
import { getProgrammaticToolFacade, mapProgrammaticToolFacadeCall } from "./programmatic-tool-facade";
import { type ProgrammaticToolDispatch, runProgrammaticToolComposition } from "./programmatic-tool-runtime";
import { isRecoverableProtocolFailure } from "./protocol-recovery";
import { parseReadFileArguments, type ReadFileResult, readBoundedFileWindow } from "./read-file";
import { deriveHarnessNativeResourceLedger } from "./resource-ledger";
import {
	deriveHarnessNativeTrajectory,
	detectHarnessNativeStuckPattern,
	HarnessNativeRuntimeEventSpine,
} from "./runtime-events";
import {
	captureHarnessNativeWorktreeMutationSurface,
	diffHarnessNativeWorktreeMutationSurfaces,
	fingerprintHarnessNativeWorktree,
	getHarnessNativeRuntimeRecordPath,
	HarnessNativeRuntimeRecord,
	hashHarnessNativeTaskIdentity,
	withHarnessNativeRuntimeRecordLock,
} from "./runtime-record";
import { redactSensitiveText } from "./sensitive-text";
import {
	isHarnessNativeMutationTool,
	isHarnessNativeRetrievalTool,
	replayHarnessNativeRuntimeMechanicalState,
} from "./shadow-control-plane";
import type {
	AgentExecution,
	AgentExecutionAttempt,
	HarnessNativeAgentPolicy,
	HarnessNativeAttemptContinuation,
	HarnessNativeProviderFailure,
	HarnessNativeRuntimeEvent,
	HarnessNativeRuntimeResult,
	HarnessNativeSearchCoverage,
	HarnessNativeSearchSkipReason,
	HarnessNativeToolName,
	HarnessNativeToolResultFacts,
	PatchExpectation,
	RepairContext,
	VerificationPolicy,
} from "./types";

export type HarnessNativeModelProvider = Pick<ModelProvider, "id" | "decide"> &
	Partial<Pick<ModelProvider, "createSession" | "plan">>;

const registeredTools: HarnessNativeToolName[] = [
	"read-file",
	"list-directory",
	"search-text",
	"search-text-recursive",
	"git-status",
	"git-diff",
	"apply-edit",
	"apply-patch",
	"apply-patch-batch",
	"apply-edit-batch",
	"create-file",
];

export function getHarnessNativeAvailableTools(verification: VerificationPolicy | undefined): HarnessNativeToolName[] {
	return verification !== undefined && verification.commands.length > 0
		? [...registeredTools, "run-public-verification"]
		: registeredTools;
}

function replayTerminalHarnessNativeRuntime(input: {
	policy: HarnessNativeAgentPolicy;
	model: string;
	provider: HarnessNativeModelProvider;
	events: readonly HarnessNativeRuntimeEvent[];
	attempt: number;
}): HarnessNativeRuntimeResult {
	const terminal = input.events.find(
		(event): event is Extract<HarnessNativeRuntimeEvent, { type: "attempt-ended" }> =>
			event.attempt === input.attempt && event.type === "attempt-ended",
	);
	if (terminal === undefined) throw new Error("Terminal Runtime replay requires an attempt-ended event.");
	const attemptEvents = input.events.filter((event) => event.attempt === input.attempt);
	const trajectory = deriveHarnessNativeTrajectory(attemptEvents, input.attempt);
	const contextViews = deriveHarnessNativeContextViews(input.events, input.attempt);
	const revisions = attemptEvents.filter((event) => event.type === "plan-revised").map((event) => event.revision);
	const ledger = deriveHarnessNativeResourceLedger(input.events);
	const attemptLedger = deriveHarnessNativeResourceLedger(attemptEvents);
	let actualModel: string | null = null;
	for (const event of attemptEvents)
		if (event.type === "model-call-completed" && event.actualModel !== null) actualModel = event.actualModel;
	const allUsageUnknown =
		attemptLedger.provider.total.completedCalls === attemptLedger.provider.total.unknownUsageCalls;
	return {
		version: 1,
		provider: input.provider.id,
		providerIdentity: {
			provider: input.policy.modelProvider.provider,
			protocol: input.policy.modelProvider.protocol,
			thinkingMode: input.policy.modelProvider.thinkingMode,
			endpointSha256: input.policy.modelProvider.endpointSha256,
			credentialRef: input.policy.modelProvider.credentialRef,
			implementation: input.policy.modelProvider.implementation,
			configuredModel: input.model,
			actualModel,
		},
		model: input.model,
		status: terminal.status,
		terminationReason: terminal.terminationReason,
		providerFailure: terminal.providerFailure ?? null,
		iterations: terminal.iterations,
		toolCalls: terminal.toolCalls,
		rejectedToolCalls: terminal.rejectedToolCalls,
		transportRetries: terminal.transportRetries,
		protocolRecoveries: attemptLedger.protocolRecoveries,
		completionDeferrals: attemptLedger.completionDeferrals,
		budget: {
			maxIterations: input.policy.maxIterations,
			maxToolCalls: input.policy.maxToolCalls,
			maxRejectedToolCalls: input.policy.maxRejectedToolCalls,
			maxObservationBytes: input.policy.maxObservationBytes,
			maxTransportRetries: input.policy.maxTransportRetries,
			maxProtocolRecoveries: input.policy.maxProtocolRecoveries,
			maxCompletionDeferrals: input.policy.maxCompletionDeferrals,
		},
		usage: {
			inputTokens: allUsageUnknown ? null : attemptLedger.provider.total.inputTokens,
			outputTokens: allUsageUnknown ? null : attemptLedger.provider.total.outputTokens,
		},
		resourceLedger: ledger,
		trajectory,
		convergenceCheckpoint: {
			version: 1,
			triggered: false,
			triggerIteration: null,
			discoveryActionsAtTrigger: null,
			successfulFileReadsAtTrigger: null,
			mutationActionsAtTrigger: null,
			targetedRetrieval: null,
			firstMutationIteration: null,
			firstPublicVerificationIteration: null,
			finishIteration: terminal.decision === "finish" ? terminal.iteration : null,
			outcome: "not-triggered",
		},
		historyProjection: contextViews.executor.historyProjection,
		workingContext: contextViews.executor.workingContext,
		planning: {
			version: 1,
			enabled: input.policy.plannerEnabled && input.provider.plan !== undefined,
			maxRevisions: input.policy.maxPlanRevisions,
			revisions,
			currentPlan: revisions.at(-1)?.plan ?? null,
		},
		planExecution: replayHarnessNativePlanExecutor(input.events, input.attempt).snapshot(),
		shadowControlPlane: replayHarnessNativeRuntimeMechanicalState(attemptEvents, true).shadowControlPlane,
	};
}

const WORKING_CONTEXT_MAX_SKIPPED_SEARCH_PATHS = 8;

type SearchMatch = { path: string; line: number; text: string };
type SearchMetadata = {
	query: string;
	matchCount: number;
	coverage: HarnessNativeSearchCoverage;
	skippedCount: number;
	skipped: Array<{ path: string; reason: HarnessNativeSearchSkipReason }>;
	matches: SearchMatch[];
};
type RuntimeToolResult = {
	status: "ok" | "rejected" | "error";
	observation: string;
	evidence: string;
	search?: SearchMetadata;
	facts: HarnessNativeToolResultFacts;
	rejectionReason?: Extract<HarnessNativeRuntimeEvent, { type: "tool-result" }>["rejectionReason"];
	/** DSH Code Mode canonical JSON result; never serialized as a second fact source. */
	programmaticValue?: DshCodeJsonValue;
	/** Compatibility projection for direct tool-executor consumers. Shadow state uses `facts`. */
	affectedPaths?: string[];
};

function dshProgrammaticValue(value: DshCodeJsonValue): DshCodeJsonValue {
	return value;
}

function toolPath(argumentsValue: Record<string, unknown>): string | null {
	const path = argumentsValue.path;
	if (typeof path !== "string") return null;
	try {
		return validateRelativeToolPath(path).replaceAll("\\", "/");
	} catch {
		return null;
	}
}

function normalizedWorkspacePath(root: string, path: string): string {
	return relative(root, path).replaceAll("\\", "/");
}

function retrievalFacts(
	request: Extract<ModelDecision, { kind: "tool" }>,
	status: RuntimeToolResult["status"],
	search?: SearchMetadata,
	read?: ReadFileResult,
): Extract<HarnessNativeToolResultFacts, { kind: "retrieval" }> {
	if (!isHarnessNativeRetrievalTool(request.tool)) throw new Error("Retrieval facts require a retrieval tool.");
	const path = toolPath(request.arguments);
	return {
		kind: "retrieval",
		tool: request.tool,
		path,
		query: typeof request.arguments.query === "string" ? request.arguments.query : null,
		inspectedPaths: status === "ok" && request.tool === "read-file" && path !== null ? [path] : [],
		candidatePaths:
			status === "ok" && search !== undefined ? [...new Set(search.matches.map((match) => match.path))] : [],
		search:
			search === undefined
				? null
				: {
						matchCount: search.matchCount,
						coverage: search.coverage,
						skippedCount: search.skippedCount,
						skipped: search.skipped.map((skip) => ({ ...skip })),
					},
		...(read === undefined
			? {}
			: {
					readWindow: {
						offset: read.offset,
						limit: read.limit,
						returnedLines: read.lines.length,
						totalLines: read.totalLines,
						truncatedByBytes: read.truncatedByBytes,
					},
				}),
	};
}

function mutationFacts(
	tool: string,
	affectedPaths: string[] = [],
): Extract<HarnessNativeToolResultFacts, { kind: "mutation" }> {
	if (!isHarnessNativeMutationTool(tool) && tool !== "run-code")
		throw new Error("Mutation facts require a mutation-capable tool.");
	return {
		kind: "mutation",
		tool: tool as Extract<HarnessNativeToolResultFacts, { kind: "mutation" }>["tool"],
		affectedPaths: [...new Set(affectedPaths.map((path) => path.replaceAll("\\", "/")))],
	};
}

function rejectedToolFacts(request: Extract<ModelDecision, { kind: "tool" }>): HarnessNativeToolResultFacts {
	if (isHarnessNativeRetrievalTool(request.tool)) return retrievalFacts(request, "rejected");
	if (isHarnessNativeMutationTool(request.tool)) return mutationFacts(request.tool);
	if (request.tool === "run-public-verification")
		return {
			kind: "verification",
			tool: "run-public-verification",
			commandIndex: typeof request.arguments.index === "number" ? request.arguments.index : null,
			outcome: "not-run",
			exitCode: null,
			timedOut: null,
			durationMs: null,
		};
	return { kind: "other" };
}

const RECURSIVE_SEARCH_MAX_DEPTH = 4;
const RECURSIVE_SEARCH_MAX_DIRECTORIES = 64;
const RECURSIVE_SEARCH_MAX_FILES = 256;
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

export function createHarnessNativeRuntime(
	providerOverride?: HarnessNativeModelProvider,
	options: { durable?: boolean } = {},
): AgentRuntime {
	return {
		id: "harness-native",
		execute: async ({ policy, worktreePath, repairContext }) => {
			if (policy.nativeAgent === null || policy.model === undefined)
				throw new Error("Harness-native Runtime requires validated native policy and model.");
			const nativePolicy = policy.nativeAgent;
			const model = policy.model;
			const provider =
				providerOverride ??
				createModelProvider(
					nativePolicy.modelProvider,
					{},
					{ maxTransportRetries: nativePolicy.maxTransportRetries },
				);
			const runId = policy.runId ?? basename(worktreePath);
			const recordPath = getHarnessNativeRuntimeRecordPath(policy.worktreeRoot, runId);
			const executeWithRecord = async (
				record: { initialEvents: HarnessNativeRuntimeEvent[]; append(event: HarnessNativeRuntimeEvent): void },
				durable: boolean,
			): Promise<AgentExecution> => {
				const eventSpine = new HarnessNativeRuntimeEventSpine(record.initialEvents, record);
				const invocationStartedAt = Date.now();
				const initialActiveRuntimeMs = deriveHarnessNativeResourceLedger(eventSpine.snapshot()).activeRuntimeMs;
				const attempts: AgentExecutionAttempt[] = [];
				let lastEvent = eventSpine.snapshot().at(-1);
				if (lastEvent?.type === "attempt-ended") {
					const terminalRuntime = replayTerminalHarnessNativeRuntime({
						policy: nativePolicy,
						model,
						provider,
						events: eventSpine.snapshot(),
						attempt: lastEvent.attempt,
					});
					const review = reviewHarnessNativeAttempt({
						runtime: terminalRuntime,
						attempt: lastEvent.attempt,
						maxAttempts: Math.max(lastEvent.attempt, nativePolicy.maxAttempts),
						remainingTimeMs: policy.timeoutMs - initialActiveRuntimeMs,
						minContinuationTimeMs: nativePolicy.minContinuationTimeMs,
					});
					eventSpine.append({
						version: 1,
						attempt: lastEvent.attempt,
						iteration: null,
						type: "attempt-reviewed",
						review,
					});
					lastEvent = eventSpine.snapshot().at(-1);
				}
				let attempt = lastEvent?.attempt ?? 1;
				let phaseAttemptLimit = attempt + nativePolicy.maxAttempts - 1;
				let resumeAttempt =
					lastEvent !== undefined &&
					!eventSpine.forAttempt(attempt).some((event) => event.type === "attempt-ended");
				let attemptContinuation: HarnessNativeAttemptContinuation | null = null;
				if (!resumeAttempt && lastEvent !== undefined) {
					const reviewEvent = eventSpine.forAttempt(attempt).find((event) => event.type === "attempt-reviewed");
					if (reviewEvent?.type !== "attempt-reviewed")
						throw new Error("Durable Runtime terminal attempt has no review event.");
					if (reviewEvent.review.decision === "continue") {
						attemptContinuation = createHarnessNativeAttemptContinuation(reviewEvent.review);
						attempt += 1;
						phaseAttemptLimit = Math.max(phaseAttemptLimit, attempt);
					} else if (repairContext.phase === "public-verification-repair") {
						attempt += 1;
						phaseAttemptLimit = attempt + nativePolicy.maxAttempts - 1;
					} else {
						const runtime = replayTerminalHarnessNativeRuntime({
							policy: nativePolicy,
							model,
							provider,
							events: eventSpine.snapshot(),
							attempt,
						});
						return {
							executable: "harness-native",
							args: [runtime.provider, runtime.model],
							exitCode: runtime.status === "succeeded" ? 0 : 1,
							signal: null,
							stdout: runtime.status === "succeeded" ? "Harness-native agent finished." : "",
							stderr:
								runtime.status === "succeeded"
									? ""
									: `Harness-native agent stopped: ${runtime.terminationReason}.`,
							durationMs: runtime.resourceLedger?.activeRuntimeMs ?? 0,
							timedOut: runtime.terminationReason === "timeout",
							runtime,
							attemptReview: reviewEvent.review,
							runtimeEvents: eventSpine.snapshot(),
						};
					}
				} else if (resumeAttempt && attempt > 1) {
					const previousReview = eventSpine
						.forAttempt(attempt - 1)
						.find((event) => event.type === "attempt-reviewed");
					if (previousReview?.type !== "attempt-reviewed" || previousReview.review.decision !== "continue")
						throw new Error("Resumed attempt has no valid continuation owner.");
					attemptContinuation = createHarnessNativeAttemptContinuation(previousReview.review);
				}
				let finalExecution: AgentExecution | null = null;

				for (; attempt <= phaseAttemptLimit; attempt += 1) {
					const attemptStartedAt = Date.now();
					const activeElapsedMs = initialActiveRuntimeMs + (attemptStartedAt - invocationStartedAt);
					const remainingTimeMs = policy.timeoutMs - activeElapsedMs;
					if (remainingTimeMs <= 0)
						throw new Error("Harness-native task resource ledger exhausted wall-clock time.");
					const runtime = await runHarnessNativeRuntime({
						policy: nativePolicy,
						prompt: policy.prompt,
						patchExpectation: policy.patchExpectation,
						model,
						worktreePath,
						provider,
						timeoutMs: remainingTimeMs,
						repairContext,
						attemptContinuation,
						verification: policy.verification,
						attempt,
						phase: attempt === 1 ? repairContext.phase : "attempt-continuation",
						eventSpine,
						resumeAttempt,
						durableWorktreeCheckpoints: durable,
					});
					resumeAttempt = false;
					const execution: AgentExecution = {
						executable: "harness-native",
						args: [runtime.provider, runtime.model],
						exitCode: runtime.status === "succeeded" ? 0 : 1,
						signal: null,
						stdout: runtime.status === "succeeded" ? "Harness-native agent finished." : "",
						stderr:
							runtime.status === "succeeded"
								? ""
								: `Harness-native agent stopped: ${runtime.terminationReason}.`,
						durationMs: Date.now() - attemptStartedAt,
						timedOut: runtime.terminationReason === "timeout",
						runtime,
					};
					const review = reviewHarnessNativeAttempt({
						runtime,
						attempt,
						maxAttempts: phaseAttemptLimit,
						remainingTimeMs: policy.timeoutMs - (initialActiveRuntimeMs + (Date.now() - invocationStartedAt)),
						minContinuationTimeMs: nativePolicy.minContinuationTimeMs,
					});
					execution.attemptReview = review;
					eventSpine.append({ version: 1, attempt, iteration: null, type: "attempt-reviewed", review });
					attempts.push({
						phase: attempt === 1 ? repairContext.phase : "attempt-continuation",
						feedback:
							repairContext.phase === "public-verification-repair"
								? repairContext.publicVerificationFeedback
								: null,
						continuation: attemptContinuation,
						review,
						execution,
					});
					finalExecution = execution;
					if (review.decision === "stop") break;
					attemptContinuation = createHarnessNativeAttemptContinuation(review);
				}

				if (finalExecution === null) throw new Error("Harness-native Runtime did not execute an attempt.");
				const resourceLedger = deriveHarnessNativeResourceLedger(eventSpine.snapshot());
				return {
					...finalExecution,
					durationMs: resourceLedger.activeRuntimeMs,
					attempts: attempts.length > 1 ? attempts : undefined,
					runtimeEvents: eventSpine.snapshot(),
				};
			};
			const durable = options.durable ?? providerOverride === undefined;
			if (!durable) return await executeWithRecord({ initialEvents: [], append: () => undefined }, false);
			return await withHarnessNativeRuntimeRecordLock(recordPath, async () => {
				const record = await HarnessNativeRuntimeRecord.open({
					path: recordPath,
					identity: {
						version: 1,
						kind: "agentpatchcheck-runtime",
						runId,
						taskSha256: hashHarnessNativeTaskIdentity({
							prompt: policy.prompt,
							model,
							provider: provider.id,
							policy: nativePolicy,
						}),
						worktreePath: resolve(worktreePath),
						repositoryRoot: resolve(policy.repositoryRoot),
						baseCommit: policy.baseCommit,
					},
				});
				return await executeWithRecord(record, true);
			});
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

async function safePatchTarget(root: string, value: string): Promise<void> {
	try {
		await regularFile(root, value);
	} catch (error) {
		if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
		await safeNewFile(root, value);
	}
}

interface ConstrainedPatch {
	path: string;
	expectedText: string;
	replacementText: string;
}

interface ConstrainedNewFile {
	path: string;
	content: string;
}

function exactOccurrenceCount(content: string, expectedText: string): number {
	return content.split(expectedText).length - 1;
}

function normalizeLineEndings(value: string, lineEnding: "\n" | "\r\n"): string {
	return value.replace(/\r\n|\r|\n/gu, lineEnding);
}

/**
 * Retains exact matching as the default. A single CRLF/LF fallback is allowed
 * only for multi-line model text and writes with the target file's line style.
 */
function replaceExactText(
	content: string,
	expectedText: string,
	replacementText: string,
	failureMessage: string,
): string {
	if (exactOccurrenceCount(content, expectedText) === 1) return content.replace(expectedText, replacementText);
	if (!/[\r\n]/u.test(expectedText)) throw new Error(failureMessage);
	const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
	const normalizedExpected = normalizeLineEndings(expectedText, lineEnding);
	if (normalizedExpected === expectedText || exactOccurrenceCount(content, normalizedExpected) !== 1)
		throw new Error(failureMessage);
	return content.replace(normalizedExpected, normalizeLineEndings(replacementText, lineEnding));
}

async function preparePatches(
	root: string,
	value: unknown,
	options: { minimum: number; maximum: number; failureMessage: string; matchFailureMessage?: string },
): Promise<Array<{ path: string; content: string; replacement: string }>> {
	if (!Array.isArray(value) || value.length < options.minimum || value.length > options.maximum)
		throw new Error(options.failureMessage);
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
			return {
				path: patch.path,
				content,
				replacement: replaceExactText(
					content,
					patch.expectedText,
					patch.replacementText,
					options.matchFailureMessage ?? "Patch batch expectedText must match each target exactly once.",
				),
			};
		}),
	);
	return prepared;
}

async function preparePatchBatch(root: string, value: unknown) {
	return await preparePatches(root, value, {
		minimum: 2,
		maximum: 8,
		failureMessage: "Patch batch must contain 2-8 patches.",
	});
}

async function prepareNewFiles(root: string, value: unknown): Promise<ConstrainedNewFile[]> {
	if (!Array.isArray(value) || value.length > 8) throw new Error("New-file batch is invalid.");
	const files: ConstrainedNewFile[] = [];
	for (const item of value) {
		if (item === null || typeof item !== "object") throw new Error("New-file batch entry is invalid.");
		const file = item as Partial<ConstrainedNewFile>;
		if (typeof file.content !== "string" || file.content.length > 32_768 || file.content.includes("\0"))
			throw new Error("New-file batch entry content is invalid.");
		files.push({ path: await safeNewFile(root, file.path), content: file.content });
	}
	if (new Set(files.map((file) => file.path)).size !== files.length)
		throw new Error("New-file batch must not target the same file twice.");
	return files;
}

async function prepareEditBatch(root: string, value: unknown) {
	if (value === null || typeof value !== "object") throw new Error("Edit batch is invalid.");
	const batch = value as { patches?: unknown; creates?: unknown };
	const patches = await preparePatches(root, batch.patches, {
		minimum: 0,
		maximum: 8,
		failureMessage: "Edit batch patches are invalid.",
	});
	const creates = await prepareNewFiles(root, batch.creates);
	const editCount = patches.length + creates.length;
	if (editCount < 2 || editCount > 8) throw new Error("Edit batch must contain 2-8 edits.");
	if (new Set([...patches.map((patch) => patch.path), ...creates.map((file) => file.path)]).size !== editCount)
		throw new Error("Edit batch must not mix a patch and creation for the same file.");
	return { patches, creates };
}

function summary(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, limit)}\n[truncated]`;
}

function publicVerificationObservation(
	index: number,
	outcome: "passed" | "failed",
	result: { exitCode: number | null; timedOut: boolean; stdout: string; stderr: string },
	limit: number,
): string {
	const status = `Public verification command ${index} ${outcome}. Exit code: ${result.exitCode ?? "unavailable"}. Timed out: ${result.timedOut}.`;
	if (outcome === "passed") return status;

	const diagnostics = [
		result.stdout.trim().length > 0 ? `stdout:\n${result.stdout}` : "",
		result.stderr.trim().length > 0 ? `stderr:\n${result.stderr}` : "",
	]
		.filter((value) => value.length > 0)
		.join("\n\n");
	if (diagnostics.length === 0) return status;

	return summary(
		`${status}\n\nUntrusted public verification diagnostics (sensitive text redacted):\n${redactSensitiveText(diagnostics)}`,
		limit,
	);
}

function recordSearchSkip(metadata: SearchMetadata, path: string, reason: HarnessNativeSearchSkipReason): void {
	metadata.skippedCount += 1;
	metadata.coverage = "partial";
	if (metadata.skipped.length < WORKING_CONTEXT_MAX_SKIPPED_SEARCH_PATHS)
		metadata.skipped.push({ path: path.replaceAll("\\", "/"), reason });
}

function createSearchMetadata(query: string): SearchMetadata {
	return { query, matchCount: 0, coverage: "complete", skippedCount: 0, skipped: [], matches: [] };
}

function searchObservation(
	matches: readonly SearchMatch[],
	workspaceRoot: string,
	displayRoot: string,
	coverage: HarnessNativeSearchCoverage,
	skippedCount: number,
	limit: number,
): string {
	return summary(
		[
			`Search coverage=${coverage}; matches=${matches.length}; skipped=${skippedCount}.`,
			...matches.map(
				(match) =>
					`${relative(displayRoot, join(workspaceRoot, match.path)).replaceAll("\\", "/")}:${match.line}:${match.text}`,
			),
		].join("\n"),
		limit,
	);
}

async function scanTextFile(options: {
	path: string;
	workspaceRoot: string;
	query: string;
	maxBytes: number;
	metadata: SearchMetadata;
}): Promise<{ scannedBytes: number; stoppedForMatchLimit: boolean }> {
	const metadata = await lstat(options.path);
	const displayPath = relative(options.workspaceRoot, options.path).replaceAll("\\", "/");
	if (!metadata.isFile() || metadata.isSymbolicLink()) {
		recordSearchSkip(options.metadata, displayPath, "unreadable");
		return { scannedBytes: 0, stoppedForMatchLimit: false };
	}
	if (options.maxBytes < 1) {
		recordSearchSkip(options.metadata, displayPath, "total-byte-limit");
		return { scannedBytes: 0, stoppedForMatchLimit: false };
	}
	const scanBytes = Math.min(metadata.size, options.maxBytes);
	if (metadata.size > scanBytes) recordSearchSkip(options.metadata, displayPath, "total-byte-limit");
	let scannedBytes = 0;
	let pending = "";
	let lineNumber = 0;
	let stoppedForMatchLimit = false;
	try {
		const stream = createReadStream(options.path, { encoding: "utf8", end: scanBytes - 1 });
		for await (const chunk of stream) {
			const text = String(chunk);
			scannedBytes += Buffer.byteLength(text, "utf8");
			if (text.includes("\0")) {
				recordSearchSkip(options.metadata, displayPath, "binary");
				return { scannedBytes, stoppedForMatchLimit: false };
			}
			const lines = `${pending}${text}`.split(/\r?\n/u);
			pending = lines.pop() ?? "";
			for (const line of lines) {
				lineNumber += 1;
				if (!line.includes(options.query)) continue;
				options.metadata.matches.push({ path: displayPath, line: lineNumber, text: line });
				options.metadata.matchCount += 1;
				if (options.metadata.matches.length >= RECURSIVE_SEARCH_MAX_MATCHES) {
					stoppedForMatchLimit = true;
					break;
				}
			}
			if (stoppedForMatchLimit) break;
		}
	} catch {
		recordSearchSkip(options.metadata, displayPath, "unreadable");
	}
	if (!stoppedForMatchLimit && pending.includes(options.query)) {
		lineNumber += 1;
		options.metadata.matches.push({ path: displayPath, line: lineNumber, text: pending });
		options.metadata.matchCount += 1;
		if (options.metadata.matches.length >= RECURSIVE_SEARCH_MAX_MATCHES) stoppedForMatchLimit = true;
	}
	return { scannedBytes, stoppedForMatchLimit };
}

async function searchTextRecursively(root: string, value: unknown, query: string, limit: number) {
	const searchRoot = await safePath(root, value);
	const searchRootMetadata = await lstat(searchRoot);
	if (!searchRootMetadata.isDirectory() || searchRootMetadata.isSymbolicLink())
		throw new Error("Recursive search path is not a regular directory.");
	const search = createSearchMetadata(query);
	const pendingDirectories: Array<{ path: string; depth: number }> = [{ path: searchRoot, depth: 0 }];
	let visitedDirectories = 0;
	let visitedFiles = 0;
	let readBytes = 0;
	let stop = false;
	while (pendingDirectories.length > 0 && !stop) {
		const directory = pendingDirectories.pop();
		if (directory === undefined) break;
		if (visitedDirectories >= RECURSIVE_SEARCH_MAX_DIRECTORIES) {
			recordSearchSkip(search, relative(root, directory.path), "directory-limit");
			break;
		}
		const directoryMetadata = await lstat(directory.path);
		if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) continue;
		visitedDirectories += 1;
		const entries = await readdir(directory.path, { withFileTypes: true });
		for (const entry of entries) {
			if (visitedFiles >= RECURSIVE_SEARCH_MAX_FILES) {
				recordSearchSkip(search, relative(root, join(directory.path, entry.name)), "file-limit");
				stop = true;
				break;
			}
			const path = join(directory.path, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				if (excludedRecursiveSearchDirectories.has(entry.name.toLowerCase()))
					recordSearchSkip(search, relative(root, path), "excluded-path");
				else if (directory.depth >= RECURSIVE_SEARCH_MAX_DEPTH)
					recordSearchSkip(search, relative(root, path), "max-depth");
				else pendingDirectories.push({ path, depth: directory.depth + 1 });
				continue;
			}
			if (!entry.isFile()) continue;
			if (isExcludedRecursiveSearchFile(entry.name)) {
				recordSearchSkip(search, relative(root, path), "excluded-path");
				continue;
			}
			visitedFiles += 1;
			const scanned = await scanTextFile({
				path,
				workspaceRoot: root,
				query,
				maxBytes: RECURSIVE_SEARCH_MAX_TOTAL_BYTES - readBytes,
				metadata: search,
			});
			readBytes += scanned.scannedBytes;
			if (scanned.stoppedForMatchLimit) {
				recordSearchSkip(search, relative(root, path), "match-limit");
				stop = true;
			}
		}
	}
	return {
		observation: searchObservation(search.matches, root, searchRoot, search.coverage, search.skippedCount, limit),
		evidence: `Recursive search coverage=${search.coverage}; files=${visitedFiles}; matches=${search.matchCount}; skipped=${search.skippedCount}.`,
		search,
	};
}

async function searchTextDirectly(root: string, value: unknown, query: string, limit: number) {
	const searchRoot = await safePath(root, value);
	const searchRootMetadata = await lstat(searchRoot);
	if (searchRootMetadata.isSymbolicLink()) throw new Error("Search path must not be a symbolic link.");
	const search = createSearchMetadata(query);
	let visitedFiles = 0;
	let readBytes = 0;
	const scan = async (path: string): Promise<boolean> => {
		const fileName = basename(path);
		if (isExcludedRecursiveSearchFile(fileName)) {
			recordSearchSkip(search, relative(root, path), "excluded-path");
			return false;
		}
		if (visitedFiles >= 128) {
			recordSearchSkip(search, relative(root, path), "file-limit");
			return true;
		}
		visitedFiles += 1;
		const scanned = await scanTextFile({
			path,
			workspaceRoot: root,
			query,
			maxBytes: RECURSIVE_SEARCH_MAX_TOTAL_BYTES - readBytes,
			metadata: search,
		});
		readBytes += scanned.scannedBytes;
		return scanned.stoppedForMatchLimit;
	};
	if (searchRootMetadata.isFile()) {
		if (await scan(searchRoot)) recordSearchSkip(search, relative(root, searchRoot), "match-limit");
	} else if (searchRootMetadata.isDirectory()) {
		const entries = await readdir(searchRoot, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isFile() || entry.isSymbolicLink()) continue;
			const stopped = await scan(join(searchRoot, entry.name));
			if (stopped) {
				recordSearchSkip(search, relative(root, join(searchRoot, entry.name)), "match-limit");
				break;
			}
		}
	} else {
		throw new Error("Search path is not a regular file or directory.");
	}
	const displayRoot = searchRootMetadata.isFile() ? dirname(searchRoot) : searchRoot;
	return {
		observation: searchObservation(search.matches, root, displayRoot, search.coverage, search.skippedCount, limit),
		evidence: `Direct search coverage=${search.coverage}; files=${visitedFiles}; matches=${search.matchCount}; skipped=${search.skippedCount}.`,
		search,
	};
}

async function executeTool(
	root: string,
	request: ModelDecision & { kind: "tool" },
	limit: number,
	verification: VerificationPolicy | undefined,
	signal?: AbortSignal,
): Promise<RuntimeToolResult> {
	const name = request.tool;
	try {
		if (name === "read-file") {
			const input = parseReadFileArguments(request.arguments);
			const result = await readBoundedFileWindow({
				absolutePath: await regularFile(root, input.path),
				displayPath: input.path.replaceAll("\\", "/"),
				input,
				maxObservationBytes: limit,
			});
			return {
				status: "ok" as const,
				observation: result.observation,
				evidence: `Read lines ${result.offset}-${result.lines.at(-1)?.number ?? result.offset - 1} of ${result.totalLines} from a regular workspace file.`,
				facts: retrievalFacts(request, "ok", undefined, result),
				programmaticValue: dshProgrammaticValue({
					path: input.path.replaceAll("\\", "/"),
					offset: result.offset,
					lines: result.lines.map((line) => ({ number: line.number, text: line.text })),
					totalLines: result.totalLines,
				}),
			};
		}
		if (name === "list-directory") {
			const path = await safePath(root, request.arguments.path);
			const entries = (await readdir(path, { withFileTypes: true }))
				.filter((entry) => entry.name !== ".git" && entry.name !== ".agentpatchcheck")
				.slice(0, 128);
			return {
				status: "ok" as const,
				observation: entries
					.map((entry) => `${entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other"}: ${entry.name}`)
					.join("\n"),
				evidence: "Listed a workspace directory.",
				facts: retrievalFacts(request, "ok"),
				programmaticValue: dshProgrammaticValue({
					path: normalizedWorkspacePath(root, path),
					entries: entries.map((entry) => ({
						name: entry.name,
						kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
					})),
				}),
			};
		}
		if (name === "search-text") {
			const query = request.arguments.query;
			if (typeof query !== "string" || !query || query.length > 256 || query.includes("\0"))
				throw new Error("Search query is invalid.");
			const result = await searchTextDirectly(root, request.arguments.path, query, limit);
			return {
				status: "ok" as const,
				...result,
				facts: retrievalFacts(request, "ok", result.search),
				programmaticValue: dshProgrammaticValue({ output: result.observation }),
			};
		}
		if (name === "search-text-recursive") {
			const query = request.arguments.query;
			if (typeof query !== "string" || !query || query.length > 256 || query.includes("\0"))
				throw new Error("Search query is invalid.");
			const result = await searchTextRecursively(root, request.arguments.path, query, limit);
			return {
				status: "ok" as const,
				...result,
				facts: retrievalFacts(request, "ok", result.search),
				programmaticValue: dshProgrammaticValue({ output: result.observation }),
			};
		}
		if (name === "git-status" || name === "git-diff") {
			const result = await runGit(root, name === "git-status" ? ["status", "--short"] : ["diff", "--"], {
				trimStdout: false,
			});
			return result.ok
				? {
						status: "ok" as const,
						observation: summary(result.stdout, limit),
						evidence: `Read ${name}.`,
						facts: retrievalFacts(request, "ok"),
						programmaticValue: dshProgrammaticValue({ output: summary(result.stdout, limit) }),
					}
				: {
						status: "error" as const,
						observation: "Git tool failed.",
						evidence: "Git tool failed.",
						facts: retrievalFacts(request, "error"),
					};
		}
		if (name === "apply-patch") {
			const result = await applyManagedMutationPatch({
				root,
				patch: request.arguments.patch,
				validateTarget: async (path) => await safePatchTarget(root, path),
			});
			return {
				status: "ok" as const,
				observation: `Patch applied to ${result.affectedPaths.length} file${result.affectedPaths.length === 1 ? "" : "s"}.`,
				evidence: `Applied a Git-validated unified diff to ${result.affectedPaths.length} Harness-validated workspace target${result.affectedPaths.length === 1 ? "" : "s"}.`,
				facts: mutationFacts(name, result.affectedPaths),
			};
		}
		if (name === "apply-edit") {
			if (request.arguments.replaceAll === true) {
				const path = await regularFile(root, request.arguments.path);
				const expectedText = request.arguments.expectedText;
				const replacementText = request.arguments.replacementText;
				if (typeof expectedText !== "string" || expectedText.length === 0 || typeof replacementText !== "string")
					throw new Error("Single edit input is invalid.");
				const before = await readFile(path, "utf8");
				if (!before.includes(expectedText))
					throw new Error("Single edit expectedText was not found in the target.");
				const after = before.replaceAll(expectedText, replacementText);
				await writeFile(path, after, "utf8");
				const relativePath = relative(root, path).replaceAll("\\", "/");
				return {
					status: "ok" as const,
					observation: `The file ${relativePath} has been updated. All occurrences were successfully replaced.`,
					evidence: "Applied a structured replace-all edit to one Harness-validated workspace file.",
					facts: mutationFacts(name, [relativePath]),
					programmaticValue: dshProgrammaticValue({ path: relativePath, before, after }),
				};
			}
			const edits = await preparePatches(root, [request.arguments], {
				minimum: 1,
				maximum: 1,
				failureMessage: "Single edit input is invalid.",
				matchFailureMessage: "Single edit expectedText must match the target exactly once.",
			});
			const [edit] = edits;
			if (edit === undefined) throw new Error("Single edit input is invalid.");
			await writeFile(edit.path, edit.replacement, "utf8");
			const affectedPath = normalizedWorkspacePath(root, edit.path);
			return {
				status: "ok" as const,
				observation: `Replaced exactly one matching text region in ${affectedPath}.`,
				evidence: "Applied one constrained exact-text replacement after regular-file and unique-match preflight.",
				facts: mutationFacts(name, [affectedPath]),
				programmaticValue: dshProgrammaticValue({
					path: affectedPath,
					before: edit.content,
					after: edit.replacement,
				}),
			};
		}
		if (name === "apply-patch-batch") {
			const patches = await preparePatchBatch(root, request.arguments.patches);
			for (const patch of patches) await writeFile(patch.path, patch.replacement, "utf8");
			return {
				status: "ok" as const,
				observation: `Patch batch applied to ${patches.length} files.`,
				evidence: `Applied ${patches.length} constrained text replacements after batch preflight.`,
				facts: mutationFacts(
					name,
					patches.map((patch) => normalizedWorkspacePath(root, patch.path)),
				),
			};
		}
		if (name === "apply-edit-batch") {
			const batch = await prepareEditBatch(root, request.arguments);
			for (const patch of batch.patches) await writeFile(patch.path, patch.replacement, "utf8");
			for (const file of batch.creates) await writeFile(file.path, file.content, { encoding: "utf8", flag: "wx" });
			return {
				status: "ok" as const,
				observation: `Edit batch applied to ${batch.patches.length} existing and ${batch.creates.length} new files.`,
				evidence: `Applied ${batch.patches.length} constrained replacements and created ${batch.creates.length} files after batch preflight.`,
				facts: mutationFacts(name, [
					...batch.patches.map((patch) => normalizedWorkspacePath(root, patch.path)),
					...batch.creates.map((file) => normalizedWorkspacePath(root, file.path)),
				]),
			};
		}
		if (name === "create-file") {
			const content = request.arguments.content;
			if (typeof content !== "string" || content.length > 32_768 || content.includes("\0"))
				throw new Error("New file content is invalid.");
			const path = await safeNewFile(root, request.arguments.path);
			await writeFile(path, content, { encoding: "utf8", flag: "wx" });
			return {
				status: "ok" as const,
				observation: "New file created.",
				evidence: "Created one new workspace file exclusively.",
				facts: mutationFacts(name, [normalizedWorkspacePath(root, path)]),
			};
		}
		if (name === "write-file") {
			const content = request.arguments.content;
			if (typeof content !== "string" || content.length > 32_768 || content.includes("\0"))
				throw new Error("File content is invalid.");
			let path: string;
			let operation: "created" | "updated";
			let before: string | null;
			try {
				path = await regularFile(root, request.arguments.path);
				before = await readFile(path, "utf8");
				await writeFile(path, content, "utf8");
				operation = "updated";
			} catch (error) {
				if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT")
					throw error;
				path = await safeNewFile(root, request.arguments.path);
				await writeFile(path, content, { encoding: "utf8", flag: "wx" });
				operation = "created";
				before = null;
			}
			const affectedPath = normalizedWorkspacePath(root, path);
			return {
				status: "ok" as const,
				observation: `${operation === "created" ? "Created" : "Updated"} ${affectedPath}.`,
				evidence: `${operation === "created" ? "Created" : "Fully replaced"} one Harness-validated workspace file.`,
				facts: mutationFacts(name, [affectedPath]),
				programmaticValue: dshProgrammaticValue({
					path: affectedPath,
					operation: operation === "created" ? "create" : "update",
					before,
					after: content,
				}),
			};
		}
		if (name === "todo-write") {
			const todos = request.arguments.todos;
			if (!Array.isArray(todos)) throw new Error("todos must be an array");
			const seen = new Set<string>();
			const counts = { pending: 0, inProgress: 0, completed: 0 };
			const normalizedTodos: Array<{ content: string; status: "pending" | "in_progress" | "completed" }> = [];
			for (const raw of todos) {
				if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("todo item is invalid");
				const item = raw as Record<string, unknown>;
				if (typeof item.content !== "string" || item.content.trim().length === 0)
					throw new Error("todo content must be non-empty");
				if (seen.has(item.content.trim())) throw new Error("todo content must be unique");
				seen.add(item.content.trim());
				if (item.status === "pending") counts.pending += 1;
				else if (item.status === "in_progress") counts.inProgress += 1;
				else if (item.status === "completed") counts.completed += 1;
				else throw new Error("todo status is invalid");
				normalizedTodos.push({ content: item.content.trim(), status: item.status });
			}
			return {
				status: "ok" as const,
				observation: `Updated todo list: ${counts.pending} pending, ${counts.inProgress} in progress, ${counts.completed} completed.`,
				evidence: "Updated the model-owned coding progress list.",
				facts: { kind: "other" as const },
				programmaticValue: dshProgrammaticValue({ todos: normalizedTodos }),
			};
		}
		if (name === "dsh-shell") {
			const command = request.arguments.command;
			const description = request.arguments.description;
			const timeoutValue = request.arguments.timeoutMs;
			const dialect = request.arguments.dialect;
			if (typeof command !== "string" || command.trim().length === 0)
				throw new Error("Shell command must be non-empty.");
			if (typeof description !== "string" || description.trim().length === 0)
				throw new Error("Shell description must be non-empty.");
			if (dialect !== "pwsh" && dialect !== "bash") throw new Error("Shell dialect is invalid.");
			const timeoutMs =
				timeoutValue === undefined
					? 120_000
					: typeof timeoutValue === "number" && Number.isFinite(timeoutValue) && timeoutValue > 0
						? Math.min(timeoutValue, 600_000)
						: 0;
			if (timeoutMs === 0) throw new Error("Shell timeoutMs must be a positive number.");
			const launch =
				dialect === "pwsh"
					? { command: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command] }
					: { command: "/bin/bash", args: ["-lc", command] };
			const result = await runVerificationCommand({
				command: { ...launch, timeoutMs },
				cwd: root,
				outputLimitBytes: limit,
				signal,
			});
			const marker = result.timedOut
				? "[timed out]"
				: result.signal !== null
					? `[signal: ${result.signal}]`
					: `[exit code: ${result.exitCode ?? "unknown"}]`;
			return {
				status: "ok" as const,
				observation: [result.stdout, result.stderr, marker].filter((part) => part.length > 0).join("\n"),
				evidence: `Executed one bounded ${dialect} command in the managed worktree (${marker}).`,
				facts: { kind: "other" as const },
				programmaticValue: dshProgrammaticValue({
					stdout: result.stdout,
					stderr: result.stderr,
					exitCode: result.exitCode,
					signal: result.signal,
					timedOut: result.timedOut,
					durationMs: result.durationMs,
				}),
			};
		}
		if (name === "run-public-verification") {
			const index = request.arguments.index;
			if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || verification === undefined)
				throw new Error("Public verification command index is invalid.");
			const command = verification.commands[index];
			if (command === undefined) throw new Error("Public verification command index is unavailable.");
			const result = await runVerificationCommand({
				command,
				cwd: root,
				outputLimitBytes: verification.outputLimitBytes,
				signal,
			});
			const outcome: Extract<HarnessNativeToolResultFacts, { kind: "verification" }>["outcome"] =
				result.exitCode === 0 && !result.timedOut ? "passed" : "failed";
			return {
				status: "ok" as const,
				observation: publicVerificationObservation(index, outcome, result, verification.outputLimitBytes),
				evidence: `Ran TaskSpec-declared public verification command ${index}: ${outcome}.`,
				facts: {
					kind: "verification" as const,
					tool: "run-public-verification" as const,
					commandIndex: index,
					outcome,
					exitCode: result.exitCode,
					timedOut: result.timedOut,
					durationMs: result.durationMs,
				},
				programmaticValue: dshProgrammaticValue({
					index,
					outcome,
					exitCode: result.exitCode,
					timedOut: result.timedOut,
					durationMs: result.durationMs,
				}),
			};
		}
		return {
			status: "rejected" as const,
			observation: "Tool is not registered.",
			evidence: "Rejected an unregistered tool.",
			facts: { kind: "other" as const },
		};
	} catch (error) {
		if (name === "apply-patch" && error instanceof MutationPatchError) {
			return {
				status: "rejected" as const,
				observation: summary(error.message, limit),
				evidence: error.message,
				facts: rejectedToolFacts(request),
			};
		}
		return {
			status: "rejected" as const,
			observation: "Tool request was rejected by workspace policy.",
			evidence: error instanceof Error ? error.message : "Tool request rejected.",
			facts: rejectedToolFacts(request),
		};
	}
}

/**
 * Reuses the Harness-owned, path-safe tool executor for alternative control
 * loops. It exposes only bounded observations, not filesystem capabilities.
 */
export async function executeHarnessNativeTool(input: {
	root: string;
	tool: HarnessNativeToolName;
	arguments: Record<string, unknown>;
	maxObservationBytes: number;
	verification: VerificationPolicy | undefined;
}): Promise<RuntimeToolResult> {
	const result = await executeTool(
		input.root,
		{ kind: "tool", tool: input.tool, arguments: input.arguments },
		input.maxObservationBytes,
		input.verification,
	);
	return result.facts.kind === "mutation" ? { ...result, affectedPaths: [...result.facts.affectedPaths] } : result;
}

function safeArguments(value: Record<string, unknown>): Record<string, string | number> {
	const entries: Array<[string, string | number]> = [];
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === "number") entries.push([key, item]);
		else if (typeof item === "string")
			entries.push(
				key === "path" || key === "query" ? [key, item] : [`${key}Bytes`, Buffer.byteLength(item, "utf8")],
			);
		else if (Array.isArray(item)) entries.push([`${key}Count`, item.length]);
	}
	return Object.fromEntries(entries);
}

export async function runHarnessNativeRuntime(options: {
	policy: HarnessNativeAgentPolicy;
	prompt: string;
	/** Existing TaskPolicy contract fact; direct callers retain the TaskPolicy default. */
	patchExpectation?: PatchExpectation;
	model: string;
	worktreePath: string;
	provider: HarnessNativeModelProvider;
	timeoutMs: number;
	/** Direct runtime callers default to an initial execution; the Headless Core always passes this explicitly. */
	repairContext?: RepairContext;
	/** Fresh-attempt handoff derived from the immediately preceding attempt. */
	attemptContinuation?: HarnessNativeAttemptContinuation | null;
	/** Only TaskPolicy-declared verification commands are exposed to the Agent. */
	verification?: VerificationPolicy;
	/** Disable only for diagnostic A/B comparison. Shadow state is never sent to the Provider. */
	shadowControlPlane?: boolean;
	/** Outer attempt identity. Direct Runtime callers use attempt 1. */
	attempt?: number;
	/** Harness-owned phase for the attempt boundary event. */
	phase?: AgentExecutionAttempt["phase"];
	/** Shared only by the bounded outer attempt controller. */
	eventSpine?: HarnessNativeRuntimeEventSpine;
	/** Resume an already-started, non-terminal attempt from its canonical event prefix. */
	resumeAttempt?: boolean;
	/** Enabled only when the Event Spine is backed by a durable Runtime record. */
	durableWorktreeCheckpoints?: boolean;
}): Promise<HarnessNativeRuntimeResult> {
	const startedAt = Date.now();
	const attempt = options.attempt ?? 1;
	const eventSpine = options.eventSpine ?? new HarnessNativeRuntimeEventSpine();
	const repairContext = options.repairContext ?? {
		phase: "initial",
		publicVerificationFeedback: null,
		repairInstruction: null,
	};
	const existingAttemptEvents = eventSpine.forAttempt(attempt);
	if (options.resumeAttempt) {
		if (!existingAttemptEvents.some((event) => event.type === "attempt-started"))
			throw new Error("Runtime resume requires an existing attempt-started event.");
		if (existingAttemptEvents.some((event) => event.type === "attempt-ended"))
			throw new Error("A terminal Runtime attempt cannot be resumed.");
		const completedModelCallIds = new Set(
			existingAttemptEvents.filter((event) => event.type === "model-call-completed").map((event) => event.callId),
		);
		for (const event of existingAttemptEvents) {
			if (event.type !== "model-call-started" || completedModelCallIds.has(event.callId)) continue;
			eventSpine.append({
				version: 1,
				attempt,
				iteration: event.iteration,
				type: "model-call-completed",
				callId: event.callId,
				owner: event.owner,
				outcome: "interrupted",
				inputTokens: null,
				outputTokens: null,
				transportRetries: null,
				actualModel: null,
			});
		}
	} else {
		if (existingAttemptEvents.length > 0) throw new Error("Runtime attempt identity is already in use.");
		eventSpine.append({
			version: 1,
			attempt,
			iteration: null,
			type: "attempt-started",
			phase: options.phase ?? (attempt === 1 ? repairContext.phase : "attempt-continuation"),
			continuationFromAttempt: options.attemptContinuation?.previousAttempt ?? null,
		});
	}
	const nativeTools = getHarnessNativeAvailableTools(options.verification);
	const programmaticTools = getProgrammaticToolFacade(
		options.verification !== undefined && options.verification.commands.length > 0,
	);
	const programmaticPresentation = options.policy.toolPresentation !== "native";
	const dshCompatible = options.policy.toolPresentation === "dsh-compatible";
	const tools: HarnessNativeToolName[] = dshCompatible
		? ["run_code"]
		: programmaticPresentation
			? ["run-code"]
			: nativeTools;
	const session = options.provider.createSession?.() ?? {
		decide: options.provider.decide,
		recordToolResults: () => undefined,
	};
	const initialViews = deriveHarnessNativeContextViews(eventSpine.snapshot(), attempt);
	const initialRevisions = eventSpine
		.forAttempt(attempt)
		.filter((event) => event.type === "plan-revised")
		.map((event) => event.revision);
	const plannerEnabled = options.policy.plannerEnabled && !dshCompatible;
	const planner = new HarnessNativePlanner(
		!plannerEnabled || options.provider.plan === undefined ? null : { plan: options.provider.plan },
		options.policy.maxPlanRevisions,
		initialViews.planner.previousPlan,
		initialRevisions,
	);
	const planExecutor = options.resumeAttempt
		? replayHarnessNativePlanExecutor(eventSpine.snapshot(), attempt)
		: new HarnessNativePlanExecutor();
	const initialAttemptLedger = deriveHarnessNativeResourceLedger(eventSpine.forAttempt(attempt));
	let consecutiveCompletionDeferrals = 0;
	for (let index = existingAttemptEvents.length - 1; index >= 0; index -= 1) {
		const event = existingAttemptEvents[index];
		if (event?.type === "completion-evaluated" && event.disposition === "continue") {
			consecutiveCompletionDeferrals += 1;
			continue;
		}
		if (event?.type === "tool-result") break;
	}
	const completionController = new HarnessNativeCompletionController(
		options.policy.maxCompletionDeferrals,
		consecutiveCompletionDeferrals,
	);
	let toolCalls = initialAttemptLedger.budgetedToolCalls;
	let rejectedToolCalls = initialAttemptLedger.budgetedRejectedToolCalls;
	let protocolRecoveries = initialAttemptLedger.protocolRecoveries;
	let completionDeferrals = initialAttemptLedger.completionDeferrals;
	let iterations = initialAttemptLedger.executorIterations;
	let inputTokens = initialAttemptLedger.provider.total.inputTokens;
	let outputTokens = initialAttemptLedger.provider.total.outputTokens;
	let transportRetries = initialAttemptLedger.provider.total.transportRetries;
	let actualModel: string | null = null;
	for (const event of eventSpine.forAttempt(attempt))
		if (event.type === "model-call-completed" && event.actualModel !== null) actualModel = event.actualModel;
	let modelCallOrdinal = eventSpine.forAttempt(attempt).filter((event) => event.type === "model-call-started").length;
	const nextModelCallId = (owner: "executor" | "planner", iteration: number): string => {
		modelCallOrdinal += 1;
		return `attempt-${attempt}:iteration-${iteration}:${owner}-call-${modelCallOrdinal}`;
	};
	const convergenceCheckpoint: HarnessNativeRuntimeResult["convergenceCheckpoint"] = {
		version: 1,
		triggered: false,
		triggerIteration: null,
		discoveryActionsAtTrigger: null,
		successfulFileReadsAtTrigger: null,
		mutationActionsAtTrigger: null,
		targetedRetrieval: null,
		firstMutationIteration: null,
		firstPublicVerificationIteration: null,
		finishIteration: null,
		outcome: "not-triggered",
	};
	const fail = (
		terminationReason: HarnessNativeRuntimeResult["terminationReason"],
		failure: HarnessNativeProviderFailure | null = null,
		decision: "finish" | "fail" | null = null,
	): HarnessNativeRuntimeResult => {
		const status = terminationReason === "finished" ? "succeeded" : "failed";
		eventSpine.append({
			version: 1,
			attempt,
			iteration: iterations || null,
			type: "attempt-ended",
			decision,
			status,
			terminationReason,
			providerFailure: failure,
			iterations,
			toolCalls,
			rejectedToolCalls,
			transportRetries,
		});
		const contextViews = deriveHarnessNativeContextViews(eventSpine.snapshot(), attempt);
		const runtimeEvents = eventSpine.forAttempt(attempt);
		const trajectory = deriveHarnessNativeTrajectory(runtimeEvents, attempt);
		const resourceLedger = deriveHarnessNativeResourceLedger(eventSpine.snapshot());
		const attemptLedger = deriveHarnessNativeResourceLedger(runtimeEvents);
		return {
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
			status,
			terminationReason,
			providerFailure: failure,
			iterations,
			toolCalls,
			rejectedToolCalls,
			transportRetries,
			protocolRecoveries,
			completionDeferrals,
			budget: {
				maxIterations: options.policy.maxIterations,
				maxToolCalls: options.policy.maxToolCalls,
				maxRejectedToolCalls: options.policy.maxRejectedToolCalls,
				maxObservationBytes: options.policy.maxObservationBytes,
				maxTransportRetries: options.policy.maxTransportRetries,
				maxProtocolRecoveries: options.policy.maxProtocolRecoveries,
				maxCompletionDeferrals: options.policy.maxCompletionDeferrals,
			},
			usage: {
				inputTokens:
					attemptLedger.provider.total.completedCalls === attemptLedger.provider.total.unknownUsageCalls
						? null
						: inputTokens,
				outputTokens:
					attemptLedger.provider.total.completedCalls === attemptLedger.provider.total.unknownUsageCalls
						? null
						: outputTokens,
			},
			resourceLedger,
			trajectory,
			runtimeEvents: options.eventSpine === undefined ? runtimeEvents : undefined,
			convergenceCheckpoint,
			historyProjection: contextViews.executor.historyProjection,
			workingContext: contextViews.executor.workingContext,
			planning: planner.snapshot(),
			planExecution: planExecutor.snapshot(),
			shadowControlPlane: replayHarnessNativeRuntimeMechanicalState(
				eventSpine.forAttempt(attempt),
				options.shadowControlPlane !== false,
			).shadowControlPlane,
		};
	};
	const recordRejectedToolRequest = (input: {
		request: Extract<ModelDecision, { kind: "tool" }>;
		iteration: number;
		actionId: string;
		reason: Extract<HarnessNativeRuntimeEvent, { type: "tool-result" }>["rejectionReason"];
		observation: string;
		dispatched?: boolean;
	}): void => {
		const tool = input.request.tool as HarnessNativeToolName;
		const argumentsProjection = safeArguments(input.request.arguments);
		if (input.dispatched !== true)
			eventSpine.append({
				version: 1,
				attempt,
				iteration: input.iteration,
				type: "tool-dispatched",
				actionId: input.actionId,
				tool,
				arguments: argumentsProjection,
			});
		eventSpine.append({
			version: 1,
			attempt,
			iteration: input.iteration,
			type: "tool-result",
			actionId: input.actionId,
			tool,
			arguments: argumentsProjection,
			status: "rejected",
			observation: input.observation,
			observationSummary: input.observation,
			facts: rejectedToolFacts(input.request),
			rejectionReason: input.reason,
		});
		rejectedToolCalls += 1;
	};
	for (let iteration = iterations + 1; iteration <= options.policy.maxIterations; iteration += 1) {
		if (Date.now() - startedAt >= options.timeoutMs) return fail("timeout");
		let answer: Awaited<ReturnType<HarnessNativeModelProvider["decide"]>>;
		iterations += 1;
		planExecutor.synchronize(planner.currentRevision);
		let executorRecoveries = 0;
		for (;;) {
			const modelCallId = nextModelCallId("executor", iteration);
			eventSpine.append({
				version: 1,
				attempt,
				iteration,
				type: "model-call-started",
				callId: modelCallId,
				owner: "executor",
			});
			try {
				const contextViews = deriveHarnessNativeContextViews(eventSpine.snapshot(), attempt);
				answer = await session.decide({
					prompt: options.prompt,
					patchExpectation: options.patchExpectation ?? "changes-required",
					observations: contextViews.executor.observations,
					tools,
					model: options.model,
					repairContext,
					workingContext: contextViews.executor.workingContext,
					iteration,
					historyProjection: contextViews.executor.historyProjection,
					plan: contextViews.executor.plan,
					plannerEnabled,
					toolPresentation: options.policy.toolPresentation,
					programmaticTools: programmaticPresentation ? programmaticTools : undefined,
					workingDirectory: dshCompatible ? options.worktreePath : undefined,
					activePlanStep: contextViews.executor.activePlanStep,
					attemptContinuation: options.attemptContinuation ?? null,
					contextView: contextViews.executor,
					protocolRecovery: contextViews.executor.protocolRecovery,
					completionFeedback: contextViews.executor.completionFeedback,
				});
				eventSpine.append({
					version: 1,
					attempt,
					iteration,
					type: "model-call-completed",
					callId: modelCallId,
					owner: "executor",
					outcome: "succeeded",
					inputTokens: answer.usage?.inputTokens ?? null,
					outputTokens: answer.usage?.outputTokens ?? null,
					transportRetries: answer.transportRetries ?? 0,
					actualModel: answer.actualModel ?? null,
				});
				break;
			} catch (error) {
				const failure = error instanceof ModelProviderFailureError ? error.failure : null;
				eventSpine.append({
					version: 1,
					attempt,
					iteration,
					type: "model-call-completed",
					callId: modelCallId,
					owner: "executor",
					outcome: "failed",
					inputTokens: null,
					outputTokens: null,
					transportRetries: null,
					actualModel: null,
				});
				if (failure === null || !isRecoverableProtocolFailure(failure)) return fail("model-failed", failure);
				const canRetry = executorRecoveries < options.policy.maxProtocolRecoveries;
				if (canRetry) {
					executorRecoveries += 1;
					protocolRecoveries += 1;
				}
				eventSpine.append({
					version: 1,
					attempt,
					iteration,
					type: "protocol-recovery",
					owner: "executor",
					failure,
					recovery: executorRecoveries,
					maxRecoveries: options.policy.maxProtocolRecoveries,
					disposition: canRetry ? "retrying" : "exhausted",
				});
				if (!canRetry) return fail("model-failed", failure);
			}
		}
		actualModel = answer.actualModel ?? actualModel;
		inputTokens += answer.usage?.inputTokens ?? 0;
		outputTokens += answer.usage?.outputTokens ?? 0;
		transportRetries += answer.transportRetries ?? 0;
		if (answer.decision.kind === "finish") {
			const completion = completionController.evaluate({
				planning: planner.snapshot(),
				planExecution: planExecutor.snapshot(),
			});
			const activeStep = planExecutor.activeStep;
			eventSpine.append({
				version: 1,
				attempt,
				iteration,
				type: "completion-evaluated",
				disposition: completion.disposition,
				reason: completion.reason,
				feedback: completion.feedback,
				activeExecutionId: activeStep?.executionId ?? null,
				planRevision: planner.currentRevision?.revision ?? null,
			});
			if (completion.disposition === "accept") {
				convergenceCheckpoint.finishIteration = iteration;
				return fail("finished", null, "finish");
			}
			if (completion.disposition === "terminal") {
				convergenceCheckpoint.finishIteration = iteration;
				return fail("incomplete-finish", null, "finish");
			}
			completionDeferrals += 1;
			continue;
		}
		if (answer.decision.kind === "fail") {
			return fail("model-failed", null, "fail");
		}
		const requests =
			answer.decision.kind === "tool"
				? [answer.decision]
				: answer.decision.kind === "tool-batch"
					? answer.decision.calls
					: [];
		if (requests.length === 0) return fail("invalid-decision");
		completionController.recordExecution();
		if (requests.length > 1 && toolCalls + requests.length > options.policy.maxToolCalls) {
			for (const [requestIndex, request] of requests.entries())
				recordRejectedToolRequest({
					request,
					iteration,
					actionId: `attempt-${attempt}:iteration-${iteration}:action-${requestIndex + 1}`,
					reason: "tool-budget",
					observation: "Tool batch was rejected because the Harness-native tool budget was exhausted.",
				});
			return fail("tool-limit");
		}
		let planningTrigger: PlannerTrigger | null = null;
		for (const [requestIndex, request] of requests.entries()) {
			const actionId = `attempt-${attempt}:iteration-${iteration}:action-${requestIndex + 1}`;
			if (toolCalls >= options.policy.maxToolCalls) {
				recordRejectedToolRequest({
					request,
					iteration,
					actionId,
					reason: "tool-budget",
					observation: "Tool request was rejected because the Harness-native tool budget was exhausted.",
				});
				return fail("tool-limit");
			}
			const argumentsProjection = safeArguments(request.arguments);
			eventSpine.append({
				version: 1,
				attempt,
				iteration,
				type: "tool-dispatched",
				actionId,
				tool: request.tool as HarnessNativeToolName,
				arguments: argumentsProjection,
			});
			const offeredTool = tools.includes(request.tool as HarnessNativeToolName);
			const compositionEnvelope =
				offeredTool && programmaticPresentation && request.tool === (dshCompatible ? "run_code" : "run-code");
			let nestedAction = 0;
			let nestedReservations = 0;
			let mutationQueue = Promise.resolve();
			let compositionTerminalReason: "tool-limit" | "rejected-tool-limit" | null = null;
			const tool = !offeredTool
				? {
						status: "rejected" as const,
						observation: `Tool ${request.tool} is not available in the current tool presentation.`,
						evidence: "Rejected a tool outside the current Provider-facing tool presentation.",
						facts: { kind: "other" as const },
						rejectionReason: "unavailable-tool" as const,
					}
				: compositionEnvelope
					? await (async (): Promise<RuntimeToolResult> => {
							const code = request.arguments.code;
							const description = request.arguments.description;
							if (typeof code !== "string" || typeof description !== "string" || description.trim().length === 0)
								return {
									status: "rejected",
									observation: "run-code requires non-empty code and description.",
									evidence: "Rejected run-code arguments.",
									facts: { kind: "other" },
									rejectionReason: "invalid-input",
								};
							const beforeSurface = dshCompatible
								? await captureHarnessNativeWorktreeMutationSurface(options.worktreePath)
								: null;
							const nestedOwnedPaths = new Set<string>();
							const nestedOwnedSurfaceHashes = new Map<string, string | undefined>();
							const collectDirectAffectedPaths = async (): Promise<string[]> => {
								if (beforeSurface === null) return [];
								const afterSurface = await captureHarnessNativeWorktreeMutationSurface(options.worktreePath);
								return diffHarnessNativeWorktreeMutationSurfaces(beforeSurface, afterSurface).filter(
									(path) =>
										!nestedOwnedPaths.has(path) ||
										afterSurface.pathSha256.get(path) !== nestedOwnedSurfaceHashes.get(path),
								);
							};
							try {
								const executeNestedCall = async (
									call: ProgrammaticToolDispatch,
									signal: AbortSignal | undefined,
									serializeMutation: boolean,
								): Promise<RuntimeToolResult | null> => {
									const mapped = mapProgrammaticToolFacadeCall(call);
									const nestedActionId = `${actionId}:code:${++nestedAction}`;
									const nestedRequest: Extract<ModelDecision, { kind: "tool" }> = {
										kind: "tool",
										tool: mapped.tool,
										arguments: mapped.arguments,
									};
									if (toolCalls + nestedReservations >= options.policy.maxToolCalls) {
										recordRejectedToolRequest({
											request: nestedRequest,
											iteration,
											actionId: nestedActionId,
											reason: "tool-budget",
											observation:
												"Nested tool request was rejected because the Harness-native tool budget was exhausted.",
										});
										compositionTerminalReason = "tool-limit";
										return null;
									}
									nestedReservations += 1;
									const executeNested = async (): Promise<RuntimeToolResult> => {
										try {
											const nestedArguments = safeArguments(mapped.arguments);
											eventSpine.append({
												version: 1,
												attempt,
												iteration,
												type: "tool-dispatched",
												actionId: nestedActionId,
												tool: mapped.tool,
												arguments: nestedArguments,
											});
											const nested = await executeTool(
												options.worktreePath,
												nestedRequest,
												options.policy.maxObservationBytes,
												options.verification,
												signal,
											);
											if (nested.status === "rejected") rejectedToolCalls += 1;
											else toolCalls += 1;
											if (nested.facts.kind === "mutation") {
												const nestedSurface = dshCompatible
													? await captureHarnessNativeWorktreeMutationSurface(options.worktreePath)
													: null;
												for (const path of nested.facts.affectedPaths) {
													nestedOwnedPaths.add(path);
													nestedOwnedSurfaceHashes.set(path, nestedSurface?.pathSha256.get(path));
												}
											}
											eventSpine.append({
												version: 1,
												attempt,
												iteration,
												type: "tool-result",
												actionId: nestedActionId,
												tool: mapped.tool,
												status: nested.status,
												arguments: nestedArguments,
												observation: nested.observation,
												observationSummary: nested.evidence,
												facts: nested.facts,
												...(nested.status === "rejected"
													? { rejectionReason: nested.rejectionReason ?? "workspace-policy" }
													: {}),
												modelVisible: false,
											});
											if (options.durableWorktreeCheckpoints && nested.facts.kind === "mutation")
												eventSpine.append({
													version: 1,
													attempt,
													iteration,
													type: "worktree-checkpoint",
													actionId: nestedActionId,
													worktreeSha256: await fingerprintHarnessNativeWorktree(options.worktreePath),
												});
											const candidate = planner.triggerFor(nested.facts, nested.status);
											if (candidate !== null) planningTrigger = candidate;
											const before = planExecutor.snapshot().events.length;
											const executionTrigger = planExecutor.record({
												actionId: nestedActionId,
												iteration,
												tool: mapped.tool,
												arguments: mapped.arguments,
												status: nested.status,
												facts: nested.facts,
											});
											const after = planExecutor.snapshot();
											if (after.events.length > before)
												eventSpine.append({
													version: 1,
													attempt,
													iteration,
													type: "plan-execution-updated",
													actionId: nestedActionId,
													activeStep: after.activeStep,
													executionEvent: after.events.at(-1) ?? null,
												});
											if (planningTrigger === null && executionTrigger !== null)
												planningTrigger = executionTrigger;
											if (
												nested.status === "rejected" &&
												rejectedToolCalls >= options.policy.maxRejectedToolCalls
											)
												compositionTerminalReason = "rejected-tool-limit";
											return nested;
										} finally {
											nestedReservations -= 1;
										}
									};
									if (!serializeMutation || !isHarnessNativeMutationTool(mapped.tool))
										return await executeNested();
									const queued = mutationQueue.then(executeNested, executeNested);
									mutationQueue = queued.then(
										() => undefined,
										() => undefined,
									);
									return await queued;
								};
								const commonInput = {
									code,
									tools: programmaticTools.map((definition) => definition.name),
									maxWallMs: Math.max(1, options.timeoutMs - (Date.now() - startedAt)),
									maxOutputBytes: options.policy.maxObservationBytes,
								};
								const result = dshCompatible
									? await runDshCompatibleCode({
											...commonInput,
											workspace: options.worktreePath,
											executionMode: (call) => {
												const mapped = mapProgrammaticToolFacadeCall(call);
												return isHarnessNativeRetrievalTool(mapped.tool) ? "parallel" : "exclusive";
											},
											dispatch: async (call, signal) => {
												const nested = await executeNestedCall(call, signal, false);
												if (nested === null)
													return { ok: false, error: "Harness-native tool budget exhausted." };
												if (nested.status !== "ok") return { ok: false, error: nested.observation };
												return {
													ok: true,
													value: nested.programmaticValue ?? { output: nested.observation },
												};
											},
										})
									: await runProgrammaticToolComposition({
											...commonInput,
											dispatch: async (call) => {
												const nested = await executeNestedCall(call, undefined, true);
												return nested === null
													? { ok: false, observation: "Harness-native tool budget exhausted." }
													: { ok: nested.status === "ok", observation: nested.observation };
											},
										});
								const affectedPaths = await collectDirectAffectedPaths();
								return {
									status: "ok",
									observation: result.observation,
									evidence:
										affectedPaths.length > 0
											? `Completed DSH-compatible run_code and detected ${affectedPaths.length} changed worktree path${affectedPaths.length === 1 ? "" : "s"}.`
											: `Completed run-code with ${result.dispatches} nested tool calls.`,
									facts:
										affectedPaths.length > 0 ? mutationFacts("run-code", affectedPaths) : { kind: "other" },
								};
							} catch (error) {
								const affectedPaths = await collectDirectAffectedPaths();
								return {
									status: "error",
									observation: redactSensitiveText(error instanceof Error ? error.message : String(error)),
									evidence:
										affectedPaths.length > 0
											? `run-code failed after changing ${affectedPaths.length} worktree path${affectedPaths.length === 1 ? "" : "s"}.`
											: "run-code failed.",
									facts:
										affectedPaths.length > 0 ? mutationFacts("run-code", affectedPaths) : { kind: "other" },
								};
							}
						})()
					: await executeTool(
							options.worktreePath,
							request,
							options.policy.maxObservationBytes,
							options.verification,
						);
			if (tool.status === "rejected") rejectedToolCalls += 1;
			else if (!compositionEnvelope) toolCalls += 1;
			eventSpine.append({
				version: 1,
				attempt,
				iteration,
				type: "tool-result",
				actionId,
				tool: request.tool as HarnessNativeToolName,
				status: tool.status,
				arguments: argumentsProjection,
				observation: tool.observation,
				observationSummary: tool.evidence,
				facts: tool.facts,
				...(tool.status === "rejected" ? { rejectionReason: tool.rejectionReason ?? "workspace-policy" } : {}),
				...(compositionEnvelope && tool.status !== "rejected" ? { countsTowardToolBudget: false } : {}),
			});
			if (options.durableWorktreeCheckpoints && tool.facts.kind === "mutation")
				eventSpine.append({
					version: 1,
					attempt,
					iteration,
					type: "worktree-checkpoint",
					actionId,
					worktreeSha256: await fingerprintHarnessNativeWorktree(options.worktreePath),
				});
			if (compositionTerminalReason !== null) return fail(compositionTerminalReason);
			const candidateTrigger = compositionEnvelope ? null : planner.triggerFor(tool.facts, tool.status);
			if (candidateTrigger !== null) planningTrigger = candidateTrigger;
			const previousExecutionEventCount = planExecutor.snapshot().events.length;
			const executionTrigger = compositionEnvelope
				? null
				: planExecutor.record({
						actionId,
						iteration,
						tool: request.tool as HarnessNativeToolName,
						arguments: request.arguments,
						status: tool.status,
						facts: tool.facts,
					});
			const executionSnapshot = planExecutor.snapshot();
			if (executionSnapshot.events.length > previousExecutionEventCount)
				eventSpine.append({
					version: 1,
					attempt,
					iteration,
					type: "plan-execution-updated",
					actionId,
					activeStep: executionSnapshot.activeStep,
					executionEvent: executionSnapshot.events.at(-1) ?? null,
				});
			if (planningTrigger === null && executionTrigger !== null) planningTrigger = executionTrigger;
			if (tool.status === "rejected" && rejectedToolCalls >= options.policy.maxRejectedToolCalls)
				return fail("rejected-tool-limit");
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
		if (detectHarnessNativeStuckPattern(eventSpine.forAttempt(attempt), attempt) !== null) return fail("stuck");
		if (planningTrigger !== null) {
			let planningResult: Awaited<ReturnType<HarnessNativePlanner["update"]>>;
			let plannerRecoveries = 0;
			for (;;) {
				const modelCallId = nextModelCallId("planner", iteration);
				eventSpine.append({
					version: 1,
					attempt,
					iteration,
					type: "model-call-started",
					callId: modelCallId,
					owner: "planner",
				});
				try {
					const contextViews = deriveHarnessNativeContextViews(eventSpine.snapshot(), attempt);
					planningResult = await planner.update({
						prompt: options.prompt,
						model: options.model,
						iteration,
						trigger: planningTrigger,
						observations: contextViews.planner.observations,
						workingContext: contextViews.planner.workingContext,
						attemptContinuation: options.attemptContinuation ?? null,
						contextView: contextViews.planner,
						protocolRecovery: contextViews.planner.protocolRecovery,
					});
					eventSpine.append({
						version: 1,
						attempt,
						iteration,
						type: "model-call-completed",
						callId: modelCallId,
						owner: "planner",
						outcome: "succeeded",
						inputTokens: planningResult?.usage?.inputTokens ?? null,
						outputTokens: planningResult?.usage?.outputTokens ?? null,
						transportRetries: planningResult?.transportRetries ?? 0,
						actualModel: planningResult?.actualModel ?? null,
					});
					break;
				} catch (error) {
					const failure = error instanceof ModelProviderFailureError ? error.failure : null;
					eventSpine.append({
						version: 1,
						attempt,
						iteration,
						type: "model-call-completed",
						callId: modelCallId,
						owner: "planner",
						outcome: "failed",
						inputTokens: null,
						outputTokens: null,
						transportRetries: null,
						actualModel: null,
					});
					if (failure === null || !isRecoverableProtocolFailure(failure)) return fail("model-failed", failure);
					const canRetry = plannerRecoveries < options.policy.maxProtocolRecoveries;
					if (canRetry) {
						plannerRecoveries += 1;
						protocolRecoveries += 1;
					}
					eventSpine.append({
						version: 1,
						attempt,
						iteration,
						type: "protocol-recovery",
						owner: "planner",
						failure,
						recovery: plannerRecoveries,
						maxRecoveries: options.policy.maxProtocolRecoveries,
						disposition: canRetry ? "retrying" : "exhausted",
					});
					if (!canRetry) return fail("model-failed", failure);
				}
			}
			try {
				actualModel = planningResult?.actualModel ?? actualModel;
				inputTokens += planningResult?.usage?.inputTokens ?? 0;
				outputTokens += planningResult?.usage?.outputTokens ?? 0;
				transportRetries += planningResult?.transportRetries ?? 0;
				if (planningResult !== null) {
					const revision = planner.currentRevision;
					if (revision === null) throw new Error("Planner revision is unavailable after an update.");
					eventSpine.append({
						version: 1,
						attempt,
						iteration,
						type: "plan-revised",
						revision,
					});
					planExecutor.synchronize(revision);
					eventSpine.append({
						version: 1,
						attempt,
						iteration,
						type: "plan-execution-updated",
						actionId: null,
						activeStep: planExecutor.activeStep,
						executionEvent: null,
					});
				}
			} catch (error) {
				return fail("model-failed", error instanceof ModelProviderFailureError ? error.failure : null);
			}
		}
	}
	return fail("iteration-limit");
}
