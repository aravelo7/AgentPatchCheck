import type { RunIdentity, RunIdentityInput } from "./run-identity";

export type AgentPatchCheckSandbox = "read-only" | "workspace-write";
export type AgentAdapterId = "codex" | "script" | "harness-native" | "cline-runtime";
export const TASK_POLICY_BRAND: unique symbol = Symbol("TaskPolicy");

export interface TaskPolicyInput {
	repositoryRoot: string;
	prompt: string;
	executionBootstrap?: ExecutionBootstrapInput;
	publicVerificationRepairInstruction?: string;
	baseRef?: string;
	worktreeRoot?: string;
	runId?: string;
	runIdentity?: RunIdentityInput;
	codexExecutable?: string;
	agentAdapter?: AgentAdapterId;
	agentScript?: string;
	nativeAgent?: HarnessNativeAgentInput;
	model?: string;
	timeoutMs?: number;
	sandbox?: AgentPatchCheckSandbox;
	allowNetwork?: boolean;
	allowDangerousParameters?: boolean;
	verification?: VerificationPolicyInput;
	verificationProfile?: VerificationProfileReference;
	riskPolicy?: RiskPolicyInput;
	hiddenOracle?: HiddenOracleInput;
	patchExpectation?: PatchExpectation;
}

/** Harness-owned, npm-only dependency preparation for an isolated worktree. */
export interface ExecutionBootstrapInput {
	nodeVersion: string;
	npmVersion: string;
	npmInstall: {
		legacyPeerDeps: true;
		packageLock: false;
	};
	timeoutMs?: number;
}

export interface ExecutionBootstrapPolicy {
	nodeVersion: string;
	npmVersion: string;
	npmInstall: {
		legacyPeerDeps: true;
		packageLock: false;
	};
	timeoutMs: number;
}

export type ExecutionBootstrapCacheStatus = "not-used" | "hit" | "miss" | "restore-failed";

/**
 * Records a Harness-owned dependency snapshot outcome. The snapshot is copied
 * into each worktree; agents never receive a mutable shared dependency tree.
 */
export interface ExecutionBootstrapCacheResult {
	status: ExecutionBootstrapCacheStatus;
	fingerprint: string | null;
	durationMs: number;
	diagnostic: string | null;
}

export interface ExecutionBootstrapResult {
	status: "succeeded" | "failed";
	worktreePath: string;
	nodeVersion: string;
	npmVersion: string | null;
	npmInstall: CommandVerificationResult | null;
	cache: ExecutionBootstrapCacheResult;
	diagnostic: string | null;
}

export interface HiddenOracleInput {
	scriptPath: string;
	timeoutMs?: number;
	isolation?: HiddenOracleIsolationLevel;
	memoryLimitBytes?: number;
	cpuRatePercent?: number;
}

export type HiddenOracleIsolationLevel = "none" | "network" | "process" | "strict";

export interface HiddenOracleIsolationCapability {
	version: 1;
	requested: HiddenOracleIsolationLevel;
	platform: NodeJS.Platform;
	available: boolean;
	backend: "none" | "windows-job" | null;
	reason: string | null;
	helper?: { version: string; sha256: string };
	limits?: { memoryLimitBytes: number; cpuRatePercent: number; timeoutMs: number };
	execution?: { terminationReason: string; resourceLimitsApplied: boolean };
}

export interface HiddenOraclePolicy {
	scriptPath: string;
	timeoutMs: number;
	isolation: HiddenOracleIsolationLevel;
	memoryLimitBytes: number;
	cpuRatePercent: number;
}

export interface VerificationCommandInput {
	command: string;
	args?: string[];
	timeoutMs?: number;
}

export interface VerificationPolicyInput {
	commands?: VerificationCommandInput[];
	outputLimitBytes?: number;
}

export interface VerificationCommand {
	command: string;
	args: string[];
	timeoutMs: number;
}

export interface VerificationPolicy {
	commands: VerificationCommand[];
	outputLimitBytes: number;
	allowShell: false;
	allowNetwork: false;
}

export interface VerificationProfileReference {
	path: string;
	name: string | null;
	sha256: string;
}

export interface RiskPolicyProfileReference {
	path: string;
	name: string;
	sha256: string;
}

export interface RiskPolicyConfiguration {
	protectedPaths: string[];
	sensitivePaths: string[];
	maxChangedFiles: number;
	maxTrackedPatchBytes: number;
}

export interface RiskPolicyInput {
	configuration: RiskPolicyConfiguration;
	profile: RiskPolicyProfileReference;
}

export interface RiskPolicy {
	configuration: RiskPolicyConfiguration;
	profile: RiskPolicyProfileReference | null;
}

export interface TaskPolicy {
	readonly [TASK_POLICY_BRAND]: true;
	repositoryRoot: string;
	baseRef: string;
	baseCommit: string;
	worktreeRoot: string;
	prompt: string;
	executionBootstrap: ExecutionBootstrapPolicy | null;
	publicVerificationRepairInstruction: string | null;
	runId?: string;
	runIdentity: RunIdentity;
	codexExecutable?: string;
	agentAdapter: AgentAdapterId;
	agentScript: string | null;
	nativeAgent: HarnessNativeAgentPolicy | null;
	model?: string;
	timeoutMs: number;
	sandbox: AgentPatchCheckSandbox;
	allowNetwork: boolean;
	allowDangerousParameters: false;
	verification: VerificationPolicy;
	verificationProfile: VerificationProfileReference | null;
	riskPolicy: RiskPolicy;
	hiddenOracle: HiddenOraclePolicy | null;
	patchExpectation: PatchExpectation;
}

export interface IsolatedWorkspace {
	runId: string;
	repositoryPath: string;
	path: string;
	baseRef: string;
	baseCommit: string;
}

export interface AgentExecution {
	executable: string;
	args: string[];
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
	runtime?: HarnessNativeRuntimeResult;
	/** Canonical Harness-native lifecycle events across bounded attempts in this execution. */
	runtimeEvents?: HarnessNativeRuntimeEvent[];
	/** Cline control-runtime facts. Kept separate from Harness-native telemetry. */
	clineRuntime?: ClineRuntimeResult;
	attempts?: AgentExecutionAttempt[];
	/** Final bounded review of a Harness-native coding attempt. */
	attemptReview?: HarnessNativeAttemptReview;
	/** Harness-owned decision for the bounded public-verification repair path. */
	publicVerificationRepair?: PublicVerificationRepairDecision;
}

export interface PublicVerificationFeedback {
	version: 1;
	status: "failed";
	summary: string;
	commands: Array<{
		command: string;
		exitCode: number | null;
		signal: NodeJS.Signals | null;
		timedOut: boolean;
	}>;
}

export type PublicVerificationRepairDecisionReason =
	| "public-verification-failed"
	| "adapter-not-harness-native"
	| "initial-agent-timed-out"
	| "initial-agent-failed"
	| "public-verification-not-failed"
	| "agent-budget-exhausted";

/**
 * A bounded, Harness-owned decision. It contains no verifier output or
 * Hidden Oracle information; `initialChangedFiles` is the only patch fact
 * available to a repair execution.
 */
export interface PublicVerificationRepairDecision {
	eligible: boolean;
	reason: PublicVerificationRepairDecisionReason;
	initialChangedFiles: string[];
}

