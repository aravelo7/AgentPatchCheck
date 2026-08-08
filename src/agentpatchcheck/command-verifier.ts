import { spawn } from "node:child_process";

import { appendBoundedOutput } from "./bounded-output";
import type { CommandVerification, CommandVerificationResult, VerificationCommand, VerificationPolicy } from "./types";

async function runVerificationCommand(options: {
	command: VerificationCommand;
	cwd: string;
	outputLimitBytes: number;
}): Promise<CommandVerificationResult> {
	const startedAt = Date.now();
	return await new Promise<CommandVerificationResult>((resolve) => {
		const child = spawn(options.command.command, options.command.args, {
			cwd: options.cwd,
			env: process.env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		const finish = (result: CommandVerificationResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve(result);
		};
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, options.command.timeoutMs);

		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout = appendBoundedOutput(stdout, chunk, options.outputLimitBytes);
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr = appendBoundedOutput(stderr, chunk, options.outputLimitBytes);
		});
		child.once("error", (error) => {
			finish({
				command: options.command.command,
				args: options.command.args,
				exitCode: null,
				signal: null,
				stdout,
				stderr: appendBoundedOutput(stderr, error.message, options.outputLimitBytes),
				durationMs: Date.now() - startedAt,
				timedOut,
			});
		});
		child.once("close", (exitCode, signal) => {
			finish({
				command: options.command.command,
				args: options.command.args,
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

function commandSucceeded(result: CommandVerificationResult): boolean {
	return result.exitCode === 0 && !result.timedOut;
}

export async function runCommandVerification(policy: VerificationPolicy, cwd: string): Promise<CommandVerification> {
	if (policy.commands.length === 0) {
		return { status: "not-run", cwd, commands: [] };
	}

	const commands: CommandVerificationResult[] = [];
	for (const command of policy.commands) {
		const result = await runVerificationCommand({
			command,
			cwd,
			outputLimitBytes: policy.outputLimitBytes,
		});
		commands.push(result);
		if (!commandSucceeded(result)) {
			return { status: "failed", cwd, commands };
		}
	}
	return { status: "passed", cwd, commands };
}
