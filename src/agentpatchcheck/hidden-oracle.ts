import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";

import type { HiddenOraclePolicy, VerifierPluginResult } from "./types";
import type { VerifierPlugin } from "./verifier-plugin";

export const HIDDEN_ORACLE_WORKTREE_ENV = "AGENTPATCHCHECK_ORACLE_WORKTREE";

export const hiddenOracleVerifierPlugin: VerifierPlugin<HiddenOraclePolicy, { worktreePath: string }> = {
	id: "hidden-oracle",
	kind: "hidden-oracle",
	execute: async (oracle, context) => {
		const startedAt = Date.now();
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
			};
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
				child.kill();
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
