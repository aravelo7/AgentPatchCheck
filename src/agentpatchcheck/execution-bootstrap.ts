import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";

import { appendBoundedOutput } from "./bounded-output";
import { sanitizedChildEnvironment } from "./child-process-environment";
import {
	type ExecutionBootstrapCacheContext,
	prepareExecutionBootstrapCache,
	publishExecutionBootstrapCache,
} from "./execution-bootstrap-cache";
import type { CommandVerificationResult, ExecutionBootstrapPolicy, ExecutionBootstrapResult } from "./types";

const OUTPUT_LIMIT_BYTES = 64 * 1024;

export function getWindowsNpmCliEntrypoint(): string | null {
	if (process.platform !== "win32") return null;
	const entrypoint = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
	return existsSync(entrypoint) ? entrypoint : null;
}

function launchNpmCommand(args: string[]) {
	const npmCliEntrypoint = getWindowsNpmCliEntrypoint();
	return npmCliEntrypoint === null
		? { executable: "npm", args }
		: { executable: process.execPath, args: [npmCliEntrypoint, ...args] };
}

async function runNpmCommand(options: {
	args: string[];
	cwd: string;
	timeoutMs: number;
}): Promise<CommandVerificationResult> {
	const startedAt = Date.now();
	// npm treats a non-development NODE_ENV as a production-style install in
	// some legacy projects. Bootstrap always needs declared dev dependencies.
	const env = { ...sanitizedChildEnvironment(), NODE_ENV: "development" };
	const launch = launchNpmCommand(options.args);
	return await new Promise((resolve) => {
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
			resolve(result);
		};
		const timeout = setTimeout(() => {
			timedOut = true;
			try {
				child.kill();
			} catch (error) {
				stderr = appendBoundedOutput(
					stderr,
					error instanceof Error ? error.message : String(error),
					OUTPUT_LIMIT_BYTES,
				);
			}
			finish({
				command: "npm",
				args: options.args,
				exitCode: null,
				signal: null,
				stdout,
				stderr: appendBoundedOutput(stderr, "Bootstrap command timed out.", OUTPUT_LIMIT_BYTES),
				durationMs: Date.now() - startedAt,
				timedOut,
			});
		}, options.timeoutMs);
		child.stdout?.on("data", (chunk: Buffer | string) => {
			stdout = appendBoundedOutput(stdout, chunk, OUTPUT_LIMIT_BYTES);
		});
		child.stderr?.on("data", (chunk: Buffer | string) => {
			stderr = appendBoundedOutput(stderr, chunk, OUTPUT_LIMIT_BYTES);
		});
		child.once("error", (error) => {
			finish({
				command: "npm",
				args: options.args,
				exitCode: null,
				signal: null,
				stdout,
				stderr: appendBoundedOutput(stderr, error.message, OUTPUT_LIMIT_BYTES),
				durationMs: Date.now() - startedAt,
				timedOut,
			});
		});
		child.once("close", (exitCode, signal) => {
			finish({
				command: "npm",
				args: options.args,
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

/**
 * Prepares dependencies only inside the freshly-created isolated worktree.
 * This deliberately accepts one version-pinned npm install shape instead of
 * permitting arbitrary setup commands from a task definition.
 */
export async function runExecutionBootstrap(
	bootstrap: ExecutionBootstrapPolicy | null,
	worktreePath: string,
	cacheContext?: ExecutionBootstrapCacheContext,
): Promise<ExecutionBootstrapResult | null> {
	if (bootstrap === null) return null;
	if (process.version !== bootstrap.nodeVersion) {
		return {
			status: "failed",
			worktreePath,
			nodeVersion: process.version,
			npmVersion: null,
			npmInstall: null,
			cache: { status: "not-used", fingerprint: null, durationMs: 0, diagnostic: null },
			diagnostic: "Configured Node version is unavailable.",
		};
	}
	const npmVersionResult = await runNpmCommand({
		args: ["--version"],
		cwd: worktreePath,
		timeoutMs: bootstrap.timeoutMs,
	});
	const npmVersion =
		npmVersionResult.exitCode === 0 && !npmVersionResult.timedOut ? npmVersionResult.stdout.trim() : null;
	if (npmVersion !== bootstrap.npmVersion) {
		return {
			status: "failed",
			worktreePath,
			nodeVersion: process.version,
			npmVersion,
			npmInstall: null,
			cache: { status: "not-used", fingerprint: null, durationMs: 0, diagnostic: null },
			diagnostic: "Configured npm version is unavailable.",
		};
	}
	const preparedCache = await prepareExecutionBootstrapCache({ bootstrap, context: cacheContext, worktreePath });
	if (preparedCache.result.status === "hit") {
		return {
			status: "succeeded",
			worktreePath,
			nodeVersion: process.version,
			npmVersion,
			npmInstall: null,
			cache: preparedCache.result,
			diagnostic: null,
		};
	}
	const npmInstall = await runNpmCommand({
		args: ["--prefix", worktreePath, "install", "--legacy-peer-deps", "--no-package-lock"],
		cwd: worktreePath,
		timeoutMs: bootstrap.timeoutMs,
	});
	let dependenciesPresent = false;
	if (npmInstall.exitCode === 0 && !npmInstall.timedOut) {
		try {
			await access(join(worktreePath, "node_modules"));
			dependenciesPresent = true;
		} catch {
			dependenciesPresent = false;
		}
	}
	const cachePublishDiagnostic = dependenciesPresent
		? await publishExecutionBootstrapCache({ cacheDirectory: preparedCache.cacheDirectory, worktreePath })
		: null;
	return {
		status: dependenciesPresent ? "succeeded" : "failed",
		worktreePath,
		nodeVersion: process.version,
		npmVersion,
		npmInstall,
		cache: {
			...preparedCache.result,
			diagnostic: preparedCache.result.diagnostic ?? cachePublishDiagnostic,
		},
		diagnostic: dependenciesPresent ? null : "Isolated worktree dependency bootstrap failed.",
	};
}
