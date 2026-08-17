import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
	createRepetitionCompatibility,
	createQualityBaseline,
	createTaskAggregate,
	sumNativeQuality,
} from "./harness-native-repetition-report.mjs";
import { evaluateQualityGate, parseQualityGate } from "./harness-native-quality-gate.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const suiteScript = join(scriptDirectory, "run-harness-native-benchmark-suite.mjs");
const modelPattern = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/u;
const providerProfiles = new Set(["openai-responses", "deepseek-chat"]);
const suiteVersions = new Set(["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8"]);
const maxRuns = 20;

function parseArguments(argv) {
	let outputRoot;
	let model;
	let providerProfile = "openai-responses";
	let suiteVersion = "v1";
	let runs;
	let qualityGatePath;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (
			argument !== "--output-root" &&
			argument !== "--model" &&
			argument !== "--provider-profile" &&
			argument !== "--suite-version" &&
			argument !== "--runs" &&
			argument !== "--quality-gate"
		)
			throw new Error(`Unknown argument: ${argument}`);
		const value = argv[index + 1];
		if (value === undefined || !value.trim()) throw new Error(`Missing value for ${argument}.`);
		if (argument === "--output-root") outputRoot = resolve(value);
		else if (argument === "--model") model = value.trim();
		else if (argument === "--provider-profile") providerProfile = value.trim();
		else if (argument === "--suite-version") suiteVersion = value.trim();
		else if (argument === "--runs") runs = Number(value);
		else qualityGatePath = resolve(value);
		index += 1;
	}
	if (outputRoot === undefined || model === undefined || runs === undefined)
		throw new Error(
		"Usage: npm run benchmark:harness-native-repetitions -- --output-root <new-directory> --runs <2-20> --model <model> [--provider-profile <profile>] [--suite-version <v1|v2|v3|v4|v5|v6|v7|v8>] [--quality-gate <path>]",
		);
	if (!modelPattern.test(model)) throw new Error("model must be a valid 1-128 character model identifier.");
	if (!providerProfiles.has(providerProfile)) throw new Error("provider-profile must be one of: openai-responses, deepseek-chat.");
	if (!suiteVersions.has(suiteVersion)) throw new Error("suite-version must be one of: v1, v2, v3, v4, v5, v6, v7, v8.");
	if (!Number.isSafeInteger(runs) || runs < 2 || runs > maxRuns) throw new Error(`runs must be an integer from 2 to ${maxRuns}.`);
	return { outputRoot, model, providerProfile, suiteVersion, runs, qualityGatePath };
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

async function runSuite(args) {
	return await new Promise((resolveRun, rejectRun) => {
		const child = spawn(process.execPath, [suiteScript, ...args], {
			cwd: dirname(scriptDirectory),
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

function parseSuiteOutput(result, runNumber) {
	if (result.code !== 0 && result.code !== 1)
		throw new Error(`Run ${runNumber} did not return a Benchmark result: ${result.stderr.trim() || result.stdout.trim()}`);
	let output;
	try {
		output = JSON.parse(result.stdout);
	} catch (error) {
		const diagnostic = result.stderr.trim() || result.stdout.trim();
		throw new Error(
			`Run ${runNumber} did not return JSON: ${error instanceof Error ? error.message : String(error)}${diagnostic ? ` (${diagnostic})` : ""}`,
		);
	}
	if (output?.mode !== "executed" || typeof output.benchmarkReportPath !== "string" || typeof output.benchmarkOk !== "boolean")
		throw new Error(`Run ${runNumber} returned an invalid Benchmark result.`);
	return output;
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	const qualityGate =
		options.qualityGatePath === undefined
			? null
			: parseQualityGate(JSON.parse(await readFile(options.qualityGatePath, "utf8")));
	await assertPathDoesNotExist(options.outputRoot);
	await mkdir(options.outputRoot, { recursive: true });
	const outputs = [];
	for (let runNumber = 1; runNumber <= options.runs; runNumber += 1) {
		const runDirectory = join(options.outputRoot, `run-${String(runNumber).padStart(3, "0")}`);
		const result = await runSuite([
			"--output-root",
			runDirectory,
			"--model",
			options.model,
			"--provider-profile",
			options.providerProfile,
			"--suite-version",
			options.suiteVersion,
		]);
		outputs.push(parseSuiteOutput(result, runNumber));
	}
	const benchmarkReports = await Promise.all(
		outputs.map(async (output) => JSON.parse(await readFile(output.benchmarkReportPath, "utf8"))),
	);
	const compatibility = createRepetitionCompatibility(benchmarkReports);
	const tasks = createTaskAggregate(outputs);
	const qualityBaseline = createQualityBaseline(outputs, compatibility);
	const report = {
		version: 1,
		mode: "executed",
		suite: outputs[0]?.suite ?? null,
		model: options.model,
		providerProfile: options.providerProfile,
		suiteVersion: options.suiteVersion,
		experimentIdentity: compatibility,
		qualityBaseline,
		qualityGate: null,
		runs: outputs.map((output, index) => ({
			run: index + 1,
			benchmarkOk: output.benchmarkOk,
			benchmarkReportPath: output.benchmarkReportPath,
		})),
		summary: {
			totalRuns: outputs.length,
			passedRuns: outputs.filter((output) => output.benchmarkOk).length,
			failedRuns: outputs.filter((output) => !output.benchmarkOk).length,
			tasks,
			publicVerificationFalsePositives: tasks.reduce(
				(total, task) => total + task.publicVerificationFalsePositives,
				0,
			),
			nativeQuality: sumNativeQuality(outputs),
		},
	};
	report.qualityGate = qualityGate === null ? null : evaluateQualityGate(qualityGate, report);
	const reportPath = join(options.outputRoot, "repetitions-report.json");
	await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
	process.stdout.write(`${JSON.stringify({ ...report, reportPath }, null, 2)}\n`);
	if (report.summary.failedRuns > 0 || report.qualityGate?.status === "failed") process.exitCode = 1;
}

void main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
