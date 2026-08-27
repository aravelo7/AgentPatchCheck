import { describe, expect, it } from "vitest";

import { applyDeepSeekV4ModelSelection, parseDeepSeekV4Model } from "../../src/agentpatchcheck/deepseek-v4-model";

describe("DeepSeek V4 run selection", () => {
	it("accepts only the explicit V4 model choices", () => {
		expect(parseDeepSeekV4Model(" deepseek-v4-flash ")).toBe("deepseek-v4-flash");
		expect(() => parseDeepSeekV4Model("deepseek-chat")).toThrow("DeepSeek model must be one of");
	});

	it("changes only the selected DeepSeek model", () => {
		const input = {
			repositoryRoot: "D:\\repo",
			prompt: "Repair it.",
			agentAdapter: "harness-native" as const,
			model: "deepseek-v4-pro",
			nativeAgent: {
				provider: "deepseek" as const,
				protocol: "chat-completions" as const,
				thinkingMode: "enabled" as const,
				reasoningEffort: "high" as const,
				credentialRef: "deepseek-primary",
			},
		};
		const selected = applyDeepSeekV4ModelSelection(input, "deepseek-v4-flash");
		expect(selected).toEqual({ ...input, model: "deepseek-v4-flash" });
		expect(selected.nativeAgent).toBe(input.nativeAgent);
	});

	it("does not allow the override to cross the DeepSeek provider boundary", () => {
		expect(() =>
			applyDeepSeekV4ModelSelection(
				{ repositoryRoot: "D:\\repo", prompt: "Repair it.", agentAdapter: "harness-native", nativeAgent: {} },
				"deepseek-v4-flash",
			),
		).toThrow("dedicated DeepSeek provider");
	});
});
