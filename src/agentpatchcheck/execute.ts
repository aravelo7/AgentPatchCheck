import { randomUUID } from "node:crypto";
import { getAgentAdapter } from "./agent-adapter";
import { assessEvidenceBundle } from "./assessment-report";
import { createPublicVerificationFeedback, runCommandVerification } from "./command-verifier";
import { createEvidenceBundle, getEvidenceBundlePath, writeEvidenceBundle } from "./evidence-bundle";

import { runHiddenOracle } from "./hidden-oracle";
import { collectPatchSnapshot, createIsolatedWorkspace } from "./isolated-workspace";
import type {
	AgentExecution,
	AgentExecutionAttempt,
	AgentPatchCheckExecutionResult,
	AgentPatchCheckResult,
	AssessmentResult,
	CommandVerification,
	RepairContext,
	TaskPolicy,
} from "./types";

export interface HeadlessCoreDependencies {
	createWorkspace: typeof createIsolatedWorkspace;
	collectPatch: typeof collectPatchSnapshot;
	runAgent: (policy: TaskPolicy, worktreePath: string, repairContext: RepairContext) => Promise<AgentExecution>;
	runVerification: typeof runCommandVerification;
	writeEvidence: typeof writeEvidenceBundle;
	assessEvidence: typeof assessEvidenceBundle;
}

const defaultDependencies: HeadlessCoreDependencies = {
	createWorkspace: createIsolatedWorkspace,
	collectPatch: collectPatchSnapshot,
	runAgent: async (policy, worktreePath, repairContext) =>
		await getAgentAdapter(policy.agentAdapter).execute({ policy, worktreePath, repairContext }),
	runVerification: runCommandVerification,
	writeEvidence: writeEvidenceBundle,
	assessEvidence: assessEvidenceBundle,
};

function createRunId(): string {
	return `run-${randomUUID().slice(0, 12)}`;
}

function failedAgentExecution(policy: TaskPolicy, message: string): AgentExecution {
	return {
		executable:
			policy.agentAdapter === "codex"
				? policy.codexExecutable?.trim() || "codex"
				: policy.agentAdapter === "harness-native"
					? "harness-native"
					: process.execPath,
		args: [],
		exitCode: null,
		signal: null,
		stdout: "",
		stderr: message,
		durationMs: 0,
		timedOut: false,
	};
}

async function runAgentSafely(
	runAgent: HeadlessCoreDependencies["runAgent"],
	policy: TaskPolicy,
	worktreePath: string,
	repairContext: RepairContext,
): Promise<AgentExecution> {
	try {
		return await runAgent(policy, worktreePath, repairContext);
	} catch (error) {
		return failedAgentExecution(policy, error instanceof Error ? error.message : String(error));
	}
}

async function runVerificationSafely(
	runVerification: HeadlessCoreDependencies["runVerification"],
	policy: TaskPolicy,
	worktreePath: string,
): Promise<CommandVerification> {
	try {
		return await runVerification(policy.verification, worktreePath);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			status: "failed",
			cwd: worktreePath,
			commands: [
				{
					command: "[command-verifier]",
					args: [],
					exitCode: null,
					signal: null,
					stdout: "",
					stderr: message,
					durationMs: 0,
					timedOut: false,
				},
			],
		};
	}
}

export async function executeAgentPatchCheck(
	policy: TaskPolicy,
	dependencies: Partial<HeadlessCoreDependencies> = {},
): Promise<AgentPatchCheckResult> {
	const resolvedDependencies = { ...defaultDependencies, ...dependencies };
	const workspace = await resolvedDependencies.createWorkspace({
		repositoryPath: policy.repositoryRoot,
		runId: policy.runId ?? createRunId(),
		baseRef: policy.baseRef,
		baseCommit: policy.baseCommit,
		worktreeRoot: policy.worktreeRoot,
	});
	const agentBudgetStartedAt = Date.now();
	const initialAgent = await runAgentSafely(resolvedDependencies.runAgent, policy, workspace.path, {
		phase: "initial",
		publicVerificationFeedback: null,
		repairInstruction: null,
	});
	let agent = initialAgent;
	let commandVerification = await runVerificationSafely(resolvedDependencies.runVerification, policy, workspace.path);
	const feedback = createPublicVerificationFeedback(commandVerification);
	if (
		policy.agentAdapter === "harness-native" &&
		initialAgent.exitCode === 0 &&
		!initialAgent.timedOut &&
		feedback !== null
	) {
		const remainingAgentBudgetMs = policy.timeoutMs - (Date.now() - agentBudgetStartedAt);
		const repairAgent =
			remainingAgentBudgetMs > 0
				? await runAgentSafely(
						resolvedDependencies.runAgent,
						{ ...policy, timeoutMs: remainingAgentBudgetMs },
						workspace.path,
						{
							phase: "public-verification-repair",
							publicVerificationFeedback: feedback,
							repairInstruction: policy.publicVerificationRepairInstruction,
						},
					)
				: failedAgentExecution(policy, "Harness-native public verification repair budget was exhausted.");
		const attempts: AgentExecutionAttempt[] = [
			{ phase: "initial", feedback: null, execution: initialAgent },
			{ phase: "public-verification-repair", feedback, execution: repairAgent },
		];
		agent = { ...repairAgent, attempts };
		commandVerification = await runVerificationSafely(resolvedDependencies.runVerification, policy, workspace.path);
	}
	const patch = await resolvedDependencies.collectPatch(workspace.path);
	const hiddenOracle = await runHiddenOracle(policy.hiddenOracle, workspace.path);
	const execution: AgentPatchCheckExecutionResult = {
		status: agent.exitCode === 0 && !agent.timedOut ? "succeeded" : "failed",
		workspace,
		agent,
		patch,
		commandVerification,
		hiddenOracle,
	};
	const bundle = createEvidenceBundle({ policy, execution });
	const evidence = await resolvedDependencies.writeEvidence({
		path: getEvidenceBundlePath(policy.worktreeRoot, workspace.runId),
		bundle,
	});
	const assessment: AssessmentResult = await resolvedDependencies.assessEvidence({
		evidencePath: evidence.path,
		expectation: policy.patchExpectation,
	});
	return { ...execution, evidence, assessment };
}

export type {
	AgentPatchCheckResult,
	AssessmentResult,
	EvidenceBundle,
	IsolatedWorkspace,
	PatchSnapshot,
	TaskPolicy,
} from "./types";
