export type AgentPatchCheckSandbox = "read-only" | "workspace-write";
export const TASK_POLICY_BRAND: unique symbol = Symbol("TaskPolicy");

export interface TaskPolicyInput {
	repositoryRoot: string;
	prompt: string;
	baseRef?: string;
	worktreeRoot?: string;
	runId?: string;
	codexExecutable?: string;
	model?: string;
	timeoutMs?: number;
	sandbox?: AgentPatchCheckSandbox;
	allowNetwork?: boolean;
	allowDangerousParameters?: boolean;
	verification?: VerificationPolicyInput;
	verificationProfile?: VerificationProfileReference;
	patchExpectation?: PatchExpectation;
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

export interface TaskPolicy {
	readonly [TASK_POLICY_BRAND]: true;
	repositoryRoot: string;
	baseRef: string;
	baseCommit: string;
	worktreeRoot: string;
	prompt: string;
	runId?: string;
	codexExecutable?: string;
	model?: string;
	timeoutMs: number;
	sandbox: AgentPatchCheckSandbox;
	allowNetwork: boolean;
	allowDangerousParameters: false;
	verification: VerificationPolicy;
	verificationProfile: VerificationProfileReference | null;
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
	model: string | null;
	timeoutMs: number;
	sandbox: AgentPatchCheckSandbox;
	allowNetwork: boolean;
	allowDangerousParameters: false;
	verification: VerificationPolicy;
	verificationProfile: VerificationProfileReference | null;
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
	patch: PatchSnapshot & {
		trackedPatchSha256: string;
	};
	result: {
		status: AgentPatchCheckStatus;
		durationMs: number;
	};
}

export type CommandVerificationStatus = "passed" | "failed" | "not-run";

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
	result: EvidenceBundle["result"];
	assessment: {
		status: EvidenceAssessmentStatus;
		path: string;
		report: Pick<AssessmentReport, "createdAt" | "verdict" | "gitPatchVerification"> | null;
	};
}

export type ApplyPlanStatus = "ready" | "nothing-to-apply" | "blocked";

export interface ApplyPlanResult {
	status: ApplyPlanStatus;
	evidencePath: string;
	assessmentPath: string;
	repositoryRoot: string | null;
	baseCommit: string;
	changedFiles: string[];
	unmaterializedFiles: string[];
	checks: { assessmentPasses: boolean; headMatchesBaseCommit: boolean; patchApplies: boolean };
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
	| "assessment-failed"
	| "setup-failed";

export interface BenchmarkTaskDefinition {
	id: string;
	taskSpecPath: string;
}

export interface BenchmarkDefinition {
	version: 1;
	sourcePath: string;
	name: string | null;
	tasks: BenchmarkTaskDefinition[];
}

export interface BenchmarkTaskResult {
	taskId: string;
	taskSpecPath: string;
	status: BenchmarkTaskStatus;
	durationMs: number;
	evidence: EvidenceBundleReference | null;
	assessment: AssessmentReportReference | null;
	agent: Pick<AgentExecution, "exitCode" | "signal" | "durationMs" | "timedOut"> | null;
	verificationStatus: CommandVerificationStatus | null;
	verdict: PatchVerdictStatus | null;
	error: { code: "task-failed"; message: string } | null;
}

export interface BenchmarkReport {
	version: 1;
	createdAt: string;
	benchmark: {
		sourcePath: string;
		name: string | null;
		runId: string;
	};
	tasks: BenchmarkTaskResult[];
	summary: {
		total: number;
		passed: number;
		failed: number;
		byStatus: Record<BenchmarkTaskStatus, number>;
		summaryText: string;
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
