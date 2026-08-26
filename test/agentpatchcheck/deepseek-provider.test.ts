import { describe, expect, it } from "vitest";

import { parseDeepSeekChatResponse, serializeDeepSeekChatRequest } from "../../src/agentpatchcheck/deepseek-provider";
import { createModelProvider, type ModelProviderContext } from "../../src/agentpatchcheck/model-provider";
import type { ModelProviderConfiguration } from "../../src/agentpatchcheck/types";

const context: ModelProviderContext = {
	prompt: "Inspect src/value.ts.",
	patchExpectation: "changes-required",
	observations: [],
	tools: ["read-file"],
	model: "deepseek-v4-pro",
	repairContext: { phase: "initial", publicVerificationFeedback: null },
	workingContext: {
		version: 1,
		phase: "discovery",
		inspectedPaths: [],
		candidatePaths: [],
		retrieval: { successfulActions: 0, rejectedActions: 0, recent: [] },
		mutation: { successfulActions: 0, paths: [], firstIteration: null },
		publicVerification: { runs: 0, latestStatus: null, latestIteration: null },
	},
};

function configuration(
	thinkingMode: ModelProviderConfiguration["thinkingMode"] = "enabled",
): ModelProviderConfiguration {
	return {
		provider: "deepseek",
		protocol: "chat-completions",
		thinkingMode,
		reasoningEffort: thinkingMode === "disabled" ? null : "max",
		baseUrl: "https://api.deepseek.com/v1",
		endpointSha256: "d".repeat(64),
		credentialRef: "deepseek-primary",
		implementation: "deepseek-official-chat-v1",
	};
}

function deepSeekResponse(callId: string, path: string, reasoning: string) {
	return {
		model: "deepseek-v4-pro",
		choices: [
			{
				finish_reason: "tool_calls",
				message: {
					content: null,
					reasoning_content: reasoning,
					tool_calls: [
						{
							id: callId,
							type: "function",
							function: { name: "read-file", arguments: JSON.stringify({ path }) },
						},
					],
				},
			},
		],
		usage: { prompt_tokens: 17, completion_tokens: 9 },
	};
}

describe("DeepSeek official protocol", () => {
	it("serializes thinking and effort without generic tool_choice", () => {
		const request = serializeDeepSeekChatRequest({
			model: "deepseek-v4-pro",
			messages: [{ role: "user", content: "hello" }],
			tools: [],
			thinkingMode: "enabled",
			reasoningEffort: "max",
		});
		expect(request).toMatchObject({
			model: "deepseek-v4-pro",
			thinking: { type: "enabled" },
			reasoning_effort: "max",
			stream: false,
		});
		expect(request).not.toHaveProperty("tool_choice");
		expect(request).not.toHaveProperty("tools");

		expect(
			serializeDeepSeekChatRequest({
				model: "deepseek-v4-pro",
				messages: [],
				tools: [],
				thinkingMode: "disabled",
			}),
		).toMatchObject({ thinking: { type: "disabled" } });
		expect(
			serializeDeepSeekChatRequest({
				model: "deepseek-v4-pro",
				messages: [],
				tools: [],
				thinkingMode: "default",
			}),
		).not.toHaveProperty("thinking");
	});

	it("parses reasoning, opaque tool IDs, finish reason, and usage", () => {
		const parsed = parseDeepSeekChatResponse(deepSeekResponse("call:opaque/1", "src/value.ts", "inspect it"));
		expect(parsed).toEqual({
			model: "deepseek-v4-pro",
			assistantMessage: {
				role: "assistant",
				content: "",
				reasoning_content: "inspect it",
				tool_calls: [
					{
						id: "call:opaque/1",
						type: "function",
						function: { name: "read-file", arguments: '{"path":"src/value.ts"}' },
					},
				],
			},
			finishReason: "tool_calls",
			usage: { inputTokens: 17, outputTokens: 9 },
		});
	});

	it("parses a content-only completion without inventing a tool call", () => {
		expect(
			parseDeepSeekChatResponse({
				model: "deepseek-v4-pro",
				choices: [
					{
						finish_reason: "stop",
						message: { content: "done", reasoning_content: "checked", tool_calls: null },
					},
				],
			}),
		).toMatchObject({
			assistantMessage: { content: "done", reasoning_content: "checked", tool_calls: [] },
			finishReason: "stop",
		});
	});

	it("round-trips assistant reasoning and matching tool result in one session", async () => {
		const requests: Array<Record<string, unknown>> = [];
		const responses = [
			deepSeekResponse("call:opaque/1", "src/value.ts", "inspect it"),
			deepSeekResponse("call:opaque/2", "src/next.ts", "continue"),
		];
		const provider = createModelProvider(configuration(), {
			resolveCredential: () => ({ ok: true, credentialRef: "deepseek-primary", secret: "test-secret" }),
			fetcher: async (_input, init) => {
				requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
				return new Response(JSON.stringify(responses.shift()), {
					status: 200,
					headers: { "content-type": "application/json", "x-request-id": "request-1" },
				});
			},
		});
		expect(provider.id).toBe("deepseek:chat-completions");
		const session = provider.createSession();
		const first = await session.decide({ ...context, iteration: 1 });
		expect(first.decision).toMatchObject({ kind: "tool", callId: "call:opaque/1" });
		expect(requests[0]).toMatchObject({
			thinking: { type: "enabled" },
			reasoning_effort: "max",
		});
		expect(requests[0]?.tools).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "function",
					function: expect.objectContaining({ name: "read-file" }),
				}),
			]),
		);
		session.recordToolResults([
			{
				callId: "call:opaque/1",
				tool: "read-file",
				status: "ok",
				observation: "export const value = 1;",
			},
		]);
		await session.decide({ ...context, iteration: 2 });

		const secondMessages = requests[1]?.messages;
		expect(secondMessages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "assistant",
					content: "",
					reasoning_content: "inspect it",
					tool_calls: [expect.objectContaining({ id: "call:opaque/1" })],
				}),
				{
					role: "tool",
					tool_call_id: "call:opaque/1",
					content: "export const value = 1;",
				},
			]),
		);
		expect(requests[1]).not.toHaveProperty("tool_choice");
	});

	it("keeps shared HTTP failure classification on the dedicated route", async () => {
		const provider = createModelProvider(configuration("disabled"), {
			resolveCredential: () => ({ ok: true, credentialRef: "deepseek-primary", secret: "test-secret" }),
			fetcher: async () =>
				new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), {
					status: 429,
					headers: { "content-type": "application/json", "x-request-id": "request-429" },
				}),
		});
		await expect(provider.decide(context)).rejects.toMatchObject({
			failure: {
				kind: "rate-limited",
				code: "rate_limit_exceeded",
				httpStatus: 429,
				requestId: "request-429",
			},
		});
	});
});
