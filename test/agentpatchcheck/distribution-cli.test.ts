import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { HEADLESS_CLI_CONTRACT_VERSION } from "../../src/agentpatchcheck/cli";

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
	it("runs the built agentpatchcheck binary without tsx and preserves the JSON argument contract", async () => {
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
	});
});
