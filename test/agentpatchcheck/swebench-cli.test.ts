import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { RunIdentity } from "../../src/agentpatchcheck/run-identity";
import {
	SWE_BENCH_STANDARD_BASELINE_TAG,
	createSWEbenchRuntimeConfiguration,
	resolveDevelopmentVerification,
	type SWEbenchAdapterResult,
} from "../../src/agentpatchcheck/swebench-adapter";
import { getHarnessNativeAvailableTools } from "../../src/agentpatchcheck/harness-native-runtime";
import {
	loadSWEbenchBootstrapConfiguration,
	runSWEbenchCli,
	SWEbenchEvaluatorPreflightError,
	preflightSWEbenchEvaluator,
	type SWEbenchBootstrapConfiguration,
	type SWEbenchGradingResult,
} from "../../src/agentpatchcheck/swebench-cli";
import type { AgentExecution, IsolatedWorkspace, VerificationPolicy } from "../../src/agentpatchcheck/types";

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
		failure: null,
		runtimeRecordPath: join(root, "runtime.jsonl"),
	};
}

const evaluatorRevision = "b".repeat(40);

function bootstrapConfiguration(root: string, overrides: Partial<SWEbenchBootstrapConfiguration> = {}): SWEbenchBootstrapConfiguration {
	return {
		manifestPath: join(root, "APC-Pilot-10-v1.manifest.json"),
		manifestName: "APC-Pilot-10",
		manifestVersion: "v1",
		datasetPath: join(root, "agent-safe-dataset.jsonl"),
		evaluatorDatasetPath: join(root, "official-dataset.jsonl"),
		evaluatorRevision,
		evaluatorTimeoutSeconds: 120,
		evaluatorSourceRoot: join(root, "official-evaluator"),
		evaluatorPythonPath: join(root, "evaluator-python"),
		deepseekModel: "deepseek-v4-flash",
		classification: "engineering-validation",
		engineeringValidation: true,
		instanceIds: [instance.instance_id],
		...overrides,
	};
}

function outputDirectoryFor(root: string): string {
	return join(root, ".agentpatchcheck", "swebench", "results", "APC-Pilot-10-v1", instance.instance_id);
}

function predictionPathFor(root: string): string {
	return join(outputDirectoryFor(root), "swebench-cli-test.prediction.jsonl");
}

