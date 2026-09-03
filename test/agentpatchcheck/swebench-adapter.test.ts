import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createHarnessNativeAdapter } from "../../src/agentpatchcheck/agent-adapter";
import { ProcessTreeTerminationError } from "../../src/agentpatchcheck/codex-runner";
import { createHostRepositoryPrimitives } from "../../src/agentpatchcheck/harness-native-runtime";
import { IsolatedWorkspaceCollisionError } from "../../src/agentpatchcheck/isolated-workspace";
import {
	AGENTPATCHCHECK_BASELINE_MODEL,
	collectSWEbenchModelPatch,
	createSWEbenchModelNameOrPath,
	createSWEbenchPrediction,
	createSWEbenchRuntimeConfiguration,
	loadSWEbenchInstance,
	resolveSWEbenchRepositoryRoot,
	runSWEbenchInstance,
	validateSWEbenchRepositoryRoot,
} from "../../src/agentpatchcheck/swebench-adapter";
import type { SWEbenchDockerTaskEnvironment } from "../../src/agentpatchcheck/swebench-docker-task-environment";
import { validateTaskPolicy } from "../../src/agentpatchcheck/task-policy";
import type { AgentExecution, IsolatedWorkspace, TaskPolicy } from "../../src/agentpatchcheck/types";
import { runGit } from "../../src/workspace/git-utils";

const instance = {
	instance_id: "gin-gonic__gin-2755",
	repo: "gin-gonic/gin",
	base_commit: "f2bbdfe9f26d84cb994f381050692a9e4553bf75",
	problem_statement: "Fix the HandleContext panic.",
};