/** Harness-owned phase contract for one Agent execution. Hidden Oracle data is never included. */
export type RepairContext =
	| { phase: "initial"; publicVerificationFeedback: null; repairInstruction?: null }
	| {
			phase: "public-verification-repair";
			publicVerificationFeedback: PublicVerificationFeedback;
			initialChangedFiles: string[];
			repairInstruction?: string | null;
	  };

export interface AgentExecutionAttempt {
	phase: "initial" | "attempt-continuation" | "public-verification-repair";
	feedback: PublicVerificationFeedback | null;
	/** Present only when this attempt was started from a prior exhausted attempt. */
	continuation?: HarnessNativeAttemptContinuation | null;
	/** Deterministic outer-loop decision made after this attempt ended. */
	review?: HarnessNativeAttemptReview;
	execution: Omit<AgentExecution, "attempts">;
}

export type HarnessNativeAttemptReviewReason =
	| "completed"
	| "iteration-limit-with-progress"
	| "no-partial-progress"
	| "terminal-termination"
	| "max-attempts"
	| "insufficient-time";

/** Safe attempt-level assessment derived only from canonical Runtime facts and bounded lifecycle state. */
export interface HarnessNativeAttemptReview {
	version: 1;
	attempt: number;
	decision: "continue" | "stop";
	reason: HarnessNativeAttemptReviewReason;
	successfulMutationCount: number;
	affectedPaths: string[];
	latestVerificationOutcome: "passed" | "failed" | "not-run" | null;
	executionCheckpoint: HarnessNativePlanExecutionCheckpoint | null;
	remainingAttempts: number;
	remainingTimeMs: number;
}

/** Provider-visible handoff for a fresh inner-loop attempt in the same managed worktree. */
export interface HarnessNativeAttemptContinuation {
	version: 1;
	attempt: number;
	previousAttempt: number;
	reason: "iteration-limit-with-progress";
	successfulMutationCount: number;
	affectedPaths: string[];
	latestVerificationOutcome: "passed" | "failed" | "not-run" | null;
	executionCheckpoint: HarnessNativePlanExecutionCheckpoint | null;
}

export interface HarnessNativeAgentInput {
	provider?: ModelProviderKind;
	protocol?: ModelProviderProtocol;
	thinkingMode?: ModelProviderThinkingMode;
	reasoningEffort?: ModelProviderReasoningEffort;
	baseUrl?: string;
	credentialRef?: string;
	maxIterations?: number;
	maxToolCalls?: number;
	/** Bounded invalid or policy-rejected calls; these never consume maxToolCalls. */
	maxRejectedToolCalls?: number;
	maxObservationBytes?: number;
	maxTransportRetries?: number;
	/** Maximum same-decision correction requeries after recoverable protocol failures. */
	maxProtocolRecoveries?: number;
	/** Maximum consecutive finish deferrals before an explicit incomplete terminal result. */
	maxCompletionDeferrals?: number;
	/** Maximum structured plan revisions during one Harness-native execution. */
	maxPlanRevisions?: number;
	/** Whether the independent Planner participates; false keeps action ownership in the Executor session. */
	plannerEnabled?: boolean;
	/** Provider-facing tool presentation. Code mode composes Harness tools through run-code. */
	toolPresentation?: "native" | "code" | "dsh-compatible";
	/** Total bounded coding attempts, including the initial attempt. */
	maxAttempts?: number;
	/** Minimum shared task time required before starting a continuation attempt. */
	minContinuationTimeMs?: number;
	/** Explicit Cline provider identity; required only by the Cline control adapter. */
	clineProviderId?: string;
}

export type ModelProviderKind = "openai" | "openai-compatible" | "deepseek" | "gemini";
export type ModelProviderProtocol = "responses" | "chat-completions" | "native";
export type ModelProviderThinkingMode = "default" | "enabled" | "disabled";
export type ModelProviderReasoningEffort = "low" | "high" | "max";

/**
 * Safe, validated model transport configuration. The credential value itself is
 * resolved only at execution time and is never part of this contract.
 */
export interface ModelProviderConfiguration {
	provider: ModelProviderKind;
	protocol: ModelProviderProtocol;
	thinkingMode: ModelProviderThinkingMode;
	reasoningEffort?: ModelProviderReasoningEffort | null;
	baseUrl: string;
	endpointSha256: string;
	credentialRef: string;
	implementation: "openai-compatible-v1" | "deepseek-official-chat-v1" | "cline-llms-gemini-native-v1";
}

export interface HarnessNativeAgentPolicy {
	modelProvider: ModelProviderConfiguration;
	maxIterations: number;
	maxToolCalls: number;
	maxRejectedToolCalls: number;
	maxObservationBytes: number;
	maxTransportRetries: number;
	maxProtocolRecoveries: number;
	maxCompletionDeferrals: number;
	maxPlanRevisions: number;
	plannerEnabled: boolean;
	toolPresentation: "native" | "code" | "dsh-compatible";
	maxAttempts: number;
	minContinuationTimeMs: number;
	clineProviderId?: string | null;
}

/** Normalized facts from the Cline control stack; secrets and raw transcripts are excluded. */
export interface ClineRuntimeResult {
	version: 1;
	providerId: string;
	model: string;
	status: "succeeded" | "failed";
	terminationReason:
		| "finished"
		| "model-failed"
		| "iteration-limit"
		| "tool-limit"
		| "rejected-tool-limit"
		| "timeout";
	iterations: number;
	toolCalls: number;
	rejectedToolCalls: number;
	/**
	 * Bounded lifecycle record for the Cline control adapter. It contains model
	 * tool requests and Harness execution outcomes, never provider messages or
	 * raw tool output.
	 */
	trajectory: ClineRuntimeTrajectoryStep[];
	budget: Pick<
		HarnessNativeAgentPolicy,
		"maxIterations" | "maxToolCalls" | "maxRejectedToolCalls" | "maxObservationBytes"
	>;
}

export interface ClineRuntimeToolArguments {
	[key: string]: boolean | number | string | null;
}

export interface ClineRuntimeTrajectoryStep {
	iteration: number;
	sequence: number;
	/** The tool name emitted by Cline's model turn, including unknown names. */
	tool: string;
	arguments: ClineRuntimeToolArguments | null;
	/** Whether Cline emitted the request, the wrapper executed it, or both. */
	stage: "requested" | "executed";
	status: "ok" | "rejected" | "error" | null;
	/** Stable classification for a Harness-side rejection; no provider payload. */
	rejection: { kind: "invalid-input" | "tool-budget" | "harness-policy"; detail: string } | null;
	/** Bounded structural outcome suitable for correlating the next model turn. */
	observationSummary: string | null;
}

export type HarnessNativeToolName =
	| "run-code"
	| "run_code"
	| "read-file"
	| "list-directory"
	| "search-text"
	| "search-text-recursive"
	| "git-status"
	| "git-diff"
	| "apply-edit"
	| "apply-patch"
	| "apply-patch-batch"
	| "apply-edit-batch"
	| "create-file"
	| "write-file"
	| "todo-write"
	| "dsh-shell"
	| "run-public-verification";
export type HarnessNativeTerminationReason =
	| "finished"
	| "incomplete-finish"
	| "model-failed"
	| "stuck"
	| "iteration-limit"
	| "tool-limit"
	| "rejected-tool-limit"
	| "timeout"
	| "invalid-decision";
export type HarnessNativeProviderFailureKind =
	| "missing-credential"
	| "invalid-credential-reference"
	| "authentication-failure"
	| "rate-limited"
	| "timeout"
	| "provider-unavailable"
	| "malformed-response"
	| "unsupported-tool-calling"
	| "provider-error";
