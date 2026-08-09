import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runHiddenOracle } from "../../src/agentpatchcheck/hidden-oracle";
import type { HiddenOraclePolicy } from "../../src/agentpatchcheck/types";
import {
	getWindowsJobCapability,
	runWindowsJob,
	type WindowsJobBackendPaths,
} from "../../src/agentpatchcheck/windows-job-backend";

const helperPaths: WindowsJobBackendPaths = {
	helperPath: resolve("dist/native/windows/agentpatchcheck-job-helper.exe"),
	manifestPath: resolve("dist/native/windows/agentpatchcheck-job-helper.manifest.json"),
};

function policy(scriptPath: string, timeoutMs = 5_000): HiddenOraclePolicy {
	return { scriptPath, timeoutMs, isolation: "process", memoryLimitBytes: 128 * 1024 * 1024, cpuRatePercent: 25 };
}

describe.runIf(process.platform === "win32")("Windows Job backend", () => {
	it("runs an Oracle only after the verified helper capability is available", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agentpatchcheck-windows-job-"));
		try {
			const scriptPath = join(directory, "oracle.mjs");
			const markerPath = join(directory, "marker.txt");
			await writeFile(
				scriptPath,
				`import { writeFile } from "node:fs/promises"; await writeFile(${JSON.stringify(markerPath)}, process.env.AGENTPATCHCHECK_ORACLE_WORKTREE ?? "missing");`,
				"utf8",
			);
			const oracle = policy(scriptPath);
			const capability = await getWindowsJobCapability(oracle, helperPaths);
			expect(capability).toMatchObject({
				available: true,
				backend: "windows-job",
				limits: { memoryLimitBytes: oracle.memoryLimitBytes, cpuRatePercent: oracle.cpuRatePercent },
			});
			const result = await runHiddenOracle(oracle, "isolated-worktree");
			expect(result).toMatchObject({
				status: "passed",
				isolation: {
					backend: "windows-job",
					execution: { terminationReason: "completed", resourceLimitsApplied: true },
				},
			});
			expect(await readFile(markerPath, "utf8")).toBe("isolated-worktree");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("fails closed when the helper is missing or its hash is invalid", async () => {
		const oracle = policy("C:\\does-not-run.mjs");
		const missing = await getWindowsJobCapability(oracle, {
			helperPath: "C:\\missing-helper.exe",
			manifestPath: helperPaths.manifestPath,
		});
		expect(missing).toMatchObject({ available: false, backend: null });
		const directory = await mkdtemp(join(tmpdir(), "agentpatchcheck-windows-job-manifest-"));
		try {
			const manifestPath = join(directory, "manifest.json");
			const actualHash = createHash("sha256")
				.update(await readFile(helperPaths.helperPath))
				.digest("hex");
			await writeFile(
				manifestPath,
				JSON.stringify({
					protocolVersion: 1,
					helperVersion: "1.0.0",
					file: "agentpatchcheck-job-helper.exe",
					sha256: `${actualHash.startsWith("0") ? "1" : "0"}${actualHash.slice(1)}`,
				}),
				"utf8",
			);
			const invalid = await getWindowsJobCapability(oracle, { helperPath: helperPaths.helperPath, manifestPath });
			expect(invalid).toMatchObject({ available: false, backend: null });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("terminates an Oracle child process tree when the Job timeout expires", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agentpatchcheck-windows-job-timeout-"));
		try {
			const scriptPath = join(directory, "oracle.mjs");
			const markerPath = join(directory, "child-marker.txt");
			await writeFile(
				scriptPath,
				`import { spawn } from "node:child_process"; spawn(process.execPath, ["-e", ${JSON.stringify(`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "orphan"), 500)`)}], { stdio: "ignore" }); setInterval(() => {}, 1_000);`,
				"utf8",
			);
			const result = await runWindowsJob(policy(scriptPath, 100), "isolated-worktree", helperPaths);
			expect(result).toMatchObject({ status: "timed-out", terminationReason: "timeout" });
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 750));
			await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
