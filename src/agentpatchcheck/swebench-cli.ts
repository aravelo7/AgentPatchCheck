import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getGitStdout } from "../workspace/git-utils";
import { findAgentPatchCheckProjectRoot, initializeAgentPatchCheckEnvironment } from "./project-environment";
import {
	AGENTPATCHCHECK_BASELINE_COMMIT,
	runSWEbenchInstance,
	SWE_BENCH_MULTILINGUAL_DATASET,
} from "./swebench-adapter";

interface CliOptions {
	dataset: string;
	instance: string;
	repository: string;
	output: string;
	modelNameOrPath: string;
	runId?: string;
	variant?: string;
	attempt?: number;
}

function optionValue(argv: string[], name: string, required = true): string | undefined {
	const index = argv.indexOf(name);
	if (index === -1) {
		if (required) throw new Error(`Missing required option: ${name}`);
		return undefined;
	}
	const value = argv[index + 1];
	if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for option: ${name}`);
	return value;
}

function parseOptions(argv: string[]): CliOptions {
	return {
		dataset: optionValue(argv, "--dataset") as string,
		instance: optionValue(argv, "--instance") as string,
		repository: optionValue(argv, "--repository") as string,
		output: optionValue(argv, "--output") as string,
		modelNameOrPath:
			optionValue(argv, "--model-name-or-path", false) ??
			`agentpatchcheck/${AGENTPATCHCHECK_BASELINE_COMMIT}/deepseek-v4-pro`,
		runId: optionValue(argv, "--run-id", false),
		variant: optionValue(argv, "--variant", false),
		attempt: (() => {
			const value = optionValue(argv, "--attempt", false);
			if (value === undefined) return undefined;
			const parsed = Number(value);
			if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("--attempt must be a positive integer.");
			return parsed;
		})(),
	};
}

export async function runSWEbenchCli(argv = process.argv.slice(2)): Promise<void> {
	initializeAgentPatchCheckEnvironment();
	const options = parseOptions(argv);
	const projectRoot = findAgentPatchCheckProjectRoot();
	const sourceCommit = await getGitStdout(["rev-parse", "HEAD"], projectRoot);
	if (sourceCommit !== AGENTPATCHCHECK_BASELINE_COMMIT) {
		throw new Error(
			`SWE-bench smoke must run from APC baseline ${AGENTPATCHCHECK_BASELINE_COMMIT}; current HEAD is ${sourceCommit}.`,
		);
	}
	const result = await runSWEbenchInstance({
		datasetPath: options.dataset,
		instanceId: options.instance,
		repositoryRoot: options.repository,
		outputPath: options.output,
		modelNameOrPath: options.modelNameOrPath,
		runId: options.runId,
		variant: options.variant,
		attempt: options.attempt,
	});
	const summaryPath = resolve(dirname(result.predictionPath), `${result.runId}.apc-run.json`);
	await writeFile(
		summaryPath,
		`${JSON.stringify(
			{
				version: 1,
				dataset: SWE_BENCH_MULTILINGUAL_DATASET,
				apcBaselineCommit: sourceCommit,
				instanceId: result.instance.instance_id,
				baseCommit: result.instance.base_commit,
				runId: result.runId,
				runIdentity: result.runIdentity,
				repository: result.instance.repo,
				model: result.runIdentity.model,
				workspacePath: result.workspace.path,
				runtimeRecordPath: result.runtimeRecordPath,
				agent: {
					exitCode: result.agent.exitCode,
					signal: result.agent.signal,
					timedOut: result.agent.timedOut,
					durationMs: result.agent.durationMs,
					terminationReason: result.agent.runtime?.terminationReason ?? null,
				},
				mutationOccurred: result.mutationOccurred,
				changedFiles: result.changedFiles,
				modelPatchBytes: Buffer.byteLength(result.prediction.model_patch, "utf8"),
				predictionPath: result.predictionPath,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	process.stdout.write(`${JSON.stringify({ ...result.prediction, model_patch: undefined, summaryPath })}\n`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	void runSWEbenchCli().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
