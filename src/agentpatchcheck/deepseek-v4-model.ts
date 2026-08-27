import type { TaskPolicyInput } from "./types";

export const DEEPSEEK_V4_MODELS = ["deepseek-v4-flash", "deepseek-v4-pro"] as const;

export type DeepSeekV4Model = (typeof DEEPSEEK_V4_MODELS)[number];

export function parseDeepSeekV4Model(value: string): DeepSeekV4Model {
	const model = value.trim();
	if ((DEEPSEEK_V4_MODELS as readonly string[]).includes(model)) return model as DeepSeekV4Model;
	throw new Error(`DeepSeek model must be one of: ${DEEPSEEK_V4_MODELS.join(", ")}.`);
}

/**
 * Applies a run-local model selection without mutating the frozen TaskSpec or
 * changing any provider, protocol, reasoning, tool, or budget configuration.
 */
export function applyDeepSeekV4ModelSelection(
	input: TaskPolicyInput,
	model: DeepSeekV4Model | undefined,
): TaskPolicyInput {
	if (model === undefined) return input;
	if (input.agentAdapter !== "harness-native" || input.nativeAgent?.provider !== "deepseek") {
		throw new Error("--deepseek-model requires a Harness-native TaskSpec using the dedicated DeepSeek provider.");
	}
	return { ...input, model };
}
