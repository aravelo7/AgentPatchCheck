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

	it("materializes the separately versioned v3 corpus with feedback invariants and nested configuration semantics", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-benchmark-suite-"));
		const outputRoot = join(root, "suite");
		try {
			const { stdout } = await execFile(
				process.execPath,
				[suiteScript, "--output-root", outputRoot, "--model", "test-model", "--suite-version", "v3", "--dry-run"],
				{ cwd: projectRoot, windowsHide: true },
			);
			const output = JSON.parse(stdout) as NativeSuiteDryRunOutput;
			expect(output).toMatchObject({
				suite: { id: "harness-native-public-repair", fixtureVersion: "v3" },
				baseCommit: "f5fe46204f769c8f73f4d59c4639b80f62a8c396",
			});
			expect(output.taskSpecPaths).toHaveLength(8);
			const feedbackInvariantPath = output.taskSpecPaths.find((path) =>
				path.endsWith("recursive-feedback-invariant-repair.json"),
			);
			const configurationInvariantPath = output.taskSpecPaths.find((path) =>
				path.endsWith("nested-configuration-invariant-repair.json"),
			);
			expect(await validateTaskPolicy(await loadTaskSpec(feedbackInvariantPath ?? ""))).toMatchObject({
				verificationProfile: { name: "recursive-feedback-invariant" },
				hiddenOracle: { scriptPath: expect.stringContaining("oracle-recursive-feedback-invariant-exact.mjs") },
				nativeAgent: { maxIterations: 8, maxToolCalls: 10 },
			});
			expect(await validateTaskPolicy(await loadTaskSpec(configurationInvariantPath ?? ""))).toMatchObject({
				verificationProfile: { name: "nested-settings-targets" },
				hiddenOracle: { scriptPath: expect.stringContaining("oracle-nested-settings-exact.mjs") },
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("materializes the v4 extension corpus without changing the v3 source fixture", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-benchmark-suite-"));
		const outputRoot = join(root, "suite");
		try {
			const { stdout } = await execFile(
				process.execPath,
				[suiteScript, "--output-root", outputRoot, "--model", "test-model", "--suite-version", "v4", "--dry-run"],
				{ cwd: projectRoot, windowsHide: true },
			);
			const output = JSON.parse(stdout) as NativeSuiteDryRunOutput;
			expect(output).toMatchObject({
				suite: { id: "harness-native-public-repair", fixtureVersion: "v4" },
				baseCommit: "5af355fd77539c8ca140d678651880fdad668b4b",
			});
			expect(output.taskSpecPaths).toHaveLength(12);
			const contractTaskPath = output.taskSpecPaths.find((path) => path.endsWith("cross-file-contract-repair.json"));
			expect(await validateTaskPolicy(await loadTaskSpec(contractTaskPath ?? ""))).toMatchObject({
				verificationProfile: { name: "cross-file-contract" },
				hiddenOracle: { scriptPath: expect.stringContaining("oracle-cross-file-contract.mjs") },
				nativeAgent: { maxIterations: 8, maxToolCalls: 10 },
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("materializes the v5 controlled edit and self-verification corpus without changing v4", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-benchmark-suite-"));
		const outputRoot = join(root, "suite");
		try {
			const { stdout } = await execFile(
				process.execPath,
				[suiteScript, "--output-root", outputRoot, "--model", "test-model", "--suite-version", "v5", "--dry-run"],
				{ cwd: projectRoot, windowsHide: true },
			);
			const output = JSON.parse(stdout) as NativeSuiteDryRunOutput;
			expect(output).toMatchObject({
				suite: { id: "harness-native-public-repair", fixtureVersion: "v5" },
				baseCommit: "1f487c7346407098397230807a9f4c971a826781",
			});
			expect(output.taskSpecPaths).toHaveLength(13);
			const taskPath = output.taskSpecPaths.find((path) => path.endsWith("edit-batch-public-verification.json"));
			const policy = await validateTaskPolicy(await loadTaskSpec(taskPath ?? ""));
			expect(policy).toMatchObject({
				verificationProfile: { name: "edit-batch-public" },
				hiddenOracle: { scriptPath: expect.stringContaining("oracle-edit-batch-public-verification.mjs") },
				nativeAgent: { maxIterations: 8, maxToolCalls: 10 },
			});
			expect(
				await readFile(join(outputRoot, "tasks", "prompts", "edit-batch-public-verification.txt"), "utf8"),
			).toContain("apply-edit-batch");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("materializes the v6 directed cross-file repair corpus without changing v5", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-benchmark-suite-"));
		const outputRoot = join(root, "suite");
		try {
			const { stdout } = await execFile(
				process.execPath,
				[suiteScript, "--output-root", outputRoot, "--model", "test-model", "--suite-version", "v6", "--dry-run"],
				{ cwd: projectRoot, windowsHide: true },
			);
			const output = JSON.parse(stdout) as NativeSuiteDryRunOutput;
			expect(output).toMatchObject({
				suite: { id: "harness-native-public-repair", fixtureVersion: "v6" },
				baseCommit: "1f487c7346407098397230807a9f4c971a826781",
			});
			expect(output.taskSpecPaths).toHaveLength(13);
			expect(JSON.parse(await readFile(join(outputRoot, "benchmark.json"), "utf8"))).toMatchObject({
				name: "harness-native-public-repair-v6",
				suite: { id: "harness-native-public-repair", fixtureVersion: "v6" },
			});
			const prompt = await readFile(join(outputRoot, "tasks", "prompts", "cross-file-contract-repair.txt"), "utf8");
			expect(prompt).toContain("src/api/request.ts");
			expect(prompt).toContain("src/api/response.ts");
			expect(prompt).toContain("apply-edit-batch");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("materializes the v7 directed source normalization corpus without changing v6", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-benchmark-suite-"));
		const outputRoot = join(root, "suite");
		try {
			const { stdout } = await execFile(
				process.execPath,
				[suiteScript, "--output-root", outputRoot, "--model", "test-model", "--suite-version", "v7", "--dry-run"],
				{ cwd: projectRoot, windowsHide: true },
			);
			const output = JSON.parse(stdout) as NativeSuiteDryRunOutput;
			expect(output).toMatchObject({
				suite: { id: "harness-native-public-repair", fixtureVersion: "v7" },
				baseCommit: "1f487c7346407098397230807a9f4c971a826781",
			});
			expect(JSON.parse(await readFile(join(outputRoot, "benchmark.json"), "utf8"))).toMatchObject({
				name: "harness-native-public-repair-v7",
				suite: { id: "harness-native-public-repair", fixtureVersion: "v7" },
			});
			const prompt = await readFile(join(outputRoot, "tasks", "prompts", "source-normalization-repair.txt"), "utf8");
			expect(prompt).toContain("src/domain/normalize.ts");
			expect(prompt).toContain("apply-patch");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("materializes the v8 directed validation-boundary corpus without changing v7", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-benchmark-suite-"));
		const outputRoot = join(root, "suite");
		try {
			const { stdout } = await execFile(
				process.execPath,
				[suiteScript, "--output-root", outputRoot, "--model", "test-model", "--suite-version", "v8", "--dry-run"],
				{ cwd: projectRoot, windowsHide: true },
			);
			const output = JSON.parse(stdout) as NativeSuiteDryRunOutput;
			expect(output).toMatchObject({
				suite: { id: "harness-native-public-repair", fixtureVersion: "v8" },
				baseCommit: "1f487c7346407098397230807a9f4c971a826781",
			});
			expect(JSON.parse(await readFile(join(outputRoot, "benchmark.json"), "utf8"))).toMatchObject({
				name: "harness-native-public-repair-v8",
				suite: { id: "harness-native-public-repair", fixtureVersion: "v8" },
			});
			const prompt = await readFile(join(outputRoot, "tasks", "prompts", "validation-boundary-repair.txt"), "utf8");
			expect(prompt).toContain("src/validation/range.ts");
			expect(prompt).toContain("finish");
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
						"--suite-version",
						"v7",
					],
					{ cwd: projectRoot, windowsHide: true, env: { ...process.env, DEEPSEEK_API_KEY: "" } },
				),
			).rejects.toMatchObject({ stderr: expect.stringContaining("DEEPSEEK_API_KEY") });
			await expect(access(outputRoot)).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("preserves a child suite credential diagnostic in a repetitions failure", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentpatchcheck-native-benchmark-repetitions-"));
		const outputRoot = join(root, "suite");
		try {
			await expect(
				execFile(
					process.execPath,
					[
						repetitionsScript,
						"--output-root",
						outputRoot,
						"--runs",
						"2",
						"--model",
						"test-model",
						"--provider-profile",
						"deepseek-chat",
						"--suite-version",
						"v6",
					],
					{ cwd: projectRoot, windowsHide: true, env: { ...process.env, DEEPSEEK_API_KEY: "" } },
				),
			).rejects.toMatchObject({ stderr: expect.stringContaining("DEEPSEEK_API_KEY") });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
