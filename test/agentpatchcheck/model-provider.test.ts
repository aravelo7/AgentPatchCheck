import { describe, expect, it } from "vitest";

import { resolveCredential } from "../../src/agentpatchcheck/credential-resolver";
import { createModelProvider } from "../../src/agentpatchcheck/model-provider";
import type { ModelProviderConfiguration } from "../../src/agentpatchcheck/types";

const context = {
	prompt: "Update README.",
	observations: [],
	tools: ["read-file", "list-directory", "search-text", "git-status", "git-diff", "apply-patch"] as const,
	model: "test-model",
};

function configuration(protocol: ModelProviderConfiguration["protocol"]): ModelProviderConfiguration {
	return {
		provider: "openai-compatible",
		protocol,
		baseUrl: "http://127.0.0.1:4010/v1",
		endpointSha256: "a".repeat(64),
		credentialRef: "provider-a-primary",
		implementation: "openai-compatible-v1",
	};
}

describe("Model Provider Registry", () => {
	it("normalizes an OpenAI-compatible Responses tool call without retaining the credential", async () => {
		let requestUrl = "";
		let requestBody = "";
		const provider = createModelProvider(configuration("responses"), {
			fetcher: async (input, init) => {
				requestUrl = input.toString();
				requestBody = typeof init?.body === "string" ? init.body : "";
				return new Response(
					JSON.stringify({
						model: "gateway-model-v1",
						usage: { input_tokens: 12, output_tokens: 7 },
						output: [{ type: "function_call", name: "read-file", arguments: '{"path":"README.md"}' }],
					}),
				);
			},
			resolveCredential: () => ({ ok: true, credentialRef: "provider-a-primary", secret: "fake-secret" }),
		});

		const result = await provider.decide(context);
		expect(requestUrl).toBe("http://127.0.0.1:4010/v1/responses");
		expect(requestBody).not.toContain("fake-secret");
		expect(result).toEqual({
			decision: { kind: "tool", tool: "read-file", arguments: { path: "README.md" } },
			usage: { inputTokens: 12, outputTokens: 7 },
			actualModel: "gateway-model-v1",
		});
	});

	it("normalizes an OpenAI-compatible Chat Completions finish function", async () => {
		const provider = createModelProvider(configuration("chat-completions"), {
			fetcher: async (input) => {
				expect(input.toString()).toBe("http://127.0.0.1:4010/v1/chat/completions");
				return new Response(
					JSON.stringify({
						model: "gateway-chat-v1",
						usage: { prompt_tokens: 8, completion_tokens: 2 },
						choices: [
							{
								message: {
									tool_calls: [{ function: { name: "finish", arguments: "{}" } }],
								},
							},
						],
					}),
				);
			},
			resolveCredential: () => ({ ok: true, credentialRef: "provider-a-primary", secret: "fake-secret" }),
		});

		await expect(provider.decide(context)).resolves.toEqual({
			decision: { kind: "finish" },
			usage: { inputTokens: 8, outputTokens: 2 },
			actualModel: "gateway-chat-v1",
		});
	});

	it("normalizes finish and tool calls for both supported wire protocols", async () => {
		const responsesFinish = createModelProvider(configuration("responses"), {
			fetcher: async () =>
				new Response(JSON.stringify({ output: [{ type: "function_call", name: "finish", arguments: "{}" }] })),
			resolveCredential: () => ({ ok: true, credentialRef: "provider-a-primary", secret: "fake-secret" }),
		});
		await expect(responsesFinish.decide(context)).resolves.toMatchObject({ decision: { kind: "finish" } });

		const chatTool = createModelProvider(configuration("chat-completions"), {
			fetcher: async () =>
				new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									tool_calls: [{ function: { name: "git-status", arguments: "{}" } }],
								},
							},
						],
					}),
				),
			resolveCredential: () => ({ ok: true, credentialRef: "provider-a-primary", secret: "fake-secret" }),
		});
		await expect(chatTool.decide(context)).resolves.toMatchObject({
			decision: { kind: "tool", tool: "git-status", arguments: {} },
		});
	});

	it("rejects plain chat output rather than silently treating it as a completion", async () => {
		const provider = createModelProvider(configuration("chat-completions"), {
			fetcher: async () => new Response(JSON.stringify({ choices: [{ message: { content: "done" } }] })),
			resolveCredential: () => ({ ok: true, credentialRef: "provider-a-primary", secret: "fake-secret" }),
		});

		await expect(provider.decide(context)).rejects.toMatchObject({
			failure: { kind: "unsupported-tool-calling", httpStatus: null, requestId: null },
		});
	});

	it("resolves fixed credential references and fails without exposing a credential", async () => {
		expect(resolveCredential("openai-primary", { OPENAI_API_KEY: "first" })).toEqual({
			ok: true,
			credentialRef: "openai-primary",
			secret: "first",
		});
		expect(resolveCredential("openai-secondary", { OPENAI_API_KEY_SECONDARY: "second" })).toEqual({
			ok: true,
			credentialRef: "openai-secondary",
			secret: "second",
		});
		expect(resolveCredential("unknown", {})).toEqual({
			ok: false,
			kind: "invalid-credential-reference",
			credentialRef: "unknown",
		});
		const provider = createModelProvider(configuration("responses"), {
			fetcher: async () => new Response(),
			resolveCredential: () => ({ ok: false, kind: "missing-credential", credentialRef: "provider-a-primary" }),
		});
		await expect(provider.decide(context)).rejects.toMatchObject({
			failure: {
				kind: "missing-credential",
				code: "provider-a-primary",
				httpStatus: null,
				requestId: null,
			},
		});
	});
});
