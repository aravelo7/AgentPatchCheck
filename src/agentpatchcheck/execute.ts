import { randomUUID } from "node:crypto";

import { runCodex } from "./codex-runner";
import { collectPatchSnapshot, createIsolatedWorkspace } from "./isolated-workspace";
import type { AgentExecution, AgentPatchCheckRequest, AgentPatchCheckResult } from "./types";

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
	request: AgentPatchCheckRequest,
	dependencies: HeadlessCoreDependencies = defaultDependencies,
): Promise<AgentPatchCheckResult> {
	const workspace = await dependencies.createWorkspace({
		repositoryPath: request.repositoryPath,
		runId: request.runId ?? createRunId(),
		baseRef: request.baseRef,
	});
	let agent: AgentExecution;
	try {
		agent = await dependencies.runAgent({
			cwd: workspace.path,
			prompt: request.prompt,
			executable: request.codexExecutable,
			model: request.model,
			timeoutMs: request.timeoutMs,
			sandbox: request.sandbox,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		agent = {
			executable: request.codexExecutable?.trim() || "codex",
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

export type { AgentPatchCheckRequest, AgentPatchCheckResult, IsolatedWorkspace, PatchSnapshot } from "./types";