export type HarnessNativeProviderFailureDetail =
	| "no-tool-calls"
	| "multiple-tool-calls"
	| "mixed-control-tool-calls"
	| "invalid-tool-call-shape"
	| "missing-tool-function"
	| "unsupported-tool-name"
	| "invalid-tool-arguments"
	| null;
export type HarnessNativeProviderValidationIssueType =
	| "json-parse"
	| "root-type"
	| "missing-field"
	| "invalid-type"
	| "invalid-enum"
	| "array-length"
	| "string-length"
	| "duplicate-step"
	| "ambiguous-alias"
	| "unexpected-field"
	| "lifecycle-invariant";
export type HarnessNativeProviderReceivedValueType =
	| "missing"
	| "null"
	| "array"
	| "object"
	| "string"
	| "number"
	| "boolean";
/** Safe structural diagnostic. It never includes Provider values or generated plan text. */
export interface HarnessNativeProviderValidationIssue {
	path: string;
	issue: HarnessNativeProviderValidationIssueType;
	receivedType: HarnessNativeProviderReceivedValueType;
	/** Supported function selected before argument validation; never Provider text outside the registered tool set. */
	selectedTool?: HarnessNativeToolName | "finish" | "fail";
	/** Property names only. Values and the complete arguments object are never retained. */
	unexpectedFields?: string[];
	constraint:
		| "json-object"
		| "plan-array"
		| "2-6-items"
		| "non-empty-string"
		| "max-500-characters"
		| "max-300-characters"
		| "plan-step-kind"
		| "plan-step-status"
		| "unique-step-text"
		| "single-plan-field"
		| "tool-arguments"
		| "at-most-one-in-progress";
}
export interface HarnessNativeProviderFailure {
	kind: HarnessNativeProviderFailureKind;
	/** Fixed structural diagnostic only; never raw provider content. */
	detail: HarnessNativeProviderFailureDetail;
	code: string | null;
	httpStatus: number | null;
	requestId: string | null;
	/** Present only for safe structured-output validation failures. */
	validationIssue?: HarnessNativeProviderValidationIssue;
}
export type HarnessNativeProtocolRecoveryOwner = "executor" | "planner";
export interface HarnessNativeProtocolRecoveryFeedback {
	version: 1;
	owner: HarnessNativeProtocolRecoveryOwner;
	recovery: number;
	maxRecoveries: number;
	/** Safe normalized structure only; raw Provider output is never retained. */
	failure: HarnessNativeProviderFailure;
	correction: string;
}
export type HarnessNativeCompletionReason =
	| "complete"
	| "verification-due"
	| "repair-due"
	| "plan-incomplete"
	| "deferral-limit";
export interface HarnessNativeCompletionDecision {
	disposition: "accept" | "continue" | "terminal";
	reason: HarnessNativeCompletionReason;
	feedback: string | null;
}
export interface ModelProviderIdentity {
	provider: ModelProviderKind;
	protocol: ModelProviderProtocol;
	thinkingMode: ModelProviderThinkingMode;
	endpointSha256: string;
	credentialRef: string;
	implementation: "openai-compatible-v1" | "deepseek-official-chat-v1" | "cline-llms-gemini-native-v1";
	configuredModel: string;
	actualModel: string | null;
}
export type HarnessNativeToolResultFacts =
	| {
			kind: "retrieval";
			tool: "read-file" | "search-text" | "search-text-recursive" | "list-directory" | "git-status" | "git-diff";
			path: string | null;
			query: string | null;
			inspectedPaths: string[];
			candidatePaths: string[];
			search: {
				matchCount: number;
				coverage: HarnessNativeSearchCoverage;
				skippedCount: number;
				skipped: Array<{ path: string; reason: HarnessNativeSearchSkipReason }>;
			} | null;
			/** Present for successful read-file facts; numeric and replay-safe. */
			readWindow?: {
				offset: number;
				limit: number;
				returnedLines: number;
				totalLines: number;
				truncatedByBytes: boolean;
			};
	  }
	| {
			kind: "mutation";
			tool:
				| "apply-edit"
				| "apply-patch"
				| "apply-patch-batch"
				| "apply-edit-batch"
				| "create-file"
				| "write-file"
				| "run-code";
			affectedPaths: string[];
	  }
	| {
			kind: "verification";
			tool: "run-public-verification";
			commandIndex: number | null;
			outcome: "passed" | "failed" | "not-run";
			exitCode: number | null;
			timedOut: boolean | null;
			durationMs: number | null;
	  }
	| { kind: "other" };
/** Backward-compatible audit projection derived from Runtime events. */
export interface HarnessNativeTrajectoryStep {
	/** Harness-owned action correlation identity. Absent only in historical trajectories. */
	actionId?: string;
	iteration: number;
	decision: "tool" | "finish" | "fail";
	tool: HarnessNativeToolName | null;
	arguments: Record<string, string | number> | null;
	toolStatus: "ok" | "rejected" | "error" | null;
	observationSummary: string | null;
	/** Structured execution facts. Null only for finish/fail decisions. */
	facts: HarnessNativeToolResultFacts | null;
}

/**
 * Canonical, ordered Harness-native runtime information. Repository facts remain
 * owned by `HarnessNativeToolResultFacts`; lifecycle events only correlate how
 * Planner, Controller, and attempt boundaries consumed those facts.
 */
