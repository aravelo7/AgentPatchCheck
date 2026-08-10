import { type ChildProcess, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProcessTreeKiller } from "./codex-runner";
import { terminateCodexProcess } from "./codex-runner";
import type {
	HiddenOracleIsolationCapability,
	HiddenOracleIsolationLevel,
	HiddenOraclePolicy,
	VerifierPluginResult,
} from "./types";
import type { VerifierPlugin } from "./verifier-plugin";
import { getWindowsJobCapability, runWindowsJob } from "./windows-job-backend";

export const HIDDEN_ORACLE_WORKTREE_ENV = "AGENTPATCHCHECK_ORACLE_WORKTREE";

export function probeHiddenOracleIsolation(
	requested: HiddenOracleIsolationLevel,
	platform: NodeJS.Platform = process.platform,
): HiddenOracleIsolationCapability {
	if (requested === "none") {
		return { version: 1, requested, platform, available: true, backend: "none", reason: null };
	}
	return {
		version: 1,
		requested,
		platform,
		available: false,
		backend: null,
		reason: "No verified OS isolation backend is configured for this platform.",
	};
}

export function terminateHiddenOracleProcess(
	child: Pick<ChildProcess, "pid" | "kill">,
	platform: NodeJS.Platform = process.platform,
	killTree?: ProcessTreeKiller,
): void {
	terminateCodexProcess(child, platform, killTree);
}

export const hiddenOracleVerifierPlugin: VerifierPlugin<HiddenOraclePolicy, { worktreePath: string }> = {
	id: "hidden-oracle",
	kind: "hidden-oracle",
	execute: async (oracle, context) => {
		const startedAt = Date.now();
		const isolation =
			oracle.isolation === "process"
				? await getWindowsJobCapability(oracle)
				: probeHiddenOracleIsolation(oracle.isolation);
		if (!isolation.available) {
			return {
				id: "hidden-oracle",
				kind: "hidden-oracle",
				status: "error",
				durationMs: Date.now() - startedAt,
				exitCode: null,
				signal: null,
				diagnostic: "Requested Hidden Oracle isolation is unavailable.",
				isolation,
			};
		}
		try {
			if (!(await stat(oracle.scriptPath)).isFile()) throw new Error("Hidden Oracle script is unavailable.");
		} catch {
			return {
				id: "hidden-oracle",
				kind: "hidden-oracle",
				status: "error",
				durationMs: Date.now() - startedAt,
				exitCode: null,
				signal: null,
				diagnostic: "Hidden Oracle infrastructure is unavailable.",
				isolation,
			};
		}
		if (isolation.backend === "windows-job") {
			try {
				const result = await runWindowsJob(oracle, context.worktreePath);
				const completedIsolation = {
					...isolation,
					execution: {
						terminationReason: result.terminationReason,
						resourceLimitsApplied: result.status !== "error",
					},
				};
				return {
					id: "hidden-oracle",
					kind: "hidden-oracle",
					status:
						result.status === "timed-out"
							? "timed-out"
							: result.status === "exited"
								? result.exitCode === 0
									? "passed"
									: result.exitCode === 1
										? "failed"
										: "error"
								: "error",
					durationMs: Date.now() - startedAt,
					exitCode: result.status === "exited" ? result.exitCode : null,
					signal: null,
					diagnostic:
						result.status === "timed-out"
							? "Hidden Oracle timed out."
							: result.status === "exited"
								? result.exitCode === 0
									? null
									: result.exitCode === 1
										? "Hidden Oracle rejected the patch."
										: "Hidden Oracle infrastructure failed."
								: "Hidden Oracle infrastructure failed.",
					isolation: completedIsolation,
				};
			} catch {
				return {
					id: "hidden-oracle",
					kind: "hidden-oracle",
					status: "error",
					durationMs: Date.now() - startedAt,
					exitCode: null,
					signal: null,
					diagnostic: "Hidden Oracle infrastructure is unavailable.",
					isolation,
				};
			}
		}
		return await new Promise((resolve) => {
			const child = spawn(process.execPath, [oracle.scriptPath], {
				cwd: dirname(oracle.scriptPath),
				env: { ...process.env, [HIDDEN_ORACLE_WORKTREE_ENV]: context.worktreePath },
				stdio: "ignore",
				windowsHide: true,
			});
			let timedOut = false;
			let settled = false;
			const finish = (result: VerifierPluginResult) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				resolve(result);
			};
			const timeout = setTimeout(() => {
				timedOut = true;
				terminateHiddenOracleProcess(child);
			}, oracle.timeoutMs);
			child.once("error", () => {
				finish({
					id: "hidden-oracle",
					kind: "hidden-oracle",
					status: "error",
					durationMs: Date.now() - startedAt,
					exitCode: null,
					signal: null,
					diagnostic: "Hidden Oracle could not start.",
					isolation,
				});
			});
			child.once("close", (exitCode, signal) => {
				finish({
					id: "hidden-oracle",
					kind: "hidden-oracle",
					status: timedOut ? "timed-out" : exitCode === 0 ? "passed" : exitCode === 1 ? "failed" : "error",
					durationMs: Date.now() - startedAt,
					exitCode,
					signal,
					diagnostic: timedOut
						? "Hidden Oracle timed out."
						: exitCode === 0
							? null
							: exitCode === 1
								? "Hidden Oracle rejected the patch."
								: "Hidden Oracle infrastructure failed.",
					isolation,
				});
			});
		});
	},
};

export async function runHiddenOracle(
	oracle: HiddenOraclePolicy | null,
	worktreePath: string,
): Promise<VerifierPluginResult | null> {
	return oracle === null ? null : await hiddenOracleVerifierPlugin.execute(oracle, { worktreePath });
}
