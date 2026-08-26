import { describe, expect, it } from "vitest";

import { type ClineRuntimeFactory, createClineRuntimeAdapter } from "../../src/agentpatchcheck/cline-runtime-adapter";
import { validateTaskPolicy } from "../../src/agentpatchcheck/task-policy";

describe("Cline control runtime adapter", () => {
	it("constructs the public Cline runtime with the validated provider and Harness-owned tools", async () => {
		const original = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "test-secret";
		type RuntimeConfiguration = Parameters<ClineRuntimeFactory>[0];
		const capturedConfigurations: RuntimeConfiguration[] = [];
		const factory = ((config: RuntimeConfiguration) => {
			capturedConfigurations.push(config);
			return {
				run: async () => ({
					agentId: "control",
					runId: "control-run",
					status: "completed" as const,
					iterations: 1,
					outputText: "",
					messages: [],
					usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
				}),
				abort: () => undefined,
				subscribe: () => () => undefined,
			};
		}) as unknown as ClineRuntimeFactory;
		try {
			const policy = await validateTaskPolicy({
				repositoryRoot: process.cwd(),
				prompt: "Inspect the managed workspace.",
				agentAdapter: "cline-runtime",
				model: "test-model",
				nativeAgent: { credentialRef: "openai-primary", clineProviderId: "openai-native" },
				patchExpectation: "changes-optional",
			});
			const result = await createClineRuntimeAdapter(factory).execute({
				policy,
				worktreePath: process.cwd(),
				repairContext: { phase: "initial", publicVerificationFeedback: null },
			});

			const captured = capturedConfigurations[0];
			if (captured === undefined) throw new Error("Cline runtime factory was not called.");
			expect(captured).toMatchObject({ providerId: "openai-native", modelId: "test-model", maxIterations: 12 });
			expect(captured.tools?.map((tool) => tool.name)).toContain("finish");
			expect(captured.tools?.map((tool) => tool.name)).toContain("apply-patch");
			expect(result).toMatchObject({
				exitCode: 0,
				clineRuntime: { status: "succeeded", terminationReason: "finished" },
			});
		} finally {
			if (original === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = original;
		}
	});

	it("persists a bounded model-request and Harness-rejection lifecycle trace", async () => {
		const original = process.env.OPENAI_API_KEY;
		process.env.OPENAI_API_KEY = "test-secret";
		type RuntimeConfiguration = Parameters<ClineRuntimeFactory>[0];
		let listener: ((event: { type: string }) => void) | null = null;
		const factory = ((config: RuntimeConfiguration) => ({
			run: async () => {
				listener?.({ type: "turn-started", iteration: 1 } as unknown as { type: string });
				listener?.({
					type: "tool-started",
					iteration: 1,
					toolCall: { toolName: "read-file", input: { path: "../outside.txt" } },
				} as unknown as { type: string });
				const readFile = (config.tools ?? []).find((tool) => tool.name === "read-file");
				if (readFile === undefined) throw new Error("read-file tool was not registered.");
				await readFile.execute({ path: "../outside.txt" }, { agentId: "control", iteration: 1 });
				return {
					agentId: "control",
					runId: "control-run",
					status: "completed" as const,
					iterations: 1,
					outputText: "",
					messages: [],
					usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
				};
			},
			abort: () => undefined,
			subscribe: (nextListener: (event: { type: string }) => void) => {
				listener = nextListener;
				return () => {
					listener = null;
				};
			},
		})) as unknown as ClineRuntimeFactory;
		try {
			const policy = await validateTaskPolicy({
				repositoryRoot: process.cwd(),
				prompt: "Inspect the managed workspace.",
				agentAdapter: "cline-runtime",
				model: "test-model",
				nativeAgent: { credentialRef: "openai-primary", clineProviderId: "openai-native" },
				patchExpectation: "changes-optional",
			});
			const result = await createClineRuntimeAdapter(factory).execute({
				policy,
				worktreePath: process.cwd(),
				repairContext: { phase: "initial", publicVerificationFeedback: null },
			});

			expect(result.clineRuntime?.trajectory).toEqual([
				{
					iteration: 1,
					sequence: 1,
					tool: "read-file",
					arguments: { path: "../outside.txt" },
					stage: "requested",
					status: null,
					rejection: null,
					observationSummary: null,
				},
				{
					iteration: 1,
					sequence: 2,
					tool: "read-file",
					arguments: { path: "../outside.txt" },
					stage: "executed",
					status: "rejected",
					rejection: {
						kind: "harness-policy",
						detail: "Tool path is outside the managed workspace.",
					},
					observationSummary: "Tool path is outside the managed workspace.",
				},
			]);
		} finally {
			if (original === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = original;
		}
	});
});
