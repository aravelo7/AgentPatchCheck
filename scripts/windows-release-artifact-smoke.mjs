import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

if (process.platform !== "win32") {
	console.log("windows-release-artifact-smoke: skipped outside Windows");
	process.exit(0);
}

const root = resolve(import.meta.dirname, "..");

function quoteForCmd(value) {
	return `"${value.replaceAll('"', '""')}"`;
}

async function run(command, args, options = {}) {
	return await new Promise((resolveResult, reject) => {
		const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...options });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.once("error", reject);
		child.once("close", (exitCode) => resolveResult({ exitCode, stdout, stderr }));
	});
}

async function requireSuccess(command, args, options) {
	const result = await run(command, args, options);
	if (result.exitCode !== 0) throw new Error(`${basename(command)} failed: ${result.stderr || result.stdout}`);
	return result;
}

async function npm(args, options) {
	const npmCommand = join(dirname(process.execPath), "npm.cmd");
	return await requireSuccess(
		process.env.ComSpec ?? "cmd.exe",
		["/d", "/c", `call ${quoteForCmd(npmCommand)} ${args.map(quoteForCmd).join(" ")}`],
		{ windowsVerbatimArguments: true, ...options },
	);
}

const smokeRoot = await mkdtemp(join(tmpdir(), "agentpatchcheck-release-smoke-"));
let tarballPath = null;
try {
	await requireSuccess(process.execPath, ["scripts/build.mjs"]);
	await requireSuccess(process.execPath, ["scripts/build-windows-job-helper.mjs"]);
	const packed = await npm(["pack", "--ignore-scripts"]);
	const tarballName = packed.stdout.trim().split(/\r?\n/).at(-1);
	if (tarballName === undefined || !tarballName.endsWith(".tgz")) throw new Error("npm pack did not return a tarball name.");
	tarballPath = join(root, tarballName);

	const consumer = join(smokeRoot, "consumer");
	const repository = join(smokeRoot, "repository");
	const specDirectory = join(smokeRoot, "spec");
	await mkdir(specDirectory, { recursive: true });
	await requireSuccess("git", ["init", "-q", repository]);
	await requireSuccess("git", ["-C", repository, "config", "user.email", "smoke@example.invalid"]);
	await requireSuccess("git", ["-C", repository, "config", "user.name", "release-smoke"]);
	await writeFile(join(repository, "baseline.txt"), "baseline\n", "utf8");
	await requireSuccess("git", ["-C", repository, "add", "baseline.txt"]);
	await requireSuccess("git", ["-C", repository, "commit", "-qm", "baseline"]);
	await writeFile(join(specDirectory, "agent.mjs"), "process.exit(0);\n", "utf8");
	await writeFile(join(specDirectory, "oracle.mjs"), "process.exit(process.env.AGENTPATCHCHECK_ORACLE_WORKTREE ? 0 : 2);\n", "utf8");
	await writeFile(join(specDirectory, "task.json"), JSON.stringify({
		version: 1,
		repositoryRoot: "../repository",
		prompt: "No-op release artifact smoke.",
		baseRef: "HEAD",
		worktreeRoot: "../repository/.worktrees",
		runId: "release-artifact-smoke",
		agentAdapter: "script",
		agentScript: "agent.mjs",
		timeoutMs: 30_000,
		sandbox: "workspace-write",
		allowNetwork: false,
		patchExpectation: "changes-optional",
		hiddenOracle: { script: "oracle.mjs", timeoutMs: 5_000, isolation: "process", memoryLimitBytes: 134_217_728, cpuRatePercent: 25 },
	}), "utf8");
	await npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--prefix", consumer, tarballPath], { cwd: smokeRoot });
	const cli = join(consumer, "node_modules", "kanban", "dist", "agentpatchcheck.js");
	const executed = await requireSuccess(process.execPath, [cli, "run", "--task-spec", join(specDirectory, "task.json")], { cwd: smokeRoot });
	const response = JSON.parse(executed.stdout);
	const isolation = response.data?.hiddenOracle?.isolation;
	if (response.ok !== true || response.data?.hiddenOracle?.status !== "passed" || isolation?.backend !== "windows-job" || isolation?.available !== true || isolation?.execution?.resourceLimitsApplied !== true) {
		throw new Error("Installed package did not run the Hidden Oracle through the verified Windows Job backend.");
	}
	console.log("windows-release-artifact-smoke: passed");
} finally {
	if (tarballPath !== null) await rm(tarballPath, { force: true });
	await rm(smokeRoot, { recursive: true, force: true });
}