function argumentsFor(_root: string, _outputPath: string): string[] {
	return [
		"--instance",
		instance.instance_id,
		"--run-id",
		"swebench-cli-test",
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

function baselineGitStdout(options: { currentCommit?: string; trackedChanges?: string } = {}) {
	const expectedCommit = "e7fa37e1e9af8ace2c6b4ff13d99eb94e80c6854";
	const currentCommit = options.currentCommit ?? expectedCommit;
	const trackedChanges = options.trackedChanges ?? "";
	return async (args: string[]): Promise<string> => {
		if (args[0] === "rev-parse" && args[1] === "--verify") {
			expect(args[2]).toBe(`${SWE_BENCH_STANDARD_BASELINE_TAG}^{commit}`);
			return expectedCommit;
		}
		if (args[0] === "rev-parse" && args[1] === "HEAD") return currentCommit;
		if (args[0] === "status") return trackedChanges;
		throw new Error(`Unexpected Git command: ${args.join(" ")}`);
	};
}

describe("SWE-bench CLI post-run orchestration", () => {
	it("loads the single canonical manifest plus machine prerequisite environment", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-bootstrap-"));
		const manifestDirectory = join(root, ".agentpatchcheck", "swebench", "datasets");
		await mkdir(manifestDirectory, { recursive: true });
		await writeFile(
			join(manifestDirectory, "APC-Pilot-10-v1-formal.manifest.json"),
			JSON.stringify({
				name: "APC-Pilot-10",
				version: "v1",
				fullSubset: { path: "agent.jsonl" },
				evaluator: { dataset: "official.jsonl", revision: evaluatorRevision, timeoutSeconds: 120 },
				execution: { classification: "formal-frozen", deepseekModel: "deepseek-v4-flash" },
				instanceIds: [instance.instance_id],
			}),
		);

		await expect(
			loadSWEbenchBootstrapConfiguration(root, {
				AGENTPATCHCHECK_SWEBENCH_EVALUATOR_ROOT: join(root, "evaluator"),
				AGENTPATCHCHECK_SWEBENCH_EVALUATOR_PYTHON: join(root, "python.exe"),
			}),
		).resolves.toMatchObject({
			datasetPath: join(manifestDirectory, "agent.jsonl"),
			evaluatorDatasetPath: join(manifestDirectory, "official.jsonl"),
			evaluatorRevision,
			deepseekModel: "deepseek-v4-flash",
			classification: "formal-frozen",
			engineeringValidation: false,
		});
	});

	it("resolves the canonical formal bootstrap into the zero-LLM effective contract", async () => {
		const projectRoot = resolve(process.cwd());
		const manifestDirectory = join(projectRoot, ".agentpatchcheck", "swebench", "datasets");
		const [historicalManifest, formalManifest] = await Promise.all(
			["APC-Pilot-10-v1.manifest.json", "APC-Pilot-10-v1-formal.manifest.json"].map(async (name) =>
				JSON.parse(await readFile(join(manifestDirectory, name), "utf8")) as Record<string, unknown>,
			),
		);
		const bootstrap = await loadSWEbenchBootstrapConfiguration(projectRoot, {
			AGENTPATCHCHECK_SWEBENCH_EVALUATOR_ROOT: join(projectRoot, "test-evaluator"),
			AGENTPATCHCHECK_SWEBENCH_EVALUATOR_PYTHON: join(projectRoot, "test-python"),
		});
		const runtime = createSWEbenchRuntimeConfiguration(bootstrap.deepseekModel);
		const verificationInput = resolveDevelopmentVerification(
			SWE_BENCH_STANDARD_BASELINE_TAG,
			bootstrap.instanceIds[0] as string,
			runtime,
		);
		const verification: VerificationPolicy = {
			commands: [],
			outputLimitBytes: 16_384,
			allowShell: false,
			allowNetwork: false,
		};
		const nativeTools = getHarnessNativeAvailableTools(verification);
		const { classification: historicalClassification, ...historicalExecution } = historicalManifest.execution as Record<
			string,
			unknown
		>;
		const { classification: formalClassification, ...formalExecution } = formalManifest.execution as Record<string, unknown>;

		expect(bootstrap.manifestPath).toBe(join(manifestDirectory, "APC-Pilot-10-v1-formal.manifest.json"));
		expect(bootstrap.classification).toBe("formal-frozen");
		expect(bootstrap.engineeringValidation).toBe(false);
		expect(verificationInput.commands ?? []).toEqual([]);
		expect(verification.commands).toEqual([]);
		expect(nativeTools).toContain("dsh-shell");
		expect(nativeTools).not.toContain("run-public-verification");
		expect(bootstrap.instanceIds).toEqual(formalManifest.instanceIds);
		expect(bootstrap.deepseekModel).toBe((formalManifest.execution as { deepseekModel: string }).deepseekModel);
		expect(bootstrap.evaluatorRevision).toBe((formalManifest.evaluator as { revision: string }).revision);
		expect(runtime).toMatchObject({
			model: bootstrap.deepseekModel,
			timeoutMs: 1_200_000,
			nativeAgent: { maxIterations: 24, maxToolCalls: 48, maxTransportRetries: 2 },
		});
		expect(historicalClassification).toBe("engineering-validation");
		expect(formalClassification).toBe("formal-frozen");
		expect(formalExecution).toEqual(historicalExecution);
		expect({ ...formalManifest, execution: formalExecution }).toEqual({
			...historicalManifest,
			execution: historicalExecution,
		});
	});

	it("reports all unavailable evaluator prerequisites", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-cli-"));
		await expect(
			preflightSWEbenchEvaluator({
				evaluatorPythonPath: join(root, "missing-python"),
				evaluatorSourceRoot: join(root, "missing-evaluator"),
				datasetPath: join(root, "missing-dataset.jsonl"),
				expectedRevision: evaluatorRevision,
			}),
		).rejects.toMatchObject({
			code: "evaluator_preflight_failed",
			failedChecks: expect.arrayContaining([
				"evaluator-source-root-missing",
				"run_evaluation.py-unreadable",
				"evaluator-python-unavailable",
				"full-evaluator-dataset-unreadable",
			]),
		});
	});

	it("fails before Agent startup when the selected evaluator Python lacks the Docker SDK", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-cli-"));
		const evaluatorRoot = join(root, "evaluator");
		const pythonPath = join(root, "python.exe");
		const datasetPath = join(root, "official-dataset.jsonl");
		await mkdir(join(evaluatorRoot, "swebench", "harness"), { recursive: true });
		await writeFile(join(evaluatorRoot, "swebench", "harness", "run_evaluation.py"), "# evaluator\n");
		await writeFile(pythonPath, "placeholder\n");
		await writeFile(datasetPath, "{}\n");

		await expect(
			preflightSWEbenchEvaluator(
				{ evaluatorPythonPath: pythonPath, evaluatorSourceRoot: evaluatorRoot, datasetPath, expectedRevision: evaluatorRevision },
				async () => false,
				async () => evaluatorRevision,
			),
		).rejects.toMatchObject({
			code: "evaluator_preflight_failed",
			failedChecks: ["evaluator-python-docker-module-unavailable"],
		});
	});

	it("rejects an evaluator checkout whose HEAD differs from the frozen manifest revision", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-cli-"));
		const evaluatorRoot = join(root, "evaluator");
		const pythonPath = join(root, "python.exe");
		const datasetPath = join(root, "official-dataset.jsonl");
		await mkdir(join(evaluatorRoot, "swebench", "harness"), { recursive: true });
		await writeFile(join(evaluatorRoot, "swebench", "harness", "run_evaluation.py"), "# evaluator\n");
		await writeFile(pythonPath, "placeholder\n");
		await writeFile(datasetPath, "{}\n");

		await expect(
			preflightSWEbenchEvaluator(
				{ evaluatorPythonPath: pythonPath, evaluatorSourceRoot: evaluatorRoot, datasetPath, expectedRevision: evaluatorRevision },
				async () => true,
				async () => "a".repeat(40),
			),
		).rejects.toMatchObject({
			failedChecks: ["evaluator-revision-mismatch"],
			expectedRevision: evaluatorRevision,
			actualRevision: "a".repeat(40),
		});
	});

	it("blocks Agent startup when evaluator preflight fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-cli-"));
		let agentStarted = false;
		await expect(
			runSWEbenchCli(argumentsFor(root, join(root, "predictions.jsonl")), {
				initializeEnvironment: () => "already-loaded",
				findProjectRoot: () => root,
				loadBootstrapConfiguration: async () => bootstrapConfiguration(root),
				runEvaluatorPreflight: async () => {
					throw new SWEbenchEvaluatorPreflightError(["run_evaluation.py-unreadable"], join(root, "missing-evaluator"));
				},
				runInstance: async () => {
					agentStarted = true;
					throw new Error("Agent must not start after evaluator preflight failure.");
				},
			}),
		).rejects.toMatchObject({ code: "evaluator_preflight_failed", failedChecks: ["run_evaluation.py-unreadable"] });
		expect(agentStarted).toBe(false);
	});

	it("proves Operator Independence through environment preparation and the AgentRuntime boundary without an LLM call", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-cli-"));
		const outputPath = join(root, "predictions.jsonl");
		const order: string[] = [];
		let preflightInput: {
			evaluatorPythonPath: string;
			evaluatorSourceRoot: string;
			datasetPath: string;
			expectedRevision: string;
		} | null = null;
		let agentStarted = false;
		await runSWEbenchCli(argumentsFor(root, outputPath), {
			initializeEnvironment: () => "already-loaded",
			loadBootstrapConfiguration: async () => {
				order.push("canonical-config");
				return bootstrapConfiguration(root);
			},
			runEvaluatorPreflight: async (input) => {
				order.push("evaluator-preflight");
				preflightInput = input;
			},
			findProjectRoot: () => root,
			getGitStdout: baselineGitStdout(),
			loadInstance: async () => instance,
			resolveRepositoryRoot: async () => {
				order.push("host-repository-preflight");
				return join(root, "repository");
			},
			runInstance: async (options) => {
				order.push("docker-environment-prepared", "agent-runtime-boundary");
				agentStarted = true;
				expect(options.outputPath).toBe(predictionPathFor(root));
				await writeFile(join(outputDirectoryFor(root), "evaluator-artifacts", "write-proof"), "ok\n");
				return adapterResult(root, null, null, execution(), "prediction_export_failed");
			},
		});
		expect(preflightInput).toEqual({
			evaluatorPythonPath: join(root, "evaluator-python"),
			evaluatorSourceRoot: join(root, "official-evaluator"),
			datasetPath: join(root, "official-dataset.jsonl"),
			expectedRevision: evaluatorRevision,
		});
		expect(agentStarted).toBe(true);
		expect(order).toEqual([
			"canonical-config",
			"evaluator-preflight",
			"host-repository-preflight",
			"docker-environment-prepared",
			"agent-runtime-boundary",
		]);
	});

	it("rejects an independently supplied prediction model label", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-cli-"));
		await expect(
			runSWEbenchCli([...argumentsFor(root, join(root, "predictions.jsonl")), "--model-name-or-path", "apc/stale"], {
				initializeEnvironment: () => "already-loaded",
				findProjectRoot: () => root,
				loadBootstrapConfiguration: async () => bootstrapConfiguration(root),
				runEvaluatorPreflight: async () => undefined,
			}),
		).rejects.toThrow("--model-name-or-path is owned by the canonical SWE-bench bootstrap configuration");
	});

	it("rejects a manually supplied repository before Agent startup", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-cli-repository-"));
		let agentStarted = false;
		await expect(
			runSWEbenchCli(
				[...argumentsFor(root, join(root, "predictions.jsonl")), "--repository", root],
				{
					initializeEnvironment: () => "already-loaded",
					loadBootstrapConfiguration: async () => bootstrapConfiguration(root),
					runEvaluatorPreflight: async () => undefined,
					findProjectRoot: () => root,
					getGitStdout: baselineGitStdout(),
					loadInstance: async () => instance,
					runInstance: async () => {
						agentStarted = true;
						throw new Error("Agent must not start for a manually supplied repository.");
					},
				},
			),
		).rejects.toThrow("--repository is owned by the canonical SWE-bench bootstrap configuration");
		expect(agentStarted).toBe(false);
	});

	it("executes Agent, writes a standard prediction, then evaluates a timeout with a valid patch", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-cli-"));
		const outputPath = predictionPathFor(root);
		const officialDatasetPath = join(root, "official-dataset.jsonl");
		const order: string[] = [];
		const prediction = {
			instance_id: instance.instance_id,
			model_name_or_path: `agentpatchcheck/${SWE_BENCH_STANDARD_BASELINE_TAG}/deepseek-v4-pro`,
			model_patch: "diff --git a/gin.go b/gin.go\n",
		};
		await writeFile(
			officialDatasetPath,
			`${JSON.stringify({
				...instance,
				test_patch: "evaluator-only test patch",
				FAIL_TO_PASS: ["hidden_failure"],
				PASS_TO_PASS: ["hidden_success"],
			})}\n`,
		);

		await runSWEbenchCli(argumentsFor(root, outputPath), {
			initializeEnvironment: () => "already-loaded",
			loadBootstrapConfiguration: async () =>
				bootstrapConfiguration(root, { deepseekModel: "deepseek-v4-pro", engineeringValidation: false }),
			runEvaluatorPreflight: async () => undefined,
				findProjectRoot: () => root,
				getGitStdout: baselineGitStdout(),
				loadInstance: async () => instance,
				resolveRepositoryRoot: async () => join(root, "repository"),
				runInstance: async (options) => {
				order.push("executeAgent", "collectPatch");
				expect(options).toEqual({
					instance,
					repositoryRoot: join(root, "repository"),
					outputPath,
					modelNameOrPath: `agentpatchcheck/${SWE_BENCH_STANDARD_BASELINE_TAG}/deepseek-v4-pro`,
					sourceLabel: SWE_BENCH_STANDARD_BASELINE_TAG,
					runtime: expect.objectContaining({ model: "deepseek-v4-pro" }),
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
				expect(input.datasetPath).toBe(officialDatasetPath);
				expect(input.instanceId).toBe(instance.instance_id);
				expect(JSON.parse((await readFile(input.datasetPath, "utf8")).trim())).toMatchObject({
					FAIL_TO_PASS: ["hidden_failure"],
					PASS_TO_PASS: ["hidden_success"],
					test_patch: "evaluator-only test patch",
				});
				expect(JSON.parse((await readFile(input.predictionPath, "utf8")).trim())).toEqual(prediction);
				return resolvedGrading("resolved");
			},
		});

		expect(order).toEqual(["executeAgent", "collectPatch", "writePrediction", "evaluator"]);
		const grading = JSON.parse(await readFile(join(outputDirectoryFor(root), "swebench-cli-test.swebench-grading.json"), "utf8"));
		const summary = JSON.parse(await readFile(join(outputDirectoryFor(root), "swebench-cli-test.apc-run.json"), "utf8"));
		expect(grading).toMatchObject({ normalizedStatus: "resolved", officialRunId: "official-run-1" });
		expect(summary).toMatchObject({
			apcBaselineCommit: "e7fa37e1e9af8ace2c6b4ff13d99eb94e80c6854",
			runClassification: "formal-frozen",
			source: {
				baselineTag: SWE_BENCH_STANDARD_BASELINE_TAG,
				dirty: false,
			},
			agent: { status: "timeout", timedOut: true },
			grading: { normalizedStatus: "resolved" },
			candidateValidity: {
				executionValidity: "valid",
				pass1Eligible: true,
				predictionStatus: "generated",
				gradingValidity: "valid",
			},
			predictionPath: outputPath,
		});
	});

	it("writes not_run without invoking the evaluator when a legal prediction cannot be produced", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-cli-"));
		const outputPath = predictionPathFor(root);
		let evaluatorInvoked = false;

		await runSWEbenchCli(argumentsFor(root, outputPath), {
			initializeEnvironment: () => "already-loaded",
			loadBootstrapConfiguration: async () =>
				bootstrapConfiguration(root, { deepseekModel: "deepseek-v4-pro", engineeringValidation: false }),
			runEvaluatorPreflight: async () => undefined,
			findProjectRoot: () => root,
			getGitStdout: baselineGitStdout(),
			loadInstance: async () => instance,
			resolveRepositoryRoot: async () => join(root, "repository"),
			runInstance: async () => adapterResult(root, null, null, execution(), "prediction_export_failed"),
			runPostRunEvaluator: async () => {
				evaluatorInvoked = true;
				return resolvedGrading("resolved");
			},
		});

		const grading = JSON.parse(await readFile(join(outputDirectoryFor(root), "swebench-cli-test.swebench-grading.json"), "utf8"));
		const summary = JSON.parse(await readFile(join(outputDirectoryFor(root), "swebench-cli-test.apc-run.json"), "utf8"));
		expect(evaluatorInvoked).toBe(false);
		expect(grading).toMatchObject({ normalizedStatus: "not_run", reason: "prediction_export_failed" });
		expect(summary).toMatchObject({
			apcBaselineCommit: "e7fa37e1e9af8ace2c6b4ff13d99eb94e80c6854",
			agent: { status: "completed" },
			grading: { normalizedStatus: "not_run" },
			predictionPath: null,
			predictionError: "prediction_export_failed",
			candidateValidity: {
				predictionStatus: "not_generated",
				gradingValidity: "not_run",
			},
		});
	});

	it("keeps evaluator infrastructure and ambiguous outcomes out of Agent execution state", async () => {
		for (const normalizedStatus of ["infrastructure_error", "grading_error_or_ambiguous"] as const) {
			const root = await mkdtemp(join(tmpdir(), "apc-swebench-cli-"));
			const outputPath = predictionPathFor(root);
			const prediction = {
				instance_id: instance.instance_id,
				model_name_or_path: "apc/test-model",
				model_patch: "diff --git a/gin.go b/gin.go\n",
			};
			const agent = execution();

			await runSWEbenchCli(argumentsFor(root, outputPath), {
				initializeEnvironment: () => "already-loaded",
				loadBootstrapConfiguration: async () =>
					bootstrapConfiguration(root, { deepseekModel: "deepseek-v4-pro", engineeringValidation: false }),
				runEvaluatorPreflight: async () => undefined,
				findProjectRoot: () => root,
				getGitStdout: baselineGitStdout(),
				loadInstance: async () => instance,
				resolveRepositoryRoot: async () => join(root, "repository"),
				runInstance: async () => {
					await writeFile(outputPath, `${JSON.stringify(prediction)}\n`, "utf8");
					return adapterResult(root, outputPath, prediction, agent);
				},
				runPostRunEvaluator: async () => resolvedGrading(normalizedStatus),
			});

			const summary = JSON.parse(await readFile(join(outputDirectoryFor(root), "swebench-cli-test.apc-run.json"), "utf8"));
			expect(agent).toEqual(execution());
			expect(summary).toMatchObject({
				agent: { status: "completed" },
				grading: { normalizedStatus },
				candidateValidity: { gradingValidity: "grading_invalid" },
			});
		}
	});

	it("rejects a HEAD that differs from the resolved baseline tag", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-cli-"));
		await expect(
			runSWEbenchCli(argumentsFor(root, join(root, "predictions.jsonl")), {
				initializeEnvironment: () => "already-loaded",
				loadBootstrapConfiguration: async () =>
					bootstrapConfiguration(root, { deepseekModel: "deepseek-v4-pro", engineeringValidation: false }),
				runEvaluatorPreflight: async () => undefined,
				findProjectRoot: () => root,
				getGitStdout: baselineGitStdout({ currentCommit: "f".repeat(40) }),
				loadInstance: async () => {
					throw new Error("Agent execution must not start after baseline rejection.");
				},
			}),
		).rejects.toThrow(`baseline tag ${SWE_BENCH_STANDARD_BASELINE_TAG}`);
	});

	it("rejects tracked source changes after the baseline tag resolves to HEAD", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-cli-"));
		await expect(
			runSWEbenchCli(argumentsFor(root, join(root, "predictions.jsonl")), {
				initializeEnvironment: () => "already-loaded",
				loadBootstrapConfiguration: async () =>
					bootstrapConfiguration(root, { deepseekModel: "deepseek-v4-pro", engineeringValidation: false }),
				runEvaluatorPreflight: async () => undefined,
				findProjectRoot: () => root,
				getGitStdout: baselineGitStdout({ trackedChanges: " M src/agentpatchcheck/swebench-cli.ts" }),
				loadInstance: async () => {
					throw new Error("Agent execution must not start after dirty-source rejection.");
				},
			}),
		).rejects.toThrow("clean tracked source worktree");
	});

	it("runs engineering validation from the current dirty source and records its identity", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-cli-"));
		const outputPath = predictionPathFor(root);
		const currentCommit = "a".repeat(40);
		const trackedChanges = " M src/agentpatchcheck/swebench-cli.ts\n?? scratch.txt";
		const prediction = {
			instance_id: instance.instance_id,
			model_name_or_path: "agentpatchcheck/engineering-validation-aaaaaaaaaaaa/deepseek-v4-pro",
			model_patch: "diff --git a/gin.go b/gin.go\n",
		};

		await runSWEbenchCli(argumentsFor(root, outputPath), {
			initializeEnvironment: () => "already-loaded",
			loadBootstrapConfiguration: async () =>
				bootstrapConfiguration(root, { deepseekModel: "deepseek-v4-pro", engineeringValidation: true }),
			runEvaluatorPreflight: async () => undefined,
			findProjectRoot: () => root,
			getGitStdout: baselineGitStdout({ currentCommit, trackedChanges }),
			loadInstance: async () => instance,
			resolveRepositoryRoot: async () => join(root, "repository"),
			runInstance: async (options) => {
				expect(options.modelNameOrPath).toBe(prediction.model_name_or_path);
				expect(options.sourceLabel).toBe("engineering-validation-aaaaaaaaaaaa");
				await writeFile(outputPath, `${JSON.stringify(prediction)}\n`, "utf8");
				return adapterResult(root, outputPath, prediction, execution());
			},
			runPostRunEvaluator: async () => resolvedGrading("resolved"),
		});

		const summary = JSON.parse(await readFile(join(outputDirectoryFor(root), "swebench-cli-test.apc-run.json"), "utf8"));
		expect(summary).toMatchObject({
			apcBaselineCommit: null,
			runClassification: "engineering-validation",
			source: {
				head: currentCommit,
				baselineTag: null,
				dirty: true,
				statusPorcelain: trackedChanges,
			},
			runConfiguration: { deepseekModel: "deepseek-v4-pro", attempt: 1 },
		});
	});

	it("defaults engineering validation to the converged Flash runtime", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-cli-default-runtime-"));
		const outputPath = predictionPathFor(root);
		const args = argumentsFor(root, outputPath);
		const prediction = {
			instance_id: instance.instance_id,
			model_name_or_path: "agentpatchcheck/engineering-validation-aaaaaaaaaaaa/deepseek-v4-flash",
			model_patch: "diff --git a/gin.go b/gin.go\n",
		};

		await runSWEbenchCli(args, {
			initializeEnvironment: () => "already-loaded",
			loadBootstrapConfiguration: async () => bootstrapConfiguration(root),
			runEvaluatorPreflight: async () => undefined,
			findProjectRoot: () => root,
			getGitStdout: baselineGitStdout({ currentCommit: "a".repeat(40), trackedChanges: " M source.ts" }),
			loadInstance: async () => instance,
			resolveRepositoryRoot: async () => join(root, "repository"),
			runInstance: async (options) => {
				expect(options).toMatchObject({
					modelNameOrPath: prediction.model_name_or_path,
					runtime: {
						model: "deepseek-v4-flash",
						timeoutMs: 1_200_000,
						nativeAgent: { maxIterations: 24, maxToolCalls: 48, maxTransportRetries: 2 },
					},
				});
				await writeFile(outputPath, `${JSON.stringify(prediction)}\n`, "utf8");
				return adapterResult(root, outputPath, prediction, execution());
			},
			runPostRunEvaluator: async () => resolvedGrading("resolved"),
		});

		const summary = JSON.parse(await readFile(join(outputDirectoryFor(root), "swebench-cli-test.apc-run.json"), "utf8"));
		expect(summary.runConfiguration).toMatchObject({ deepseekModel: "deepseek-v4-flash", attempt: 1 });
	});
});
