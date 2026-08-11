import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const fixtureSource = join(projectRoot, "test", "fixtures", "agentpatchcheck", "deterministic-benchmark-suite-v1");
const cliPath = join(projectRoot, "src", "agentpatchcheck", "cli.ts");

function parseOutputRoot(argv) {
	if (argv.length !== 2 || argv[0] !== "--output-root" || !argv[1]?.trim()) {
		throw new Error("Usage: npm run benchmark:deterministic-suite -- --output-root <new-directory>");
	}
	return resolve(argv[1]);
}

async function assertPathDoesNotExist(path) {
	try {
		await access(path);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
	throw new Error(`Output root must not already exist: ${path}`);
}

async function run(command, args, options = {}) {
	return await new Promise((resolveRun, rejectRun) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.once("error", rejectRun);
		child.once("close", (code, signal) => resolveRun({ code, signal, stdout, stderr }));
	});
}

async function runGit(repository, args, env) {
	const result = await run("git", ["-C", repository, ...args], { env });
	if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

function parseBenchmarkResponse(stdout) {
	try {
		return JSON.parse(stdout);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Benchmark CLI did not return JSON: ${message}`);
	}
}

async function main() {
	const outputRoot = parseOutputRoot(process.argv.slice(2));
	await assertPathDoesNotExist(outputRoot);
	await mkdir(dirname(outputRoot), { recursive: true });
	await cp(fixtureSource, outputRoot, { recursive: true, errorOnExist: true, force: false });

	const fixtureManifest = JSON.parse(await readFile(join(outputRoot, "fixture-manifest.json"), "utf8"));
	const repository = join(outputRoot, "fixture-repository");
	const commitEnvironment = {
		GIT_AUTHOR_NAME: "AgentPatchCheck Fixture",
		GIT_AUTHOR_EMAIL: "fixture@example.invalid",
		GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
		GIT_COMMITTER_NAME: "AgentPatchCheck Fixture",
		GIT_COMMITTER_EMAIL: "fixture@example.invalid",
		GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
	};
	await runGit(repository, ["init"], commitEnvironment);
	await runGit(repository, ["config", "core.autocrlf", "false"], commitEnvironment);
	await runGit(repository, ["add", "--all"], commitEnvironment);
	await runGit(repository, ["commit", "--no-gpg-sign", "-m", "benchmark-suite-v1 base"], commitEnvironment);
	const baseCommit = await runGit(repository, ["rev-parse", "HEAD"], commitEnvironment);
	if (baseCommit !== fixtureManifest.baseCommit)
		throw new Error(`Fixture base commit mismatch: expected ${fixtureManifest.baseCommit}, received ${baseCommit}.`);

	const cliResult = await run(process.execPath, ["--import", "tsx", cliPath, "benchmark", "--spec", join(outputRoot, "benchmark.json")]);
	const response = parseBenchmarkResponse(cliResult.stdout);
	if (cliResult.code !== 1 || response.ok !== false || response.error?.code !== "benchmark-failed") {
		throw new Error(`Benchmark CLI returned unexpected result: ${cliResult.stderr.trim() || cliResult.stdout.trim()}`);
	}
	const benchmarkResult = response.data;
	const report = benchmarkResult?.report;
	if (report?.benchmark?.suite?.id !== fixtureManifest.suite.id || report.benchmark.suite.fixtureVersion !== fixtureManifest.suite.fixtureVersion)
		throw new Error("Benchmark report suite identity does not match the fixture manifest.");
	const taskStatuses = report.tasks.map((task) => ({ id: task.taskId, status: task.status }));
	if (report.tasks.some((task) => task.status !== task.configuration.expectedStatus))
		throw new Error("Benchmark task classification does not match the deterministic suite manifest.");
	if (report.tasks.some((task) => task.executionIdentity?.baseCommit !== baseCommit))
		throw new Error("Benchmark task base commit does not match the deterministic fixture base.");
	if (report.tasks.some((task) => task.configuration.verificationProfile === null || task.configuration.riskPolicyProfile === null))
		throw new Error("Benchmark task profile identity is missing.");
	const oracleSha256 = createHash("sha256")
		.update(await readFile(join(outputRoot, "tasks", "scripts", "oracle-exact-after.mjs")))
		.digest("hex");
	if (
		report.tasks
			.filter((task) => task.taskId === "success" || task.taskId === "hidden-oracle-failure")
			.some((task) => task.executionIdentity?.hiddenOracleSha256 !== oracleSha256)
	)
		throw new Error("Benchmark report Hidden Oracle identity does not match the fixture source.");

	process.stdout.write(
		`${JSON.stringify(
			{
				version: 1,
				suite: fixtureManifest.suite,
				outputRoot,
				baseCommit,
				benchmarkReportPath: benchmarkResult.reference.path,
				taskStatuses,
			},
			null,
			2,
		)}\n`,
	);
}

void main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
