import { Command } from "commander";

import { assessEvidenceBundle } from "./assessment-report";
import { cleanupEvidenceWorktree } from "./cleanup";
import { listEvidenceBundles } from "./evidence-list";
import { showEvidenceBundle } from "./evidence-show";
import { executeAgentPatchCheck } from "./execute";
import { validateTaskPolicy } from "./task-policy";
import { loadTaskSpec } from "./task-spec";

const program = new Command();
program.name("agentpatchcheck").description("Run and assess controlled Codex patch tasks in isolated Git worktrees.");

program
	.command("run")
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

program
	.command("assess")
	.description("Assess an existing EvidenceBundle without launching an agent or creating a worktree.")
	.requiredOption("--evidence <path>", "Path to a persisted EvidenceBundle JSON file.")
	.action(async (options) => {
		const result = await assessEvidenceBundle({ evidencePath: options.evidence });
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		if (result.report.verdict.status !== "pass") {
			process.exitCode = 1;
		}
	});

program
	.command("cleanup")
	.description("Dry-run or remove an assessed managed worktree while preserving its evidence.")
	.requiredOption("--evidence <path>", "Path to a persisted EvidenceBundle JSON file.")
	.option("--apply", "Remove the worktree after all cleanup safety checks pass.")
	.action(async (options) => {
		const result = await cleanupEvidenceWorktree({ evidencePath: options.evidence, apply: options.apply === true });
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	});

program
	.command("list")
	.description("List persisted Headless Core evidence for one local Git repository.")
	.requiredOption("--repository <path>", "Git repository root containing .agentpatchcheck evidence.")
	.action(async (options) => {
		const result = await listEvidenceBundles({ repositoryPath: options.repository });
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	});

program
	.command("show")
	.description("Show a concise, read-only summary of one persisted Headless Core run.")
	.requiredOption("--evidence <path>", "Path to a persisted EvidenceBundle JSON file.")
	.action(async (options) => {
		const result = await showEvidenceBundle({ evidencePath: options.evidence });
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
	});

void program.parseAsync(process.argv);
