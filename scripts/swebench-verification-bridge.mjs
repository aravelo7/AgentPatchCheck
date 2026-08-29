import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

const PATCH_APPLY_FAILED_MARKER = ">>>>> Patch Apply Failed";

function parseOptions(argv) {
	const values = new Map();
	for (let index = 0; index < argv.length; index += 2) {
		const name = argv[index];
		const value = argv[index + 1];
		if (name === undefined || !name.startsWith("--") || value === undefined || value.startsWith("--")) {
			throw new Error("invalid_arguments");
		}
		if (values.has(name)) throw new Error("duplicate_argument");
		values.set(name, value);
	}
	const required = (name) => {
		const value = values.get(name)?.trim();
		if (!value) throw new Error("missing_argument");
		return value;
	};
	const positiveInteger = (name) => {
		const value = Number(required(name));
		if (!Number.isSafeInteger(value) || value <= 0) throw new Error("invalid_integer");
		return value;
	};
	return {
		datasetPath: resolve(required("--dataset")),
		predictionPath: resolve(required("--prediction-path")),
		instanceId: required("--instance-id"),
		evaluatorPythonPath: resolve(required("--evaluator-python")),
		evaluatorSourceRoot: resolve(required("--evaluator-source-root")),
		artifactRoot: resolve(required("--artifact-root")),
		evaluatorTimeoutSeconds: positiveInteger("--evaluator-timeout-seconds"),
		evaluatorVersion: values.get("--evaluator-version")?.trim() || null,
	};
}

function safeSegment(value) {
	return value.replaceAll(/[^a-zA-Z0-9._-]/gu, "-").slice(0, 96);
}

async function runProcess(command, args, options = {}) {
	return await new Promise((resolveResult, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			shell: false,
			stdio: ["ignore", options.capture ? "pipe" : "ignore", options.capture ? "pipe" : "ignore"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString("utf8");
		});
		child.once("error", reject);
		child.once("close", (exitCode, signal) => resolveResult({ exitCode, signal, stdout, stderr }));
	});
}

async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

async function readPrediction(predictionPath, instanceId) {
	const lines = (await readFile(predictionPath, "utf8")).split(/\r?\n/u).filter((line) => line.trim());
	let prediction = null;
	for (const line of lines) {
		const candidate = JSON.parse(line);
		if (candidate?.instance_id !== instanceId) continue;
		if (prediction !== null) throw new Error("duplicate_prediction");
		prediction = candidate;
	}
	if (prediction === null) throw new Error("prediction_not_found");
	if (typeof prediction.model_name_or_path !== "string" || !prediction.model_name_or_path.trim()) {
		throw new Error("invalid_prediction");
	}
	if (typeof prediction.model_patch !== "string") throw new Error("invalid_prediction");
	return prediction;
}

function gradingResult(options, runId, officialReportPath, normalizedStatus, reason) {
	return {
		version: 2,
		instanceId: options.instanceId,
		normalizedStatus,
		reason,
		officialReportPath,
		officialRunId: runId,
		evaluatorVersion: options.evaluatorVersion,
	};
}

