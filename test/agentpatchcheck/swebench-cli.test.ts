import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { RunIdentity } from "../../src/agentpatchcheck/run-identity";
import {
	AGENTPATCHCHECK_BASELINE_COMMIT,
	type SWEbenchAdapterResult,
} from "../../src/agentpatchcheck/swebench-adapter";
import { runSWEbenchCli, type SWEbenchGradingResult } from "../../src/agentpatchcheck/swebench-cli";
import type { AgentExecution, IsolatedWorkspace } from "../../src/agentpatchcheck/types";

const instance = {
	instance_id: "gin-gonic__gin-2755",
	repo: "gin-gonic/gin",
	base_commit: "f2bbdfe9f26d84cb994f381050692a9e4553bf75",
	problem_statement: "Fix the HandleContext panic.",
};

const runIdentity: RunIdentity = {
	version: 1,
	experiment: "swe-bench/SWE-Bench_Multilingual",
	task: instance.instance_id,
	variant: "apc/test-model",
	attempt: 1,
	repository: instance.repo,
	baseCommit: instance.base_commit,
	model: "test-model",
	benchmark: "swe-bench/SWE-Bench_Multilingual",
};

function execution(overrides: Partial<AgentExecution> = {}): AgentExecution {
	return {
		executable: "agent",
		args: [],
		exitCode: 0,
		signal: null,
		stdout: "",
		stderr: "",
		durationMs: 1,
		timedOut: false,
		...overrides,
	};
}

function adapterResult(
	root: string,
	predictionPath: string | null,
	prediction: SWEbenchAdapterResult["prediction"],
	agent: AgentExecution,
	predictionError: SWEbenchAdapterResult["predictionError"] = null,
): SWEbenchAdapterResult {
	const workspace: IsolatedWorkspace = {
		runId: "swebench-cli-test",
		repositoryPath: root,
		path: join(root, "worktree"),
		baseRef: instance.base_commit,
		baseCommit: instance.base_commit,
	};
	return {
		instance,
		runId: "swebench-cli-test",
		runIdentity,
		workspace,
		agent,
		mutationOccurred: prediction !== null,
		changedFiles: prediction === null ? [] : ["gin.go"],
		prediction,
		predictionPath,
		predictionError,
		runtimeRecordPath: join(root, "runtime.jsonl"),
	};
}

function argumentsFor(root: string, outputPath: string): string[] {
	return [
		"--dataset",
		join(root, "dataset.jsonl"),
		"--instance",
		instance.instance_id,
		"--repository",
		join(root, "repository"),
		"--output",
		outputPath,
		"--model-name-or-path",
		"apc/test-model",
		"--run-id",
		"swebench-cli-test",
		"--evaluator-python",
		"evaluator-python",
		"--evaluator-source-root",
		join(root, "official-evaluator"),
		"--evaluator-artifact-root",
		join(root, "grading-artifacts"),
		"--evaluator-timeout-seconds",
		"120",
	];
}

function resolvedGrading(normalizedStatus: SWEbenchGradingResult["normalizedStatus"]): SWEbenchGradingResult {
	return {
		version: 2,
		instanceId: instance.instance_id,
		normalizedStatus,
		reason: `official_${normalizedStatus}`,
		officialReportPath: "/official/report.json",
		officialRunId: "official-run-1",
		evaluatorVersion: "official-v1",
	};
}

