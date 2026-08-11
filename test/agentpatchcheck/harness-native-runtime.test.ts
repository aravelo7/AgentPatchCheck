import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createHarnessNativeAdapter } from "../../src/agentpatchcheck/agent-adapter";
import {
	type HarnessNativeModelProvider,
	runHarnessNativeRuntime,
} from "../../src/agentpatchcheck/harness-native-runtime";
import { validateTaskPolicy } from "../../src/agentpatchcheck/task-policy";

describe("Harness-native Agent Runtime", () => {
	it("runs a bounded multi-step read, observation, patch, and finish loop", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			const policy = await validateTaskPolicy({
				repositoryRoot: process.cwd(),
				prompt: "Update README.",
				agentAdapter: "harness-native",
				model: "test-model",
				nativeAgent: { maxIterations: 4, maxToolCalls: 3 },
			});
			const provider: HarnessNativeModelProvider = {
				id: "openai-responses",
				decide: async ({ observations }) => {
					if (observations.length === 0)
						return { decision: { kind: "tool", tool: "read-file", arguments: { path: "README.md" } } };
					if (observations.length === 1 && observations[0]?.includes("before"))
						return {
							decision: { kind: "tool", tool: "search-text", arguments: { path: ".", query: "before" } },
						};
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
			const result = await createHarnessNativeAdapter(provider).execute({ policy, worktreePath: worktree });
			expect(result).toMatchObject({
				executable: "harness-native",
				exitCode: 0,
				runtime: { iterations: 4, toolCalls: 3, terminationReason: "finished" },
			});
			expect(await readFile(join(worktree, "README.md"), "utf8")).toBe("after\n");
			expect(result.runtime?.trajectory.map((step) => step.tool)).toEqual([
				"read-file",
				"search-text",
				"apply-patch",
				null,
			]);
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("rejects workspace escapes and unregistered tools while enforcing tool budgets", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			const provider: HarnessNativeModelProvider = {
				id: "openai-responses",
				decide: async ({ observations }) =>
					observations.length === 0
						? { decision: { kind: "tool", tool: "read-file", arguments: { path: "../outside.txt" } } }
						: { decision: { kind: "tool", tool: "shell", arguments: {} } },
			};
			const result = await runHarnessNativeRuntime({
				policy: { provider: "openai-responses", maxIterations: 3, maxToolCalls: 2, maxObservationBytes: 1024 },
				prompt: "untrusted",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});
			expect(result).toMatchObject({ status: "failed", terminationReason: "tool-limit", toolCalls: 2 });
			expect(result.trajectory.map((step) => step.toolStatus)).toEqual(["rejected", "rejected"]);
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});
});
