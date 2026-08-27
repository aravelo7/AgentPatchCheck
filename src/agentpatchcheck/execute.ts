import { getAgentAdapter } from "./agent-adapter";
import { assessEvidenceBundle } from "./assessment-report";
import { createPublicVerificationFeedback, runCommandVerification } from "./command-verifier";
import { createEvidenceBundle, getEvidenceBundlePath, writeEvidenceBundle } from "./evidence-bundle";

import { runExecutionBootstrap } from "./execution-bootstrap";

import { runHiddenOracle } from "./hidden-oracle";
import { collectPatchSnapshot, createIsolatedWorkspace, resumeIsolatedWorkspace } from "./isolated-workspace";
import { selectPublicVerificationRepair } from "./public-verification-repair-policy";
import { createRunId } from "./run-identity";
import { getHarnessNativeRuntimeRecordPath, harnessNativeRuntimeRecordExists } from "./runtime-record";
import { persistTaskDefinitionSnapshot } from "./task-definition-snapshot";
import {
	getTaskFinalizationPath,
	readCompletedTaskFinalization,
	withTaskFinalizationLock,
	writeCompletedTaskFinalization,
} from "./task-finalization";
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
	resumeWorkspace: typeof resumeIsolatedWorkspace;
	runBootstrap: typeof runExecutionBootstrap;
	collectPatch: typeof collectPatchSnapshot;
	runAgent: (policy: TaskPolicy, worktreePath: string, repairContext: RepairContext) => Promise<AgentExecution>;
	runVerification: typeof runCommandVerification;
	runHiddenOracle: typeof runHiddenOracle;
	writeEvidence: typeof writeEvidenceBundle;
	assessEvidence: typeof assessEvidenceBundle;
	persistTaskDefinition: typeof persistTaskDefinitionSnapshot;
	readTaskFinalization: typeof readCompletedTaskFinalization;
	writeTaskFinalization: typeof writeCompletedTaskFinalization;
	withTaskFinalizationLock: typeof withTaskFinalizationLock;
}

const defaultDependencies: HeadlessCoreDependencies = {
	createWorkspace: createIsolatedWorkspace,
	resumeWorkspace: resumeIsolatedWorkspace,
	runBootstrap: runExecutionBootstrap,
	collectPatch: collectPatchSnapshot,
	runAgent: async (policy, worktreePath, repairContext) =>
		await getAgentAdapter(policy.agentAdapter).execute({ policy, worktreePath, repairContext }),
	runVerification: runCommandVerification,
	runHiddenOracle,
	writeEvidence: writeEvidenceBundle,
	assessEvidence: assessEvidenceBundle,
	persistTaskDefinition: persistTaskDefinitionSnapshot,
	readTaskFinalization: readCompletedTaskFinalization,
	writeTaskFinalization: writeCompletedTaskFinalization,
	withTaskFinalizationLock,
};

