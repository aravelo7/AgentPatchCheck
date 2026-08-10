import { randomUUID } from "node:crypto";
import { getAgentAdapter } from "./agent-adapter";
import { assessEvidenceBundle } from "./assessment-report";
import { runCommandVerification } from "./command-verifier";
import { createEvidenceBundle, getEvidenceBundlePath, writeEvidenceBundle } from "./evidence-bundle";

import { runHiddenOracle } from "./hidden-oracle";
import { collectPatchSnapshot, createIsolatedWorkspace } from "./isolated-workspace";
import type {
	AgentExecution,
	AgentPatchCheckExecutionResult,
	AgentPatchCheckResult,
	AssessmentResult,
	CommandVerification,
	TaskPolicy,
} from "./types";

interface HeadlessCoreDependencies {
	createWorkspace: typeof createIsolatedWorkspace;
	collectPatch: typeof collectPatchSnapshot;
	runAgent: (policy: TaskPolicy, worktreePath: string) => Promise<AgentExecution>;
	runVerification: typeof runCommandVerification;
	writeEvidence: typeof writeEvidenceBundle;
	assessEvidence: typeof assessEvidenceBundle;
}

const defaultDependencies: HeadlessCoreDependencies = {
	createWorkspace: createIsolatedWorkspace,
	collectPatch: collectPatchSnapshot,
	runAgent: async (policy, worktreePath) =>
		await getAgentAdapter(policy.agentAdapter).execute({ policy, worktreePath }),
	runVerification: runCommandVerification,
	writeEvidence: writeEvidenceBundle,
	assessEvidence: assessEvidenceBundle,
};

function createRunId(): string {
	return `run-${randomUUID().slice(0, 12)}`;
}

export async function executeAgentPatchCheck(
	policy: TaskPolicy,
	dependencies: HeadlessCoreDependencies = defaultDependencies,
): Promise<AgentPatchCheckResult> {
	const workspace = await dependencies.createWorkspace({
		repositoryPath: policy.repositoryRoot,
		runId: policy.runId ?? createRunId(),
		baseRef: policy.baseRef,
		baseCommit: policy.baseCommit,
		worktreeRoot: policy.worktreeRoot,
	});
	let agent: AgentExecution;
	try {
		agent = await dependencies.runAgent(policy, workspace.path);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		agent = {
			executable: policy.agentAdapter === "codex" ? policy.codexExecutable?.trim() || "codex" : process.execPath,
			args: [],
			exitCode: null,
			signal: null,
			stdout: "",
			stderr: message,
			durationMs: 0,
			timedOut: false,
		};
	}

	let commandVerification: CommandVerification;
	try {
		commandVerification = await dependencies.runVerification(policy.verification, workspace.path);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		commandVerification = {
			status: "failed",
			cwd: workspace.path,
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
	const patch = await dependencies.collectPatch(workspace.path);
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
	const evidence = await dependencies.writeEvidence({
		path: getEvidenceBundlePath(policy.worktreeRoot, workspace.runId),
		bundle,
	});
	const assessment: AssessmentResult = await dependencies.assessEvidence({
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
