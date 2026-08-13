import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createHarnessNativeAdapter } from "../../src/agentpatchcheck/agent-adapter";
import {
	type HarnessNativeModelProvider,
	runHarnessNativeRuntime,
} from "../../src/agentpatchcheck/harness-native-runtime";
import { createModelProvider } from "../../src/agentpatchcheck/model-provider";
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
				nativeAgent: { credentialRef: "openai-primary", maxIterations: 4, maxToolCalls: 3 },
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
			const result = await createHarnessNativeAdapter(provider).execute({
				policy,
				worktreePath: worktree,
				repairContext: { phase: "initial", publicVerificationFeedback: null },
			});
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
				policy: testNativePolicy({ maxIterations: 3, maxToolCalls: 2 }),
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

	it("searches bounded recursive regular workspace files while excluding state and dependency paths", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await mkdir(join(worktree, "src", "feature"), { recursive: true });
			await mkdir(join(worktree, "node_modules", "package"), { recursive: true });
			await mkdir(join(worktree, ".agentpatchcheck", "state"), { recursive: true });
			await mkdir(join(worktree, "depth-1", "depth-2", "depth-3", "depth-4", "depth-5"), {
				recursive: true,
			});
			await writeFile(join(worktree, "src", "feature", "target.ts"), "const needle = true;\n", "utf8");
			await writeFile(join(worktree, "node_modules", "package", "ignored.js"), "needle\n", "utf8");
			await writeFile(join(worktree, ".agentpatchcheck", "state", "ignored.txt"), "needle\n", "utf8");
			await writeFile(join(worktree, ".env"), "SECRET=needle\n", "utf8");
			await writeFile(
				join(worktree, "depth-1", "depth-2", "depth-3", "depth-4", "included.txt"),
				"needle\n",
				"utf8",
			);
			await writeFile(
				join(worktree, "depth-1", "depth-2", "depth-3", "depth-4", "depth-5", "excluded.txt"),
				"needle\n",
				"utf8",
			);
			let observation = "";
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async ({ observations }) => {
					if (observations.length === 0)
						return {
							decision: {
								kind: "tool",
								tool: "search-text-recursive",
								arguments: { path: ".", query: "needle" },
							},
						};
					observation = observations[0] ?? "";
					return { decision: { kind: "finish" } };
				},
			};
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 2, maxToolCalls: 1 }),
				prompt: "Find source occurrences.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});

			expect(result).toMatchObject({ status: "succeeded", toolCalls: 1 });
			expect(result.trajectory[0]).toMatchObject({ tool: "search-text-recursive", toolStatus: "ok" });
			expect(observation).toContain("src/feature/target.ts:1:const needle = true;");
			expect(observation).toContain("depth-1/depth-2/depth-3/depth-4/included.txt:1:needle");
			expect(observation).not.toContain("node_modules");
			expect(observation).not.toContain(".agentpatchcheck");
			expect(observation).not.toContain("SECRET");
			expect(observation).not.toContain("depth-5");
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("creates one new UTF-8 workspace file exclusively", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async ({ observations }) =>
					observations.length === 0
						? {
								decision: {
									kind: "tool",
									tool: "create-file",
									arguments: { path: "new-file.txt", content: "created\\n" },
								},
							}
						: { decision: { kind: "finish" } },
			};
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 2, maxToolCalls: 1 }),
				prompt: "Create one file.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});

			expect(result).toMatchObject({ status: "succeeded", toolCalls: 1 });
			expect(result.trajectory[0]).toMatchObject({ tool: "create-file", toolStatus: "ok" });
			expect(await readFile(join(worktree, "new-file.txt"), "utf8")).toBe("created\\n");
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("applies a fully preflighted multi-file patch batch", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "first.txt"), "first-before\n", "utf8");
			await writeFile(join(worktree, "second.txt"), "second-before\n", "utf8");
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async ({ observations }) =>
					observations.length === 0
						? {
								decision: {
									kind: "tool",
									tool: "apply-patch-batch",
									arguments: {
										patches: [
											{ path: "first.txt", expectedText: "first-before", replacementText: "first-after" },
											{ path: "second.txt", expectedText: "second-before", replacementText: "second-after" },
										],
									},
								},
							}
						: { decision: { kind: "finish" } },
			};
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 2, maxToolCalls: 1 }),
				prompt: "Update two files.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});

			expect(result).toMatchObject({ status: "succeeded", toolCalls: 1 });
			expect(result.trajectory[0]).toMatchObject({ tool: "apply-patch-batch", toolStatus: "ok" });
			expect(await readFile(join(worktree, "first.txt"), "utf8")).toBe("first-after\n");
			expect(await readFile(join(worktree, "second.txt"), "utf8")).toBe("second-after\n");
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("rejects an invalid multi-file patch batch without changing any target", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "first.txt"), "first-before\n", "utf8");
			await writeFile(join(worktree, "second.txt"), "second-before\n", "utf8");
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async ({ observations }) =>
					observations.length === 0
						? {
								decision: {
									kind: "tool",
									tool: "apply-patch-batch",
									arguments: {
										patches: [
											{ path: "first.txt", expectedText: "first-before", replacementText: "first-after" },
											{ path: "second.txt", expectedText: "missing", replacementText: "second-after" },
										],
									},
								},
							}
						: { decision: { kind: "finish" } },
			};
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 2, maxToolCalls: 1 }),
				prompt: "Try an invalid batch.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});

			expect(result.trajectory[0]).toMatchObject({ tool: "apply-patch-batch", toolStatus: "rejected" });
			expect(await readFile(join(worktree, "first.txt"), "utf8")).toBe("first-before\n");
			expect(await readFile(join(worktree, "second.txt"), "utf8")).toBe("second-before\n");
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("rejects new-file overwrite, missing-parent, and workspace-escape attempts", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "existing.txt"), "original\\n", "utf8");
			const requests = [
				{ path: "existing.txt", content: "overwrite" },
				{ path: "missing/new.txt", content: "missing parent" },
				{ path: "../outside.txt", content: "escape" },
			];
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async ({ observations }) =>
					observations.length < requests.length
						? {
								decision: {
									kind: "tool",
									tool: "create-file",
									arguments: requests[observations.length] ?? {},
								},
							}
						: { decision: { kind: "finish" } },
			};
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 4, maxToolCalls: 3 }),
				prompt: "Try invalid creates.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});

			expect(result).toMatchObject({ status: "succeeded", toolCalls: 3 });
			expect(result.trajectory.map((step) => step.toolStatus)).toEqual(["rejected", "rejected", "rejected", null]);
			expect(await readFile(join(worktree, "existing.txt"), "utf8")).toBe("original\\n");
			await expect(readFile(join(worktree, "missing", "new.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("preflights a tool batch, then executes and replays each call sequentially", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			const observedResults: string[] = [];
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async ({ observations }) =>
					observations.length === 0
						? {
								decision: {
									kind: "tool-batch",
									calls: [
										{
											kind: "tool",
											callId: "call-read",
											tool: "read-file",
											arguments: { path: "README.md" },
										},
										{ kind: "tool", callId: "call-status", tool: "git-status", arguments: {} },
									],
								},
							}
						: { decision: { kind: "finish" } },
				createSession: () => ({
					decide: async (context) => provider.decide(context),
					recordToolResults: (results) => observedResults.push(...results.map((result) => result.callId)),
				}),
			};
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 2, maxToolCalls: 2 }),
				prompt: "Inspect.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});

			expect(result).toMatchObject({
				status: "succeeded",
				iterations: 2,
				toolCalls: 2,
				terminationReason: "finished",
			});
			expect(result.trajectory.map((step) => [step.iteration, step.tool])).toEqual([
				[1, "read-file"],
				[1, "git-status"],
				[2, null],
			]);
			expect(observedResults).toEqual(["call-read", "call-status"]);
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("rejects an over-budget batch before executing any call", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			await writeFile(join(worktree, "README.md"), "before\n", "utf8");
			const provider: HarnessNativeModelProvider = {
				id: "test-provider",
				decide: async () => ({
					decision: {
						kind: "tool-batch",
						calls: [
							{ kind: "tool", tool: "read-file", arguments: { path: "README.md" } },
							{ kind: "tool", tool: "git-status", arguments: {} },
						],
					},
				}),
			};
			const result = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 2, maxToolCalls: 1 }),
				prompt: "Inspect.",
				model: "test-model",
				worktreePath: worktree,
				provider,
				timeoutMs: 1_000,
			});

			expect(result).toMatchObject({
				status: "failed",
				iterations: 1,
				terminationReason: "tool-limit",
				toolCalls: 0,
			});
			expect(result.trajectory).toEqual([]);
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});

	it("records normalized provider failures without retaining provider error content", async () => {
		const worktree = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-runtime-"));
		try {
			const transportError = Object.assign(new Error("connection contained secret-value"), {
				cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
			});
			const timeoutProvider = createModelProvider(testProviderConfiguration(), {
				fetcher: async () => {
					throw transportError;
				},
				resolveCredential: () => ({ ok: true, credentialRef: "openai-primary", secret: "test-key" }),
			});
			const timeout = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 1, maxToolCalls: 1 }),
				prompt: "do not retain this prompt",
				model: "test-model",
				worktreePath: worktree,
				provider: timeoutProvider,
				timeoutMs: 1_000,
			});
			expect(timeout).toMatchObject({
				status: "failed",
				terminationReason: "model-failed",
				providerFailure: {
					kind: "timeout",
					code: "UND_ERR_CONNECT_TIMEOUT",
					httpStatus: null,
					requestId: null,
				},
			});
			expect(JSON.stringify(timeout)).not.toContain("secret-value");

			const httpProvider = createModelProvider(testProviderConfiguration(), {
				fetcher: async () =>
					new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "do not retain this" } }), {
						status: 429,
						headers: { "content-type": "application/json", "x-request-id": "req_test-123" },
					}),
				resolveCredential: () => ({ ok: true, credentialRef: "openai-primary", secret: "test-key" }),
			});
			const http = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 1, maxToolCalls: 1 }),
				prompt: "do not retain this prompt",
				model: "test-model",
				worktreePath: worktree,
				provider: httpProvider,
				timeoutMs: 1_000,
			});
			expect(http.providerFailure).toEqual({
				kind: "rate-limited",
				detail: null,
				code: "rate_limit_exceeded",
				httpStatus: 429,
				requestId: "req_test-123",
			});
			expect(JSON.stringify(http)).not.toContain("do not retain this");

			const invalidDecisionProvider = createModelProvider(testProviderConfiguration(), {
				fetcher: async () =>
					new Response(
						JSON.stringify({ output: [{ type: "function_call", name: "read-file", arguments: "not-json" }] }),
					),
				resolveCredential: () => ({ ok: true, credentialRef: "openai-primary", secret: "test-key" }),
			});
			const invalidDecision = await runHarnessNativeRuntime({
				policy: testNativePolicy({ maxIterations: 1, maxToolCalls: 1 }),
				prompt: "do not retain this prompt",
				model: "test-model",
				worktreePath: worktree,
				provider: invalidDecisionProvider,
				timeoutMs: 1_000,
			});
			expect(invalidDecision.providerFailure).toEqual({
				kind: "malformed-response",
				detail: "invalid-tool-arguments",
				code: null,
				httpStatus: null,
				requestId: null,
			});
		} finally {
			await rm(worktree, { recursive: true, force: true });
		}
	});
});

function testProviderConfiguration() {
	return {
		provider: "openai" as const,
		protocol: "responses" as const,
		thinkingMode: "default" as const,
		baseUrl: "https://api.openai.com/v1",
		endpointSha256: "a".repeat(64),
		credentialRef: "openai-primary",
		implementation: "openai-compatible-v1" as const,
	};
}

function testNativePolicy(options: { maxIterations: number; maxToolCalls: number }) {
	return {
		modelProvider: testProviderConfiguration(),
		maxIterations: options.maxIterations,
		maxToolCalls: options.maxToolCalls,
		maxObservationBytes: 1024,
	};
}