export type HarnessNativeRuntimeEvent = {
	version: 1;
	sequence: number;
	/** Harness clock sample used only for replayable resource accounting. */
	recordedAtMs?: number;
	attempt: number;
} & (
	| {
			iteration: null;
			type: "attempt-started";
			phase: AgentExecutionAttempt["phase"];
			continuationFromAttempt: number | null;
	  }
	| {
			iteration: number;
			type: "model-call-started";
			callId: string;
			owner: "executor" | "planner";
	  }
	| {
			iteration: number;
			type: "model-call-completed";
			callId: string;
			owner: "executor" | "planner";
			outcome: "succeeded" | "failed" | "interrupted";
			inputTokens: number | null;
			outputTokens: number | null;
			transportRetries: number | null;
			actualModel: string | null;
	  }
	| {
			iteration: number;
			type: "tool-dispatched";
			actionId: string;
			tool: HarnessNativeToolName;
			arguments: Record<string, string | number>;
	  }
	| {
			iteration: number;
			type: "tool-result";
			actionId: string;
			tool: HarnessNativeToolName;
			arguments: Record<string, string | number>;
			status: "ok" | "rejected" | "error";
			/** Bounded Runtime observation. Evidence serialization replaces this value. */
			observation: string;
			observationSummary: string;
			facts: HarnessNativeToolResultFacts;
			/** Mechanical reason for a rejected request; never model-generated text. */
			rejectionReason?: "invalid-input" | "unavailable-tool" | "workspace-policy" | "tool-budget";
			/** False for the run-code envelope; nested Tool Executor results own resource consumption. */
			countsTowardToolBudget?: boolean;
			/** False for nested programmatic operations; the run-code envelope owns model-facing observation. */
			modelVisible?: boolean;
	  }
	| {
			iteration: number;
			type: "worktree-checkpoint";
			actionId: string;
			/** SHA-256 of the complete tracked/untracked worktree mutation surface. */
			worktreeSha256: string;
	  }
	| {
			iteration: number;
			type: "protocol-recovery";
			owner: HarnessNativeProtocolRecoveryOwner;
			failure: HarnessNativeProviderFailure;
			recovery: number;
			maxRecoveries: number;
			disposition: "retrying" | "exhausted";
	  }
	| {
			iteration: number;
			type: "completion-evaluated";
			disposition: HarnessNativeCompletionDecision["disposition"];
			reason: HarnessNativeCompletionReason;
			feedback: string | null;
			activeExecutionId: number | null;
			planRevision: number | null;
	  }
	| {
			iteration: number;
			/** Legacy successful-call usage event retained for historical replay. */
			type: "model-usage";
			owner: "executor" | "planner";
			inputTokens: number | null;
			outputTokens: number | null;
			transportRetries: number;
			actualModel: string | null;
	  }
	| {
			iteration: number;
			type: "plan-revised";
			revision: HarnessNativePlanRevision;
	  }
	| {
			iteration: number;
			type: "plan-execution-updated";
			actionId: string | null;
			activeStep: HarnessNativeActivePlanStep | null;
			executionEvent: HarnessNativePlanExecutionEvent | null;
	  }
	| {
			iteration: number | null;
			type: "attempt-ended";
			decision: "finish" | "fail" | null;
			status: "succeeded" | "failed";
			terminationReason: HarnessNativeTerminationReason;
			/** Safe terminal Provider metadata needed for deterministic replay. */
			providerFailure?: HarnessNativeProviderFailure | null;
			iterations: number;
			toolCalls: number;
			rejectedToolCalls: number;
			transportRetries: number;
	  }
	| {
			iteration: null;
			type: "attempt-reviewed";
			review: HarnessNativeAttemptReview;
	  }
);
export type HarnessNativeShadowStallReason = "repeated-retrieval" | "retrieval-without-new-path";
export interface HarnessNativeShadowControlState {
	version: 1;
	/** Number of trajectory steps deterministically reduced into this state. */
	trajectoryStepCount: number;
	lastIteration: number | null;
	retrieval: {
		totalActions: number;
		successfulActions: number;
		rejectedActions: number;
		errorActions: number;
		uniqueActions: number;
		repeatedActions: number;
		consecutiveActions: number;
		consecutiveRepeatedActions: number;
	};
	mutation: {
		totalActions: number;
		successfulActions: number;
		rejectedActions: number;
		errorActions: number;
		firstIteration: number | null;
		affectedPaths: string[];
	};
	verification: {
		runs: number;
		latestStatus: "passed" | "failed" | null;
		latestIteration: number | null;
	};
	visitedPaths: string[];
	inspectedPaths: string[];
	candidatePaths: string[];
	interpretation: {
		/** Heuristic diagnostic derived from facts; never a Runtime fact or Agent input. */
		progress: {
			lastNewPathIteration: number | null;
			consecutiveRetrievalsWithoutNewPath: number;
			stallDetected: boolean;
			stallReason: HarnessNativeShadowStallReason | null;
			stallSinceIteration: number | null;
		};
	};
}
export interface HarnessNativeShadowControlStateEvolution {
	trajectoryStep: number;
	iteration: number;
	state: HarnessNativeShadowControlState;
}
export interface HarnessNativeShadowControlPlaneDiagnostic {
	version: 1;
	source: "runtime-trajectory";
	/** Shadow mode is observation-only and is never included in Provider input. */
	enabled: boolean;
	finalState: HarnessNativeShadowControlState;
	evolution: HarnessNativeShadowControlStateEvolution[];
}
/** Derived Runtime tool interaction retained for deterministic request projection only. */
export interface HarnessNativeHistoryProjectionInteraction {
	sequence: number;
	iteration: number;
	actionId: string;
	tool: HarnessNativeToolName;
	arguments: Record<string, string | number>;
	status: "ok" | "rejected" | "error";
	observation: string;
	/** Present for current Runtime events; optional for historical projections. */
	facts?: HarnessNativeToolResultFacts;
}
/** Non-sensitive metadata for the most recent provider-visible history projection. */
export interface HarnessNativeHistoryProjection {
	version: 1;
	canonicalInteractionCount: number;
	projectedInteractionCount: number;
	elidedInteractionCount: number;
	canonicalObservationCount: number;
	projectedObservationCount: number;
	elidedObservationCount: number;
	retainedInteractionIterations: number[];
	/** Canonical Runtime event identities retained in the model-visible projection. */
	retainedEventSequences?: number[];
	/** Exact UTF-8 size of the projected observation envelope, including separators. */
	projectedObservationBytes?: number;
	/** UTF-8 bytes removed by interaction elision or bounded observation truncation. */
	omittedObservationBytes?: number;
	/** Retained observations whose text was shortened to satisfy the byte budget. */
	truncatedObservationCount?: number;
}
export type HarnessNativeConvergenceCheckpointOutcome =
	| "not-triggered"
	| "edited-directly"
	| "targeted-retrieval-then-edited"
	| "targeted-retrieval-no-edit"
	| "finished-without-edit"
	| "failed-without-edit"
	| "iteration-limit-without-edit";
export interface HarnessNativeConvergenceCheckpoint {
	version: 1;
	triggered: boolean;
	triggerIteration: number | null;
	discoveryActionsAtTrigger: number | null;
	successfulFileReadsAtTrigger: number | null;
	mutationActionsAtTrigger: number | null;
	targetedRetrieval: { iteration: number; tool: HarnessNativeToolName; status: "ok" | "rejected" | "error" } | null;
	firstMutationIteration: number | null;
	firstPublicVerificationIteration: number | null;
	finishIteration: number | null;
	outcome: HarnessNativeConvergenceCheckpointOutcome;
}
export type HarnessNativeWorkingContextPhase =
	| "discovery"
	| "mutation-applied"
	| "public-verification-completed"
	| "finished"
	| "failed";
export type HarnessNativeSearchCoverage = "complete" | "partial";
export type HarnessNativeSearchSkipReason =
	| "binary"
	| "directory-limit"
	| "excluded-path"
	| "file-limit"
	| "max-depth"
	| "match-limit"
	| "total-byte-limit"
	| "unreadable";
