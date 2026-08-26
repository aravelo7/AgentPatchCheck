import type { ApiHandler, ApiStreamChunk, Message, ToolDefinition } from "@clinebot/llms";
import { describe, expect, it } from "vitest";

import { resolveCredential } from "../../src/agentpatchcheck/credential-resolver";
import {
	createModelProvider,
	getHarnessNativeToolDefinition,
	type ModelProviderContext,
} from "../../src/agentpatchcheck/model-provider";
import { getProgrammaticToolFacade } from "../../src/agentpatchcheck/programmatic-tool-facade";
import type { ModelProviderConfiguration } from "../../src/agentpatchcheck/types";

const context: ModelProviderContext = {
	prompt: "Update README.",
	patchExpectation: "changes-required",
	observations: [],
	tools: [
		"read-file",
		"list-directory",
		"search-text",
		"search-text-recursive",
		"git-status",
		"git-diff",
		"apply-edit",
		"apply-patch",
	] as const,
	model: "test-model",
	repairContext: { phase: "initial", publicVerificationFeedback: null } as const,
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

function geminiConfiguration(): ModelProviderConfiguration {
	return {
		provider: "gemini",
		protocol: "native",
		thinkingMode: "default",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		endpointSha256: "b".repeat(64),
		credentialRef: "gemini-primary",
		implementation: "cline-llms-gemini-native-v1",
	};
}

function geminiHandler(
	responses: ApiStreamChunk[][],
	requests: Message[][],
	toolsSeen: ToolDefinition[][],
): ApiHandler {
	return {
		getMessages: () => undefined,
		getModel: () => ({ id: "models/gemini-3.1-flash-lite", info: { id: "models/gemini-3.1-flash-lite" } }),
		createMessage: (_systemPrompt, messages, tools = []) => {
			requests.push(messages);
			toolsSeen.push(tools);
			const response = responses.shift() ?? [];
			return (async function* () {
				for (const chunk of response) yield chunk;
			})();
		},
	};
}

function connectionResetError(): Error & { code: string } {
	return Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
}

describe("Model Provider Registry", () => {
	it("uses a provider-neutral structured planning call for both OpenAI-compatible protocols", async () => {
		for (const protocol of ["responses", "chat-completions"] as const) {
			let requestBody: Record<string, unknown> = {};
			const planArguments = JSON.stringify({
				objective: "Repair the implementation behavior",
				plan: [
					{ step: "Inspect observed implementation", kind: "diagnosis", status: "completed" },
					{ step: "Implement the behavior fix", kind: "implementation", status: "in_progress" },
					{ step: "Run public verification", kind: "verification", status: "pending" },
				],
			});
			const provider = createModelProvider(configuration(protocol), {
				fetcher: async (_input, init) => {
					requestBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
					return new Response(
						JSON.stringify(
							protocol === "responses"
								? {
										model: "planner-model",
										usage: { input_tokens: 7, output_tokens: 3 },
										output: [{ type: "function_call", name: "update_plan", arguments: planArguments }],
									}
								: {
										model: "planner-model",
										usage: { prompt_tokens: 7, completion_tokens: 3 },
										choices: [
											{
												message: {
													tool_calls: [{ function: { name: "update_plan", arguments: planArguments } }],
												},
											},
										],
									},
						),
					);
				},
				resolveCredential: () => ({ ok: true, credentialRef: "provider-a-primary", secret: "fake-secret" }),
			});

			await expect(
				provider.plan({
					prompt: "Repair README.",
					model: "test-model",
					iteration: 2,
					trigger: "initial-observation",
					observations: ["README contents"],
					workingContext: context.workingContext,
					previousPlan: null,
					attemptContinuation: {
						version: 1,
						attempt: 2,
						previousAttempt: 1,
						reason: "iteration-limit-with-progress",
						successfulMutationCount: 1,
						affectedPaths: ["README.md"],
						latestVerificationOutcome: null,
						executionCheckpoint: "verification-due",
					},
				}),
			).resolves.toMatchObject({
				plan: {
					version: 1,
					objective: "Repair the implementation behavior",
					steps: [
						{ kind: "diagnosis", status: "completed" },
						{ kind: "implementation", status: "in_progress" },
						{ kind: "verification", status: "pending" },
					],
				},
				usage: { inputTokens: 7, outputTokens: 3 },
				actualModel: "planner-model",
			});
			expect(JSON.stringify(requestBody)).toContain("update_plan");
			expect(JSON.stringify(requestBody)).toContain("Canonical projected observations");
			expect(JSON.stringify(requestBody)).toContain("Treat execution observations as feedback");
			expect(JSON.stringify(requestBody)).toContain("require a genuine scope or ordering change");
			expect(JSON.stringify(requestBody)).toContain("iteration-limit-with-progress");
			expect(JSON.stringify(requestBody)).not.toContain("apply-patch");
		}
	});

	it("uses the native Gemini handler for an isolated structured planning decision", async () => {
		const requests: Message[][] = [];
		const toolsSeen: ToolDefinition[][] = [];
		const provider = createModelProvider(geminiConfiguration(), {
			createHandler: () =>
				geminiHandler(
					[
						[
							{
								type: "tool_calls",
								id: "plan-response",
								tool_call: {
									function: {
										name: "update_plan",
										arguments: {
											plan: [
												{ step: "Implement repair", kind: "implementation" },
												{ step: "Run verification", kind: "verification" },
											],
										},
									},
								},
							},
							{ type: "done", id: "plan-response", success: true },
						],
					],
					requests,
					toolsSeen,
				),
			resolveCredential: () => ({ ok: true, credentialRef: "gemini-primary", secret: "fake-secret" }),
		});

		await expect(
			provider.plan({
				prompt: "Repair target.",
				model: "models/gemini-3.1-flash-lite",
				iteration: 1,
				trigger: "initial-observation",
				observations: ["target source"],
				workingContext: context.workingContext,
				previousPlan: null,
			}),
		).resolves.toMatchObject({
			plan: {
				objective: "Implement repair",
				steps: [
					{ step: "Implement repair", kind: "implementation", status: "in_progress" },
					{ step: "Run verification", kind: "verification", status: "pending" },
				],
			},
		});
		expect(toolsSeen).toEqual([[expect.objectContaining({ name: "update_plan" })]]);
		expect(toolsSeen[0]?.[0]?.inputSchema).toMatchObject({
			required: ["plan"],
			properties: {
				objective: { type: "string" },
				plan: { type: "array", items: { required: ["step", "kind"] } },
			},
		});
		expect(JSON.stringify(requests)).toContain("Canonical projected observations");
	});

	it("normalizes mechanical plan defaults on the OpenAI-compatible Chat path", async () => {
		let requestBody: Record<string, unknown> = {};
		const provider = createModelProvider(configuration("chat-completions"), {
			fetcher: async (_input, init) => {
				requestBody = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
				return new Response(
					JSON.stringify({
						model: "deepseek-chat",
						choices: [
							{
								message: {
									tool_calls: [
										{
											function: {
												name: "update_plan",
												arguments: JSON.stringify({
													plan: [
														{ step: "Inspect evidence", kind: "diagnosis", status: "completed" },
														{ step: "Implement repair", kind: "implementation", status: "in-progress" },
														{ step: "Verify repair", kind: "verification" },
													],
												}),
											},
										},
									],
								},
							},
						],
					}),
				);
			},
			resolveCredential: () => ({ ok: true, credentialRef: "provider-a-primary", secret: "fake-secret" }),
		});

		await expect(
			provider.plan({
				prompt: "Repair target.",
				model: "deepseek-chat",
				iteration: 2,
				trigger: "initial-observation",
				observations: ["target source"],
				workingContext: context.workingContext,
				previousPlan: null,
			}),
		).resolves.toMatchObject({
			plan: {
				objective: "Implement repair",
				steps: [{ status: "completed" }, { status: "in_progress" }, { status: "pending" }],
			},
		});
		const serializedRequest = JSON.stringify(requestBody);
		expect(serializedRequest).toContain('"required":["plan"]');
		expect(serializedRequest).not.toContain('"minItems"');
	});

	it("reports safe Gemini plan validation diagnostics without retaining arguments", async () => {
		const sensitiveStep = "private implementation objective";
		const sensitiveStatus = "private-invalid-status";
		const provider = createModelProvider(geminiConfiguration(), {
			createHandler: () =>
				geminiHandler(
					[
						[
							{
								type: "tool_calls",
								id: "invalid-plan",
								tool_call: {
									function: {
										name: "update_plan",
										arguments: {
											plan: [
												{ step: sensitiveStep, kind: "implementation", status: sensitiveStatus },
												{ step: "Verify", kind: "verification" },
											],
										},
									},
								},
							},
						],
					],
					[],
					[],
				),
			resolveCredential: () => ({ ok: true, credentialRef: "gemini-primary", secret: "fake-secret" }),
		});

		const failure = await provider
			.plan({
				prompt: "Repair target.",
				model: "models/gemini-3.1-flash-lite",
				iteration: 1,
				trigger: "initial-observation",
				observations: ["target source"],
				workingContext: context.workingContext,
				previousPlan: null,
			})
			.catch((error: unknown) => error);
		expect(failure).toMatchObject({
			failure: {
				kind: "malformed-response",
				detail: "invalid-tool-arguments",
				validationIssue: {
					path: "$.plan[0].status",
					issue: "invalid-enum",
					receivedType: "string",
					constraint: "plan-step-status",
				},
			},
		});
		const serializedFailure = JSON.stringify(failure);
		expect(serializedFailure).not.toContain(sensitiveStep);
		expect(serializedFailure).not.toContain(sensitiveStatus);
	});

	it("reports a safe JSON shape failure on the OpenAI-compatible Chat path", async () => {
		const sensitiveArguments = '{"plan":[{"step":"private objective"}';
		const provider = createModelProvider(configuration("chat-completions"), {
			fetcher: async () =>
				new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									tool_calls: [{ function: { name: "update_plan", arguments: sensitiveArguments } }],
								},
							},
						],
					}),
				),
			resolveCredential: () => ({ ok: true, credentialRef: "provider-a-primary", secret: "fake-secret" }),
		});

		const failure = await provider
			.plan({
				prompt: "Repair target.",
				model: "deepseek-chat",
				iteration: 1,
				trigger: "initial-observation",
				observations: ["target source"],
				workingContext: context.workingContext,
				previousPlan: null,
			})
			.catch((error: unknown) => error);
		expect(failure).toMatchObject({
			failure: {
				kind: "malformed-response",
				detail: "invalid-tool-arguments",
				validationIssue: {
					path: "$",
					issue: "json-parse",
					receivedType: "string",
					constraint: "json-object",
				},
			},
		});
		expect(JSON.stringify(failure)).not.toContain(sensitiveArguments);
	});

	it("rejects ambiguous plan lifecycle state after transport parsing", async () => {
		const planArguments = JSON.stringify({
			plan: [
				{ step: "First private objective", kind: "implementation", status: "in_progress" },
				{ step: "Second private objective", kind: "verification", status: "in_progress" },
			],
		});
		const provider = createModelProvider(configuration("chat-completions"), {
			fetcher: async () =>
				new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									tool_calls: [{ function: { name: "update_plan", arguments: planArguments } }],
								},
							},
						],
					}),
				),
			resolveCredential: () => ({ ok: true, credentialRef: "provider-a-primary", secret: "fake-secret" }),
		});

		const failure = await provider
			.plan({
				prompt: "Repair target.",
				model: "deepseek-chat",
				iteration: 1,
				trigger: "initial-observation",
				observations: ["target source"],
				workingContext: context.workingContext,
				previousPlan: null,
			})
			.catch((error: unknown) => error);
		expect(failure).toMatchObject({
			failure: {
				validationIssue: {
					path: "$.plan",
					issue: "lifecycle-invariant",
					receivedType: "array",
					constraint: "at-most-one-in-progress",
				},
			},
		});
		expect(JSON.stringify(failure)).not.toContain("private objective");
	});

	it("uses the public Gemini handler and retains native tool continuity through Harness result feedback", async () => {
		const requests: Message[][] = [];
		const toolsSeen: ToolDefinition[][] = [];
		const responses: ApiStreamChunk[][] = [
			[
				{ type: "reasoning", id: "response-1", reasoning: "Inspect first.", signature: "thought-signature-1" },
				{
					type: "tool_calls",
					id: "response-1",
					signature: "tool-signature-1",
					tool_call: {
						call_id: "native-read-1",
						function: { id: "harness-read-1", name: "read-file", arguments: { path: "README.md" } },
					},
				},
				{ type: "done", id: "response-1", success: true },
			],
			[
				{
					type: "tool_calls",
					id: "response-2",
					signature: "tool-signature-2",
					tool_call: {
						call_id: "native-patch-1",
						function: {
							id: "harness-patch-1",
							name: "apply-patch",
							arguments: { patch: "diff --git a/README.md b/README.md" },
						},
					},
				},
				{ type: "done", id: "response-2", success: true },
			],
			[
				{
					type: "tool_calls",
					id: "response-3",
					tool_call: {
						call_id: "native-verify-1",
						function: { id: "harness-verify-1", name: "run-public-verification", arguments: { index: 0 } },
					},
				},
				{ type: "done", id: "response-3", success: true },
			],
			[
				{
					type: "tool_calls",
					id: "response-4",
					tool_call: { function: { id: "harness-finish-1", name: "finish", arguments: {} } },
				},
				{ type: "done", id: "response-4", success: true },
			],
		];
		const provider = createModelProvider(geminiConfiguration(), {
			createHandler: (config) => {
				expect(config).toMatchObject({ providerId: "gemini", modelId: "gemini-3.1-flash-lite" });
				expect(config).not.toHaveProperty("baseUrl");
				return geminiHandler(responses, requests, toolsSeen);
			},
			resolveCredential: () => ({ ok: true, credentialRef: "gemini-primary", secret: "fake-gemini-secret" }),
		});
		const session = provider.createSession();
		const geminiContext = {
			...context,
			model: "models/gemini-3.1-flash-lite",
			tools: [...context.tools, "run-public-verification"] as const,
		};

		await expect(session.decide({ ...geminiContext, iteration: 1 })).resolves.toMatchObject({
			decision: { kind: "tool", callId: "harness-read-1", tool: "read-file", arguments: { path: "README.md" } },
		});
		session.recordToolResults([
			{ callId: "harness-read-1", tool: "read-file", status: "ok", observation: "README before" },
		]);
		await expect(
			session.decide({
				...geminiContext,
				iteration: 2,
				protocolRecovery: {
					version: 1,
					owner: "executor",
					recovery: 1,
					maxRecoveries: 2,
					failure: {
						kind: "malformed-response",
						detail: "invalid-tool-arguments",
						code: null,
						httpStatus: null,
						requestId: null,
					},
					correction: "Return tool arguments as one JSON object matching the selected function schema.",
				},
			}),
		).resolves.toMatchObject({
			decision: { kind: "tool", callId: "harness-patch-1", tool: "apply-patch" },
		});
		session.recordToolResults([
			{ callId: "harness-patch-1", tool: "apply-patch", status: "ok", observation: "Patch applied" },
		]);
		await expect(
			session.decide({
				...geminiContext,
				iteration: 3,
				completionFeedback: "Finish was not accepted because verification remains due.",
			}),
		).resolves.toMatchObject({
			decision: {
				kind: "tool",
				callId: "harness-verify-1",
				tool: "run-public-verification",
				arguments: { index: 0 },
			},
		});
		session.recordToolResults([
			{
				callId: "harness-verify-1",
				tool: "run-public-verification",
				status: "ok",
				observation: "Verification passed",
			},
		]);
		await expect(session.decide({ ...geminiContext, iteration: 4 })).resolves.toMatchObject({
			decision: { kind: "finish" },
		});

		expect(toolsSeen[0]).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ name: "read-file" }),
				expect.objectContaining({
					name: "apply-edit",
					inputSchema: expect.objectContaining({ required: ["path", "expectedText", "replacementText"] }),
				}),
				expect.objectContaining({ name: "finish" }),
			]),
		);
		expect(JSON.stringify(requests[0])).toContain("Coding task workflow");
		expect(JSON.stringify(requests[0])).toContain("Current coding-loop checkpoint");
		expect(JSON.stringify(requests[0])).toContain("Next-action decision protocol");
		expect(JSON.stringify(requests[0])).toContain("specific unresolved question");
		expect(JSON.stringify(requests[1])).toContain("Harness-owned protocol correction for this same decision");
		expect(JSON.stringify(requests[1])).toContain("invalid-tool-arguments");
		expect(JSON.stringify(requests[2])).toContain("Harness-owned completion feedback");
		expect(JSON.stringify(requests[2])).toContain("verification remains due");
		expect(JSON.stringify(requests)).not.toContain("fake-gemini-secret");
		expect(requests[1]).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "assistant",
					content: expect.arrayContaining([
						expect.objectContaining({ type: "thinking", signature: "thought-signature-1" }),
						expect.objectContaining({
							type: "tool_use",
							id: "harness-read-1",
							call_id: "native-read-1",
							signature: "tool-signature-1",
						}),
					]),
				}),
				expect.objectContaining({
					role: "user",
					content: [expect.objectContaining({ type: "tool_result", tool_use_id: "harness-read-1" })],
				}),
			]),
		);
	});

	it("maps a Gemini SDK quota completion failure without retaining its provider text", async () => {
		const provider = createModelProvider(geminiConfiguration(), {
			createHandler: () =>
				geminiHandler(
					[
						[
							{
								type: "done",
								id: "response-1",
								success: false,
								error: "Quota exceeded by provider",
							},
						],
					],
					[],
					[],
				),
			resolveCredential: () => ({ ok: true, credentialRef: "gemini-primary", secret: "fake-gemini-secret" }),
		});
		await expect(provider.decide({ ...context, model: "models/gemini-3.1-flash-lite" })).rejects.toMatchObject({
			failure: { kind: "rate-limited", detail: null, code: null },
		});
	});

	it("exposes freeform unified diff input for the primary mutation tool", () => {
		const definition = getHarnessNativeToolDefinition("apply-patch");
		expect(definition.description).toContain("freeform unified diff");
		expect(definition.description).toContain("prefer apply-edit");
		expect(definition.inputSchema).toEqual({
			type: "object",
			properties: {
				patch: {
					type: "string",
					description: "A standard unified diff with ---/+++ headers, suitable for git apply.",
				},
			},
			required: ["patch"],
			additionalProperties: false,
		});
	});

	it("exposes a bounded line-window contract for read-file", () => {
		const definition = getHarnessNativeToolDefinition("read-file");
		expect(definition.description).toContain("bounded, line-numbered window");
		expect(definition.description).toContain("1-based offset and limit");
		expect(definition.description).toContain("path-only calls start at line 1");
		expect(definition.inputSchema).toEqual({
			type: "object",
			properties: {
				path: { type: "string", description: "Workspace-relative path to a regular UTF-8 text file." },
				offset: { type: "number", minimum: 1, description: "Optional 1-based first line. Defaults to 1." },
				limit: {
					type: "number",
					minimum: 1,
					maximum: 2000,
					description: "Optional maximum lines to return. Defaults to and cannot exceed 2000.",
				},
			},
			required: ["path"],
			additionalProperties: false,
		});
	});

	it("accepts read-file line-window arguments on the OpenAI-compatible Chat path", async () => {
		const provider = createModelProvider(configuration("chat-completions"), {
			fetcher: async () =>
				new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									tool_calls: [
										{
											id: "read-window",
											function: {
												name: "read-file",
												arguments: '{"path":"src/index.ts","offset":201,"limit":80}',
											},
										},
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
				kind: "tool",
				callId: "read-window",
				tool: "read-file",
				arguments: { path: "src/index.ts", offset: 201, limit: 80 },
			},
		});
	});

	it("exposes a structured exact-text primitive for one existing-file edit", () => {
		const definition = getHarnessNativeToolDefinition("apply-edit");
		expect(definition.description).toContain("one uniquely matching text region");
		expect(definition.description).toContain("no unified diff syntax");
		expect(definition.inputSchema).toMatchObject({
			type: "object",
			required: ["path", "expectedText", "replacementText"],
			additionalProperties: false,
			properties: {
				path: { type: "string" },
				expectedText: { type: "string", description: expect.stringContaining("exactly once") },
				replacementText: { type: "string" },
			},
		});
	});

	it("describes the combined edit count contract at the Provider boundary", () => {
		const definition = getHarnessNativeToolDefinition("apply-edit-batch");
		expect(definition.description).toContain("2-8 total edits");
		expect(definition.description).toContain("apply-edit for one existing-file edit");
		expect(definition.inputSchema).toMatchObject({
			description: expect.stringContaining("2-8 edits total"),
			properties: {
				patches: { description: expect.stringContaining("patches.length plus creates.length must be 2-8") },
				creates: { description: expect.stringContaining("patches.length plus creates.length must be 2-8") },
			},
		});
	});

	it("describes the distinct file and directory search contracts", () => {
		expect(getHarnessNativeToolDefinition("search-text").description).toContain("regular workspace file");
		expect(getHarnessNativeToolDefinition("search-text-recursive").description).toContain("must be a directory");
	});

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

	it("projects working context into each request without persisting snapshots in chat history", async () => {
		let responsesRequest = "";
		const responses = createModelProvider(configuration("responses"), {
			fetcher: async (_input, init) => {
				responsesRequest = typeof init?.body === "string" ? init.body : "";
				return new Response(
					JSON.stringify({ output: [{ type: "function_call", name: "finish", arguments: "{}" }] }),
				);
			},
			resolveCredential: () => ({ ok: true, credentialRef: "provider-a-primary", secret: "fake-secret" }),
		});
		await responses.decide({
			...context,
			activePlanStep: {
				version: 1,
				executionId: 2,
				revision: 2,
				stepIndex: 1,
				objective: "Implement repair",
				step: "Modify the observed implementation",
				attempts: 0,
				lastOutcome: null,
				executionCheckpoint: "verification-due",
			},
		});
		expect(responsesRequest).toContain("Harness-owned current working context");
		expect(responsesRequest).toContain("Harness-owned task contract");
		expect(JSON.parse(responsesRequest).input).toContain('"patchExpectation":"changes-required"');
		expect(responsesRequest).toContain("Successful completion requires actual, task-relevant repository changes.");
		expect(responsesRequest).toContain("analysis alone cannot substitute for implementation");
		expect(responsesRequest).toContain(
			"After implementing the change, complete the existing verification obligations before finishing.",
		);
		expect(responsesRequest).toContain("Harness-owned active-step execution state");
		expect(responsesRequest).toContain("Modify the observed implementation");
		expect(JSON.parse(responsesRequest).input).toContain('"executionCheckpoint":"verification-due"');
		expect(responsesRequest).toContain("current execution objective");
		expect(responsesRequest).toContain("Coding task workflow");
		expect(responsesRequest).toContain("required software behavior as the acceptance criteria");
		expect(responsesRequest).toContain(
			"Reproduction or test changes are diagnostic unless the task explicitly requires them",
		);
		expect(responsesRequest).toContain("A passing existing test command establishes only the behavior it covers");
		expect(responsesRequest).toContain("those decisions remain with the model");
		expect(responsesRequest).toContain("Next-action decision protocol");
		expect(responsesRequest).toContain("transition to a task-relevant implementation action");
		expect(responsesRequest).toContain("does not authorize the Harness to choose an action or file");
		await responses.decide({
			...context,
			attemptContinuation: {
				version: 1,
				attempt: 2,
				previousAttempt: 1,
				reason: "iteration-limit-with-progress",
				successfulMutationCount: 1,
				affectedPaths: ["implementation.ts"],
				latestVerificationOutcome: "failed",
				executionCheckpoint: "repair-due",
			},
		});
		expect(responsesRequest).toContain("Harness-owned attempt continuation");
		expect(JSON.parse(responsesRequest).input).toContain('"previousAttempt":1');
		expect(responsesRequest).toContain("changes remain in the managed workspace");
		await responses.decide({
			...context,
			workingContext: {
				...context.workingContext,
				phase: "public-verification-completed",
				mutation: { successfulActions: 1, paths: ["implementation.ts"], firstIteration: 1 },
				publicVerification: { runs: 1, latestStatus: "passed", latestIteration: 2 },
			},
		});
		expect(responsesRequest).toContain("The latest public verification command passed");
		expect(responsesRequest).toContain("other declared verification commands");
		await responses.decide({
			...context,
			protocolRecovery: {
				version: 1,
				owner: "executor",
				recovery: 1,
				maxRecoveries: 2,
				failure: {
					kind: "malformed-response",
					detail: "invalid-tool-arguments",
					code: null,
					httpStatus: null,
					requestId: null,
				},
				correction: "Return tool arguments as one JSON object matching the selected function schema.",
			},
		});
		expect(responsesRequest).toContain("Harness-owned protocol correction for this same decision");
		expect(responsesRequest).toContain("invalid-tool-arguments");
		await responses.decide({
			...context,
			completionFeedback: "Finish was not accepted because verification remains due.",
		});
		expect(responsesRequest).toContain("Harness-owned completion feedback");
		expect(responsesRequest).toContain("verification remains due");
		await responses.decide({
			...context,
			patchExpectation: "changes-optional",
		});
		expect(JSON.parse(responsesRequest).input).toContain('"patchExpectation":"changes-optional"');
		expect(responsesRequest).toContain(
			"Successful completion may be valid without repository changes when the task requirements are already satisfied.",
		);

		const requestBodies: Array<{ messages: Array<{ role: string; content?: string }> }> = [];
		const payloads = [
			{
				choices: [
					{
						message: {
							content: "The implementation is understood; inspect this file to resolve one concrete edge case.",
							tool_calls: [
								{ id: "call-read", function: { name: "read-file", arguments: '{"path":"README.md"}' } },
							],
						},
					},
				],
			},
			{
				choices: [
					{ message: { tool_calls: [{ id: "call-finish", function: { name: "finish", arguments: "{}" } }] } },
				],
			},
		];
		const chat = createModelProvider(configuration("chat-completions"), {
			fetcher: async (_input, init) => {
				requestBodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
				return new Response(JSON.stringify(payloads.shift()));
			},
			resolveCredential: () => ({ ok: true, credentialRef: "provider-a-primary", secret: "fake-secret" }),
		});
		const session = chat.createSession();
		await session.decide(context);
		session.recordToolResults([
			{ callId: "call-read", tool: "read-file", status: "ok", observation: "README contents" },
		]);
		await session.decide({
			...context,
			workingContext: {
				...context.workingContext,
				phase: "public-verification-completed",
				mutation: { successfulActions: 1, paths: ["test/repro.test.ts"], firstIteration: 1 },
				publicVerification: { runs: 1, latestStatus: "failed", latestIteration: 2 },
			},
		});
		const projections = requestBodies[1]?.messages.filter((message) =>
			message.content?.includes("Harness-owned current working context"),
		);
		expect(projections).toHaveLength(1);
		expect(projections?.[0]?.content).toContain('"phase":"public-verification-completed"');
		expect(projections?.[0]?.content).toContain('"successfulChangedPaths":["test/repro.test.ts"]');
		expect(projections?.[0]?.content).toContain("The latest public verification failed");
		expect(projections?.[0]?.content).toContain("not a separate state source");
		expect(projections?.[0]?.content).toContain("Next-action decision protocol");
		expect(requestBodies[1]?.messages.find((message) => message.role === "assistant")?.content).toBe(
			"The implementation is understood; inspect this file to resolve one concrete edge case.",
		);
		expect(
			requestBodies[1]?.messages.filter((message) => message.content?.includes('"phase":"discovery"')),
		).toHaveLength(0);
	});

	it("projects chat history by whole tool interactions without orphaning tool results", async () => {
		const requestBodies: Array<{ messages: Array<{ role: string; content?: string; tool_call_id?: string }> }> = [];
		const payloads = [
			{
				choices: [
					{
						message: {
							tool_calls: [
								{ id: "call-read", function: { name: "read-file", arguments: '{"path":"README.md"}' } },
							],
						},
					},
				],
			},
			{
				choices: [
					{ message: { tool_calls: [{ id: "call-finish", function: { name: "finish", arguments: "{}" } }] } },
				],
			},
		];
		const provider = createModelProvider(configuration("chat-completions"), {
			fetcher: async (_input, init) => {
				requestBodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
				return new Response(JSON.stringify(payloads.shift()));
			},
			resolveCredential: () => ({ ok: true, credentialRef: "provider-a-primary", secret: "fake-secret" }),
		});
		const session = provider.createSession();
		await session.decide({ ...context, iteration: 1 });
		session.recordToolResults([
			{ callId: "call-read", tool: "read-file", status: "ok", observation: "README contents" },
		]);
		await session.decide({
			...context,
			iteration: 2,
			historyProjection: {
				version: 1,
				canonicalInteractionCount: 1,
				projectedInteractionCount: 0,
				elidedInteractionCount: 1,
				canonicalObservationCount: 1,
				projectedObservationCount: 0,
				elidedObservationCount: 1,
				retainedInteractionIterations: [],
			},
		});

		const projected = requestBodies[1]?.messages ?? [];
		expect(projected.some((message) => message.role === "assistant")).toBe(false);
		expect(projected.some((message) => message.role === "tool")).toBe(false);
		expect(
			projected.filter((message) => message.content?.includes("Harness-owned current working context")),
		).toHaveLength(1);
	});

	it("delivers the DSH-compatible SDK and canonical Context View through the Chat session path", async () => {
		const requestBodies: Array<{ messages: Array<{ role: string; content?: string }> }> = [];
		const provider = createModelProvider(configuration("chat-completions"), {
			fetcher: async (_input, init) => {
				requestBodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
				return new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									tool_calls: [
										{ id: `finish-${requestBodies.length}`, function: { name: "finish", arguments: "{}" } },
									],
								},
							},
						],
					}),
				);
			},
			resolveCredential: () => ({ ok: true, credentialRef: "provider-a-primary", secret: "fake-secret" }),
		});
		const workingContext = {
			...context.workingContext,
			phase: "mutation-applied" as const,
			mutation: { successfulActions: 1, paths: ["src/implementation.ts"], firstIteration: 3 },
		};
		const historyProjection = {
			version: 1 as const,
			canonicalInteractionCount: 2,
			projectedInteractionCount: 1,
			elidedInteractionCount: 1,
			canonicalObservationCount: 2,
			projectedObservationCount: 1,
			elidedObservationCount: 1,
			retainedInteractionIterations: [3],
		};
		const dshContext: ModelProviderContext = {
			...context,
			iteration: 4,
			tools: ["run_code"],
			toolPresentation: "dsh-compatible",
			workingDirectory: "D:/managed/worktree",
			programmaticTools: getProgrammaticToolFacade(true),
			workingContext,
			historyProjection,
			contextView: {
				version: 1,
				throughEventSequence: 12,
				attempt: 1,
				observations: ["Observed implementation behavior."],
				historyProjection,
				workingContext,
				continuation: null,
				protocolRecovery: null,
				completionFeedback: null,
				plan: null,
				activePlanStep: null,
			},
		};
		const session = provider.createSession();
		await session.decide(dshContext);
		const currentContextView = dshContext.contextView;
		if (currentContextView === undefined) throw new Error("Expected the DSH-compatible Context View fixture.");
		await session.decide({
			...dshContext,
			iteration: 5,
			contextView: {
				...currentContextView,
				throughEventSequence: 14,
				completionFeedback: "Verification remains due.",
			},
		});

		const firstMessages = (requestBodies[0]?.messages ?? []).map((message) => message.content ?? "").join("\n");
		expect(firstMessages).toContain("Use run_code");
		expect(firstMessages).toContain("declare const tools");
		expect(firstMessages).toContain("Harness Runtime Context");
		expect(firstMessages).toContain('"throughEventSequence":12');
		expect(firstMessages).toContain('"phase":"mutation-applied"');
		const secondProjection = requestBodies[1]?.messages.at(-1)?.content ?? "";
		expect(secondProjection).toContain("Harness Runtime Context");
		expect(secondProjection).toContain('"throughEventSequence":14');
		expect(secondProjection).toContain("Verification remains due.");
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

	it("retries one ECONNRESET only before a Chat session has received tool state", async () => {
		let requests = 0;
		const provider = createModelProvider(
			configuration("chat-completions"),
			{
				fetcher: async () => {
					requests += 1;
					if (requests === 1) throw connectionResetError();
					return new Response(
						JSON.stringify({
							choices: [{ message: { tool_calls: [{ function: { name: "finish", arguments: "{}" } }] } }],
						}),
					);
				},
				resolveCredential: () => ({ ok: true, credentialRef: "provider-a-primary", secret: "fake-secret" }),
			},
			{ maxTransportRetries: 1 },
		);

		const decision = await provider.createSession().decide(context);
		expect(decision).toMatchObject({ decision: { kind: "finish" }, transportRetries: 1 });
		expect(requests).toBe(2);
	});

	it("does not retry ECONNRESET after a Chat session has begun", async () => {
		let requests = 0;
		const provider = createModelProvider(
			configuration("chat-completions"),
			{
				fetcher: async () => {
					requests += 1;
					if (requests === 2) throw connectionResetError();
					return new Response(
						JSON.stringify({
							choices: [
								{
									message: {
										tool_calls: [{ id: "call-1", function: { name: "git-status", arguments: "{}" } }],
									},
								},
							],
						}),
					);
				},
				resolveCredential: () => ({ ok: true, credentialRef: "provider-a-primary", secret: "fake-secret" }),
			},
			{ maxTransportRetries: 1 },
		);
		const session = provider.createSession();
		await session.decide(context);

		await expect(session.decide({ ...context, observations: ["Git status clean."] })).rejects.toMatchObject({
			failure: { kind: "provider-unavailable", code: "ECONNRESET" },
		});
		expect(requests).toBe(2);
	});

	it("does not retry malformed model output", async () => {
		let requests = 0;
		const provider = createModelProvider(
			configuration("chat-completions"),
			{
				fetcher: async () => {
					requests += 1;
					return new Response("{");
				},
				resolveCredential: () => ({ ok: true, credentialRef: "provider-a-primary", secret: "fake-secret" }),
			},
			{ maxTransportRetries: 1 },
		);

		await expect(provider.decide(context)).rejects.toMatchObject({ failure: { kind: "malformed-response" } });
		expect(requests).toBe(1);
	});

	it("serializes a distinct bounded repair context for both supported protocols", async () => {
		for (const protocol of ["responses", "chat-completions"] as const) {
			let requestBody = "";
			const provider = createModelProvider(configuration(protocol), {
				fetcher: async (_input, init) => {
					requestBody = typeof init?.body === "string" ? init.body : "";
					return new Response(
						JSON.stringify(
							protocol === "responses"
								? { output: [{ type: "function_call", name: "finish", arguments: "{}" }] }
								: {
										choices: [
											{ message: { tool_calls: [{ function: { name: "finish", arguments: "{}" } }] } },
										],
									},
						),
					);
				},
				resolveCredential: () => ({ ok: true, credentialRef: "provider-a-primary", secret: "fake-secret" }),
			});

			await provider.decide({
				...context,
				repairContext: {
					phase: "public-verification-repair",
					repairInstruction: "Only modify src/config/beta.ts, then finish.",
					initialChangedFiles: ["src/feature/alpha.ts"],
					publicVerificationFeedback: {
						version: 1,
						status: "failed",
						summary: "The public verification command failed.",
						commands: [{ command: "node", exitCode: 1, signal: null, timedOut: false }],
					},
				},
			});

			expect(requestBody).toContain("Execution phase: public-verification repair");
			expect(requestBody).toContain("Do not repeat initial-attempt instructions");
			expect(requestBody).toContain("The public verification command failed.");
			expect(requestBody).toContain("Only modify src/config/beta.ts, then finish.");
			expect(requestBody).toContain("src/feature/alpha.ts");
			expect(requestBody).not.toContain("fake-secret");
		}
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

	it("normalizes missing tool arguments as recoverable protocol failures for Chat and Gemini Native", async () => {
		const chat = createModelProvider(configuration("chat-completions"), {
			fetcher: async () =>
				new Response(
					JSON.stringify({
						choices: [{ message: { tool_calls: [{ function: { name: "read-file", arguments: "{}" } }] } }],
					}),
				),
			resolveCredential: () => ({ ok: true, credentialRef: "provider-a-primary", secret: "fake-secret" }),
		});
		await expect(chat.decide(context)).rejects.toMatchObject({
			failure: {
				kind: "malformed-response",
				detail: "invalid-tool-arguments",
				validationIssue: {
					path: "$.arguments.path",
					issue: "missing-field",
					receivedType: "missing",
					constraint: "tool-arguments",
				},
			},
		});
		const nestedBatch = createModelProvider(configuration("chat-completions"), {
			fetcher: async () =>
				new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									tool_calls: [
										{
											function: {
												name: "apply-edit-batch",
												arguments: '{"patches":[{}],"creates":[]}',
											},
										},
									],
								},
							},
						],
					}),
				),
			resolveCredential: () => ({ ok: true, credentialRef: "provider-a-primary", secret: "fake-secret" }),
		});
		await expect(nestedBatch.decide(context)).rejects.toMatchObject({
			failure: {
				detail: "invalid-tool-arguments",
				validationIssue: { path: "$.arguments.patches[0].path", issue: "missing-field" },
			},
		});

		const gemini = createModelProvider(geminiConfiguration(), {
			createHandler: () =>
				geminiHandler(
					[
						[
							{
								type: "tool_calls",
								id: "response-1",
								tool_call: { function: { id: "call-1", name: "read-file", arguments: {} } },
							},
							{ type: "done", id: "response-1", success: true },
						],
					],
					[],
					[],
				),
			resolveCredential: () => ({ ok: true, credentialRef: "gemini-primary", secret: "fake-secret" }),
		});
		await expect(gemini.decide({ ...context, model: "models/gemini-3.1-flash-lite" })).rejects.toMatchObject({
			failure: {
				kind: "malformed-response",
				detail: "invalid-tool-arguments",
				validationIssue: { path: "$.arguments.path", issue: "missing-field", constraint: "tool-arguments" },
			},
		});
	});

	it("records only the selected tool and unexpected field names for invalid Chat arguments", async () => {
		const sensitiveValue = "private replacement payload must not survive";
		const provider = createModelProvider(configuration("chat-completions"), {
			fetcher: async () =>
				new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									tool_calls: [
										{
											function: {
												name: "read-file",
												arguments: JSON.stringify({
													path: "README.md",
													arguments: { replacementText: sensitiveValue },
													wrapper: sensitiveValue,
												}),
											},
										},
									],
								},
							},
						],
					}),
				),
			resolveCredential: () => ({ ok: true, credentialRef: "provider-a-primary", secret: "fake-secret" }),
		});

		const failure = await provider.decide(context).catch((error: unknown) => error);
		expect(failure).toMatchObject({
			failure: {
				kind: "malformed-response",
				detail: "invalid-tool-arguments",
				validationIssue: {
					path: "$.arguments",
					issue: "unexpected-field",
					selectedTool: "read-file",
					unexpectedFields: ["arguments", "wrapper"],
				},
			},
		});
		expect(JSON.stringify(failure)).not.toContain(sensitiveValue);
		expect(JSON.stringify(failure)).not.toContain("replacementText");
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
