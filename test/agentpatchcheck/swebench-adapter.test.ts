import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createHarnessNativeAdapter } from "../../src/agentpatchcheck/agent-adapter";
import {
	collectSWEbenchModelPatch,
	createSWEbenchModelNameOrPath,
	createSWEbenchPrediction,
	createSWEbenchRuntimeConfiguration,
	loadSWEbenchInstance,
	runSWEbenchInstance,
} from "../../src/agentpatchcheck/swebench-adapter";
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

		const patch = await collectSWEbenchModelPatch(repository, baseCommit);

		expect(patch.changedFiles).toEqual(["created.txt", "tracked.txt"]);
		expect(patch.modelPatch).toContain("diff --git a/created.txt b/created.txt");
		expect(patch.modelPatch).toContain("diff --git a/tracked.txt b/tracked.txt");
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
				modelNameOrPath: createSWEbenchModelNameOrPath("deepseek-v4-pro"),
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
});
