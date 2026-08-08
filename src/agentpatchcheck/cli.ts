import { Command } from "commander";

import { executeAgentPatchCheck } from "./execute";
import { validateTaskPolicy } from "./task-policy";
import { loadTaskSpec } from "./task-spec";

const program = new Command();
program
	.name("agentpatchcheck")
	.description("Run a controlled Codex patch task in an isolated Git worktree.")
	.requiredOption("--task-spec <path>", "Strict JSON TaskSpec containing the controlled task configuration.")
	.action(async (options) => {
		const policy = await validateTaskPolicy(await loadTaskSpec(options.taskSpec));
		const result = await executeAgentPatchCheck(policy);
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		if (result.status !== "succeeded" || result.assessment.report.verdict.status !== "pass") {
			process.exitCode = 1;
		}
	});

void program.parseAsync(process.argv);
