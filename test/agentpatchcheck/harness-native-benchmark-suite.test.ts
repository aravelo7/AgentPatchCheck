import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { validateTaskPolicy } from "../../src/agentpatchcheck/task-policy";
import { loadTaskSpec } from "../../src/agentpatchcheck/task-spec";

const execFile = promisify(execFileCallback);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const suiteScript = join(projectRoot, "scripts", "run-harness-native-benchmark-suite.mjs");
const repetitionsScript = join(projectRoot, "scripts", "run-harness-native-benchmark-repetitions.mjs");

interface NativeSuiteDryRunOutput {
	version: 1;
	mode: "dry-run";
	suite: { id: string; fixtureVersion: string };
	outputRoot: string;
	baseCommit: string;
	model: string;
	providerProfile: string;
	taskSpecPaths: string[];
	budgets: { timeoutMs: number; maxIterations: number; maxToolCalls: number; maxObservationBytes: number };
}

describe("Harness-native Benchmark Suite v1", () => {
	it("requires an explicit model and materializes the fixed corpus without an API request in dry-run mode", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-benchmark-suite-"));
		const outputRoot = join(root, "suite");
		try {
			const { stdout } = await execFile(
				process.execPath,
				[suiteScript, "--output-root", outputRoot, "--model", "test-model", "--dry-run"],
				{ cwd: projectRoot, windowsHide: true },
			);
			const output = JSON.parse(stdout) as NativeSuiteDryRunOutput;
			expect(output).toMatchObject({
				version: 1,
				mode: "dry-run",
				suite: { id: "harness-native-public-repair", fixtureVersion: "v1" },
				model: "test-model",
				providerProfile: "openai-responses",
				baseCommit: "ea3b436179b5fc7e98ee2f260193560f74ca663b",
				budgets: { timeoutMs: 120000, maxIterations: 6, maxToolCalls: 8, maxObservationBytes: 4096 },
			});
			expect(output.taskSpecPaths).toHaveLength(5);
			for (const taskSpecPath of output.taskSpecPaths) {
				const task = JSON.parse(await readFile(taskSpecPath, "utf8")) as { model: string };
				expect(task.model).toBe("test-model");
			}
			expect(output.outputRoot).toBe(outputRoot);
			const policy = await validateTaskPolicy(await loadTaskSpec(output.taskSpecPaths[0] ?? ""));
			expect(policy).toMatchObject({
				agentAdapter: "harness-native",
				model: "test-model",
				timeoutMs: 120000,
				nativeAgent: {
					modelProvider: { credentialRef: "openai-primary", provider: "openai", protocol: "responses" },
					maxIterations: 6,
					maxToolCalls: 8,
					maxObservationBytes: 4096,
				},
			});
			const feedbackTaskPath = output.taskSpecPaths.find((path) => path.endsWith("recursive-feedback-repair.json"));
			const feedbackPolicy = await validateTaskPolicy(await loadTaskSpec(feedbackTaskPath ?? ""));
			expect(feedbackPolicy).toMatchObject({
				agentAdapter: "harness-native",
				patchExpectation: "changes-required",
				verificationProfile: { name: "recursive-feedback-repair" },
				nativeAgent: { maxIterations: 8, maxToolCalls: 10 },
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("materializes the fixed DeepSeek Chat profile without using a credential in dry-run mode", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-benchmark-suite-"));
		const outputRoot = join(root, "suite");
		try {
			const { stdout } = await execFile(
				process.execPath,
				[
					suiteScript,
					"--output-root",
					outputRoot,
					"--model",
					"deepseek-v4-pro",
					"--provider-profile",
					"deepseek-chat",
					"--dry-run",
				],
				{ cwd: projectRoot, windowsHide: true },
			);
			const output = JSON.parse(stdout) as NativeSuiteDryRunOutput;
			expect(output.providerProfile).toBe("deepseek-chat");
			for (const taskSpecPath of output.taskSpecPaths) {
				const policy = await validateTaskPolicy(await loadTaskSpec(taskSpecPath));
				expect(policy).toMatchObject({
					model: "deepseek-v4-pro",
					nativeAgent: {
						modelProvider: {
							credentialRef: "deepseek-primary",
							provider: "openai-compatible",
							protocol: "chat-completions",
							thinkingMode: "disabled",
						},
						maxTransportRetries: 1,
					},
				});
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("materializes the separately versioned v2 corpus without changing v1", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-benchmark-suite-"));
		const outputRoot = join(root, "suite");
		try {
			const { stdout } = await execFile(
				process.execPath,
				[suiteScript, "--output-root", outputRoot, "--model", "test-model", "--suite-version", "v2", "--dry-run"],
				{ cwd: projectRoot, windowsHide: true },
			);
			const output = JSON.parse(stdout) as NativeSuiteDryRunOutput;
			expect(output).toMatchObject({
				suite: { id: "harness-native-public-repair", fixtureVersion: "v2" },
				baseCommit: "41bfa2e34e2d76d755cb5a11fc932b6fed4c32b8",
			});
			expect(output.taskSpecPaths).toHaveLength(6);
			const semanticTaskPath = output.taskSpecPaths.find((path) =>
				path.endsWith("configuration-semantic-repair.json"),
			);
			const semanticPolicy = await validateTaskPolicy(await loadTaskSpec(semanticTaskPath ?? ""));
			expect(semanticPolicy).toMatchObject({
				verificationProfile: { name: "settings-semantic" },
				hiddenOracle: { scriptPath: expect.stringContaining("oracle-settings-exact.mjs") },
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("fails before materializing a suite when model selection is omitted", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-benchmark-suite-"));
		const outputRoot = join(root, "suite");
		try {
			await expect(
				execFile(process.execPath, [suiteScript, "--output-root", outputRoot, "--dry-run"], {
					cwd: projectRoot,
					windowsHide: true,
				}),
			).rejects.toMatchObject({ stderr: expect.stringContaining("--model") });
			await expect(access(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects an unsafe repetition count before starting a model-backed experiment", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-benchmark-repetitions-"));
		const outputRoot = join(root, "suite");
		try {
			await expect(
				execFile(
					process.execPath,
					[repetitionsScript, "--output-root", outputRoot, "--runs", "1", "--model", "test-model"],
					{ cwd: projectRoot, windowsHide: true },
				),
			).rejects.toMatchObject({ stderr: expect.stringContaining("runs must be an integer") });
			await expect(access(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("fails closed before materializing a suite when a real run has no API key", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-benchmark-suite-"));
		const outputRoot = join(root, "suite");
		try {
			await expect(
				execFile(process.execPath, [suiteScript, "--output-root", outputRoot, "--model", "test-model"], {
					cwd: projectRoot,
					windowsHide: true,
					env: { ...process.env, OPENAI_API_KEY: "" },
				}),
			).rejects.toMatchObject({ stderr: expect.stringContaining("OPENAI_API_KEY") });
			await expect(access(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("requires the selected profile credential before materializing a real run", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-benchmark-suite-"));
		const outputRoot = join(root, "suite");
		try {
			await expect(
				execFile(
					process.execPath,
					[
						suiteScript,
						"--output-root",
						outputRoot,
						"--model",
						"deepseek-v4-pro",
						"--provider-profile",
						"deepseek-chat",
					],
					{ cwd: projectRoot, windowsHide: true, env: { ...process.env, DEEPSEEK_API_KEY: "" } },
				),
			).rejects.toMatchObject({ stderr: expect.stringContaining("DEEPSEEK_API_KEY") });
			await expect(access(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
