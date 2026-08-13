import { describe, expect, it } from "vitest";

import { resolveCredential } from "../../src/agentpatchcheck/credential-resolver";
import { createModelProvider } from "../../src/agentpatchcheck/model-provider";
import type { ModelProviderConfiguration } from "../../src/agentpatchcheck/types";

const context = {
	prompt: "Update README.",
	observations: [],
	tools: [
		"read-file",
		"list-directory",
		"search-text",
		"search-text-recursive",
		"git-status",
		"git-diff",
		"apply-patch",
	] as const,
	model: "test-model",
};

function configuration(protocol: ModelProviderConfiguration["protocol"]): ModelProviderConfiguration {
	return {
		provider: "openai-compatible",
		protocol,
		thinkingMode: "default",
		baseUrl: "http://127.0.0.1:4010/v1",
		endpointSha256: "a".repeat(64),
		credentialRef: "provider-a-primary",
		implementation: "openai-compatible-v1",
	};
}

describe("Model Provider Registry", () => {
	it("creates isolated Provider-neutral sessions that accept bounded tool result state", async () => {
		const provider = createModelProvider(configuration("chat-completions"), {
			fetcher: async () =>
				new Response(
					JSON.stringify({
						choices: [{ message: { tool_calls: [{ function: { name: "finish", arguments: "{}" } }] } }],
					}),
				),
			resolveCredential: () => ({ ok: true, credentialRef: "provider-a-primary", secret: "fake-secret" }),
		});
		const firstSession = provider.createSession();
		const secondSession = provider.createSession();

		expect(firstSession).not.toBe(secondSession);
		firstSession.recordToolResults([
			{ callId: "call-1", tool: "git-status", status: "ok", observation: "Git status clean." },
		]);
		await expect(firstSession.decide(context)).resolves.toMatchObject({ decision: { kind: "finish" } });
	});

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
		let requestBody = "";
		const provider = createModelProvider(
			{ ...configuration("chat-completions"), thinkingMode: "disabled" },
			{
				fetcher: async (input, init) => {
					expect(input.toString()).toBe("http://127.0.0.1:4010/v1/chat/completions");
					requestBody = typeof init?.body === "string" ? init.body : "";
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
			},
		);

		await expect(provider.decide(context)).resolves.toMatchObject({
			decision: { kind: "finish" },
			usage: { inputTokens: 8, outputTokens: 2 },
			actualModel: "gateway-chat-v1",
		});
		expect(JSON.parse(requestBody)).toMatchObject({
			tool_choice: "required",
			tools: expect.arrayContaining([
				expect.objectContaining({ function: expect.objectContaining({ name: "finish" }) }),
			]),
		});
	});

	it("requires a function call in every DeepSeek-compatible Chat Completions round", async () => {
		const requestBodies: string[] = [];
		const payloads = [
			{
				choices: [
					{ message: { tool_calls: [{ function: { name: "list-directory", arguments: '{"path":"."}' } }] } },
				],
			},
			{ choices: [{ message: { tool_calls: [{ function: { name: "finish", arguments: "{}" } }] } }] },
		];
		const provider = createModelProvider(
			{ ...configuration("chat-completions"), thinkingMode: "disabled" },
			{
				fetcher: async (_input, init) => {
					requestBodies.push(typeof init?.body === "string" ? init.body : "");
					return new Response(JSON.stringify(payloads.shift()));
				},
				resolveCredential: () => ({ ok: true, credentialRef: "provider-a-primary", secret: "fake-secret" }),
			},
		);

		await expect(provider.decide(context)).resolves.toMatchObject({
			decision: { kind: "tool", tool: "list-directory", arguments: { path: "." } },
		});
		await expect(
			provider.decide({ ...context, observations: ["Listed a workspace directory."] }),
		).resolves.toMatchObject({
			decision: { kind: "finish" },
		});
		expect(requestBodies).toHaveLength(2);
		for (const requestBody of requestBodies) {
			expect(JSON.parse(requestBody)).toMatchObject({ tool_choice: "required", thinking: { type: "disabled" } });
		}
	});

	it("replays every assistant batch tool call and result in order in a Chat session", async () => {
		const requestBodies: Array<Record<string, unknown>> = [];
		const payloads = [
			{
				choices: [
					{
						message: {
							content: "",
							tool_calls: [
								{ id: "call-read", function: { name: "read-file", arguments: '{"path":"README.md"}' } },
								{ id: "call-status", function: { name: "git-status", arguments: "{}" } },
							],
						},
					},
				],
			},
			{
				choices: [
					{
						message: {
							content: "",
							tool_calls: [{ id: "call-finish", function: { name: "finish", arguments: "{}" } }],
						},
					},
				],
			},
		];
		const provider = createModelProvider(
			{ ...configuration("chat-completions"), thinkingMode: "disabled" },
			{
				fetcher: async (_input, init) => {
					requestBodies.push(
						JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>,
					);
					return new Response(JSON.stringify(payloads.shift()));
				},
				resolveCredential: () => ({ ok: true, credentialRef: "provider-a-primary", secret: "fake-secret" }),
			},
		);
		const session = provider.createSession();

		await expect(session.decide(context)).resolves.toMatchObject({
			decision: {
				kind: "tool-batch",
				calls: [
					{ kind: "tool", callId: "call-read", tool: "read-file" },
					{ kind: "tool", callId: "call-status", tool: "git-status" },
				],
			},
		});
		session.recordToolResults([
			{ callId: "call-read", tool: "read-file", status: "ok", observation: "README contents" },
			{ callId: "call-status", tool: "git-status", status: "ok", observation: "Git status clean." },
		]);
		await expect(
			session.decide({ ...context, observations: ["ignored after session initialization"] }),
		).resolves.toMatchObject({
			decision: { kind: "finish" },
		});

		const secondMessages = requestBodies[1]?.messages as Array<Record<string, unknown>>;
		expect(secondMessages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "assistant",
					tool_calls: expect.arrayContaining([expect.objectContaining({ id: "call-read" })]),
				}),
				expect.objectContaining({ role: "tool", tool_call_id: "call-read", content: "README contents" }),
				expect.objectContaining({ role: "tool", tool_call_id: "call-status", content: "Git status clean." }),
			]),
		);
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
			failure: { kind: "unsupported-tool-calling", detail: "no-tool-calls", httpStatus: null, requestId: null },
		});
	});

	it("normalizes multiple ordinary tool calls into one provider-neutral batch", async () => {
		const provider = createModelProvider(configuration("chat-completions"), {
			fetcher: async () =>
				new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									tool_calls: [
										{ function: { name: "git-status", arguments: "{}" } },
										{ function: { name: "git-diff", arguments: "{}" } },
									],
								},
							},
						],
					}),
				),
			resolveCredential: () => ({ ok: true, credentialRef: "provider-a-primary", secret: "fake-secret" }),
		});

		await expect(provider.decide(context)).resolves.toMatchObject({
			decision: {
				kind: "tool-batch",
				calls: [
					{ kind: "tool", tool: "git-status", arguments: {} },
					{ kind: "tool", tool: "git-diff", arguments: {} },
				],
			},
		});
	});

	it("rejects a provider response that mixes control and ordinary tool calls", async () => {
		const provider = createModelProvider(configuration("chat-completions"), {
			fetcher: async () =>
				new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									tool_calls: [
										{ function: { name: "git-status", arguments: "{}" } },
										{ function: { name: "finish", arguments: "{}" } },
									],
								},
							},
						],
					}),
				),
			resolveCredential: () => ({ ok: true, credentialRef: "provider-a-primary", secret: "fake-secret" }),
		});

		await expect(provider.decide(context)).rejects.toMatchObject({
			failure: { kind: "unsupported-tool-calling", detail: "mixed-control-tool-calls" },
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
