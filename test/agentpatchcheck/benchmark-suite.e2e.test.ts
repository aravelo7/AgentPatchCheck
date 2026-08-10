import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { runBenchmark } from "../../src/agentpatchcheck/benchmark-runner";
import { loadBenchmarkSpec } from "../../src/agentpatchcheck/benchmark-spec";

const execFile = promisify(execFileCallback);

async function git(repository: string, args: string[]): Promise<void> {
	await execFile("git", args, { cwd: repository, windowsHide: true });
}

async function writeTask(options: {
	suiteDirectory: string;
	repository: string;
	id: string;
	expectedStatus: string;
	agentScript: string;
	timeoutMs?: number;
	verification?: { command: string; args: string[] };
	hiddenOracle?: { script: string; isolation?: "none" | "network" | "process" | "strict" };
}): Promise<void> {
	await writeFile(
		join(options.suiteDirectory, "tasks", `${options.id}.json`),
		JSON.stringify(
			{
				version: 1,
				repositoryRoot: relative(join(options.suiteDirectory, "tasks"), options.repository),
				prompt: `Harness suite task: ${options.id}`,
				agentAdapter: "script",
				agentScript: `scripts/${options.agentScript}`,
				timeoutMs: options.timeoutMs ?? 5_000,
				patchExpectation: "changes-required",
				verification:
					options.verification === undefined
						? undefined
						: { commands: [{ ...options.verification, timeoutMs: 5_000 }] },
				hiddenOracle:
					options.hiddenOracle === undefined
						? undefined
						: {
								script: `scripts/${options.hiddenOracle.script}`,
								isolation: options.hiddenOracle.isolation,
							},
			},
			null,
			2,
		),
		"utf8",
	);
}

describe("Harness Benchmark Suite v1", () => {
	it("records deterministic Headless Core classifications through the real orchestration path", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentpatchcheck-benchmark-suite-"));
		const repository = join(root, "target-repository");
		const suiteDirectory = join(root, "harness-suite");
		try {
			await mkdir(repository, { recursive: true });
			await writeFile(join(repository, "README.md"), "before\n", "utf8");
			await git(repository, ["init"]);
			await git(repository, ["config", "user.email", "fixture@example.invalid"]);
			await git(repository, ["config", "user.name", "Fixture"]);
			await git(repository, ["add", "."]);
			await git(repository, ["commit", "-m", "base"]);
			await mkdir(join(suiteDirectory, "tasks"), { recursive: true });
			await mkdir(join(suiteDirectory, "tasks", "scripts"), { recursive: true });
			await writeFile(
				join(suiteDirectory, "tasks", "scripts", "change-readme.mjs"),
				`import { writeFile } from "node:fs/promises"; import { join } from "node:path"; await writeFile(join(process.env.AGENTPATCHCHECK_AGENT_WORKTREE, "README.md"), "after\\n");`,
				"utf8",
			);
			await writeFile(join(suiteDirectory, "tasks", "scripts", "agent-failure.mjs"), "process.exit(1);", "utf8");
			await writeFile(
				join(suiteDirectory, "tasks", "scripts", "timeout.mjs"),
				"setTimeout(() => process.exit(0), 1000);",
				"utf8",
			);
			await writeFile(join(suiteDirectory, "tasks", "scripts", "oracle-reject.mjs"), "process.exit(1);", "utf8");

			await writeTask({
				suiteDirectory,
				repository,
				id: "success",
				expectedStatus: "passed",
				agentScript: "change-readme.mjs",
			});
			await writeTask({
				suiteDirectory,
				repository,
				id: "agent-failure",
				expectedStatus: "agent-failed",
				agentScript: "agent-failure.mjs",
			});
			await writeTask({
				suiteDirectory,
				repository,
				id: "verification-failure",
				expectedStatus: "verification-failed",
				agentScript: "change-readme.mjs",
				verification: { command: process.execPath, args: ["-e", "process.exit(1)"] },
			});
			await writeTask({
				suiteDirectory,
				repository,
				id: "oracle-reject",
				expectedStatus: "hidden-oracle-failed",
				agentScript: "change-readme.mjs",
				hiddenOracle: { script: "oracle-reject.mjs" },
			});
			await writeTask({
				suiteDirectory,
				repository,
				id: "oracle-isolation",
				expectedStatus: "hidden-oracle-error",
				agentScript: "change-readme.mjs",
				hiddenOracle: { script: "oracle-reject.mjs", isolation: "network" },
			});
			await writeTask({
				suiteDirectory,
				repository,
				id: "timeout",
				expectedStatus: "timed-out",
				agentScript: "timeout.mjs",
				timeoutMs: 50,
			});
			const specPath = join(suiteDirectory, "benchmark.json");
			await writeFile(
				specPath,
				JSON.stringify({
					version: 1,
					name: "headless-core-v1",
					suite: { id: "headless-core", fixtureVersion: "v1" },
					tasks: [
						"success",
						"agent-failure",
						"verification-failure",
						"oracle-reject",
						"oracle-isolation",
						"timeout",
					].map((id) => ({
						id,
						taskSpec: `tasks/${id}.json`,
						expectedStatus:
							id === "success"
								? "passed"
								: id === "agent-failure"
									? "agent-failed"
									: id === "verification-failure"
										? "verification-failed"
										: id === "oracle-reject"
											? "hidden-oracle-failed"
											: id === "oracle-isolation"
												? "hidden-oracle-error"
												: "timed-out",
					})),
				}),
				"utf8",
			);

			const result = await runBenchmark(await loadBenchmarkSpec(specPath));

			expect(result.report.benchmark).toMatchObject({ suite: { id: "headless-core", fixtureVersion: "v1" } });
			expect(
				result.report.tasks.map((task) => [task.taskId, task.status, task.configuration.expectedStatus]),
			).toEqual([
				["success", "passed", "passed"],
				["agent-failure", "agent-failed", "agent-failed"],
				["verification-failure", "verification-failed", "verification-failed"],
				["oracle-reject", "hidden-oracle-failed", "hidden-oracle-failed"],
				["oracle-isolation", "hidden-oracle-error", "hidden-oracle-error"],
				["timeout", "timed-out", "timed-out"],
			]);
			expect(result.report.tasks.every((task) => task.evidence !== null && task.assessment !== null)).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
