import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	collectSWEbenchModelPatch,
	createSWEbenchPrediction,
	loadSWEbenchInstance,
	runSWEbenchInstance,
} from "../../src/agentpatchcheck/swebench-adapter";
import type { AgentExecution, IsolatedWorkspace, TaskPolicy } from "../../src/agentpatchcheck/types";
import { runGit } from "../../src/workspace/git-utils";

const instance = {
	instance_id: "gin-gonic__gin-2755",
	repo: "gin-gonic/gin",
	base_commit: "f2bbdfe9f26d84cb994f381050692a9e4553bf75",
	problem_statement: "Fix the HandleContext panic.",
};

function fakeAgent(): AgentExecution {
	return {
		executable: "harness-native",
		args: [],
		exitCode: 0,
		signal: null,
		stdout: "",
		stderr: "",
		durationMs: 10,
		timedOut: false,
	};
}

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

	it("maps instance to APC runtime and writes one prediction JSONL row", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-run-"));
		const repositoryRoot = join(root, "repository");
		const worktreePath = join(repositoryRoot, ".agentpatchcheck", "worktrees", "swebench-test");
		const datasetPath = join(root, "test.jsonl");
		const outputPath = join(root, "predictions.jsonl");
		await mkdir(worktreePath, { recursive: true });
		await writeFile(datasetPath, `${JSON.stringify(instance)}\n`);
		let receivedPolicy: TaskPolicy | null = null;

		const result = await runSWEbenchInstance(
			{
				datasetPath,
				instanceId: instance.instance_id,
				repositoryRoot,
				outputPath,
				modelNameOrPath: "apc/baseline",
				runId: "swebench-test",
			},
			{
				validatePolicy: async (input) =>
					({
						...input,
						baseCommit: instance.base_commit,
						baseRef: instance.base_commit,
						worktreeRoot: join(repositoryRoot, ".agentpatchcheck", "worktrees"),
						agentAdapter: "harness-native",
					}) as TaskPolicy,
				createWorkspace: async (options): Promise<IsolatedWorkspace> => ({
					runId: options.runId,
					repositoryPath: options.repositoryPath,
					path: worktreePath,
					baseRef: options.baseRef,
					baseCommit: options.baseCommit,
				}),
				executeAgent: async (policy) => {
					receivedPolicy = policy;
					return fakeAgent();
				},
				collectModelPatch: async () => ({
					modelPatch: "diff --git a/gin.go b/gin.go\n",
					changedFiles: ["gin.go"],
				}),
			},
		);

		expect(receivedPolicy).toMatchObject({
			prompt: instance.problem_statement,
			baseRef: instance.base_commit,
			runId: "swebench-test",
		});
		expect(result.mutationOccurred).toBe(true);
		expect(result.changedFiles).toEqual(["gin.go"]);
		expect(result.runIdentity).toMatchObject({
			experiment: "swe-bench/SWE-Bench_Multilingual",
			task: instance.instance_id,
			attempt: 1,
			repository: instance.repo,
			baseCommit: instance.base_commit,
		});
		expect(JSON.parse((await readFile(outputPath, "utf8")).trim())).toEqual(result.prediction);
	});
});
