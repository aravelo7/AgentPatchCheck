export type AgentPatchCheckSandbox = "read-only" | "workspace-write";

export interface AgentPatchCheckRequest {
	repositoryPath: string;
	prompt: string;
	baseRef?: string;
	runId?: string;
	codexExecutable?: string;
	model?: string;
	timeoutMs?: number;
	sandbox?: AgentPatchCheckSandbox;
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
