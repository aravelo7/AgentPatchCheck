import type { HarnessNativeRepositoryPrimitives } from "./harness-native-runtime";
import type { AgentAdapterId, AgentExecution, RepairContext, TaskPolicy } from "./types";

/** Harness-owned runtimes consume validated policy and return execution facts only. */
export interface AgentRuntimeContext {
	policy: TaskPolicy;
	worktreePath: string;
	/** Caller-owned whole-agent cancellation scope. */
	signal?: AbortSignal;
	/** Candidate repository I/O; omitted for existing Host-backed executions. */
	repository?: HarnessNativeRepositoryPrimitives;
	/** Explicit Harness-owned execution phase; Hidden Oracle data is never included. */
	repairContext: RepairContext;
}

/** Runtimes never construct patches, verifier output, Evidence, Risk, or apply decisions. */
export interface AgentRuntime {
	id: AgentAdapterId;
	execute: (context: AgentRuntimeContext) => Promise<AgentExecution>;
}
