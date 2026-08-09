import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	HIDDEN_ORACLE_WORKTREE_ENV,
	probeHiddenOracleIsolation,
	runHiddenOracle,
	terminateHiddenOracleProcess,
} from "../../src/agentpatchcheck/hidden-oracle";

describe("Hidden Oracle", () => {
	it("terminates the complete Windows Oracle process tree on timeout", () => {
		let childKilled = false;
		let treePid: number | undefined;
		const child = {
			pid: 42,
			kill: () => {
				childKilled = true;
				return true;
			},
		};

		terminateHiddenOracleProcess(child, "win32", (pid, callback) => {
			treePid = pid;
			callback();
		});

		expect(treePid).toBe(42);
		expect(childKilled).toBe(false);
	});

	it("keeps direct Oracle process termination on Unix", () => {
		let childKilled = false;
		terminateHiddenOracleProcess(
			{
				pid: 42,
				kill: () => {
					childKilled = true;
					return true;
				},
			},
			"linux",
		);
		expect(childKilled).toBe(true);
	});

	it("runs outside the agent workspace and records only a structural result", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agentpatchcheck-hidden-oracle-"));
		try {
			const scriptPath = join(directory, "oracle.mjs");
			await writeFile(
				scriptPath,
				`if (process.env.${HIDDEN_ORACLE_WORKTREE_ENV} !== "worktree-path") process.exit(2); process.stdout.write("hidden body");`,
				"utf8",
			);

			const result = await runHiddenOracle(
				{
					scriptPath,
					timeoutMs: 5_000,
					isolation: "none",
					memoryLimitBytes: 512 * 1024 * 1024,
					cpuRatePercent: 50,
				},
				"worktree-path",
			);

			expect(result).toMatchObject({
				id: "hidden-oracle",
				kind: "hidden-oracle",
				status: "passed",
				durationMs: expect.any(Number),
				exitCode: 0,
				signal: null,
				diagnostic: null,
				isolation: { requested: "none", available: true, backend: "none" },
			});
			expect(JSON.stringify(result)).not.toContain("hidden body");
			expect(JSON.stringify(result)).not.toContain(scriptPath);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("distinguishes rejection, timeout, and Oracle infrastructure failure", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agentpatchcheck-hidden-oracle-"));
		try {
			const rejectedPath = join(directory, "rejected.mjs");
			const timeoutPath = join(directory, "timeout.mjs");
			const infrastructurePath = join(directory, "infrastructure.mjs");
			await writeFile(rejectedPath, "process.exit(1)", "utf8");
			await writeFile(timeoutPath, "setTimeout(() => process.exit(0), 1_000)", "utf8");
			await writeFile(infrastructurePath, "process.exit(2)", "utf8");

			const rejected = await runHiddenOracle(
				{
					scriptPath: rejectedPath,
					timeoutMs: 5_000,
					isolation: "none",
					memoryLimitBytes: 512 * 1024 * 1024,
					cpuRatePercent: 50,
				},
				"worktree-path",
			);
			const timedOut = await runHiddenOracle(
				{
					scriptPath: timeoutPath,
					timeoutMs: 10,
					isolation: "none",
					memoryLimitBytes: 512 * 1024 * 1024,
					cpuRatePercent: 50,
				},
				"worktree-path",
			);
			const infrastructureFailure = await runHiddenOracle(
				{
					scriptPath: infrastructurePath,
					timeoutMs: 5_000,
					isolation: "none",
					memoryLimitBytes: 512 * 1024 * 1024,
					cpuRatePercent: 50,
				},
				"worktree-path",
			);

			expect(rejected).toMatchObject({
				status: "failed",
				exitCode: 1,
				diagnostic: "Hidden Oracle rejected the patch.",
			});
			expect(timedOut).toMatchObject({ status: "timed-out", diagnostic: "Hidden Oracle timed out." });
			expect(infrastructureFailure).toMatchObject({
				status: "error",
				exitCode: 2,
				diagnostic: "Hidden Oracle infrastructure failed.",
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("fails closed without starting an Oracle when requested OS isolation is unavailable", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agentpatchcheck-hidden-oracle-"));
		try {
			const markerPath = join(directory, "started.txt");
			const scriptPath = join(directory, "oracle.mjs");
			await writeFile(
				scriptPath,
				`import { writeFile } from "node:fs/promises"; await writeFile(${JSON.stringify(markerPath)}, "started");`,
				"utf8",
			);

			const capability = probeHiddenOracleIsolation("network");
			const result = await runHiddenOracle(
				{
					scriptPath,
					timeoutMs: 5_000,
					isolation: "network",
					memoryLimitBytes: 512 * 1024 * 1024,
					cpuRatePercent: 50,
				},
				"worktree-path",
			);

			expect(capability).toMatchObject({ requested: "network", available: false, backend: null });
			expect(result).toMatchObject({
				status: "error",
				diagnostic: "Requested Hidden Oracle isolation is unavailable.",
				isolation: capability,
			});
			await expect(writeFile(markerPath, "check", { flag: "wx" })).resolves.toBeUndefined();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
