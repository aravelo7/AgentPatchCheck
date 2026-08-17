import { spawn } from "node:child_process";
import { access, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const fixtureRoot = join(projectRoot, "test", "fixtures", "agentpatchcheck");
const cliPath = join(projectRoot, "src", "agentpatchcheck", "cli.ts");
const modelPattern = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/u;
const providerProfiles = {
	"openai-responses": {
		nativeAgent: {
			provider: "openai",
			protocol: "responses",
			credentialRef: "openai-primary",
		},
		requiredEnvironment: "OPENAI_API_KEY",
	},
	"deepseek-chat": {
		nativeAgent: {
			provider: "openai-compatible",
			protocol: "chat-completions",
			thinkingMode: "disabled",
			baseUrl: "https://api.deepseek.com",
			credentialRef: "deepseek-primary",
			maxTransportRetries: 1,
		},
		requiredEnvironment: "DEEPSEEK_API_KEY",
	},
};
const suiteVersions = new Set(["v1", "v2", "v3", "v4"]);

function getProviderProfile(profileId) {
	const profile = providerProfiles[profileId];
	if (profile === undefined)
		throw new Error(`provider-profile must be one of: ${Object.keys(providerProfiles).join(", ")}.`);
	return profile;
}

function parseArguments(argv) {
	let outputRoot;
	let model;
	let dryRun = false;
	let providerProfile = "openai-responses";
	let suiteVersion = "v1";
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (argument === "--output-root" || argument === "--model" || argument === "--provider-profile" || argument === "--suite-version") {
			const value = argv[index + 1];
			if (value === undefined || !value.trim()) throw new Error(`Missing value for ${argument}.`);
			if (argument === "--output-root") outputRoot = resolve(value);
			else if (argument === "--model") model = value.trim();
			else if (argument === "--provider-profile") providerProfile = value.trim();
			else suiteVersion = value.trim();
			index += 1;
			continue;
		}
		throw new Error(`Unknown argument: ${argument}`);
	}
	if (outputRoot === undefined || model === undefined)
		throw new Error(
		"Usage: npm run benchmark:harness-native-suite -- --output-root <new-directory> --model <model> [--provider-profile <profile>] [--suite-version <v1|v2|v3|v4>] [--dry-run]",
		);
	if (!modelPattern.test(model)) throw new Error("model must be a valid 1-128 character model identifier.");
	getProviderProfile(providerProfile);
	if (!suiteVersions.has(suiteVersion)) throw new Error("suite-version must be one of: v1, v2, v3, v4.");
	return { outputRoot, model, providerProfile, suiteVersion, dryRun };
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

async function materializeTaskSpec(taskPath, model, providerProfile) {
	const task = JSON.parse(await readFile(taskPath, "utf8"));
	if (task.model !== "__AGENTPATCHCHECK_MODEL__") throw new Error("Fixture task model placeholder is invalid.");
	if (task.nativeAgent === null || typeof task.nativeAgent !== "object")
		throw new Error("Fixture task must define a Harness-native agent configuration.");
	task.model = model;
	task.nativeAgent = { ...task.nativeAgent, ...providerProfile.nativeAgent };
	await writeFile(taskPath, `${JSON.stringify(task, null, 2)}\n`, "utf8");
}

async function materializeTaskSpecs(tasksDirectory, model, providerProfile) {
	const taskPaths = (await readdir(tasksDirectory))
		.filter((entry) => entry.endsWith(".json"))
		.map((entry) => join(tasksDirectory, entry));
	await Promise.all(taskPaths.map(async (taskPath) => await materializeTaskSpec(taskPath, model, providerProfile)));
	return taskPaths;
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
	const options = parseArguments(process.argv.slice(2));
	const providerProfile = getProviderProfile(options.providerProfile ?? "openai-responses");
	const fixtureSources =
		options.suiteVersion === "v4"
			? [
				join(fixtureRoot, "harness-native-benchmark-suite-v3"),
				join(fixtureRoot, "harness-native-benchmark-suite-v4-extension"),
			]
			: [join(fixtureRoot, `harness-native-benchmark-suite-${options.suiteVersion}`)];
	if (!options.dryRun && !process.env[providerProfile.requiredEnvironment]?.trim())
		throw new Error(
			`${providerProfile.requiredEnvironment} is required for provider profile ${options.providerProfile ?? "openai-responses"}. Use --dry-run to validate setup.`,
		);
	await assertPathDoesNotExist(options.outputRoot);
	await mkdir(dirname(options.outputRoot), { recursive: true });
	await cp(fixtureSources[0], options.outputRoot, { recursive: true, errorOnExist: true, force: false });
	for (const fixtureSource of fixtureSources.slice(1))
		await cp(fixtureSource, options.outputRoot, { recursive: true, errorOnExist: false, force: true });

	const fixtureManifest = JSON.parse(await readFile(join(options.outputRoot, "fixture-manifest.json"), "utf8"));
	const repository = join(options.outputRoot, "fixture-repository");
	const taskPaths = await materializeTaskSpecs(join(options.outputRoot, "tasks"), options.model, providerProfile);
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
	await runGit(repository, ["commit", "--no-gpg-sign", "-m", "harness-native-benchmark-suite-v1 base"], commitEnvironment);
	const baseCommit = await runGit(repository, ["rev-parse", "HEAD"], commitEnvironment);
	if (baseCommit !== fixtureManifest.baseCommit)
		throw new Error(`Fixture base commit mismatch: expected ${fixtureManifest.baseCommit}, received ${baseCommit}.`);

	if (options.dryRun) {
		process.stdout.write(
			`${JSON.stringify(
				{
					version: 1,
					mode: "dry-run",
					suite: fixtureManifest.suite,
					outputRoot: options.outputRoot,
					baseCommit,
					model: options.model,
					providerProfile: options.providerProfile,
					suiteVersion: options.suiteVersion,
					taskSpecPaths: taskPaths,
					budgets: fixtureManifest.budgets,
				},
				null,
				2,
			)}\n`,
		);
		return;
	}

	const cliResult = await run(process.execPath, ["--import", "tsx", cliPath, "benchmark", "--spec", join(options.outputRoot, "benchmark.json")]);
	const response = parseBenchmarkResponse(cliResult.stdout);
	if (
		(cliResult.code !== 0 && cliResult.code !== 1) ||
		response.command !== "benchmark" ||
		response.data?.report === undefined ||
		(response.error?.code !== undefined && response.error.code !== "benchmark-failed")
	)
		throw new Error(`Benchmark CLI returned unexpected result: ${cliResult.stderr.trim() || cliResult.stdout.trim()}`);
	const benchmarkResult = response.data;
	const report = benchmarkResult.report;
	if (report.benchmark.suite?.id !== fixtureManifest.suite.id || report.benchmark.suite.fixtureVersion !== fixtureManifest.suite.fixtureVersion)
		throw new Error("Benchmark report suite identity does not match the fixture manifest.");
	if (
		report.tasks.some(
			(task) =>
				task.configuration.agentAdapter !== "harness-native" ||
				task.configuration.model !== options.model ||
				task.configuration.modelProvider?.provider !== providerProfile.nativeAgent.provider ||
				task.configuration.modelProvider?.protocol !== providerProfile.nativeAgent.protocol ||
				task.configuration.modelProvider?.credentialRef !== providerProfile.nativeAgent.credentialRef,
		)
	)
		throw new Error("Benchmark report does not record the requested Harness-native Agent identity.");

	process.stdout.write(
		`${JSON.stringify(
			{
				version: 1,
				mode: "executed",
				suite: fixtureManifest.suite,
				outputRoot: options.outputRoot,
				baseCommit,
				model: options.model,
				providerProfile: options.providerProfile,
				suiteVersion: options.suiteVersion,
				benchmarkReportPath: benchmarkResult.reference.path,
				benchmarkOk: response.ok,
				taskResults: report.tasks.map((task) => ({
					id: task.taskId,
					status: task.status,
					verificationStatus: task.verificationStatus,
					repairCycle: task.repairCycle ?? null,
					hiddenOracleStatus: task.hiddenOracleStatus,
				})),
				repairCycles: report.summary.repairCycles ?? null,
				nativeQuality: report.summary.nativeQuality ?? null,
			},
			null,
			2,
		)}\n`,
	);
	if (!response.ok) process.exitCode = 1;
}

void main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
