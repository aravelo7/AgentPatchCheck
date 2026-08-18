import { describe, expect, it } from "vitest";

import { selectPublicVerificationRepair } from "../../src/agentpatchcheck/public-verification-repair-policy";
import type { AgentExecution, CommandVerification } from "../../src/agentpatchcheck/types";

const completedAgent: AgentExecution = {
	executable: "harness-native",
	args: [],
	exitCode: 0,
	signal: null,
	stdout: "",
	stderr: "",
	durationMs: 1,
	timedOut: false,
};

const failedVerification: CommandVerification = {
	status: "failed",
	cwd: "D:\\worktree",
	commands: [
		{
			command: "node",
			args: ["test.mjs"],
			exitCode: 1,
			signal: null,
			stdout: "",
			stderr: "",
			durationMs: 1,
			timedOut: false,
		},
	],
};

describe("public verification repair policy", () => {
	it("permits one native repair only after normal completion and public verification failure", () => {
		expect(
			selectPublicVerificationRepair({
				agentAdapter: "harness-native",
				initialAgent: completedAgent,
				verification: failedVerification,
				remainingAgentBudgetMs: 100,
				initialPatch: { changedFiles: ["src/parse-port.js"] },
			}),
		).toEqual({
			eligible: true,
			reason: "public-verification-failed",
			initialChangedFiles: ["src/parse-port.js"],
		});
	});

	it.each([
		[
			"a timed-out initial execution",
			{ ...completedAgent, timedOut: true },
			failedVerification,
			100,
			"initial-agent-timed-out",
		],
		[
			"a failed initial execution",
			{ ...completedAgent, exitCode: 1 },
			failedVerification,
			100,
			"initial-agent-failed",
		],
		[
			"a successful public verification",
			completedAgent,
			{ ...failedVerification, status: "passed" as const },
			100,
			"public-verification-not-failed",
		],
		["an exhausted shared budget", completedAgent, failedVerification, 0, "agent-budget-exhausted"],
	] as const)(
		"does not repair after %s",
		(_description, initialAgent, verification, remainingAgentBudgetMs, reason) => {
			expect(
				selectPublicVerificationRepair({
					agentAdapter: "harness-native",
					initialAgent,
					verification,
					remainingAgentBudgetMs,
					initialPatch: null,
				}),
			).toMatchObject({ eligible: false, reason, initialChangedFiles: [] });
		},
	);
});
