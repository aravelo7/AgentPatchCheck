import type {
	AgentAdapterId,
	AgentExecution,
	CommandVerification,
	PatchSnapshot,
	PublicVerificationRepairDecision,
} from "./types";

/**
 * Selects the sole permitted repair attempt from completed Harness facts.
 * It deliberately cannot inspect Hidden Oracle output, arbitrary verifier
 * output, or workspace contents.
 */
export function selectPublicVerificationRepair(input: {
	agentAdapter: AgentAdapterId;
	initialAgent: AgentExecution;
	verification: CommandVerification;
	remainingAgentBudgetMs: number;
	initialPatch: Pick<PatchSnapshot, "changedFiles"> | null;
}): PublicVerificationRepairDecision {
	const initialChangedFiles = input.initialPatch?.changedFiles ?? [];
	if (input.agentAdapter !== "harness-native" && input.agentAdapter !== "cline-runtime")
		return { eligible: false, reason: "adapter-not-harness-native", initialChangedFiles };
	if (input.initialAgent.timedOut) return { eligible: false, reason: "initial-agent-timed-out", initialChangedFiles };
	if (input.initialAgent.exitCode !== 0)
		return { eligible: false, reason: "initial-agent-failed", initialChangedFiles };
	if (input.verification.status !== "failed")
		return { eligible: false, reason: "public-verification-not-failed", initialChangedFiles };
	if (input.remainingAgentBudgetMs <= 0)
		return { eligible: false, reason: "agent-budget-exhausted", initialChangedFiles };
	return { eligible: true, reason: "public-verification-failed", initialChangedFiles };
}
