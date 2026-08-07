import { Command } from "commander";

import { executeAgentPatchCheck } from "./execute";
import { validateTaskPolicy } from "./task-policy";
import type { AgentPatchCheckSandbox } from "./types";

function parseTimeout(value: string): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error("Timeout must be a positive integer in milliseconds.");
	}
	return parsed;
}

function parseSandbox(value: string): AgentPatchCheckSandbox {
	if (value === "read-only" || value === "workspace-write") {
		return value;
	}
	throw new Error('Sandbox must be "read-only" or "workspace-write".');
}

const program = new Command();
program
	.name("agentpatchcheck")
	.description("Run a controlled Codex patch task in an isolated Git worktree.")
	.requiredOption("--repo <path>", "Path to the local Git repository.")
	.requiredOption("--prompt <text>", "Task prompt passed to Codex.")
	.option("--base <ref>", "Base Git ref for the isolated worktree.", "HEAD")
	.option("--worktree-root <path>", "Managed worktree root under the repository.")
	.option("--run-id <id>", "Stable identifier for this run.")
	.option("--codex <path>", "Codex executable or command name.")
	.option("--model <id>", "Codex model override for the installed CLI.")
	.option("--timeout-ms <milliseconds>", "Execution timeout in milliseconds.", parseTimeout)
	.option("--sandbox <mode>", "Codex sandbox: read-only or workspace-write.", parseSandbox, "workspace-write")
	.option("--allow-network", "Allow Codex network access inside the workspace-write sandbox.")
	.action(async (options) => {
		const policy = await validateTaskPolicy({
			repositoryRoot: options.repo,
			prompt: options.prompt,
			baseRef: options.base,
			worktreeRoot: options.worktreeRoot,
			runId: options.runId,
			codexExecutable: options.codex,
			model: options.model,
			timeoutMs: options.timeoutMs,
			sandbox: options.sandbox,
			allowNetwork: options.allowNetwork === true,
		});
		const result = await executeAgentPatchCheck(policy);
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		if (result.status !== "succeeded") {
			process.exitCode = 1;
		}
	});

void program.parseAsync(process.argv);
