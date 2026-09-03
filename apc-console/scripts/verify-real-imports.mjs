import { readFile } from "node:fs/promises";
import { createReadModel, parseArtifactText } from "../src/artifact-read-model.ts";
import { associateArtifacts, isWorkspaceArtifactCandidate } from "../src/workspace-import.ts";

const samples = [
	["../../.agentpatchcheck/evidence/run-f75ce2dd-2f2.json", "evidence"],
	["../../.agentpatchcheck/formal-b2/command-results/pre-v4-b2-c01-agentpatchcheck/benchmarks/benchmark-e14193d0-0af.json", "benchmark-report"],
	["../../.agentpatchcheck/swebench/results/HAL-Verified-Mini-v1/django__django-9296/hal-final-batch-5-9296-exec.apc-run.json", "swebench-run"],
	["../../.agentpatchcheck/swebench/results/HAL-Verified-Mini-v1/HAL-Verified-Mini-v1-phase-1-final-summary.json", "benchmark-summary"],
];

for (const [path, expectedKind] of samples) {
	const artifact = parseArtifactText(await readFile(new URL(path, import.meta.url), "utf8"), path);
	if (artifact.kind !== expectedKind) throw new Error(`Expected ${expectedKind}, got ${artifact.kind}`);
}

const runPath = "../../.agentpatchcheck/swebench/results/HAL-Verified-Mini-v1/django__django-9296/hal-final-batch-5-9296-exec.apc-run.json";
const gradingPath = "../../.agentpatchcheck/swebench/results/HAL-Verified-Mini-v1/django__django-9296/hal-final-batch-5-9296-exec.swebench-grading.json";
const runArtifact = parseArtifactText(await readFile(new URL(runPath, import.meta.url), "utf8"), runPath);
const gradingArtifact = parseArtifactText(await readFile(new URL(gradingPath, import.meta.url), "utf8"), gradingPath);
const [runAssociation, gradingAssociation] = associateArtifacts([runArtifact, gradingArtifact], createReadModel([runArtifact]).runs);
if (runAssociation.runId !== "hal-final-batch-5-9296-exec" || gradingAssociation.runId !== "hal-final-batch-5-9296-exec") {
	throw new Error("Expected the verified grading artifact to associate to its run by explicit path evidence.");
}
if (!isWorkspaceArtifactCandidate("HAL-Verified-Mini-v1-phase-1-final-summary.json")) {
	throw new Error("Expected the supported frozen benchmark summary to be discoverable.");
}
const standaloneArtifact = parseArtifactText(await readFile(new URL(samples[3][0], import.meta.url), "utf8"), samples[3][0]);
if (associateArtifacts([standaloneArtifact], createReadModel([runArtifact]).runs)[0].runId !== null) {
	throw new Error("Expected an artifact without a matching identifier or path to remain standalone.");
}
console.log("Real Evidence and BenchmarkReport imports succeeded.");
