import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { compareBenchmarkReports } from "../../src/agentpatchcheck/benchmark-compare";
import type { BenchmarkReport } from "../../src/agentpatchcheck/types";

const execFile = promisify(execFileCallback);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const suiteScript = join(projectRoot, "scripts", "run-deterministic-benchmark-suite.mjs");

interface DeterministicSuiteOutput {
	version: 1;
	suite: { id: string; fixtureVersion: string };
	outputRoot: string;
	baseCommit: string;
	benchmarkReportPath: string;
	taskStatuses: Array<{ id: string; status: string }>;
}

async function runSuite(outputRoot: string): Promise<DeterministicSuiteOutput> {
	const { stdout } = await execFile(process.execPath, [suiteScript, "--output-root", outputRoot], {
		cwd: projectRoot,
		windowsHide: true,
	});
	return JSON.parse(stdout) as DeterministicSuiteOutput;
}

describe("Deterministic Benchmark Suite v1", () => {
	it("materializes the committed corpus and records fixed task, profile, fixture, and Oracle identities", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentpatchcheck-deterministic-benchmark-suite-"));
		try {
			const outputRoot = join(root, "suite");
			const output = await runSuite(outputRoot);
			const report = JSON.parse(await readFile(output.benchmarkReportPath, "utf8")) as BenchmarkReport;

			expect(output).toMatchObject({
				version: 1,
				suite: { id: "deterministic-headless-core", fixtureVersion: "v1" },
				baseCommit: "6bea5431946e1b551d904349988167118a34adeb",
			});
			expect(output.taskStatuses).toEqual([
				{ id: "success", status: "passed" },
				{ id: "agent-failure", status: "agent-failed" },
				{ id: "verification-failure", status: "verification-failed" },
				{ id: "hidden-oracle-failure", status: "hidden-oracle-failed" },
				{ id: "timeout", status: "timed-out" },
			]);
			expect(report.benchmark).toMatchObject({
				suite: { id: "deterministic-headless-core", fixtureVersion: "v1" },
			});
			expect(report.executionIdentity).toMatchObject({
				suite: { id: "deterministic-headless-core", fixtureVersion: "v1" },
			});
			expect(report.tasks.every((task) => task.evidence !== null && task.assessment !== null)).toBe(true);
			expect(report.tasks.every((task) => task.configuration.verificationProfile !== null)).toBe(true);
			expect(report.tasks.every((task) => task.configuration.riskPolicyProfile !== null)).toBe(true);
			expect(report.tasks.every((task) => task.executionIdentity?.baseCommit === output.baseCommit)).toBe(true);
			for (const task of report.tasks.filter(
				(task) => task.taskId === "success" || task.taskId === "hidden-oracle-failure",
			)) {
				expect(task.executionIdentity?.hiddenOracleSha256).toMatch(/^[a-f0-9]{64}$/u);
			}

			const candidate = await runSuite(join(root, "candidate"));
			const comparison = await compareBenchmarkReports({
				leftReportPath: output.benchmarkReportPath,
				rightReportPath: candidate.benchmarkReportPath,
			});
			expect(candidate.baseCommit).toBe(output.baseCommit);
			expect(comparison.compatibility).toEqual({ status: "comparable", reasons: [] });
			expect(comparison.tasks.every((task) => task.change === "unchanged")).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}, 45_000);
});