describe("SWE-bench Multilingual adapter", () => {
	it("creates the converged Flash development and regression runtime", () => {
		const runtime = createSWEbenchRuntimeConfiguration("deepseek-v4-flash");

		expect(runtime).toMatchObject({
			model: "deepseek-v4-flash",
			timeoutMs: 1_200_000,
			nativeAgent: {
				maxIterations: 24,
				maxToolCalls: 48,
				maxTransportRetries: 2,
			},
		});
	});

	it("loads only the official instance fields needed by APC", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-load-"));
		const dataset = join(root, "test.jsonl");
		await writeFile(dataset, `${JSON.stringify({ ...instance, patch: "secret gold patch", FAIL_TO_PASS: ["x"] })}\n`);

		await expect(loadSWEbenchInstance(dataset, instance.instance_id)).resolves.toEqual(instance);
	});

	it("creates the official prediction schema", () => {
		expect(createSWEbenchPrediction(instance.instance_id, "diff --git a/a b/a\n", "apc/baseline")).toEqual({
			instance_id: instance.instance_id,
			model_patch: "diff --git a/a b/a\n",
			model_name_or_path: "apc/baseline",
		});
	});

	it("resolves and validates the repository root from instance metadata", async () => {
		const projectRoot = await mkdtemp(join(tmpdir(), "apc-swebench-repository-resolution-"));
		const repositoryRoot = join(projectRoot, ".agentpatchcheck", "swebench", "repositories", "gin-gonic__gin");
		await mkdir(repositoryRoot, { recursive: true });
		expect((await runGit(repositoryRoot, ["init"])).ok).toBe(true);
		expect(
			(await runGit(repositoryRoot, ["remote", "add", "origin", "https://github.com/gin-gonic/gin.git"])).ok,
		).toBe(true);

		await expect(resolveSWEbenchRepositoryRoot(projectRoot, instance)).resolves.toBe(await realpath(repositoryRoot));
	});

	it("fails fast with expected and resolved repository details for a parent directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-repository-mismatch-"));
		await expect(validateSWEbenchRepositoryRoot(root, instance)).rejects.toMatchObject({
			code: "swebench-repository-mismatch",
			expectedRepository: "gin-gonic/gin",
			resolvedRepository: "<not-a-git-repository>",
			resolvedPath: root,
		});
		await expect(validateSWEbenchRepositoryRoot(root, instance)).rejects.toThrow(
			`expected repository gin-gonic/gin at ${root}; resolved repository <not-a-git-repository> at ${root}`,
		);
	});

	it("exports tracked and newly created files as one Git patch", async () => {
		const repository = await mkdtemp(join(tmpdir(), "apc-swebench-patch-"));
		expect((await runGit(repository, ["init"])).ok).toBe(true);
		expect((await runGit(repository, ["config", "user.email", "test@example.com"])).ok).toBe(true);
		expect((await runGit(repository, ["config", "user.name", "Test"])).ok).toBe(true);
		await writeFile(join(repository, "tracked.txt"), "before\n");
		expect((await runGit(repository, ["add", "tracked.txt"])).ok).toBe(true);
		expect((await runGit(repository, ["commit", "-m", "base"])).ok).toBe(true);
		const baseCommit = (await runGit(repository, ["rev-parse", "HEAD"])).stdout;
		await writeFile(join(repository, "tracked.txt"), "after\n");
		await writeFile(join(repository, "created.txt"), "created\n");

		const patch = await collectSWEbenchModelPatch(repository, baseCommit, ["created.txt", "tracked.txt"]);

		expect(patch.changedFiles).toEqual(["created.txt", "tracked.txt"]);
		expect(patch.modelPatch).toContain("diff --git a/created.txt b/created.txt");
		expect(patch.modelPatch).toContain("diff --git a/tracked.txt b/tracked.txt");
		expect((await runGit(repository, ["diff", "--cached", "--name-only"])).stdout).toBe("");
	});

	it("exports only Runtime-attributed mutations and leaves verification artifacts out of the prediction", async () => {
		const repository = await mkdtemp(join(tmpdir(), "apc-swebench-provenance-"));
		expect((await runGit(repository, ["init"])).ok).toBe(true);
		expect((await runGit(repository, ["config", "user.email", "test@example.com"])).ok).toBe(true);
		expect((await runGit(repository, ["config", "user.name", "Test"])).ok).toBe(true);
		await writeFile(join(repository, "source.txt"), "before\n");
		expect((await runGit(repository, ["add", "source.txt"])).ok).toBe(true);
		expect((await runGit(repository, ["commit", "-m", "base"])).ok).toBe(true);
		const baseCommit = (await runGit(repository, ["rev-parse", "HEAD"])).stdout.trim();
		await writeFile(join(repository, "source.txt"), "after\n");
		await writeFile(join(repository, "verification-artifact.bin"), "artifact\n");

		const patch = await collectSWEbenchModelPatch(repository, baseCommit, ["source.txt"]);

		expect(patch.changedFiles).toEqual(["source.txt"]);
		expect(patch.modelPatch).toContain("diff --git a/source.txt b/source.txt");
		expect(patch.modelPatch).not.toContain("verification-artifact.bin");
		expect((await runGit(repository, ["diff", "--cached", "--name-only"])).stdout).toBe("");
	});

	it("passes only the safe instance into Agent execution and writes one prediction JSONL row", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-run-"));
		const repositoryRoot = join(root, "repository");
		const worktreePath = join(repositoryRoot, ".agentpatchcheck", "worktrees", "swebench-test");
		const outputPath = join(root, "predictions.jsonl");
		await mkdir(repositoryRoot, { recursive: true });
		expect((await runGit(repositoryRoot, ["init"])).ok).toBe(true);
		expect((await runGit(repositoryRoot, ["config", "user.email", "test@example.com"])).ok).toBe(true);
		expect((await runGit(repositoryRoot, ["config", "user.name", "Test"])).ok).toBe(true);
		await writeFile(join(repositoryRoot, "README.md"), "base\n");
		expect((await runGit(repositoryRoot, ["add", "README.md"])).ok).toBe(true);
		expect((await runGit(repositoryRoot, ["commit", "-m", "base"])).ok).toBe(true);
		const baseCommit = (await runGit(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim();
		const safeInstance = { ...instance, base_commit: baseCommit };
		await mkdir(worktreePath, { recursive: true });
		let receivedPolicy: TaskPolicy | null = null;
		const providerInputs: string[] = [];

		const result = await runSWEbenchInstance(
			{
				instance: safeInstance,
				repositoryRoot,
				outputPath,
				modelNameOrPath: createSWEbenchModelNameOrPath(AGENTPATCHCHECK_BASELINE_MODEL),
				runId: "swebench-test",
			},
			{
				createWorkspace: async (options): Promise<IsolatedWorkspace> => ({
					runId: options.runId,
					repositoryPath: options.repositoryPath,
					path: worktreePath,
					baseRef: options.baseRef,
					baseCommit: options.baseCommit,
				}),
				executeAgent: async (policy, path) => {
					receivedPolicy = policy;
					return await createHarnessNativeAdapter({
						id: "swebench-safe-boundary-provider",
						decide: async (context) => {
							providerInputs.push(JSON.stringify(context));
							return context.observations.length === 0
								? {
										decision: {
											kind: "tool",
											tool: "create-file",
											arguments: { path: "agent-change.txt", content: "safe boundary\n" },
										},
									}
								: { decision: { kind: "finish" } };
						},
					}).execute({
						policy,
						worktreePath: path,
						repairContext: { phase: "initial", publicVerificationFeedback: null, repairInstruction: null },
					});
				},
				collectModelPatch: async () => ({
					modelPatch: "diff --git a/gin.go b/gin.go\n",
					changedFiles: ["gin.go"],
				}),
			},
		);

		expect(receivedPolicy).toMatchObject({
			prompt: safeInstance.problem_statement,
			baseRef: safeInstance.base_commit,
			runId: "swebench-test",
			verification: { commands: [] },
		});
		expect(providerInputs).not.toHaveLength(0);
		for (const providerInput of providerInputs) {
			expect(providerInput).not.toContain("run-public-verification");
			expect(providerInput).not.toContain("FAIL_TO_PASS");
			expect(providerInput).not.toContain("PASS_TO_PASS");
			expect(providerInput).not.toContain("test_patch");
			expect(providerInput).not.toContain("evaluator");
			expect(providerInput).not.toContain("verification-artifacts");
		}
		expect(result.mutationOccurred).toBe(true);
		expect(result.changedFiles).toEqual(["gin.go"]);
		expect(result.runIdentity).toMatchObject({
			experiment: "swe-bench/SWE-Bench_Multilingual",
			task: safeInstance.instance_id,
			attempt: 1,
			repository: instance.repo,
			baseCommit: safeInstance.base_commit,
		});
		expect(JSON.parse((await readFile(outputPath, "utf8")).trim())).toEqual(result.prediction);
	});

	it("does not start the Agent when worktree creation detects a historical collision", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-collision-"));
		const repositoryRoot = join(root, "repository");
		await mkdir(repositoryRoot, { recursive: true });
		expect((await runGit(repositoryRoot, ["init"])).ok).toBe(true);
		expect((await runGit(repositoryRoot, ["config", "user.email", "test@example.com"])).ok).toBe(true);
		expect((await runGit(repositoryRoot, ["config", "user.name", "Test"])).ok).toBe(true);
		await writeFile(join(repositoryRoot, "README.md"), "base\n");
		expect((await runGit(repositoryRoot, ["add", "README.md"])).ok).toBe(true);
		expect((await runGit(repositoryRoot, ["commit", "-m", "base"])).ok).toBe(true);
		const baseCommit = (await runGit(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim();
		let agentStarted = false;

		await expect(
			runSWEbenchInstance(
				{
					instance: { ...instance, base_commit: baseCommit },
					repositoryRoot,
					outputPath: join(root, "prediction.jsonl"),
					runId: "historical-run",
				},
				{
					createWorkspace: async (input) => {
						throw new IsolatedWorkspaceCollisionError(join(input.worktreeRoot, input.runId), "path-exists");
					},
					executeAgent: async () => {
						agentStarted = true;
						throw new Error("Agent must not run after worktree collision.");
					},
				},
			),
		).rejects.toMatchObject({ code: "worktree_collision", collision: "path-exists" });
		expect(agentStarted).toBe(false);
	});

	it("uses a Flash runtime and matching prediction identity without changing provider settings", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-adapter-"));
		const repositoryRoot = join(root, "repository");
		const outputPath = join(root, "prediction.jsonl");
		await mkdir(repositoryRoot, { recursive: true });
		expect((await runGit(repositoryRoot, ["init"])).ok).toBe(true);
		expect((await runGit(repositoryRoot, ["config", "user.email", "test@example.com"])).ok).toBe(true);
		expect((await runGit(repositoryRoot, ["config", "user.name", "Test"])).ok).toBe(true);
		await writeFile(join(repositoryRoot, "README.md"), "base\n");
		expect((await runGit(repositoryRoot, ["add", "README.md"])).ok).toBe(true);
		expect((await runGit(repositoryRoot, ["commit", "-m", "base"])).ok).toBe(true);
		const safeInstance = {
			...instance,
			base_commit: (await runGit(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim(),
		};
		const runtime = createSWEbenchRuntimeConfiguration("deepseek-v4-flash");
		const result = await runSWEbenchInstance(
			{
				instance: safeInstance,
				repositoryRoot,
				outputPath,
				runtime,
			},
			{
				validatePolicy: async (input) => {
					expect(input.model).toBe("deepseek-v4-flash");
					expect(input.nativeAgent).toEqual(runtime.nativeAgent);
					return await validateTaskPolicy(input);
				},
				createWorkspace: async (options): Promise<IsolatedWorkspace> => ({
					runId: options.runId,
					repositoryPath: options.repositoryPath,
					path: join(root, "worktree"),
					baseRef: options.baseRef,
					baseCommit: options.baseCommit,
				}),
				executeAgent: async (): Promise<AgentExecution> => ({
					executable: "agent",
					args: [],
					exitCode: 0,
					signal: null,
					stdout: "",
					stderr: "",
					durationMs: 1,
					timedOut: false,
				}),
				collectModelPatch: async () => ({ modelPatch: "diff --git a/file b/file\n", changedFiles: ["file"] }),
			},
		);
		expect(result.runIdentity.model).toBe("deepseek-v4-flash");
		expect(result.prediction?.model_name_or_path).toBe(createSWEbenchModelNameOrPath("deepseek-v4-flash"));
	});

	it("wires an explicit repository-public development verifier without changing the formal profile", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-development-verification-"));
		const repositoryRoot = join(root, "repository");
		await mkdir(repositoryRoot, { recursive: true });
		expect((await runGit(repositoryRoot, ["init"])).ok).toBe(true);
		expect((await runGit(repositoryRoot, ["config", "user.email", "test@example.com"])).ok).toBe(true);
		expect((await runGit(repositoryRoot, ["config", "user.name", "Test"])).ok).toBe(true);
		await writeFile(join(repositoryRoot, "README.md"), "base\n");
		expect((await runGit(repositoryRoot, ["add", "README.md"])).ok).toBe(true);
		expect((await runGit(repositoryRoot, ["commit", "-m", "base"])).ok).toBe(true);
		const safeInstance = {
			...instance,
			base_commit: (await runGit(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim(),
		};
		const developmentVerification = {
			commands: [{ command: process.execPath, args: ["--version"], timeoutMs: 1_000 }],
		};
		const runtime = {
			...createSWEbenchRuntimeConfiguration("deepseek-v4-flash"),
			developmentVerification,
		};
		const receivedVerifications: TaskPolicy["verification"][] = [];
		const dependencies = {
			validatePolicy: async (input: Parameters<typeof validateTaskPolicy>[0]) => {
				const policy = await validateTaskPolicy(input);
				receivedVerifications.push(policy.verification);
				return policy;
			},
			createWorkspace: async (options: {
				runId: string;
				repositoryPath: string;
				baseRef: string;
				baseCommit: string;
			}): Promise<IsolatedWorkspace> => ({
				runId: options.runId,
				repositoryPath: options.repositoryPath,
				path: join(root, options.runId),
				baseRef: options.baseRef,
				baseCommit: options.baseCommit,
			}),
			executeAgent: async (): Promise<AgentExecution> => ({
				executable: "agent",
				args: [],
				exitCode: 0,
				signal: null,
				stdout: "",
				stderr: "",
				durationMs: 1,
				timedOut: false,
			}),
			collectModelPatch: async () => ({ modelPatch: "diff --git a/file b/file\n", changedFiles: ["file"] }),
		};

		await runSWEbenchInstance(
			{
				instance: safeInstance,
				repositoryRoot,
				outputPath: join(root, "development.jsonl"),
				runId: "development-verification",
				sourceLabel: "engineering-validation-development",
				runtime,
			},
			dependencies,
		);
		await runSWEbenchInstance(
			{
				instance: safeInstance,
				repositoryRoot,
				outputPath: join(root, "formal.jsonl"),
				runId: "formal-verification",
				runtime,
			},
			dependencies,
		);

		expect(receivedVerifications).toHaveLength(2);
		expect(receivedVerifications[0]?.commands).toMatchObject(developmentVerification.commands);
		expect(receivedVerifications[1]).toMatchObject({ commands: [] });
	});

	it("assembles the Docker prediction from successful Runtime mutation paths only", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-docker-adapter-"));
		const repositoryRoot = join(root, "repository");
		const outputPath = join(root, "prediction.jsonl");
		await mkdir(repositoryRoot, { recursive: true });
		expect((await runGit(repositoryRoot, ["init"])).ok).toBe(true);
		expect((await runGit(repositoryRoot, ["config", "user.email", "test@example.com"])).ok).toBe(true);
		expect((await runGit(repositoryRoot, ["config", "user.name", "Test"])).ok).toBe(true);
		await writeFile(join(repositoryRoot, "README.md"), "base\n");
		expect((await runGit(repositoryRoot, ["add", "README.md"])).ok).toBe(true);
		expect((await runGit(repositoryRoot, ["commit", "-m", "base"])).ok).toBe(true);
		const safeInstance = {
			...instance,
			base_commit: (await runGit(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim(),
		};
		let workspaceCalls = 0;
		let cleanupCalls = 0;
		let receivedMutationPaths: readonly string[] = [];
		const environment: SWEbenchDockerTaskEnvironment = {
			path: "/testbed",
			repository: createHostRepositoryPrimitives(),
			collectModelPatch: async (_baseCommit, mutationPaths) => {
				receivedMutationPaths = mutationPaths;
				return {
					modelPatch:
						"diff --git a/src/created.ts b/src/created.ts\n" + "diff --git a/src/existing.ts b/src/existing.ts\n",
					changedFiles: ["src/created.ts", "src/existing.ts"],
				};
			},
			cleanup: async () => {
				cleanupCalls += 1;
			},
		};
		const runtime = {
			...createSWEbenchRuntimeConfiguration("deepseek-v4-flash"),
			dockerTaskEnvironment: {
				image: {
					instanceId: safeInstance.instance_id,
					arch: "x86_64",
					namespace: "swebench",
					instanceImageTag: "latest",
				},
			},
		};
		const result = await runSWEbenchInstance(
			{
				instance: safeInstance,
				repositoryRoot,
				outputPath,
				runId: "docker-environment",
				sourceLabel: "engineering-validation-development",
				runtime,
			},
			{
				createWorkspace: async () => {
					workspaceCalls += 1;
					throw new Error("Host workspace must not be created.");
				},
				createDockerTaskEnvironment: async () => environment,
				executeAgent: async (_policy, path, repository): Promise<AgentExecution> => {
					expect(path).toBe("/testbed");
					expect(repository).toBe(environment.repository);
					return {
						executable: "agent",
						args: [],
						exitCode: 0,
						signal: null,
						stdout: "",
						stderr: "",
						durationMs: 1,
						timedOut: false,
						runtimeEvents: [
							{
								version: 1,
								sequence: 1,
								attempt: 1,
								iteration: 1,
								type: "tool-result",
								actionId: "mutation-existing",
								tool: "apply-edit",
								arguments: { path: "src/existing.ts" },
								status: "ok",
								observation: "updated",
								observationSummary: "updated existing source",
								facts: { kind: "mutation", tool: "apply-edit", affectedPaths: ["src/existing.ts"] },
							},
							{
								version: 1,
								sequence: 2,
								attempt: 1,
								iteration: 2,
								type: "tool-result",
								actionId: "mutation-created",
								tool: "create-file",
								arguments: { path: "src/created.ts" },
								status: "ok",
								observation: "created",
								observationSummary: "created source",
								facts: { kind: "mutation", tool: "create-file", affectedPaths: ["src/created.ts"] },
							},
							{
								version: 1,
								sequence: 3,
								attempt: 1,
								iteration: 3,
								type: "tool-result",
								actionId: "verification",
								tool: "run-public-verification",
								arguments: { index: 0 },
								status: "ok",
								observation: "passed",
								observationSummary: "verification passed",
								facts: {
									kind: "verification",
									tool: "run-public-verification",
									commandIndex: 0,
									outcome: "passed",
									exitCode: 0,
									timedOut: false,
									durationMs: 1,
								},
							},
						],
					};
				},
			},
		);
		expect(workspaceCalls).toBe(0);
		expect(result.workspace).toBeNull();
		expect(receivedMutationPaths).toEqual(["src/created.ts", "src/existing.ts"]);
		expect(result.changedFiles).toEqual(["src/created.ts", "src/existing.ts"]);
		expect(result.prediction?.model_patch).toContain("diff --git a/src/created.ts b/src/created.ts");
		expect(result.prediction?.model_patch).toContain("diff --git a/src/existing.ts b/src/existing.ts");
		expect(result.prediction?.model_patch).not.toContain("verification-output.dat");
		expect(JSON.parse((await readFile(outputPath, "utf8")).trim())).toEqual(result.prediction);
		expect(result.mutationOccurred).toBe(true);
		expect(cleanupCalls).toBe(1);
	});

	it("preserves the original pre-runtime Agent failure in the adapter result", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-pre-runtime-failure-"));
		const repositoryRoot = join(root, "repository");
		await mkdir(repositoryRoot, { recursive: true });
		expect((await runGit(repositoryRoot, ["init"])).ok).toBe(true);
		expect((await runGit(repositoryRoot, ["config", "user.email", "test@example.com"])).ok).toBe(true);
		expect((await runGit(repositoryRoot, ["config", "user.name", "Test"])).ok).toBe(true);
		await writeFile(join(repositoryRoot, "README.md"), "base\n");
		expect((await runGit(repositoryRoot, ["add", "README.md"])).ok).toBe(true);
		expect((await runGit(repositoryRoot, ["commit", "-m", "base"])).ok).toBe(true);
		const baseCommit = (await runGit(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim();
		const result = await runSWEbenchInstance(
			{
				instance: { ...instance, base_commit: baseCommit },
				repositoryRoot,
				outputPath: join(root, "prediction.jsonl"),
				runId: "pre-runtime-failure",
			},
			{
				createWorkspace: async (options): Promise<IsolatedWorkspace> => ({
					runId: options.runId,
					repositoryPath: options.repositoryPath,
					path: join(root, "worktree"),
					baseRef: options.baseRef,
					baseCommit: options.baseCommit,
				}),
				executeAgent: async () => {
					throw new Error("Runtime record failed: ENOENT D:\\testbed");
				},
			},
		);

		expect(result.predictionError).toBe("prediction_export_failed");
		expect(result.failure).toEqual({
			stage: "agent-execution",
			message: "Runtime record failed: ENOENT D:\\testbed",
		});
		expect(result.agent.stderr).toContain("Runtime record failed: ENOENT");
	});

	it("fails closed instead of converting cancellation cleanup failure into an Agent result", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-cleanup-failure-"));
		const repositoryRoot = join(root, "repository");
		try {
			await mkdir(repositoryRoot, { recursive: true });
			expect((await runGit(repositoryRoot, ["init"])).ok).toBe(true);
			expect((await runGit(repositoryRoot, ["config", "user.email", "test@example.com"])).ok).toBe(true);
			expect((await runGit(repositoryRoot, ["config", "user.name", "Test"])).ok).toBe(true);
			await writeFile(join(repositoryRoot, "README.md"), "base\n");
			expect((await runGit(repositoryRoot, ["add", "README.md"])).ok).toBe(true);
			expect((await runGit(repositoryRoot, ["commit", "-m", "base"])).ok).toBe(true);
			const baseCommit = (await runGit(repositoryRoot, ["rev-parse", "HEAD"])).stdout.trim();
			await expect(
				runSWEbenchInstance(
					{
						instance: { ...instance, base_commit: baseCommit },
						repositoryRoot,
						outputPath: join(root, "prediction.jsonl"),
						runId: "cleanup-failure",
					},
					{
						executeAgent: async () => {
							throw new ProcessTreeTerminationError("cleanup acknowledgement failed");
						},
					},
				),
			).rejects.toThrow("cleanup acknowledgement failed");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