describe("SWE-bench CLI post-run orchestration", () => {
	it("executes Agent, writes a standard prediction, then evaluates a timeout with a valid patch", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-cli-"));
		const outputPath = join(root, "predictions.jsonl");
		const order: string[] = [];
		const prediction = {
			instance_id: instance.instance_id,
			model_name_or_path: "apc/test-model",
			model_patch: "diff --git a/gin.go b/gin.go\n",
		};

		await runSWEbenchCli(argumentsFor(root, outputPath), {
			initializeEnvironment: () => "already-loaded",
			findProjectRoot: () => root,
			getGitStdout: async () => AGENTPATCHCHECK_BASELINE_COMMIT,
			loadInstance: async () => instance,
			runInstance: async (options) => {
				order.push("executeAgent", "collectPatch");
				expect(options).toEqual({
					instance,
					repositoryRoot: join(root, "repository"),
					outputPath,
					modelNameOrPath: "apc/test-model",
					runId: "swebench-cli-test",
					variant: undefined,
					attempt: undefined,
				});
				await writeFile(outputPath, `${JSON.stringify(prediction)}\n`, "utf8");
				order.push("writePrediction");
				return adapterResult(root, outputPath, prediction, execution({ timedOut: true, exitCode: null }));
			},
			runPostRunEvaluator: async (input) => {
				order.push("evaluator");
				expect(input.datasetPath).toBe(join(root, "dataset.jsonl"));
				expect(input.instanceId).toBe(instance.instance_id);
				expect(JSON.parse((await readFile(input.predictionPath, "utf8")).trim())).toEqual(prediction);
				return resolvedGrading("resolved");
			},
		});

		expect(order).toEqual(["executeAgent", "collectPatch", "writePrediction", "evaluator"]);
		const grading = JSON.parse(await readFile(join(root, "swebench-cli-test.swebench-grading.json"), "utf8"));
		const summary = JSON.parse(await readFile(join(root, "swebench-cli-test.apc-run.json"), "utf8"));
		expect(grading).toMatchObject({ normalizedStatus: "resolved", officialRunId: "official-run-1" });
		expect(summary).toMatchObject({
			agent: { status: "timeout", timedOut: true },
			grading: { normalizedStatus: "resolved" },
			predictionPath: outputPath,
		});
	});

	it("writes not_run without invoking the evaluator when a legal prediction cannot be produced", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-cli-"));
		const outputPath = join(root, "predictions.jsonl");
		let evaluatorInvoked = false;

		await runSWEbenchCli(argumentsFor(root, outputPath), {
			initializeEnvironment: () => "already-loaded",
			findProjectRoot: () => root,
			getGitStdout: async () => AGENTPATCHCHECK_BASELINE_COMMIT,
			loadInstance: async () => instance,
			runInstance: async () => adapterResult(root, null, null, execution(), "prediction_export_failed"),
			runPostRunEvaluator: async () => {
				evaluatorInvoked = true;
				return resolvedGrading("resolved");
			},
		});

		const grading = JSON.parse(await readFile(join(root, "swebench-cli-test.swebench-grading.json"), "utf8"));
		const summary = JSON.parse(await readFile(join(root, "swebench-cli-test.apc-run.json"), "utf8"));
		expect(evaluatorInvoked).toBe(false);
		expect(grading).toMatchObject({ normalizedStatus: "not_run", reason: "prediction_export_failed" });
		expect(summary).toMatchObject({
			agent: { status: "completed" },
			grading: { normalizedStatus: "not_run" },
			predictionPath: null,
			predictionError: "prediction_export_failed",
		});
	});

	it("keeps evaluator infrastructure and ambiguous outcomes out of Agent execution state", async () => {
		for (const normalizedStatus of ["infrastructure_error", "grading_error_or_ambiguous"] as const) {
			const root = await mkdtemp(join(tmpdir(), "apc-swebench-cli-"));
			const outputPath = join(root, "predictions.jsonl");
			const prediction = {
				instance_id: instance.instance_id,
				model_name_or_path: "apc/test-model",
				model_patch: "diff --git a/gin.go b/gin.go\n",
			};
			const agent = execution();
			await writeFile(outputPath, `${JSON.stringify(prediction)}\n`, "utf8");

			await runSWEbenchCli(argumentsFor(root, outputPath), {
				initializeEnvironment: () => "already-loaded",
				findProjectRoot: () => root,
				getGitStdout: async () => AGENTPATCHCHECK_BASELINE_COMMIT,
				loadInstance: async () => instance,
				runInstance: async () => adapterResult(root, outputPath, prediction, agent),
				runPostRunEvaluator: async () => resolvedGrading(normalizedStatus),
			});

			const summary = JSON.parse(await readFile(join(root, "swebench-cli-test.apc-run.json"), "utf8"));
			expect(agent).toEqual(execution());
			expect(summary).toMatchObject({
				agent: { status: "completed" },
				grading: { normalizedStatus },
			});
		}
	});
});
