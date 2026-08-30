import { spawn } from "node:child_process";

import { appendBoundedOutput } from "./bounded-output";
import { createClineRuntimeAdapter } from "./cline-runtime-adapter";
import { ProcessTreeTerminationError, runCodex, terminateCodexProcess } from "./codex-runner";
import {
	createHarnessNativeRuntime,
	type HarnessNativeModelProvider,
	type HarnessNativeRepositoryPrimitives,
} from "./harness-native-runtime";
import type { AgentAdapterId, AgentExecution, RepairContext, TaskPolicy } from "./types";

const OUTPUT_LIMIT_BYTES = 1_024 * 1_024;
export const SCRIPT_ADAPTER_WORKTREE_ENV = "AGENTPATCHCHECK_AGENT_WORKTREE";

export interface AgentAdapterContext {
	policy: TaskPolicy;
	worktreePath: string;
	signal?: AbortSignal;
	repository?: HarnessNativeRepositoryPrimitives;
	repairContext: RepairContext;
}

export async function executeAgentAdapterUnderDeadline(
	adapter: AgentAdapter,
	context: Omit<AgentAdapterContext, "signal">,
): Promise<AgentExecution> {
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(new Error(`Agent wall-clock deadline reached (${context.policy.timeoutMs}ms).`)),
		context.policy.timeoutMs,
	);
	try {
		const execution = await adapter.execute({ ...context, signal: controller.signal });
		if (controller.signal.aborted && !execution.timedOut)
			throw new ProcessTreeTerminationError("Agent wall cancellation did not produce a confirmed timeout terminal.");
		return execution;
	} catch (error) {
		if (controller.signal.aborted && !(error instanceof ProcessTreeTerminationError))
			throw new ProcessTreeTerminationError(
				"Agent wall cancellation cleanup could not be confirmed before terminal handling.",
				{ cause: error },
			);
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

export interface AgentAdapter {
	id: AgentAdapterId;
	execute: (context: AgentAdapterContext) => Promise<AgentExecution>;
}

const codexAdapter: AgentAdapter = {
	id: "codex",
	execute: async ({ policy, worktreePath }) =>
		await runCodex({
			cwd: worktreePath,
			prompt: policy.prompt,
			executable: policy.codexExecutable,
			model: policy.model,
			timeoutMs: policy.timeoutMs,
			sandbox: policy.sandbox,
			allowNetwork: policy.allowNetwork,
		}),
};

const scriptAdapter: AgentAdapter = {
	id: "script",
	execute: async ({ policy, worktreePath }) => {
		if (policy.agentScript === null) throw new Error("Script Adapter requires a validated agent script.");
		const scriptPath = policy.agentScript;
		const startedAt = Date.now();
		return await new Promise<AgentExecution>((resolve, reject) => {
			const child = spawn(process.execPath, [scriptPath], {
				cwd: worktreePath,
				env: { ...process.env, [SCRIPT_ADAPTER_WORKTREE_ENV]: worktreePath },
				stdio: "pipe",
				windowsHide: true,
			});
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			const timeout = setTimeout(() => {
				timedOut = true;
				terminateCodexProcess(child);
			}, policy.timeoutMs);
			child.stdout?.on("data", (chunk: Buffer | string) => {
				stdout = appendBoundedOutput(stdout, chunk, OUTPUT_LIMIT_BYTES);
			});
			child.stderr?.on("data", (chunk: Buffer | string) => {
				stderr = appendBoundedOutput(stderr, chunk, OUTPUT_LIMIT_BYTES);
			});
			child.once("error", (error) => {
				clearTimeout(timeout);
				reject(error);
			});
			child.once("close", (exitCode, signal) => {
				clearTimeout(timeout);
				resolve({
					executable: process.execPath,
					args: [scriptPath],
					exitCode,
					signal,
					stdout,
					stderr,
					durationMs: Date.now() - startedAt,
					timedOut,
				});
			});
		});
	},
};

export function createHarnessNativeAdapter(provider?: HarnessNativeModelProvider): AgentAdapter {
	return provider === undefined ? createHarnessNativeRuntime() : createHarnessNativeRuntime(provider);
}

const harnessNativeAdapter = createHarnessNativeAdapter();
const clineRuntimeAdapter = createClineRuntimeAdapter();

const adapters = new Map<AgentAdapterId, AgentAdapter>([
	[codexAdapter.id, codexAdapter],
	[scriptAdapter.id, scriptAdapter],
	[harnessNativeAdapter.id, harnessNativeAdapter],
	[clineRuntimeAdapter.id, clineRuntimeAdapter],
]);

export function getAgentAdapter(id: AgentAdapterId): AgentAdapter {
	const adapter = adapters.get(id);
	if (adapter === undefined) throw new Error(`Unsupported Agent Adapter: ${id}`);
	return adapter;
}
