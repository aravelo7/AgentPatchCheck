import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createHarnessNativeAdapter } from "../../src/agentpatchcheck/agent-adapter";
import { runBenchmark } from "../../src/agentpatchcheck/benchmark-runner";
import { showEvidenceBundle } from "../../src/agentpatchcheck/evidence-show";
import { executeAgentPatchCheck } from "../../src/agentpatchcheck/execute";
import { readEvidenceBundle } from "../../src/agentpatchcheck/git-patch-verifier";
import type { HarnessNativeModelProvider } from "../../src/agentpatchcheck/harness-native-runtime";
import { validateTaskPolicy } from "../../src/agentpatchcheck/task-policy";
import type { BenchmarkDefinition, TaskPolicyInput } from "../../src/agentpatchcheck/types";

const execFile = promisify(execFileCallback);

async function git(repository: string, args: string[]): Promise<void> {
	await execFile("git", args, { cwd: repository, windowsHide: true });
}

const provider: HarnessNativeModelProvider = {
	id: "openai-responses",
	decide: async ({ observations }) => {
		if (observations.length === 0)
			return { decision: { kind: "tool", tool: "read-file", arguments: { path: "README.md" } } };
		if (observations.length === 1 && observations[0]?.includes("before"))
			return { decision: { kind: "tool", tool: "search-text", arguments: { path: ".", query: "before" } } };
		if (observations.length === 2 && observations[1]?.includes("README.md:1:before"))
			return {
				decision: {
					kind: "tool",
					tool: "apply-patch",
					arguments: { path: "README.md", expectedText: "before", replacementText: "after" },
				},
			};
		return { decision: { kind: "finish" } };
	},
};

