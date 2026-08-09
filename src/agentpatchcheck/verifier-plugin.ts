import type { CommandVerification, VerifierPluginResult } from "./types";

export interface VerifierPlugin<Config, Context> {
	id: string;
	kind: VerifierPluginResult["kind"];
	execute: (config: Config, context: Context) => Promise<VerifierPluginResult>;
}

function commandDiagnostic(verification: CommandVerification): string | null {
	const command = verification.commands.at(-1);
	if (command === undefined) return null;
	if (command.timedOut) return "Verification command timed out.";
	if (command.exitCode === null) return "Verification command could not start.";
	if (command.exitCode !== 0) return `Verification command exited with code ${command.exitCode}.`;
	return null;
}

export function summarizeCommandVerification(verification: CommandVerification): VerifierPluginResult {
	const durationMs = verification.commands.reduce((total, command) => total + command.durationMs, 0);
	const lastCommand = verification.commands.at(-1);
	if (verification.status === "not-run") {
		return {
			id: "command-verification",
			kind: "command",
			status: "not-run",
			durationMs,
			exitCode: null,
			signal: null,
			diagnostic: null,
		};
	}
	if (verification.status === "passed") {
		return {
			id: "command-verification",
			kind: "command",
			status: "passed",
			durationMs,
			exitCode: lastCommand?.exitCode ?? 0,
			signal: lastCommand?.signal ?? null,
			diagnostic: null,
		};
	}
	return {
		id: "command-verification",
		kind: "command",
		status: lastCommand?.timedOut ? "timed-out" : lastCommand?.exitCode === null ? "error" : "failed",
		durationMs,
		exitCode: lastCommand?.exitCode ?? null,
		signal: lastCommand?.signal ?? null,
		diagnostic: commandDiagnostic(verification),
	};
}
