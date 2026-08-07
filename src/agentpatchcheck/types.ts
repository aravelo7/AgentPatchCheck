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
}

export type AgentPatchCheckStatus = "succeeded" | "failed";

export interface AgentPatchCheckResult {
	status: AgentPatchCheckStatus;
	workspace: IsolatedWorkspace;
	agent: AgentExecution;
	patch: PatchSnapshot;
}
