import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";

const executable = join(process.cwd(), "dist", "agentpatchcheck.js");
const installedBin = join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "agentpatchcheck.cmd" : "agentpatchcheck");

async function run(args, expectedExitCode, expectedCommand) {
	const result = await new Promise((resolvePromise, reject) => {
		const command = process.platform === "win32" ? process.execPath : installedBin;
		const commandArgs = process.platform === "win32" ? [executable, ...args] : args;
		const child = spawn(command, commandArgs, {
			cwd: process.cwd(),
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.once("error", reject);
		child.once("close", (exitCode) => resolvePromise({ exitCode, stdout, stderr }));
	});
	if (result.exitCode !== expectedExitCode) throw new Error(`${expectedCommand} exit code was ${result.exitCode}.`);
	if (result.stderr !== "") throw new Error(`${expectedCommand} wrote to stderr: ${result.stderr}`);
	const response = JSON.parse(result.stdout);
	if (response.command !== expectedCommand || response.ok !== false || response.error?.code !== "invalid-arguments")
		throw new Error(`${expectedCommand} did not preserve the Headless CLI argument contract.`);
}

await access(executable);
if (process.platform !== "win32") await access(installedBin);
await run(["show"], 2, "show");
await run(["benchmark"], 2, "benchmark");
console.log("agentpatchcheck Headless CLI smoke passed.");