describe("Harness-native Headless Core E2E", () => {
	it("uses the existing workspace, patch, Evidence, Assessment, show, and Benchmark paths", async () => {
		const repository = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-headless-"));
		try {
			await writeFile(join(repository, "README.md"), "before\n", "utf8");
			await git(repository, ["init"]);
			await git(repository, ["config", "user.email", "fixture@example.invalid"]);
			await git(repository, ["config", "user.name", "Fixture"]);
			await git(repository, ["add", "."]);
			await git(repository, ["commit", "-m", "base"]);
			const input: TaskPolicyInput = {
				repositoryRoot: repository,
				prompt: "Update the existing README.",
				agentAdapter: "harness-native",
				model: "test-model",
				nativeAgent: { maxIterations: 5, maxToolCalls: 4 },
				patchExpectation: "changes-required",
				verification: {
					commands: [
						{
							command: process.execPath,
							args: [
								"-e",
								"const fs=require('node:fs');process.exit(fs.readFileSync('README.md','utf8').startsWith('after')?0:1)",
							],
						},
					],
				},
			};
			const definition: BenchmarkDefinition = {
				version: 1,
				sourcePath: join(repository, "native-benchmark.json"),
				sourceSha256: "native-e2e-benchmark",
				name: "native-e2e",
				suite: { id: "native-e2e", fixtureVersion: "v1" },
				tasks: [
					{
						id: "native",
						taskSpecPath: "native.json",
						taskSpecSha256: "native-e2e-task",
						expectedStatus: "passed",
					},
				],
			};
			const result = await runBenchmark(definition, {
				loadTaskSpec: async () => input,
				validateTaskPolicy,
				execute: async (policy) =>
					await executeAgentPatchCheck(policy, {
						runAgent: async (nativePolicy, worktreePath) =>
							await createHarnessNativeAdapter(provider).execute({ policy: nativePolicy, worktreePath }),
					}),
				readAgentVersion: async () => null,
			});
			const task = result.report.tasks[0];
			if (task?.evidence === null || task?.evidence === undefined)
				throw new Error("Native benchmark did not write Evidence.");
			const evidence = await readEvidenceBundle(task.evidence.path);
			const shown = await showEvidenceBundle({ evidencePath: task.evidence.path });
			expect(result.report.tasks[0]).toMatchObject({
				status: "passed",
				configuration: { agentAdapter: "harness-native" },
			});
			expect(evidence.patch.changedFiles).toEqual(["README.md"]);
			expect(evidence.agent.runtime?.trajectory.map((step) => step.tool)).toEqual([
				"read-file",
				"search-text",
				"apply-patch",
				null,
			]);
			expect(shown.agent.runtime).toMatchObject({ terminationReason: "finished", toolCalls: 3 });
			expect((await readFile(join(evidence.workspace.path, "README.md"), "utf8")).replaceAll("\r\n", "\n")).toBe(
				"after\n",
			);
		} finally {
			await rm(repository, { recursive: true, force: true });
		}
	}, 30_000);

	it("repairs a public verification failure once before the Hidden Oracle runs", async () => {
		const repository = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-repair-"));
		const oracleDirectory = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-oracle-"));
		try {
			await writeFile(join(repository, "README.md"), "before\n", "utf8");
			await writeFile(
				join(oracleDirectory, "oracle.mjs"),
				"import { readFileSync } from 'node:fs'; const path = process.env.AGENTPATCHCHECK_ORACLE_WORKTREE + '/README.md'; process.exit(readFileSync(path, 'utf8').startsWith('after') ? 0 : 1);\n",
				"utf8",
			);
			await git(repository, ["init"]);
			await git(repository, ["config", "user.email", "fixture@example.invalid"]);
			await git(repository, ["config", "user.name", "Fixture"]);
			await git(repository, ["add", "."]);
			await git(repository, ["commit", "-m", "base"]);
			const policy = await validateTaskPolicy({
				repositoryRoot: repository,
				prompt: "Update the existing README.",
				agentAdapter: "harness-native",
				model: "test-model",
				nativeAgent: { maxIterations: 3, maxToolCalls: 1 },
				patchExpectation: "changes-required",
				verification: {
					commands: [
						{
							command: process.execPath,
							args: [
								"-e",
								"const fs=require('node:fs');process.exit(fs.readFileSync('README.md','utf8').startsWith('after')?0:1)",
							],
						},
					],
				},
				hiddenOracle: { scriptPath: join(oracleDirectory, "oracle.mjs") },
			});
			let repairDecisions = 0;
			const repairProvider: HarnessNativeModelProvider = {
				id: "openai-responses",
				decide: async ({ observations, publicVerificationFeedback }) => {
					if (observations.length === 0) {
						if (publicVerificationFeedback === undefined)
							return {
								decision: {
									kind: "tool",
									tool: "apply-patch",
									arguments: {
										path: "README.md",
										expectedText: "before",
										replacementText: "invalid",
									},
								},
							};
						repairDecisions += 1;
						return {
							decision: {
								kind: "tool",
								tool: "apply-patch",
								arguments: {
									path: "README.md",
									expectedText: "invalid",
									replacementText: "after",
								},
							},
						};
					}
					return { decision: { kind: "finish" } };
				},
			};
			const result = await executeAgentPatchCheck(policy, {
				runAgent: async (nativePolicy, worktreePath, publicVerificationFeedback) =>
					await createHarnessNativeAdapter(repairProvider).execute({
						policy: nativePolicy,
						worktreePath,
						publicVerificationFeedback,
					}),
			});

			expect(repairDecisions).toBe(1);
			expect(result.commandVerification.status).toBe("passed");
			expect(result.hiddenOracle).toMatchObject({ status: "passed" });
			expect(result.agent.attempts).toHaveLength(2);
			expect(result.agent.attempts?.map((attempt) => attempt.phase)).toEqual([
				"initial",
				"public-verification-repair",
			]);
			expect(result.agent.attempts?.[1]?.feedback).toMatchObject({
				status: "failed",
				commands: [{ exitCode: 1 }],
			});
			expect((await readFile(join(result.workspace.path, "README.md"), "utf8")).replaceAll("\r\n", "\n")).toBe(
				"after\n",
			);
		} finally {
			await rm(repository, { recursive: true, force: true });
			await rm(oracleDirectory, { recursive: true, force: true });
		}
	}, 30_000);

	it("does not retry a second time when the one public repair still fails verification", async () => {
		const repository = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-repair-limit-"));
		try {
			await writeFile(join(repository, "README.md"), "before\n", "utf8");
			await git(repository, ["init"]);
			await git(repository, ["config", "user.email", "fixture@example.invalid"]);
			await git(repository, ["config", "user.name", "Fixture"]);
			await git(repository, ["add", "."]);
			await git(repository, ["commit", "-m", "base"]);
			const policy = await validateTaskPolicy({
				repositoryRoot: repository,
				prompt: "Update the existing README.",
				agentAdapter: "harness-native",
				model: "test-model",
				nativeAgent: { maxIterations: 3, maxToolCalls: 1 },
				verification: {
					commands: [
						{
							command: process.execPath,
							args: [
								"-e",
								"const fs=require('node:fs');process.exit(fs.readFileSync('README.md','utf8').startsWith('after')?0:1)",
							],
						},
					],
				},
			});
			let repairDecisions = 0;
			const provider: HarnessNativeModelProvider = {
				id: "openai-responses",
				decide: async ({ observations, publicVerificationFeedback }) => {
					if (observations.length > 0) return { decision: { kind: "finish" } };
					if (publicVerificationFeedback === undefined)
						return {
							decision: {
								kind: "tool",
								tool: "apply-patch",
								arguments: { path: "README.md", expectedText: "before", replacementText: "invalid" },
							},
						};
					repairDecisions += 1;
					return {
						decision: {
							kind: "tool",
							tool: "apply-patch",
							arguments: { path: "README.md", expectedText: "invalid", replacementText: "still-invalid" },
						},
					};
				},
			};
			const result = await executeAgentPatchCheck(policy, {
				runAgent: async (nativePolicy, worktreePath, publicVerificationFeedback) =>
					await createHarnessNativeAdapter(provider).execute({
						policy: nativePolicy,
						worktreePath,
						publicVerificationFeedback,
					}),
			});

			expect(repairDecisions).toBe(1);
			expect(result.commandVerification.status).toBe("failed");
			expect(result.agent.attempts).toHaveLength(2);
		} finally {
			await rm(repository, { recursive: true, force: true });
		}
	}, 30_000);
});
