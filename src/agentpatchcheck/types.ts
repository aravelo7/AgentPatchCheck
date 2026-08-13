export type AgentPatchCheckSandbox = "read-only" | "workspace-write";
export type AgentAdapterId = "codex" | "script" | "harness-native";
export const TASK_POLICY_BRAND: unique symbol = Symbol("TaskPolicy");

export interface TaskPolicyInput {
	repositoryRoot: string;
	prompt: string;
	baseRef?: string;
	worktreeRoot?: string;
	runId?: string;
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
	runId?: string;
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
	attempts?: AgentExecutionAttempt[];
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

export interface AgentExecutionAttempt {
	phase: "initial" | "public-verification-repair";
	feedback: PublicVerificationFeedback | null;
	execution: Omit<AgentExecution, "attempts">;
}

export interface HarnessNativeAgentInput {
	provider?: ModelProviderKind;
	protocol?: ModelProviderProtocol;
	thinkingMode?: ModelProviderThinkingMode;
	baseUrl?: string;
	credentialRef?: string;
	maxIterations?: number;
	maxToolCalls?: number;
	maxObservationBytes?: number;
}

export type ModelProviderKind = "openai" | "openai-compatible";
export type ModelProviderProtocol = "responses" | "chat-completions";
export type ModelProviderThinkingMode = "default" | "disabled";

/**
 * Safe, validated model transport configuration. The credential value itself is
 * resolved only at execution time and is never part of this contract.
 */
export interface ModelProviderConfiguration {
	provider: ModelProviderKind;
	protocol: ModelProviderProtocol;
	thinkingMode: ModelProviderThinkingMode;
	baseUrl: string;
	endpointSha256: string;
	credentialRef: string;
	implementation: "openai-compatible-v1";
}

export interface HarnessNativeAgentPolicy {
	modelProvider: ModelProviderConfiguration;
	maxIterations: number;
	maxToolCalls: number;
	maxObservationBytes: number;
}

export type HarnessNativeToolName =
	| "read-file"
	| "list-directory"
	| "search-text"
	| "search-text-recursive"
	| "git-status"
	| "git-diff"
	| "apply-patch"
	| "apply-patch-batch"
	| "create-file";
export type HarnessNativeTerminationReason =
	| "finished"
	| "model-failed"
	| "iteration-limit"
	| "tool-limit"
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
export interface HarnessNativeProviderFailure {
	kind: HarnessNativeProviderFailureKind;
	/** Fixed structural diagnostic only; never raw provider content. */
	detail: HarnessNativeProviderFailureDetail;
	code: string | null;
	httpStatus: number | null;
	requestId: string | null;
}
export interface ModelProviderIdentity {
	provider: ModelProviderKind;
	protocol: ModelProviderProtocol;
	thinkingMode: ModelProviderThinkingMode;
	endpointSha256: string;
	credentialRef: string;
	implementation: "openai-compatible-v1";
	configuredModel: string;
	actualModel: string | null;
}
export interface HarnessNativeTrajectoryStep {
	iteration: number;
	decision: "tool" | "finish" | "fail";
	tool: HarnessNativeToolName | null;
	arguments: Record<string, string | number> | null;
	toolStatus: "ok" | "rejected" | "error" | null;
	observationSummary: string | null;
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
	toolCalls: number;
	budget: Pick<HarnessNativeAgentPolicy, "maxIterations" | "maxToolCalls" | "maxObservationBytes">;
	usage: { inputTokens: number | null; outputTokens: number | null };
	trajectory: HarnessNativeTrajectoryStep[];
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
	agent: AgentExecution;
	patch: PatchSnapshot;
	commandVerification: CommandVerification;
	hiddenOracle?: VerifierPluginResult | null;
}

export interface EvidenceBundleReference {
	path: string;
	createdAt: string;
}

export interface TaskPolicyEvidenceSnapshot {
	repositoryRoot: string;
	baseRef: string;
	baseCommit: string;
	worktreeRoot: string;
	promptLength: number;
	promptSha256: string;
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
	policy: TaskPolicyEvidenceSnapshot;
	repository: {
		root: string;
		baseRef: string;
		baseCommit: string;
	};
	workspace: IsolatedWorkspace;
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
	taskSpecPath: string;
	configuration: BenchmarkTaskConfiguration;
	executionIdentity: BenchmarkTaskExecutionIdentity | null;
	status: BenchmarkTaskStatus;
	durationMs: number;
	evidence: EvidenceBundleReference | null;
	assessment: AssessmentReportReference | null;
	agent: Pick<AgentExecution, "executable" | "args" | "exitCode" | "signal" | "durationMs" | "timedOut"> | null;
	/** Present only for Harness-native tasks; aggregates all bounded attempts in this task. */
	nativeRuntime?: {
		attempts: number;
		iterations: number;
		toolCalls: number;
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
