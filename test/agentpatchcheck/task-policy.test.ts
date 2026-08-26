import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	MAX_PUBLIC_VERIFICATION_REPAIR_INSTRUCTION_LENGTH,
	MAX_TASK_PROMPT_LENGTH,
	validateTaskPolicy,
} from "../../src/agentpatchcheck/task-policy";

describe("validateTaskPolicy", () => {
	it("resolves a repository-rooted policy with safe defaults", async () => {
		const policy = await validateTaskPolicy({
			repositoryRoot: process.cwd(),
			prompt: "Inspect the change.",
		});

		expect(policy.repositoryRoot).toBe(process.cwd());
		expect(policy.worktreeRoot).toBe(join(process.cwd(), ".agentpatchcheck", "worktrees"));
		expect(policy.baseRef).toBe("HEAD");
		expect(policy.baseCommit).toMatch(/^[a-f0-9]{40}$/u);
		expect(policy.sandbox).toBe("workspace-write");
		expect(policy.allowNetwork).toBe(false);
		expect(policy.allowDangerousParameters).toBe(false);
		expect(policy.patchExpectation).toBe("changes-required");
		expect(policy.verificationProfile).toBeNull();
	});

	it("rejects a worktree root outside the repository", async () => {
		await expect(
			validateTaskPolicy({
				repositoryRoot: process.cwd(),
				worktreeRoot: join(process.cwd(), "..", "outside-worktrees"),
				prompt: "Inspect the change.",
			}),
		).rejects.toThrow("Worktree root must be a descendant");
	});

	it("rejects an oversized prompt and dangerous parameter opt-in", async () => {
		await expect(
			validateTaskPolicy({
				repositoryRoot: process.cwd(),
				prompt: "x".repeat(MAX_TASK_PROMPT_LENGTH + 1),
			}),
		).rejects.toThrow("Prompt must not exceed");
		await expect(
			validateTaskPolicy({
				repositoryRoot: process.cwd(),
				prompt: "Inspect the change.",
				allowDangerousParameters: true,
			}),
		).rejects.toThrow("Dangerous Codex parameters are not supported");
	});

	it("rejects a base ref that could be interpreted as a Git option", async () => {
		await expect(
			validateTaskPolicy({
				repositoryRoot: process.cwd(),
				baseRef: "--upload-pack=unexpected",
				prompt: "Inspect the change.",
			}),
		).rejects.toThrow("Base ref must not begin with a dash");
	});

	it("defaults transport retry to zero and permits only one explicit retry", async () => {
		const defaultPolicy = await validateTaskPolicy({
			repositoryRoot: process.cwd(),
			prompt: "Inspect the change.",
			agentAdapter: "harness-native",
			model: "test-model",
			nativeAgent: { credentialRef: "openai-primary" },
		});
		expect(defaultPolicy.nativeAgent?.maxTransportRetries).toBe(0);
		expect(defaultPolicy.nativeAgent?.maxProtocolRecoveries).toBe(2);
		expect(defaultPolicy.nativeAgent?.maxCompletionDeferrals).toBe(2);
		expect(defaultPolicy.nativeAgent?.maxPlanRevisions).toBe(4);
		expect(defaultPolicy.nativeAgent?.plannerEnabled).toBe(true);
		expect(defaultPolicy.nativeAgent?.toolPresentation).toBe("native");
		expect(defaultPolicy.nativeAgent?.maxAttempts).toBe(2);
		expect(defaultPolicy.nativeAgent?.minContinuationTimeMs).toBe(30_000);
		const retriedPolicy = await validateTaskPolicy({
			repositoryRoot: process.cwd(),
			prompt: "Inspect the change.",
			agentAdapter: "harness-native",
			model: "test-model",
			nativeAgent: { credentialRef: "openai-primary", maxTransportRetries: 1 },
		});
		expect(retriedPolicy.nativeAgent?.maxTransportRetries).toBe(1);
		const singleAgentPolicy = await validateTaskPolicy({
			repositoryRoot: process.cwd(),
			prompt: "Inspect the change.",
			agentAdapter: "harness-native",
			model: "test-model",
			nativeAgent: { credentialRef: "openai-primary", plannerEnabled: false, toolPresentation: "code" },
		});
		expect(singleAgentPolicy.nativeAgent?.plannerEnabled).toBe(false);
		expect(singleAgentPolicy.nativeAgent?.toolPresentation).toBe("code");
		await expect(
			validateTaskPolicy({
				repositoryRoot: process.cwd(),
				prompt: "Inspect the change.",
				agentAdapter: "harness-native",
				model: "test-model",
				nativeAgent: { credentialRef: "openai-primary", maxTransportRetries: 2 },
			}),
		).rejects.toThrow("maxTransportRetries must be an integer between 0 and 1");
		await expect(
			validateTaskPolicy({
				repositoryRoot: process.cwd(),
				prompt: "Inspect the change.",
				agentAdapter: "harness-native",
				model: "test-model",
				nativeAgent: { credentialRef: "openai-primary", maxProtocolRecoveries: 4 },
			}),
		).rejects.toThrow("maxProtocolRecoveries must be an integer between 0 and 3");
		await expect(
			validateTaskPolicy({
				repositoryRoot: process.cwd(),
				prompt: "Inspect the change.",
				agentAdapter: "harness-native",
				model: "test-model",
				nativeAgent: { credentialRef: "openai-primary", maxCompletionDeferrals: 0 },
			}),
		).rejects.toThrow("maxCompletionDeferrals must be an integer between 1 and 4");
		await expect(
			validateTaskPolicy({
				repositoryRoot: process.cwd(),
				prompt: "Inspect the change.",
				agentAdapter: "harness-native",
				model: "test-model",
				nativeAgent: { credentialRef: "openai-primary", maxPlanRevisions: 9 },
			}),
		).rejects.toThrow("maxPlanRevisions must be an integer between 1 and 8");
		await expect(
			validateTaskPolicy({
				repositoryRoot: process.cwd(),
				prompt: "Inspect the change.",
				agentAdapter: "harness-native",
				model: "test-model",
				nativeAgent: { credentialRef: "openai-primary", maxAttempts: 4 },
			}),
		).rejects.toThrow("maxAttempts must be an integer between 1 and 3");
	});

	it("selects the SDK-backed native Gemini provider without an OpenAI-compatible endpoint", async () => {
		const policy = await validateTaskPolicy({
			repositoryRoot: process.cwd(),
			prompt: "Inspect the change.",
			agentAdapter: "harness-native",
			model: "models/gemini-3.1-flash-lite",
			nativeAgent: { provider: "gemini", credentialRef: "gemini-primary" },
		});
		expect(policy.nativeAgent?.modelProvider).toMatchObject({
			provider: "gemini",
			protocol: "native",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta",
			credentialRef: "gemini-primary",
			implementation: "cline-llms-gemini-native-v1",
		});
		await expect(
			validateTaskPolicy({
				repositoryRoot: process.cwd(),
				prompt: "Inspect the change.",
				agentAdapter: "harness-native",
				model: "models/gemini-3.1-flash-lite",
				nativeAgent: { provider: "gemini", protocol: "chat-completions", credentialRef: "gemini-primary" },
			}),
		).rejects.toThrow("requires the native protocol");
	});

	it("selects the dedicated official DeepSeek adapter and validates thinking controls", async () => {
		const policy = await validateTaskPolicy({
			repositoryRoot: process.cwd(),
			prompt: "Inspect the change.",
			agentAdapter: "harness-native",
			model: "deepseek-v4-pro",
			nativeAgent: {
				provider: "deepseek",
				thinkingMode: "enabled",
				reasoningEffort: "max",
				credentialRef: "deepseek-primary",
			},
		});
		expect(policy.nativeAgent?.modelProvider).toMatchObject({
			provider: "deepseek",
			protocol: "chat-completions",
			thinkingMode: "enabled",
			reasoningEffort: "max",
			baseUrl: "https://api.deepseek.com/v1",
			implementation: "deepseek-official-chat-v1",
		});
		await expect(
			validateTaskPolicy({
				repositoryRoot: process.cwd(),
				prompt: "Inspect the change.",
				agentAdapter: "harness-native",
				model: "deepseek-v4-pro",
				nativeAgent: {
					provider: "deepseek",
					thinkingMode: "disabled",
					reasoningEffort: "high",
					credentialRef: "deepseek-primary",
				},
			}),
		).rejects.toThrow("cannot be used when thinking is disabled");
	});

	it("requires an explicit Cline provider identity for the Cline control adapter", async () => {
		await expect(
			validateTaskPolicy({
				repositoryRoot: process.cwd(),
				prompt: "Inspect the change.",
				agentAdapter: "cline-runtime",
				model: "test-model",
				nativeAgent: { credentialRef: "openai-primary" },
			}),
		).rejects.toThrow("clineProviderId");
		const policy = await validateTaskPolicy({
			repositoryRoot: process.cwd(),
			prompt: "Inspect the change.",
			agentAdapter: "cline-runtime",
			model: "test-model",
			nativeAgent: { credentialRef: "openai-primary", clineProviderId: "openai-native" },
		});
		expect(policy.nativeAgent?.clineProviderId).toBe("openai-native");
	});

	it("defaults rejected calls to a separate bounded budget", async () => {
		const defaultPolicy = await validateTaskPolicy({
			repositoryRoot: process.cwd(),
			prompt: "Inspect the change.",
			agentAdapter: "harness-native",
			model: "test-model",
			nativeAgent: { credentialRef: "openai-primary" },
		});
		expect(defaultPolicy.nativeAgent?.maxRejectedToolCalls).toBe(4);
		await expect(
			validateTaskPolicy({
				repositoryRoot: process.cwd(),
				prompt: "Inspect the change.",
				agentAdapter: "harness-native",
				model: "test-model",
				nativeAgent: { credentialRef: "openai-primary", maxRejectedToolCalls: 17 },
			}),
		).rejects.toThrow("maxRejectedToolCalls must be an integer between 1 and 16");
	});

	it("validates a bounded Harness-owned public verification repair instruction", async () => {
		const policy = await validateTaskPolicy({
			repositoryRoot: process.cwd(),
			prompt: "Inspect the change.",
			publicVerificationRepairInstruction: "Only modify src/config/beta.ts, then finish.",
		});
		expect(policy.publicVerificationRepairInstruction).toBe("Only modify src/config/beta.ts, then finish.");
		await expect(
			validateTaskPolicy({
				repositoryRoot: process.cwd(),
				prompt: "Inspect the change.",
				publicVerificationRepairInstruction: "x".repeat(MAX_PUBLIC_VERIFICATION_REPAIR_INSTRUCTION_LENGTH + 1),
			}),
		).rejects.toThrow("Public verification repair instruction must not exceed");
	});

	it("validates direct verification commands and rejects shell launchers", async () => {
		const policy = await validateTaskPolicy({
			repositoryRoot: process.cwd(),
			prompt: "Inspect the change.",
			verification: {
				commands: [{ command: process.execPath, args: ["--version"], timeoutMs: 1_000 }],
			},
		});

		expect(policy.verification).toMatchObject({
			allowShell: false,
			allowNetwork: false,
			commands: [{ command: process.execPath, args: ["--version"], timeoutMs: 1_000 }],
		});
		await expect(
			validateTaskPolicy({
				repositoryRoot: process.cwd(),
				prompt: "Inspect the change.",
				verification: { commands: [{ command: "cmd.exe", args: ["/c", "echo unsafe"] }] },
			}),
		).rejects.toThrow("must not launch a shell");
		await expect(
			validateTaskPolicy({
				repositoryRoot: process.cwd(),
				prompt: "Inspect the change.",
				verification: { outputLimitBytes: 1_024 * 1_024 + 1 },
			}),
		).rejects.toThrow("Verification output limit");
	});

	it("rejects a RiskPolicy Profile inside the target repository", async () => {
		await expect(
			validateTaskPolicy({
				repositoryRoot: process.cwd(),
				prompt: "Inspect the change.",
				riskPolicy: {
					configuration: {
						protectedPaths: [],
						sensitivePaths: [],
						maxChangedFiles: 26,
						maxTrackedPatchBytes: 131_072,
					},
					profile: { path: join(process.cwd(), "package.json"), name: "unsafe", sha256: "a".repeat(64) },
				},
			}),
		).rejects.toThrow("RiskPolicy Profile must be outside the repository root");
	});
});
