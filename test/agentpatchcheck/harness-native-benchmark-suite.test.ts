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

interface NativeSuiteDryRunOutput {
	version: 1;
	mode: "dry-run";
	suite: { id: string; fixtureVersion: string };
	outputRoot: string;
	baseCommit: string;
	model: string;
	taskSpecPath: string;
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
				baseCommit: "f15f6f4227826eacd0713e323e4143f3cd0cb316",
				budgets: { timeoutMs: 120000, maxIterations: 6, maxToolCalls: 6, maxObservationBytes: 4096 },
			});
			const task = JSON.parse(await readFile(output.taskSpecPath, "utf8")) as { model: string };
			expect(task.model).toBe("test-model");
			expect(output.outputRoot).toBe(outputRoot);
			const policy = await validateTaskPolicy(await loadTaskSpec(output.taskSpecPath));
			expect(policy).toMatchObject({
				agentAdapter: "harness-native",
				model: "test-model",
				timeoutMs: 120000,
				nativeAgent: {
					modelProvider: { credentialRef: "openai-primary", provider: "openai", protocol: "responses" },
					maxIterations: 6,
					maxToolCalls: 6,
					maxObservationBytes: 4096,
				},
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
});