/** Replayable context projection; never an independent source of repository facts. */
export interface HarnessNativeWorkingContext {
	version: 1;
	phase: HarnessNativeWorkingContextPhase;
	inspectedPaths: string[];
	candidatePaths: string[];
	retrieval: {
		successfulActions: number;
		rejectedActions: number;
		recent: Array<{
			iteration: number;
			tool: "read-file" | "search-text" | "search-text-recursive" | "list-directory" | "git-status" | "git-diff";
			status: "ok" | "rejected" | "error";
			path: string | null;
			query: string | null;
			summary: string;
			search: {
				matchCount: number;
				coverage: HarnessNativeSearchCoverage;
				skippedCount: number;
				skipped: Array<{ path: string; reason: HarnessNativeSearchSkipReason }>;
			} | null;
		}>;
	};
	mutation: { successfulActions: number; paths: string[]; firstIteration: number | null };
	publicVerification: { runs: number; latestStatus: "passed" | "failed" | null; latestIteration: number | null };
}
export type HarnessNativePlanStepStatus = "pending" | "in_progress" | "completed";
export type HarnessNativePlanStepKind = "diagnosis" | "implementation" | "verification";
export interface HarnessNativeExecutionPlanStep {
	step: string;
	kind: HarnessNativePlanStepKind;
	status: HarnessNativePlanStepStatus;
}
/** Model-owned execution intent. It is not a source of Runtime or repository facts. */
export interface HarnessNativeExecutionPlan {
	version: 1;
	objective: string;
	steps: HarnessNativeExecutionPlanStep[];
}
export interface HarnessNativePlanRevision {
	version: 1;
	revision: number;
	/** Executor iteration whose completed observation triggered this planning decision. */
	iteration: number;
	trigger:
		| "initial-observation"
		| "mutation-applied"
		| "verification-feedback"
		| "execution-blocked"
		| "execution-stalled";
	plan: HarnessNativeExecutionPlan;
}
export type HarnessNativePlanExecutionOutcome = "progress" | "evidence" | "blocked" | "stalled";
export type HarnessNativePlanExecutionCheckpoint = "verification-due" | "repair-due";
export interface HarnessNativeActivePlanStep {
	version: 1;
	/** Controller-owned correlation identity for facts recorded under this execution step. */
	executionId: number;
	revision: number;
	stepIndex: number;
	objective: string;
	step: string;
	attempts: number;
	lastOutcome: HarnessNativePlanExecutionOutcome | null;
	/** Derived from canonical mutation and verification facts; never selects the next tool. */
	executionCheckpoint: HarnessNativePlanExecutionCheckpoint | null;
}
export interface HarnessNativePlanExecutionEvent {
	version: 1;
	/** Stable owner assigned when the corresponding action was executed. */
	executionId: number;
	/** Runtime action correlation. Null only for historical or direct Controller consumers. */
	actionId: string | null;
	revision: number;
	stepIndex: number;
	iteration: number;
	tool: HarnessNativeToolName;
	toolStatus: "ok" | "rejected" | "error";
	outcome: HarnessNativePlanExecutionOutcome;
}
/** Derived execution lifecycle for the model-owned plan. Runtime facts remain canonical. */
export interface HarnessNativePlanExecutionResult {
	version: 1;
	activeStep: HarnessNativeActivePlanStep | null;
	events: HarnessNativePlanExecutionEvent[];
}
export interface HarnessNativePlanningResult {
	version: 1;
	enabled: boolean;
	maxRevisions: number;
	revisions: HarnessNativePlanRevision[];
	currentPlan: HarnessNativeExecutionPlan | null;
}

export type HarnessNativeContinuationEvidenceKind = "repository" | "mutation" | "verification" | "failure" | "recent";

/** One bounded, source-correlated observation carried across an attempt boundary. */
export interface HarnessNativeContinuationEvidence {
	sequence: number;
	iteration: number;
	kind: HarnessNativeContinuationEvidenceKind;
	tool: HarnessNativeToolName;
	status: "ok" | "rejected" | "error";
	paths: string[];
	observation: string;
}

/** Historical execution intent. It seeds planning but never becomes the new attempt's active execution owner. */
export interface HarnessNativeContinuationUnresolvedWork {
	objective: string;
	step: string;
	executionCheckpoint: HarnessNativePlanExecutionCheckpoint | null;
	previousRevision: number;
	previousExecutionId: number;
}

export interface HarnessNativeContinuationContextView {
	version: 2;
	previousAttempt: number;
	throughEventSequence: number;
	sourceEventSequences: number[];
	terminationReason: HarnessNativeTerminationReason | null;
	review: HarnessNativeAttemptReview | null;
	plan: HarnessNativeExecutionPlan | null;
	activePlanStep: HarnessNativeActivePlanStep | null;
	unresolvedWork: HarnessNativeContinuationUnresolvedWork | null;
	evidence: HarnessNativeContinuationEvidence[];
	retention: {
		maxBytes: number;
		renderedBytes: number;
		candidateEvidenceCount: number;
		retainedEvidenceCount: number;
		omittedEvidenceCount: number;
		omittedObservationBytes: number;
		truncatedEvidenceCount: number;
	};
}

interface HarnessNativeBaseContextView {
	version: 1;
	throughEventSequence: number;
	attempt: number;
	interactions?: HarnessNativeHistoryProjectionInteraction[];
	observations: string[];
	historyProjection: HarnessNativeHistoryProjection;
	workingContext: HarnessNativeWorkingContext;
	continuation: HarnessNativeContinuationContextView | null;
	/** Latest same-decision protocol correction, derived from Runtime events. */
	protocolRecovery: HarnessNativeProtocolRecoveryFeedback | null;
	/** Latest denied finish feedback, cleared by the next execution fact. */
	completionFeedback: string | null;
}

/** Read-only projection consumed by a planning decision. */
export interface HarnessNativePlannerContextView extends HarnessNativeBaseContextView {
	previousPlan: HarnessNativeExecutionPlan | null;
}

/** Read-only projection consumed by an Executor decision. */
export interface HarnessNativeExecutorContextView extends HarnessNativeBaseContextView {
	plan: HarnessNativeExecutionPlan | null;
	activePlanStep: HarnessNativeActivePlanStep | null;
}

export interface HarnessNativeContextViews {
	version: 1;
	planner: HarnessNativePlannerContextView;
	executor: HarnessNativeExecutorContextView;
	continuation: HarnessNativeContinuationContextView | null;
}
export interface HarnessNativeRuntimeResult {
	version: 1;
	provider: string;
	providerIdentity: ModelProviderIdentity;
	model: string;
	status: "succeeded" | "failed";
	terminationReason: HarnessNativeTerminationReason;
	/** Safe, normalized provider failure metadata; never raw provider error content. */
	providerFailure: HarnessNativeProviderFailure | null;
	/** Number of model decision requests attempted during this Runtime execution. */
	iterations: number;
	/** Calls accepted by the Harness and therefore charged to the regular tool budget. */
	toolCalls: number;
	/** Calls rejected before workspace mutation, tracked under their own strict budget. */
	rejectedToolCalls: number;
	/** Retried transient transport requests that later succeeded; never semantic or tool retries. */
	transportRetries: number;
	/** Recoverable protocol errors retried without consuming another coding iteration. */
	protocolRecoveries?: number;
	/** Finish requests deferred because the Runtime lifecycle was visibly incomplete. */
	completionDeferrals?: number;
	budget: Pick<
		HarnessNativeAgentPolicy,
		"maxIterations" | "maxToolCalls" | "maxRejectedToolCalls" | "maxObservationBytes" | "maxTransportRetries"
	> &
		Partial<Pick<HarnessNativeAgentPolicy, "maxProtocolRecoveries" | "maxCompletionDeferrals">>;
	usage: { inputTokens: number | null; outputTokens: number | null };
	/** Task-level resource projection folded from canonical Runtime events. */
	resourceLedger?: HarnessNativeResourceLedger;
	/** Backward-compatible projection of this attempt's canonical Runtime events. */
	trajectory: HarnessNativeTrajectoryStep[];
	/** Ordered event slice for this bounded attempt. Absent only in historical Evidence. */
	runtimeEvents?: HarnessNativeRuntimeEvent[];
	convergenceCheckpoint: HarnessNativeConvergenceCheckpoint;
	/** Metadata only; canonical interaction history remains complete in the Runtime trace. */
	historyProjection?: HarnessNativeHistoryProjection;
	workingContext: HarnessNativeWorkingContext;
	/** Model-owned plan lifecycle. Absent only in Runtime evidence created before Planner support. */
	planning?: HarnessNativePlanningResult;
	/** Active-step execution lifecycle derived from plan revisions and canonical tool facts. */
	planExecution?: HarnessNativePlanExecutionResult;
	/** Read-only trajectory projection. It does not participate in Agent decisions. */
	shadowControlPlane?: HarnessNativeShadowControlPlaneDiagnostic;
}