function failedAgentExecution(policy: TaskPolicy, message: string): AgentExecution {
	return {
		executable:
			policy.agentAdapter === "codex"
				? policy.codexExecutable?.trim() || "codex"
				: policy.agentAdapter === "harness-native"
					? "harness-native"
					: policy.agentAdapter === "cline-runtime"
						? "cline-agent-runtime"
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

function withoutNestedAttempts(execution: AgentExecution): Omit<AgentExecution, "attempts"> {
	const { attempts: _attempts, ...result } = execution;
	return result;
}

function materializeAgentAttempts(
	execution: AgentExecution,
	phase: AgentExecutionAttempt["phase"],
	feedback: AgentExecutionAttempt["feedback"],
): AgentExecutionAttempt[] {
	return (
		execution.attempts ?? [
			{
				phase,
				feedback,
				execution: withoutNestedAttempts(execution),
			},
		]
	);
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

async function executeUnfinalizedAgentPatchCheck(
	policy: TaskPolicy,
	resolvedDependencies: HeadlessCoreDependencies,
	taskDefinition: Awaited<ReturnType<typeof persistTaskDefinitionSnapshot>>,
	runId: string,
): Promise<AgentPatchCheckResult> {
	const runtimeRecordPath = getHarnessNativeRuntimeRecordPath(policy.worktreeRoot, runId);
	const resumeDurableRuntime =
		policy.agentAdapter === "harness-native" && harnessNativeRuntimeRecordExists(runtimeRecordPath);
	const workspace = await (resumeDurableRuntime
		? resolvedDependencies.resumeWorkspace
		: resolvedDependencies.createWorkspace)({
		repositoryPath: policy.repositoryRoot,
		runId,
		baseRef: policy.baseRef,
		baseCommit: policy.baseCommit,
		worktreeRoot: policy.worktreeRoot,
	});
	const executionBootstrap = resumeDurableRuntime
		? null
		: await resolvedDependencies.runBootstrap(policy.executionBootstrap, workspace.path, {
				repositoryRoot: policy.repositoryRoot,
				baseCommit: policy.baseCommit,
			});
	if (executionBootstrap?.status === "failed") {
		const agent = failedAgentExecution(
			policy,
			executionBootstrap.diagnostic ?? "Isolated worktree dependency bootstrap failed.",
		);
		const execution: AgentPatchCheckExecutionResult = {
			status: "failed",
			workspace,
			executionBootstrap,
			agent,
			patch: await resolvedDependencies.collectPatch(workspace.path),
			commandVerification: { status: "not-run", cwd: workspace.path, commands: [] },
			hiddenOracle: null,
		};
		const bundle = createEvidenceBundle({ policy, execution, taskDefinition });
		const evidence = await resolvedDependencies.writeEvidence({
			path: getEvidenceBundlePath(policy.worktreeRoot, workspace.runId),
			bundle,
		});
		const assessment = await resolvedDependencies.assessEvidence({
			evidencePath: evidence.path,
			expectation: policy.patchExpectation,
		});
		return { ...execution, evidence, assessment };
	}
	const agentBudgetStartedAt = Date.now();
	const initialAgent = await runAgentSafely(resolvedDependencies.runAgent, policy, workspace.path, {
		phase: "initial",
		publicVerificationFeedback: null,
		repairInstruction: null,
	});
	let agent = initialAgent;
	let commandVerification = await runVerificationSafely(resolvedDependencies.runVerification, policy, workspace.path);
	const feedback = createPublicVerificationFeedback(commandVerification);
	if (policy.agentAdapter === "harness-native" || policy.agentAdapter === "cline-runtime") {
		const initialPatch =
			initialAgent.exitCode === 0 && !initialAgent.timedOut && feedback !== null
				? await resolvedDependencies.collectPatch(workspace.path)
				: null;
		const remainingAgentBudgetMs = policy.timeoutMs - (Date.now() - agentBudgetStartedAt);
		const repairDecision = selectPublicVerificationRepair({
			agentAdapter: policy.agentAdapter,
			initialAgent,
			verification: commandVerification,
			remainingAgentBudgetMs,
			initialPatch,
		});
		if (repairDecision.eligible && feedback !== null) {
			const repairAgent = await runAgentSafely(
				resolvedDependencies.runAgent,
				{ ...policy, timeoutMs: remainingAgentBudgetMs },
				workspace.path,
				{
					phase: "public-verification-repair",
					publicVerificationFeedback: feedback,
					initialChangedFiles: repairDecision.initialChangedFiles,
					repairInstruction: policy.publicVerificationRepairInstruction,
				},
			);
			const attempts: AgentExecutionAttempt[] = [
				...materializeAgentAttempts(initialAgent, "initial", null),
				...materializeAgentAttempts(repairAgent, "public-verification-repair", feedback),
			];
			agent = { ...repairAgent, attempts, publicVerificationRepair: repairDecision };
			commandVerification = await runVerificationSafely(
				resolvedDependencies.runVerification,
				policy,
				workspace.path,
			);
		} else {
			agent = { ...initialAgent, publicVerificationRepair: repairDecision };
		}
	}
	const patch = await resolvedDependencies.collectPatch(workspace.path);
	const hiddenOracle = await resolvedDependencies.runHiddenOracle(policy.hiddenOracle, workspace.path);
	const execution: AgentPatchCheckExecutionResult = {
		status: agent.exitCode === 0 && !agent.timedOut ? "succeeded" : "failed",
		workspace,
		executionBootstrap,
		agent,
		patch,
		commandVerification,
		hiddenOracle,
	};
	const bundle = createEvidenceBundle({ policy, execution, taskDefinition });
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

export async function executeAgentPatchCheck(
	policy: TaskPolicy,
	dependencies: Partial<HeadlessCoreDependencies> = {},
): Promise<AgentPatchCheckResult> {
	const resolvedDependencies = { ...defaultDependencies, ...dependencies };
	const taskDefinition = await resolvedDependencies.persistTaskDefinition(policy);
	const runId = policy.runId ?? createRunId(policy.runIdentity);
	const finalizationPath = getTaskFinalizationPath(policy.worktreeRoot, runId);
	return await resolvedDependencies.withTaskFinalizationLock(finalizationPath, async () => {
		const completed = await resolvedDependencies.readTaskFinalization({ policy, runId, taskDefinition });
		if (completed !== null) return completed;
		const result = await executeUnfinalizedAgentPatchCheck(policy, resolvedDependencies, taskDefinition, runId);
		await resolvedDependencies.writeTaskFinalization({ policy, runId, taskDefinition, result });
		const durableResult = await resolvedDependencies.readTaskFinalization({ policy, runId, taskDefinition });
		if (durableResult === null) throw new Error(`Task finalization was not durably recorded: ${finalizationPath}`);
		return durableResult;
	});
}

export type {
	AgentPatchCheckResult,
	AssessmentResult,
	EvidenceBundle,
	IsolatedWorkspace,
	PatchSnapshot,
	TaskPolicy,
} from "./types";
