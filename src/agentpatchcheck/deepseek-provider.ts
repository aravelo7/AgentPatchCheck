import type { ModelProviderReasoningEffort, ModelProviderThinkingMode } from "./types";

export interface DeepSeekFunctionTool {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

export interface DeepSeekAssistantMessage {
	role: "assistant";
	content: string;
	reasoning_content?: string;
	tool_calls: DeepSeekToolCall[];
}

export interface DeepSeekToolMessage {
	role: "tool";
	tool_call_id: string;
	content: string;
}

export interface DeepSeekToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export type DeepSeekMessage =
	| { role: "system" | "user"; content: string }
	| DeepSeekAssistantMessage
	| DeepSeekToolMessage;

export interface DeepSeekChatRequestInput {
	model: string;
	messages: DeepSeekMessage[];
	tools: DeepSeekFunctionTool[];
	thinkingMode: ModelProviderThinkingMode;
	reasoningEffort?: ModelProviderReasoningEffort | null;
}

export interface DeepSeekChatResponse {
	model?: string;
	assistantMessage: DeepSeekAssistantMessage;
	finishReason: string | null;
	usage: { inputTokens?: number; outputTokens?: number };
}

export class DeepSeekProtocolError extends Error {
	constructor(readonly detail: "invalid-response" | "invalid-tool-call-shape") {
		super(`DeepSeek protocol response is invalid: ${detail}.`);
	}
}

/** Official DeepSeek request shape, following DSH's omission of tool_choice. */
export function serializeDeepSeekChatRequest(input: DeepSeekChatRequestInput): Record<string, unknown> {
	const thinking =
		input.thinkingMode === "default" && input.reasoningEffort == null
			? {}
			: {
					thinking: { type: input.thinkingMode === "disabled" ? "disabled" : "enabled" },
					...(input.thinkingMode === "disabled" || input.reasoningEffort == null
						? {}
						: { reasoning_effort: input.reasoningEffort }),
				};
	return {
		model: input.model,
		messages: input.messages,
		...(input.tools.length === 0 ? {} : { tools: input.tools }),
		...thinking,
		stream: false,
	};
}

export function parseDeepSeekChatResponse(payload: unknown): DeepSeekChatResponse {
	if (typeof payload !== "object" || payload === null) throw new DeepSeekProtocolError("invalid-response");
	const response = payload as {
		model?: unknown;
		usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
		choices?: Array<{
			finish_reason?: unknown;
			message?: { content?: unknown; reasoning_content?: unknown; tool_calls?: unknown };
		}>;
	};
	if (!Array.isArray(response.choices) || response.choices.length === 0)
		throw new DeepSeekProtocolError("invalid-response");
	const choice = response.choices[0];
	const message = choice?.message;
	if (typeof message !== "object" || message === null) throw new DeepSeekProtocolError("invalid-response");
	if (message.content !== null && message.content !== undefined && typeof message.content !== "string")
		throw new DeepSeekProtocolError("invalid-response");
	if (
		message.reasoning_content !== null &&
		message.reasoning_content !== undefined &&
		typeof message.reasoning_content !== "string"
	)
		throw new DeepSeekProtocolError("invalid-response");
	const toolCalls = parseToolCalls(message.tool_calls);
	return {
		...(typeof response.model === "string" ? { model: response.model } : {}),
		assistantMessage: {
			role: "assistant",
			content: typeof message.content === "string" ? message.content : "",
			...(typeof message.reasoning_content === "string" && message.reasoning_content.length > 0
				? { reasoning_content: message.reasoning_content }
				: {}),
			tool_calls: toolCalls,
		},
		finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
		usage: parseUsage(response.usage),
	};
}

function parseToolCalls(value: unknown): DeepSeekToolCall[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw new DeepSeekProtocolError("invalid-tool-call-shape");
	return value.map((item) => {
		if (typeof item !== "object" || item === null) throw new DeepSeekProtocolError("invalid-tool-call-shape");
		const call = item as { id?: unknown; type?: unknown; function?: unknown };
		if (
			typeof call.id !== "string" ||
			call.id.length === 0 ||
			call.type !== "function" ||
			typeof call.function !== "object" ||
			call.function === null
		)
			throw new DeepSeekProtocolError("invalid-tool-call-shape");
		const functionCall = call.function as { name?: unknown; arguments?: unknown };
		if (typeof functionCall.name !== "string" || typeof functionCall.arguments !== "string")
			throw new DeepSeekProtocolError("invalid-tool-call-shape");
		return {
			id: call.id,
			type: "function",
			function: { name: functionCall.name, arguments: functionCall.arguments },
		};
	});
}

function parseUsage(value: { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined): {
	inputTokens?: number;
	outputTokens?: number;
} {
	const inputTokens = value?.prompt_tokens;
	const outputTokens = value?.completion_tokens;
	return {
		...(typeof inputTokens === "number" && Number.isSafeInteger(inputTokens) ? { inputTokens } : {}),
		...(typeof outputTokens === "number" && Number.isSafeInteger(outputTokens) ? { outputTokens } : {}),
	};
}