export interface HarnessNativeProviderResourceUsage {
	calls: number;
	completedCalls: number;
	failedCalls: number;
	interruptedCalls: number;
	unknownUsageCalls: number;
	inputTokens: number;
	outputTokens: number;
	transportRetries: number;
	transportRetriesUnknownCalls: number;
}

/** Replayable task-level resource view. It is a projection, never a second event history. */
export interface HarnessNativeResourceLedger {
	version: 1;
	throughEventSequence: number;
	attempts: number;
	executorIterations: number;
	/** All completed non-rejected canonical tool actions, including run_code envelopes. */
	toolCalls: number;
	/** Subset used to restore the existing tool budget across durable resume. */
	budgetedToolCalls: number;
	/** All canonical rejected tool actions, including budget rejection. */
	rejectedToolCalls: number;
	/** Subset used to restore the existing rejected-tool budget across durable resume. */
	budgetedRejectedToolCalls: number;
	planRevisions: number;
	protocolRecoveries: number;
	completionDeferrals: number;
	activeRuntimeMs: number;
	provider: {
		total: HarnessNativeProviderResourceUsage;
		executor: HarnessNativeProviderResourceUsage;
		planner: HarnessNativeProviderResourceUsage;
	};
}

export interface PatchSnapshot {
	changedFiles: string[];
	trackedPatch: string;
	untrackedFiles?: UntrackedFileSnapshot[];
}

export interface UntrackedFileSnapshot {
	path: string;
	content: string;
	sha256: string;
	byteLength: number;
}

export type AgentPatchCheckStatus = "succeeded" | "failed";

export interface AgentPatchCheckExecutionResult {
	status: AgentPatchCheckStatus;
	workspace: IsolatedWorkspace;
	/** Absent only in Evidence created before worktree bootstrap support. */
	executionBootstrap?: ExecutionBootstrapResult | null;
	agent: AgentExecution;
	patch: PatchSnapshot;
	commandVerification: CommandVerification;
	hiddenOracle?: VerifierPluginResult | null;
}

export interface EvidenceBundleReference {
	path: string;
	createdAt: string;
}

/**
 * Immutable, content-addressed record of the validated task definition that
 * affected an execution. The referenced JSON retains the prompt and resolved
 * policy, while Evidence keeps only this safe integrity reference.
 */
export interface TaskDefinitionSnapshotReference {
	version: 1;
	path: string;
	sha256: string;
}

export interface TaskDefinitionArtifactReference {
	path: string;
	sha256: string;
}

/**
 * The persisted, normalized execution definition. It intentionally retains
 * external script references and hashes rather than copying their contents.
 */
export interface TaskDefinitionSnapshot {
	version: 1;
	policy: {
		repositoryRoot: string;
		baseRef: string;
		baseCommit: string;
		worktreeRoot: string;
		runIdentity: RunIdentity;
		prompt: string;
		executionBootstrap: ExecutionBootstrapPolicy | null;
		publicVerificationRepairInstruction: string | null;
		codexExecutable: string | null;
		agentAdapter: AgentAdapterId;
		agentScript: TaskDefinitionArtifactReference | null;
		nativeAgent: HarnessNativeAgentPolicy | null;
		model: string | null;
		timeoutMs: number;
		sandbox: AgentPatchCheckSandbox;
		allowNetwork: boolean;
		allowDangerousParameters: false;
		verification: VerificationPolicy;
		verificationProfile: VerificationProfileReference | null;
		riskPolicy: RiskPolicy;
		hiddenOracle: {
			script: TaskDefinitionArtifactReference;
			timeoutMs: number;
			isolation: HiddenOracleIsolationLevel;
			memoryLimitBytes: number;
			cpuRatePercent: number;
		} | null;
		patchExpectation: PatchExpectation;
	};
}

export interface TaskPolicyEvidenceSnapshot {
	repositoryRoot: string;
	baseRef: string;
	baseCommit: string;
	worktreeRoot: string;
	runIdentity?: RunIdentity;
	promptLength: number;
	promptSha256: string;
	/** Absent only in Evidence created before worktree bootstrap support. */
	executionBootstrap?: ExecutionBootstrapPolicy | null;
	publicVerificationRepairInstruction?: { length: number; sha256: string } | null;
	codexExecutable: string | null;
	agentAdapter?: AgentAdapterId;
	model: string | null;
	timeoutMs: number;
	sandbox: AgentPatchCheckSandbox;
	allowNetwork: boolean;
	allowDangerousParameters: false;
	verification: VerificationPolicy;
	verificationProfile: VerificationProfileReference | null;
	riskPolicy?: RiskPolicy;
	hiddenOracle?: {
		configured: true;
		timeoutMs: number;
		isolation: HiddenOracleIsolationLevel;
		memoryLimitBytes: number;
		cpuRatePercent: number;
	} | null;
	patchExpectation: PatchExpectation;
}

export interface EvidenceBundle {
	version: 1;
	createdAt: string;
	/** Absent only in Evidence created before Task Definition provenance support. */
	taskDefinition?: TaskDefinitionSnapshotReference;
	policy: TaskPolicyEvidenceSnapshot;
	repository: {
		root: string;
		baseRef: string;
		baseCommit: string;
	};
	workspace: IsolatedWorkspace;
	/** Absent only in Evidence created before worktree bootstrap support. */
	executionBootstrap?: ExecutionBootstrapResult | null;
	agent: AgentExecution;
	commandVerification: CommandVerification;
	hiddenOracle?: VerifierPluginResult | null;
	patch: PatchSnapshot & {
		trackedPatchSha256: string;
	};
	result: {
		status: AgentPatchCheckStatus;
		durationMs: number;
	};
}

export type CommandVerificationStatus = "passed" | "failed" | "not-run";

export type VerifierPluginKind = "command" | "hidden-oracle";
export type VerifierPluginStatus = "passed" | "failed" | "timed-out" | "error" | "not-run";

export interface VerifierPluginResult {
	id: string;
	kind: VerifierPluginKind;
	status: VerifierPluginStatus;
	durationMs: number;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	diagnostic: string | null;
	isolation?: HiddenOracleIsolationCapability;
}

export interface CommandVerificationResult {
	command: string;
	args: string[];
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
}

export interface CommandVerification {
	status: CommandVerificationStatus;
	cwd: string;
	commands: CommandVerificationResult[];
}

export interface AgentPatchCheckResult extends AgentPatchCheckExecutionResult {
	evidence: EvidenceBundleReference;
	assessment: AssessmentResult;
}

export type GitPatchVerificationStatus = "verified" | "failed";

export interface GitPatchVerification {
	status: GitPatchVerificationStatus;
	evidencePath: string;
	worktreePath: string;
	checkedAt: string;
	durationMs: number;
	checks: {
		worktreeExists: boolean;
		headMatchesBaseCommit: boolean;
		changedFilesMatch: boolean;
		trackedPatchMatches: boolean;
		untrackedFilesMatch?: boolean;
		unrecordedUntrackedFiles: string[];
	};
	failures: string[];
}

