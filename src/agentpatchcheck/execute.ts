import { randomUUID } from "node:crypto";
import { assessEvidenceBundle } from "./assessment-report";
import { runCodex } from "./codex-runner";
import { runCommandVerification } from "./command-verifier";
import { createEvidenceBundle, getEvidenceBundlePath, writeEvidenceBundle } from "./evidence-bundle";
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
	runAgent: typeof runCodex;
	runVerification: typeof runCommandVerification;
	writeEvidence: typeof writeEvidenceBundle;
	assessEvidence: typeof assessEvidenceBundle;
}

const defaultDependencies: HeadlessCoreDependencies = {
	createWorkspace: createIsolatedWorkspace,
	collectPatch: collectPatchSnapshot,
	runAgent: runCodex,
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
		agent = await dependencies.runAgent({
			cwd: workspace.path,
			prompt: policy.prompt,
			executable: policy.codexExecutable,
			model: policy.model,
			timeoutMs: policy.timeoutMs,
			sandbox: policy.sandbox,
			allowNetwork: policy.allowNetwork,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		agent = {
			executable: policy.codexExecutable?.trim() || "codex",
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
	const execution: AgentPatchCheckExecutionResult = {
		status: agent.exitCode === 0 && !agent.timedOut ? "succeeded" : "failed",
		workspace,
		agent,
		patch,
		commandVerification,
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
