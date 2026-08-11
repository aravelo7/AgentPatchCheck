import type { AgentAdapterId, AgentExecution, PublicVerificationFeedback, TaskPolicy } from "./types";

/** Harness-owned runtimes consume validated policy and return execution facts only. */
export interface AgentRuntimeContext {
	policy: TaskPolicy;
	worktreePath: string;
	/** A sanitized result from Harness-owned public verification; Hidden Oracle data is never included. */
	publicVerificationFeedback?: PublicVerificationFeedback;
}

/** Runtimes never construct patches, verifier output, Evidence, Risk, or apply decisions. */
export interface AgentRuntime {
	id: AgentAdapterId;
	execute: (context: AgentRuntimeContext) => Promise<AgentExecution>;
}