async function evaluate(options, invocationRoot, prediction) {
	const runId = `apc-evaluate-${safeSegment(options.instanceId)}-${randomUUID().slice(0, 12)}`;
	const reportRoot = join(invocationRoot, "evaluation");
	const evaluatorPredictionPath = join(invocationRoot, "predictions.json");
	await mkdir(reportRoot, { recursive: true });
	await writeFile(evaluatorPredictionPath, `${JSON.stringify([prediction])}\n`, "utf8");
	const evaluatorEntrypoint = join(options.evaluatorSourceRoot, "swebench", "harness", "run_evaluation.py");
	await Promise.all([
		access(options.datasetPath),
		access(options.predictionPath),
		access(options.evaluatorPythonPath),
		access(evaluatorEntrypoint),
	]);
	const evaluatorEnvironment = {
		...process.env,
		PYTHONIOENCODING: "utf-8",
		PYTHONUTF8: "1",
		PYTHONPATH: [options.evaluatorSourceRoot, process.env.PYTHONPATH].filter(Boolean).join(sep === "\\" ? ";" : ":"),
	};
	const evaluatorResult = await runProcess(
		options.evaluatorPythonPath,
		[
			evaluatorEntrypoint,
			"--dataset_name",
			options.datasetPath,
			"--split",
			"test",
			"--instance_ids",
			options.instanceId,
			"--predictions_path",
			evaluatorPredictionPath,
			"--max_workers",
			"1",
			"--timeout",
			String(options.evaluatorTimeoutSeconds),
			"--run_id",
			runId,
			"--report_dir",
			reportRoot,
		],
		{ cwd: invocationRoot, env: evaluatorEnvironment, capture: true },
	);
	await Promise.all([
		writeFile(join(invocationRoot, "evaluator.stdout.log"), evaluatorResult.stdout, "utf8"),
		writeFile(join(invocationRoot, "evaluator.stderr.log"), evaluatorResult.stderr, "utf8"),
		writeFile(
			join(invocationRoot, "evaluator.process.json"),
			`${JSON.stringify({ cwd: invocationRoot, runId, modelNameOrPath: prediction.model_name_or_path, predictionPath: evaluatorPredictionPath, exitCode: evaluatorResult.exitCode, signal: evaluatorResult.signal }, null, 2)}\n`,
			"utf8",
		),
	]);

	const modelDirectory = prediction.model_name_or_path.replaceAll("/", "__");
	const instanceRoot = join(invocationRoot, "logs", "run_evaluation", runId, modelDirectory, options.instanceId);
	const instanceReportPath = join(instanceRoot, "report.json");
	const officialReportName = `${modelDirectory}.${runId}.json`;
	const officialReportCandidates = [join(reportRoot, officialReportName), join(invocationRoot, officialReportName)];
	let officialReportPath = null;
	let finalReport;
	for (const candidate of officialReportCandidates) {
		try {
			finalReport = await readJson(candidate);
			officialReportPath = candidate;
			break;
		} catch {
			// Some official SWE-bench versions ignore report_dir and write to cwd.
		}
	}
	if (officialReportPath === null) {
		return gradingResult(options, runId, null, "infrastructure_error", "evaluator_report_missing");
	}
	if (finalReport.infra_failure_ids?.includes(options.instanceId)) {
		return gradingResult(options, runId, officialReportPath, "infrastructure_error", "official_infrastructure_failure");
	}
	if (finalReport.ambiguous_failure_ids?.includes(options.instanceId)) {
		return gradingResult(options, runId, officialReportPath, "grading_error_or_ambiguous", "official_ambiguous_failure");
	}
	if (finalReport.error_ids?.includes(options.instanceId)) {
		return gradingResult(options, runId, officialReportPath, "grading_error_or_ambiguous", "official_evaluator_error");
	}
	if (finalReport.empty_patch_ids?.includes(options.instanceId)) {
		return gradingResult(options, runId, officialReportPath, "not_run", "official_empty_patch");
	}
	let instanceReport;
	try {
		instanceReport = (await readJson(instanceReportPath))[options.instanceId];
	} catch {
		try {
			const instanceLog = await readFile(join(instanceRoot, "run_instance.log"), "utf8");
			if (instanceLog.includes(PATCH_APPLY_FAILED_MARKER)) {
				return gradingResult(options, runId, officialReportPath, "unresolved", "official_patch_apply_failed");
			}
		} catch {
			// The aggregate report remains authoritative when no instance log exists.
		}
		return gradingResult(options, runId, officialReportPath, "grading_error_or_ambiguous", "instance_report_missing");
	}
	if (instanceReport.resolved === true) {
		return gradingResult(options, runId, officialReportPath, "resolved", "official_resolved");
	}
	if (instanceReport.infra_failure === true) {
		return gradingResult(options, runId, officialReportPath, "infrastructure_error", "official_infrastructure_failure");
	}
	return gradingResult(options, runId, officialReportPath, "unresolved", "official_unresolved");
}

async function main() {
	const options = parseOptions(process.argv.slice(2));
	const prediction = await readPrediction(options.predictionPath, options.instanceId);
	const invocationRoot = join(options.artifactRoot, safeSegment(options.instanceId), `${Date.now()}-${randomUUID()}`);
	try {
		await mkdir(invocationRoot, { recursive: true });
	} catch {
		throw new Error("artifact_preparation_failed");
	}
	try {
		return await evaluate(options, invocationRoot, prediction);
	} catch {
		return gradingResult(options, null, null, "infrastructure_error", "evaluator_setup_failed");
	}
}

try {
	const result = await main();
	process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
	const allowedReasons = new Set([
		"artifact_preparation_failed",
		"duplicate_argument",
		"duplicate_prediction",
		"invalid_arguments",
		"invalid_integer",
		"invalid_prediction",
		"missing_argument",
		"prediction_not_found",
	]);
	const reason = error instanceof Error && allowedReasons.has(error.message) ? error.message : "bridge_error";
	process.stdout.write(
		`${JSON.stringify({
			version: 2,
			instanceId: null,
			normalizedStatus: "infrastructure_error",
			reason,
			officialReportPath: null,
			officialRunId: null,
			evaluatorVersion: null,
		})}\n`,
	);
	process.exitCode = 2;
}