export type PatchExpectation = "changes-required" | "changes-optional";
export type PatchVerdictStatus = "pass" | "fail" | "inconclusive";
export type PatchVerdictReasonCode =
	| "git-verification-failed"
	| "agent-timed-out"
	| "agent-failed"
	| "command-verification-failed"
	| "hidden-oracle-failed"
	| "hidden-oracle-timed-out"
	| "hidden-oracle-error"
	| "changes-required-but-none-recorded";

export interface PatchVerdict {
	status: PatchVerdictStatus;
	expectation: PatchExpectation;
	reasonCodes: PatchVerdictReasonCode[];
	reasons: string[];
}

export interface AssessmentReport {
	version: 1;
	createdAt: string;
	evidence: EvidenceBundleReference;
	gitPatchVerification: GitPatchVerification;
	verifiers?: {
		command: VerifierPluginResult;
		hiddenOracle: VerifierPluginResult | null;
	};
	verdict: PatchVerdict;
}

export interface AssessmentReportReference {
	path: string;
	createdAt: string;
}

export interface AssessmentResult {
	report: AssessmentReport;
	reference: AssessmentReportReference;
}

export type CleanupStatus = "dry-run" | "removed" | "already-removed";

export interface CleanupResult {
	status: CleanupStatus;
	evidencePath: string;
	assessmentPath: string;
	worktreePath: string;
}

export type EvidenceAssessmentStatus = "missing" | "valid" | "invalid";

export interface EvidenceListEntry {
	runId: string;
	createdAt: string;
	status: AgentPatchCheckStatus;
	assessmentStatus: EvidenceAssessmentStatus;
	verdict: PatchVerdictStatus | null;
	worktreeExists: boolean;
	evidencePath: string;
	assessmentPath: string;
}

export interface EvidenceListResult {
	repositoryRoot: string;
	evidenceDirectory: string;
	entries: EvidenceListEntry[];
	invalidEvidence: string[];
}

export interface EvidenceListFilter {
	status?: AgentPatchCheckStatus;
	assessmentStatus?: EvidenceAssessmentStatus;
	runId?: string;
	createdAfter?: string;
	createdBefore?: string;
}

export interface EvidenceAuditResult {
	version: 1;
	repositoryRoot: string;
	auditedAt: string;
	olderThanDays: number;
	missingAssessments: EvidenceListEntry[];
	missingWorktrees: EvidenceListEntry[];
	expiredBundles: EvidenceListEntry[];
	orphanApprovalPaths: string[];
	invalidEvidence: string[];
}

export interface EvidenceRetentionCandidate {
	runId: string;
	evidencePath: string;
	assessmentPath: string;
	approvalPath: string;
	approvalHistoryPath: string;
	createdAt: string;
	benchmarkReferences: string[];
}

export interface EvidenceRetentionResult {
	version: 1;
	status: "dry-run" | "removed";
	repositoryRoot: string;
	olderThanDays: number;
	benchmarkReportRoots: string[];
	candidates: EvidenceRetentionCandidate[];
	protectedByBenchmark: EvidenceRetentionCandidate[];
	removedEvidencePaths: string[];
}

export interface EvidenceShowResult {
	evidence: EvidenceBundleReference;
	/** Null for historical Evidence written before Task Definition provenance support. */
	taskDefinition: TaskDefinitionSnapshotReference | null;
	policy: TaskPolicyEvidenceSnapshot;
	workspace: IsolatedWorkspace;
	agent: {
		executable: string;
		args: string[];
		exitCode: number | null;
		signal: NodeJS.Signals | null;
		durationMs: number;
		timedOut: boolean;
		stdoutBytes: number;
		stderrBytes: number;
		runtime: HarnessNativeRuntimeResult | null;
		clineRuntime: ClineRuntimeResult | null;
	};
	commandVerification: {
		status: CommandVerificationStatus;
		cwd: string;
		commands: Array<
			Pick<CommandVerificationResult, "command" | "args" | "exitCode" | "signal" | "durationMs" | "timedOut"> & {
				stdoutBytes: number;
				stderrBytes: number;
			}
		>;
	};
	patch: {
		changedFiles: string[];
		trackedPatchSha256: string;
		trackedPatchBytes: number;
		untrackedFileCount: number;
		untrackedFileBytes: number;
	};
	hiddenOracle: VerifierPluginResult | null;
	risk: RiskResult;
	approval: ApprovalState;
	approvalHistory: ApprovalRecord[];
	result: EvidenceBundle["result"];
	assessment: {
		status: EvidenceAssessmentStatus;
		path: string;
		report: Pick<AssessmentReport, "createdAt" | "verdict" | "gitPatchVerification"> | null;
	};
}

export type ApplyPlanStatus = "ready" | "nothing-to-apply" | "blocked";

export type RiskLevel = "low" | "medium" | "high" | "critical";
export interface RiskFinding {
	policyId: string;
	level: RiskLevel;
	code: string;
	message: string;
	files: string[];
}
export interface RiskResult {
	version: 1;
	level: RiskLevel;
	findings: RiskFinding[];
	requiresApproval: boolean;
	blocksApply: boolean;
	fingerprint: string;
}
export type ApprovalDecision = "approved" | "rejected";
export interface ApprovalRecord {
	version: 1;
	evidence: EvidenceBundleReference;
	riskFingerprint: string;
	decision: ApprovalDecision;
	createdAt: string;
	reason: string | null;
	cliVersion: string;
}
export interface ApprovalState {
	status: "not-required" | "pending" | "approved" | "rejected" | "invalid";
	record: ApprovalRecord | null;
}
export type ApplyDecision = "ready" | "requires-approval" | "prohibited";

export interface ApplyPlanResult {
	status: ApplyPlanStatus;
	evidencePath: string;
	assessmentPath: string;
	repositoryRoot: string | null;
	baseCommit: string;
	changedFiles: string[];
	unmaterializedFiles: string[];
	checks: { assessmentPasses: boolean; headMatchesBaseCommit: boolean; patchApplies: boolean };
	risk: RiskResult;
	approval: ApprovalState;
	decision: ApplyDecision;
	failures: string[];
}

export type ApplyExecutionStatus = "dry-run" | "blocked" | "applied";

export interface ApplyExecutionResult {
	status: ApplyExecutionStatus;
	plan: ApplyPlanResult;
	targetRepositoryRoot: string;
	failures: string[];
	appliedFiles: string[];
	headCommit: string | null;
}

export type BenchmarkTaskStatus =
	| "passed"
	| "timed-out"
	| "agent-failed"
	| "verification-failed"
	| "hidden-oracle-failed"
	| "hidden-oracle-error"
	| "assessment-failed"
	| "setup-failed";

/**
 * Orthogonal execution, completion, and semantic facts for a Benchmark task.
 * `BenchmarkTaskStatus` remains the stable overall decision; these fields make
 * its underlying failure mode auditable without weakening any gate.
 */
export type BenchmarkExecutionClassification =
	| "completed"
	| "timed-out"
	| "provider-failed"
	| "tool-budget-exhausted"
	| "iteration-budget-exhausted"
	| "rejected-tool-budget-exhausted"
	| "agent-execution-failed"
	| "setup-failed";

export type BenchmarkCompletionClassification = "completed" | "completion-noncompliant" | "not-reached";

export type BenchmarkSemanticClassification =
	| "passed"
	| "public-verification-failed"
	| "hidden-oracle-failed"
	| "hidden-oracle-error"
	| "assessment-failed"
	| "not-evaluated";

export interface BenchmarkFailureClassification {
	execution: BenchmarkExecutionClassification;
	completion: BenchmarkCompletionClassification;
	semantic: BenchmarkSemanticClassification;
}

