import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const bridgePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/swebench-verification-bridge.mjs");

const fakeEvaluator = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const instanceId = value("--instance_ids");
const datasetPath = value("--dataset_name");
const predictionPath = value("--predictions_path");
const runId = value("--run_id");
const reportRoot = value("--report_dir");
const dataset = JSON.parse(fs.readFileSync(datasetPath, "utf8").trim());
if (!dataset.test_patch || !Array.isArray(dataset.FAIL_TO_PASS) || !Array.isArray(dataset.PASS_TO_PASS)) {
  throw new Error("full_dataset_snapshot_required");
}
const predictions = JSON.parse(fs.readFileSync(predictionPath, "utf8").trim());
if (!Array.isArray(predictions) || predictions.length !== 1) throw new Error("official_prediction_array_required");
const prediction = predictions[0];
const modelDirectory = prediction.model_name_or_path.replaceAll("/", "__");
const instanceRoot = path.join(process.cwd(), "logs", "run_evaluation", runId, modelDirectory, instanceId);
fs.mkdirSync(instanceRoot, { recursive: true });
fs.mkdirSync(reportRoot, { recursive: true });
fs.writeFileSync(path.join(reportRoot, "prediction-seen.jsonl"), fs.readFileSync(predictionPath));
fs.writeFileSync(path.join(reportRoot, "dataset-seen.json"), JSON.stringify(dataset));
const finalReport = {
  infra_failure_ids: instanceId.endsWith("infra") ? [instanceId] : [],
  ambiguous_failure_ids: instanceId.endsWith("ambiguous") ? [instanceId] : [],
  empty_patch_ids: instanceId.endsWith("empty") ? [instanceId] : [],
  error_ids: instanceId.endsWith("error") ? [instanceId] : [],
};
if (!instanceId.endsWith("infra") && !instanceId.endsWith("ambiguous") && !instanceId.endsWith("empty") && !instanceId.endsWith("error")) {
  const resolved = instanceId.endsWith("pass");
  fs.writeFileSync(path.join(instanceRoot, "report.json"), JSON.stringify({
    [instanceId]: { patch_successfully_applied: true, resolved, infra_failure: false }
  }));
}
const aggregateRoot = instanceId.endsWith("canonical-output") ? process.cwd() : reportRoot;
fs.writeFileSync(path.join(aggregateRoot, modelDirectory + "." + runId + ".json"), JSON.stringify(finalReport));
process.stdout.write("EVALUATOR_STDOUT\n");
process.stderr.write("EVALUATOR_STDERR\n");
`;

async function runBridge(instanceId: string, modelPatch = "diff --git a/file b/file\n") {
	const root = await mkdtemp(join(tmpdir(), "apc-swebench-bridge-"));
	const artifactRoot = join(root, "artifacts");
	const evaluatorSourceRoot = join(root, "evaluator-source");
	const datasetPath = join(root, "dataset.jsonl");
	const predictionPath = join(root, "predictions.jsonl");
	await mkdir(join(evaluatorSourceRoot, "swebench", "harness"), { recursive: true });
	await writeFile(join(evaluatorSourceRoot, "swebench", "harness", "run_evaluation.py"), fakeEvaluator);
	await writeFile(
		datasetPath,
		`${JSON.stringify({
			instance_id: instanceId,
			repo: "owner/repo",
			base_commit: "a".repeat(40),
			problem_statement: "Fix the issue.",
			patch: "gold patch must remain evaluator-only",
			test_patch: "hidden test patch",
			FAIL_TO_PASS: ["hidden_failure"],
			PASS_TO_PASS: ["hidden_success"],
			version: "1.0",
		})}\n`,
	);
	const prediction = {
		instance_id: instanceId,
		model_name_or_path: "apc/baseline",
		model_patch: modelPatch,
	};
	await writeFile(predictionPath, `${JSON.stringify(prediction)}\n`);

	const result = await new Promise<{ exitCode: number | null; stdout: string; stderr: string }>(
		(resolveResult, reject) => {
			const child = spawn(
				process.execPath,
				[
					bridgePath,
					"--dataset",
					datasetPath,
					"--prediction-path",
					predictionPath,
					"--instance-id",
					instanceId,
					"--evaluator-python",
					process.execPath,
					"--evaluator-source-root",
					evaluatorSourceRoot,
					"--artifact-root",
					artifactRoot,
					"--evaluator-timeout-seconds",
					"60",
					"--evaluator-version",
					"fixture-evaluator-commit",
				],
				{ cwd: root, shell: false, windowsHide: true },
			);
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => {
				stdout += chunk.toString("utf8");
			});
			child.stderr.on("data", (chunk) => {
				stderr += chunk.toString("utf8");
			});
			child.once("error", reject);
			child.once("close", (exitCode) => resolveResult({ exitCode, stdout, stderr }));
		},
	);

	const artifactFiles = await readdir(artifactRoot, { recursive: true });
	const predictionSeenPath = artifactFiles.find((path) => path.endsWith("prediction-seen.jsonl"));
	const datasetSeenPath = artifactFiles.find((path) => path.endsWith("dataset-seen.json"));
	if (predictionSeenPath === undefined || datasetSeenPath === undefined)
		throw new Error("Fixture evaluator did not run.");
	return {
		...result,
		result: JSON.parse(result.stdout),
		prediction,
		predictionSeen: await readFile(join(artifactRoot, predictionSeenPath), "utf8"),
		datasetSeen: JSON.parse(await readFile(join(artifactRoot, datasetSeenPath), "utf8")),
	};
}

describe("SWE-bench post-run prediction evaluator adapter", () => {
	it("consumes the existing prediction and complete dataset snapshot without a worktree", async () => {
		const result = await runBridge("owner__failure");

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).not.toContain("EVALUATOR_");
		expect(result.predictionSeen).toBe(`${JSON.stringify([result.prediction])}\n`);
		expect(result.datasetSeen).toMatchObject({
			test_patch: "hidden test patch",
			FAIL_TO_PASS: ["hidden_failure"],
			PASS_TO_PASS: ["hidden_success"],
		});
		expect(result.result).toMatchObject({
			version: 2,
			normalizedStatus: "unresolved",
			reason: "official_unresolved",
			officialRunId: expect.stringMatching(/^apc-evaluate-owner__failure-/u),
			evaluatorVersion: "fixture-evaluator-commit",
		});
		expect(result.result.officialReportPath).toEqual(expect.any(String));
	});

	it("discovers the official aggregate report when report_dir is ignored", async () => {
		await expect(runBridge("owner__canonical-output")).resolves.toMatchObject({
			result: { normalizedStatus: "unresolved", reason: "official_unresolved" },
		});
	});

	it("maps official resolved, infrastructure, ambiguous, and empty-patch results independently", async () => {
		await expect(runBridge("owner__pass")).resolves.toMatchObject({
			result: { normalizedStatus: "resolved", reason: "official_resolved" },
		});
		await expect(runBridge("owner__infra")).resolves.toMatchObject({
			result: { normalizedStatus: "infrastructure_error", reason: "official_infrastructure_failure" },
		});
		await expect(runBridge("owner__ambiguous")).resolves.toMatchObject({
			result: { normalizedStatus: "grading_error_or_ambiguous", reason: "official_ambiguous_failure" },
		});
		await expect(runBridge("owner__empty", "")).resolves.toMatchObject({
			result: { normalizedStatus: "not_run", reason: "official_empty_patch" },
		});
	});

	it("has no Agent Runtime, worktree, base-commit, or patch-export contract", async () => {
		const source = await readFile(bridgePath, "utf8");
		expect(source).not.toContain("exportModelPatch");
		expect(source).not.toContain("--base-commit");
		expect(source).not.toContain("worktreePath");
		expect(source).not.toContain("harness-native-runtime");
	});
});
