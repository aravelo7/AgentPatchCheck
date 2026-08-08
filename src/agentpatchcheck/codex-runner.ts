import { spawn } from "node:child_process";

import {
	buildWindowsCmdArgsCommandLine,
	resolveWindowsComSpec,
	shouldUseWindowsCmdLaunch,
} from "../core/windows-cmd-launch";
import { appendBoundedOutput } from "./bounded-output";
import type { AgentExecution, AgentPatchCheckSandbox } from "./types";

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1_000;
const OUTPUT_LIMIT_BYTES = 1_024 * 1_024;

export interface CodexLaunchPlan {
	executable: string;
	args: string[];
	windowsVerbatimArguments?: boolean;
}

export interface RunCodexOptions {
	cwd: string;
	prompt: string;
	executable?: string;
	model?: string;
	allowNetwork?: boolean;
	timeoutMs?: number;
	sandbox?: AgentPatchCheckSandbox;
	env?: NodeJS.ProcessEnv;
}

export function buildCodexLaunchPlan(options: {
	executable?: string;
	model?: string;
	allowNetwork?: boolean;
	cwd: string;
	prompt: string;
	sandbox?: AgentPatchCheckSandbox;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
}): CodexLaunchPlan {
	const executable = options.executable?.trim() || "codex";
	const sandbox = options.sandbox ?? "workspace-write";
	const args = [
		"exec",
		"--json",
		...(options.model ? ["--model", options.model] : []),
		"--config",
		`sandbox_workspace_write.network_access=${options.allowNetwork === true ? "true" : "false"}`,
		"--sandbox",
		sandbox,
		"-C",
		options.cwd,
		options.prompt,
	];
	const env = options.env ?? process.env;
	const platform = options.platform ?? process.platform;

	if (shouldUseWindowsCmdLaunch(executable, platform, env)) {
		const commandLine = buildWindowsCmdArgsCommandLine(executable, args);
		return {
			executable: resolveWindowsComSpec(env),
			args: ["/d", "/s", "/c", commandLine.slice("/d /s /c ".length)],
			windowsVerbatimArguments: true,
		};
	}

	return { executable, args };
}

export async function runCodex(options: RunCodexOptions): Promise<AgentExecution> {
	if (!options.prompt.trim()) {
		throw new Error("Agent prompt is required.");
	}
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
		throw new Error("Timeout must be a positive integer.");
	}

	const launch = buildCodexLaunchPlan(options);
	const startedAt = Date.now();
	return await new Promise<AgentExecution>((resolve, reject) => {
		const child = spawn(launch.executable, launch.args, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			windowsVerbatimArguments: launch.windowsVerbatimArguments,
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, timeoutMs);

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
				executable: launch.executable,
				args: launch.args,
				exitCode,
				signal,
				stdout,
				stderr,
				durationMs: Date.now() - startedAt,
				timedOut,
			});
		});
	});
}
