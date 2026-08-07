import { randomUUID } from "node:crypto";

import { runCodex } from "./codex-runner";
import { collectPatchSnapshot, createIsolatedWorkspace } from "./isolated-workspace";
import type { AgentExecution, AgentPatchCheckResult, TaskPolicy } from "./types";

interface HeadlessCoreDependencies {
	createWorkspace: typeof createIsolatedWorkspace;
	collectPatch: typeof collectPatchSnapshot;
	runAgent: typeof runCodex;
}

const defaultDependencies: HeadlessCoreDependencies = {
	createWorkspace: createIsolatedWorkspace,
	collectPatch: collectPatchSnapshot,
	runAgent: runCodex,
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

	const patch = await dependencies.collectPatch(workspace.path);
	return {
		status: agent.exitCode === 0 && !agent.timedOut ? "succeeded" : "failed",
		workspace,
		agent,
		patch,
	};
}

export type { AgentPatchCheckResult, IsolatedWorkspace, PatchSnapshot, TaskPolicy } from "./types";
