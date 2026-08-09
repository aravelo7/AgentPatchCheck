import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { HEADLESS_CLI_CONTRACT_VERSION } from "../../src/agentpatchcheck/cli";
import { HEADLESS_CLI_VERSION } from "../../src/agentpatchcheck/cli-version";

const repositoryRoot = process.cwd();
const distributionCliPath = join(repositoryRoot, "dist", "agentpatchcheck.js");

async function runNode(args: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
	return await new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, args, {
			cwd: repositoryRoot,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.once("error", reject);
		child.once("close", (exitCode) => resolvePromise({ exitCode, stdout, stderr }));
	});
}

describe("distributed Headless CLI", () => {
	it("keeps the public CLI version aligned with the package version", async () => {
		const packageJson = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as {
			version: string;
		};
		expect(HEADLESS_CLI_VERSION).toBe(packageJson.version);
	});

	it("runs the built agentpatchcheck binary without tsx and preserves its public command contract", async () => {
		const build = await runNode(["scripts/build.mjs"]);
		expect(build).toMatchObject({ exitCode: 0, stderr: "" });
		await expect(access(distributionCliPath)).resolves.toBeUndefined();

		const result = await runNode([distributionCliPath, "show"]);
		expect(result).toMatchObject({ exitCode: 2, stderr: "" });
		expect(JSON.parse(result.stdout)).toEqual({
			contractVersion: HEADLESS_CLI_CONTRACT_VERSION,
			command: "show",
			ok: false,
			data: null,
			error: expect.objectContaining({ code: "invalid-arguments" }),
		});

		const benchmark = await runNode([distributionCliPath, "benchmark"]);
		expect(benchmark).toMatchObject({ exitCode: 2, stderr: "" });
		expect(JSON.parse(benchmark.stdout)).toMatchObject({
			contractVersion: HEADLESS_CLI_CONTRACT_VERSION,
			command: "benchmark",
			ok: false,
			error: { code: "invalid-arguments" },
		});

		const version = await runNode([distributionCliPath, "--version"]);
		expect(version).toEqual({ exitCode: 0, stdout: `${HEADLESS_CLI_VERSION}\n`, stderr: "" });
		const help = await runNode([distributionCliPath, "--help"]);
		expect(help).toMatchObject({ exitCode: 0, stderr: "" });
		expect(help.stdout).toContain("benchmark-compare");
	});
});
