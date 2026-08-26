import { spawn } from "node:child_process";

import { appendBoundedOutput } from "./bounded-output";
import { sanitizedChildEnvironment } from "./child-process-environment";
import { terminateCodexProcess } from "./codex-runner";
import { getWindowsNpmCliEntrypoint } from "./execution-bootstrap";
import type {
	CommandVerification,
	CommandVerificationResult,
	PublicVerificationFeedback,
	VerificationCommand,
	VerificationPolicy,
} from "./types";

export { sanitizedChildEnvironment as sanitizedVerificationEnvironment } from "./child-process-environment";

function launchVerificationCommand(command: string, args: string[]) {
	if (command.toLowerCase() === "npm") {
		const npmCliEntrypoint = getWindowsNpmCliEntrypoint();
		if (npmCliEntrypoint !== null) return { executable: process.execPath, args: [npmCliEntrypoint, ...args] };
	}
	return { executable: command, args };
}

/**
 * Executes one already-validated public verification command without a shell.
 * Its child environment deliberately excludes credential-shaped variables so
 * workspace code cannot inherit provider credentials during Agent self-checks.
 */
export async function runVerificationCommand(options: {
	command: VerificationCommand;
	cwd: string;
	outputLimitBytes: number;
	/** DSH Code Mode cancellation; ordinary Native verification leaves this unset. */
	signal?: AbortSignal;
}): Promise<CommandVerificationResult> {
	const startedAt = Date.now();
	return await new Promise<CommandVerificationResult>((resolve) => {
		const env = sanitizedChildEnvironment();
		const launch = launchVerificationCommand(options.command.command, options.command.args);
		const child = spawn(launch.executable, launch.args, {
			cwd: options.cwd,
			env,
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
			options.signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const onAbort = (): void => terminateCodexProcess(child);
		const timeout = setTimeout(() => {
			timedOut = true;
			if (options.signal === undefined) child.kill();
			else terminateCodexProcess(child);
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
		if (options.signal?.aborted) onAbort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });
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

/**
 * Deliberately excludes command output and arguments: public-verifier feedback
 * may be shown to a model, while raw verifier output can contain credentials.
 */
export function createPublicVerificationFeedback(verification: CommandVerification): PublicVerificationFeedback | null {
	if (verification.status !== "failed") return null;
	const failed = verification.commands.at(-1);
	if (failed === undefined) return null;
	return {
		version: 1,
		status: "failed",
		summary:
			"Harness-owned public verification failed. Inspect the managed workspace and make one targeted repair. Hidden Oracle results are unavailable.",
		commands: [
			{
				command: failed.command,
				exitCode: failed.exitCode,
				signal: failed.signal,
				timedOut: failed.timedOut,
			},
		],
	};
}