export interface BenchmarkTaskDefinition {
	id: string;
	taskSpecPath: string;
	taskSpecSha256: string;
	expectedStatus: BenchmarkTaskStatus | null;
}

export interface BenchmarkDefinition {
	version: 1;
	sourcePath: string;
	sourceSha256: string;
	name: string | null;
	suite: { id: string; fixtureVersion: string } | null;
	/** Explicit experiment arm for compact Run Identity generation. */
	variant?: string;
	/** Explicit formal retry number for compact Run Identity generation. */
	attempt?: number;
	tasks: BenchmarkTaskDefinition[];
}

export interface BenchmarkTaskConfiguration {
	taskSpecSha256: string;
	expectedStatus: BenchmarkTaskStatus | null;
	verificationProfile: VerificationProfileReference | null;
	riskPolicyProfile: RiskPolicyProfileReference | null;
	codexExecutable: string | null;
	model: string | null;
	/** Absent only in reports produced before Provider identity was introduced. */
	modelProvider?: Pick<
		ModelProviderConfiguration,
		"provider" | "protocol" | "thinkingMode" | "endpointSha256" | "credentialRef" | "implementation"
	> | null;
	agentAdapter: AgentAdapterId;
}

export interface BenchmarkAgentIdentity {
	requestedExecutable: string;
	launchExecutable: string | null;
	version: string | null;
}

export interface BenchmarkTaskExecutionIdentity {
	baseCommit: string;
	hiddenOracleSha256: string | null;
	agent: BenchmarkAgentIdentity | null;
	/** Absent only in reports produced before Provider identity was introduced. */
	modelProvider?: ModelProviderIdentity | null;
}

/**
 * Harness-native public-verification repair is intentionally bounded to one
 * attempt. This records the observable outcome without exposing verifier output.
 */
export type BenchmarkRepairCycleOutcome =
	| "initial-pass"
	| "initial-verification-not-run"
	| "repaired"
	| "repair-failed"
	| "repair-timed-out"
	| "initial-agent-failed"
	| "initial-agent-timed-out";

export interface BenchmarkRepairCycleResult {
	attempted: boolean;
	/** Present for executions produced after the controlled repair policy was introduced. */
	decision?: PublicVerificationRepairDecision;
	initialVerificationStatus: CommandVerificationStatus;
	finalVerificationStatus: CommandVerificationStatus;
	outcome: BenchmarkRepairCycleOutcome;
}

export interface BenchmarkExecutionIdentity {
	cliVersion: string;
	coreSchemaVersion: 1;
	nodeVersion: string;
	platform: NodeJS.Platform;
	arch: string;
	suite: {
		sourceSha256: string;
		id: string | null;
		fixtureVersion: string | null;
	};
}

export interface BenchmarkTaskResult {
	taskId: string;
	/** Compact filesystem identity; full task semantics remain in this report and Evidence. */
	runId?: string;
	taskSpecPath: string;
	configuration: BenchmarkTaskConfiguration;
	executionIdentity: BenchmarkTaskExecutionIdentity | null;
	status: BenchmarkTaskStatus;
	/** Absent only in BenchmarkReports produced before failure classification was introduced. */
	failureClassification?: BenchmarkFailureClassification;
	durationMs: number;
	evidence: EvidenceBundleReference | null;
	assessment: AssessmentReportReference | null;
	agent: Pick<AgentExecution, "executable" | "args" | "exitCode" | "signal" | "durationMs" | "timedOut"> | null;
	/** Present only for Harness-native tasks; aggregates all bounded attempts in this task. */
	nativeRuntime?: {
		attempts: number;
		iterations: number;
		toolCalls: number;
		rejectedToolCalls: number;
		transportRetries: number;
		/** Absent only in reports created before Phase 5C.3. */
		protocolRecoveries?: number;
		/** Absent only in reports created before Phase 5C.3. */
		completionDeferrals?: number;
		providerFailureKinds: HarnessNativeProviderFailureKind[];
	} | null;
	verificationStatus: CommandVerificationStatus | null;
	/** Present for Harness-native tasks that reached Headless Core execution. */
	repairCycle?: BenchmarkRepairCycleResult | null;
	hiddenOracleStatus: VerifierPluginStatus | null;
	riskLevel: RiskLevel | null;
	approvalStatus: ApprovalState["status"] | null;
	verdict: PatchVerdictStatus | null;
	error: { code: "task-failed"; message: string } | null;
}

export interface BenchmarkReport {
	version: 1;
	createdAt: string;
	benchmark: {
		sourcePath: string;
		sourceSha256: string;
		name: string | null;
		suite: { id: string; fixtureVersion: string } | null;
		runId: string;
	};
	environment: {
		nodeVersion: string;
		platform: NodeJS.Platform;
		arch: string;
		coreSchemaVersion: 1;
	};
	executionIdentity?: BenchmarkExecutionIdentity;
	tasks: BenchmarkTaskResult[];
	summary: {
		total: number;
		passed: number;
		failed: number;
		byStatus: Record<BenchmarkTaskStatus, number>;
		/** Absent only in BenchmarkReports produced before failure classification was introduced. */
		failureClassification?: {
			byExecution: Partial<Record<BenchmarkExecutionClassification, number>>;
			byCompletion: Partial<Record<BenchmarkCompletionClassification, number>>;
			bySemantic: Partial<Record<BenchmarkSemanticClassification, number>>;
		};
		summaryText: string;
		repairCycles?: {
			nativeTasks: number;
			initialPasses: number;
			attempted: number;
			repaired: number;
			failed: number;
			timedOut: number;
		};
		/** Count-based quality facts. Consumers calculate rates using the named denominators. */
		nativeQuality?: {
			nativeTasks: number;
			initialPublicVerificationPassed: number;
			publicRepairAttempted: number;
			publicRepairRecovered: number;
			finalPublicVerificationPassed: number;
			hiddenOraclePassed: number;
			transportRetries: number;
			rejectedToolCalls: number;
			providerFailureTasks: number;
			agentExecutionFailureTasks: number;
		};
	};
}

export interface BenchmarkReportReference {
	path: string;
	createdAt: string;
}

export interface BenchmarkResult {
	report: BenchmarkReport;
	reference: BenchmarkReportReference;
}

export type BenchmarkComparisonChange = "unchanged" | "improved" | "regressed" | "changed" | "added" | "removed";
export type BenchmarkCompatibility =
	| "comparable"
	| "agent-drift"
	| "fixture-or-config-drift"
	| "environment-drift"
	| "incomplete";

export interface BenchmarkReportComparison {
	version: 1;
	left: { path: string; createdAt: string; benchmark: BenchmarkReport["benchmark"] };
	right: { path: string; createdAt: string; benchmark: BenchmarkReport["benchmark"] };
	compatibility: { status: BenchmarkCompatibility; reasons: string[] };
	tasks: Array<{
		taskId: string;
		change: BenchmarkComparisonChange;
		configurationChanged: boolean | null;
		executionIdentityChanged: boolean | null;
		left: Pick<BenchmarkTaskResult, "status" | "configuration"> | null;
		right: Pick<BenchmarkTaskResult, "status" | "configuration"> | null;
	}>;
	summary: {
		total: number;
		unchanged: number;
		improved: number;
		regressed: number;
		changed: number;
		added: number;
		removed: number;
		configurationChanged: number;
	};
}
