export type ArtifactKind = "evidence" | "benchmark-report" | "swebench-run" | "benchmark-summary" | "trace" | "text" | "json";

export interface ImportedArtifact {
	kind: ArtifactKind;
	fileName: string;
	importedAt: string;
	raw: Record<string, unknown> | null;
	rawText: string;
}

export interface RunReadModel {
	runId: string | null;
	instance: string | null;
	repository: string | null;
	model: string | null;
	status: string | null;
	termination: string | null;
	durationMs: number | null;
	startedAt: string | null;
	mutation: string | null;
	grading: string | null;
	verification: string | null;
	attempts: number | null;
	iterations: number | null;
	toolCalls: number | null;
	budget: Record<string, unknown> | null;
	workspace: string | null;
	provider: Record<string, unknown> | null;
	changedFiles: string[];
	patch: string | null;
	trace: unknown[];
	failure: Record<string, unknown> | null;
	validity: Record<string, unknown> | null;
	source: ImportedArtifact;
}

export interface BenchmarkReadModel {
	name: string | null;
	runId: string | null;
	createdAt: string | null;
	total: number | null;
	resolved: number | null;
	unresolved: number | null;
	notRun: number | null;
	valid: number | null;
	harnessInvalid: number | null;
	gradingInvalid: number | null;
	failureTaxonomy: Record<string, unknown> | null;
	frozenMetadata: Record<string, unknown> | null;
	tasks: Array<Record<string, unknown>>;
	source: ImportedArtifact;
}

export interface ConsoleReadModel { artifacts: ImportedArtifact[]; runs: RunReadModel[]; benchmarks: BenchmarkReadModel[]; }

export function asRecord(value: unknown): Record<string, unknown> | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
export function asText(value: unknown): string | null { return typeof value === "string" ? value : null; }
export function asNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
export function asList(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }

function kindForText(fileName: string): ArtifactKind { const lower = fileName.toLowerCase(); return lower.includes("trace") || lower.endsWith(".jsonl") ? "trace" : "text"; }

export function parseArtifactText(rawText: string, fileName: string, importedAt = new Date().toISOString()): ImportedArtifact {
	const lower = fileName.toLowerCase();
	if (!lower.endsWith(".json")) return { kind: kindForText(fileName), fileName, importedAt, raw: null, rawText };
	const raw = asRecord(JSON.parse(rawText));
	if (raw === null) throw new Error("Expected an APC artifact JSON object.");
	if (raw.version === 1 && asRecord(raw.policy) !== null && asRecord(raw.result) !== null && asRecord(raw.workspace) !== null) return { kind: "evidence", fileName, importedAt, raw, rawText };
	if (raw.version === 1 && asRecord(raw.benchmark) !== null && Array.isArray(raw.tasks) && asRecord(raw.summary) !== null) return { kind: "benchmark-report", fileName, importedAt, raw, rawText };
	if (raw.version === 2 && asText(raw.instanceId) !== null && asText(raw.runId) !== null && asRecord(raw.agent) !== null) return { kind: "swebench-run", fileName, importedAt, raw, rawText };
	if (raw.version === 1 && asRecord(raw.results) !== null && asRecord(raw.contract) !== null && asText(raw.benchmark) !== null) return { kind: "benchmark-summary", fileName, importedAt, raw, rawText };
	return { kind: "json", fileName, importedAt, raw, rawText };
}

function evidenceRun(source: ImportedArtifact, raw: Record<string, unknown>): RunReadModel {
	const workspace = asRecord(raw.workspace); const agent = asRecord(raw.agent); const runtime = asRecord(agent?.runtime); const result = asRecord(raw.result); const patch = asRecord(raw.patch); const policy = asRecord(raw.policy);
	return { runId: asText(workspace?.runId), instance: asText(workspace?.runId), repository: asText(asRecord(raw.repository)?.root), model: asText(runtime?.model) ?? asText(policy?.model), status: asText(result?.status) ?? asText(runtime?.status), termination: asText(runtime?.terminationReason), durationMs: asNumber(result?.durationMs) ?? asNumber(agent?.durationMs), startedAt: asText(raw.createdAt), mutation: asList(patch?.changedFiles).length ? "modified" : "no changes", grading: null, verification: asText(asRecord(raw.commandVerification)?.status), attempts: asNumber(runtime?.attempts), iterations: asNumber(runtime?.iterations), toolCalls: asNumber(runtime?.toolCalls), budget: asRecord(runtime?.budget), workspace: asText(workspace?.path), provider: asRecord(runtime?.providerIdentity), changedFiles: asList(patch?.changedFiles).filter((item): item is string => typeof item === "string"), patch: asText(patch?.trackedPatch), trace: asList(runtime?.trajectory), failure: asRecord(runtime?.providerFailure), validity: null, source };
}

function swebenchRun(source: ImportedArtifact, raw: Record<string, unknown>): RunReadModel {
	const agent = asRecord(raw.agent); const grading = asRecord(raw.grading); const config = asRecord(raw.runConfiguration);
	return { runId: asText(raw.runId), instance: asText(raw.instanceId), repository: asText(raw.repository), model: asText(raw.model), status: asText(agent?.status), termination: asText(agent?.terminationReason), durationMs: asNumber(agent?.durationMs), startedAt: null, mutation: raw.mutationOccurred === true ? "modified" : raw.mutationOccurred === false ? "no changes" : null, grading: asText(grading?.normalizedStatus), verification: null, attempts: asNumber(asRecord(raw.runIdentity)?.attempt), iterations: null, toolCalls: null, budget: config === null ? null : { evaluatorTimeoutSeconds: config.evaluatorTimeoutSeconds }, workspace: asText(raw.workspacePath), provider: null, changedFiles: asList(raw.changedFiles).filter((item): item is string => typeof item === "string"), patch: null, trace: [], failure: asRecord(raw.failure), validity: asRecord(raw.candidateValidity), source };
}

function benchmarkReport(source: ImportedArtifact, raw: Record<string, unknown>): BenchmarkReadModel {
	const benchmark = asRecord(raw.benchmark); const summary = asRecord(raw.summary); const tasks = asList(raw.tasks).map(asRecord).filter((item): item is Record<string, unknown> => item !== null); const passed = asNumber(summary?.passed); const total = asNumber(summary?.total);
	return { name: asText(benchmark?.name), runId: asText(benchmark?.runId), createdAt: asText(raw.createdAt), total, resolved: passed, unresolved: total !== null && passed !== null ? total - passed : null, notRun: null, valid: total, harnessInvalid: null, gradingInvalid: null, failureTaxonomy: asRecord(summary?.failureClassification), frozenMetadata: asRecord(raw.executionIdentity), tasks, source };
}

function benchmarkSummary(source: ImportedArtifact, raw: Record<string, unknown>): BenchmarkReadModel {
	const results = asRecord(raw.results);
	return { name: asText(raw.benchmark), runId: null, createdAt: null, total: asNumber(asRecord(raw.consistency)?.manifestTaskCount), resolved: asNumber(results?.resolved), unresolved: asNumber(results?.unresolved), notRun: asNumber(results?.notRun), valid: asNumber(results?.validExecution), harnessInvalid: asNumber(results?.harnessInvalid), gradingInvalid: asNumber(results?.gradingInvalid), failureTaxonomy: null, frozenMetadata: asRecord(raw.contract), tasks: [], source };
}

export function createReadModel(artifacts: ImportedArtifact[]): ConsoleReadModel {
	const runs = artifacts.flatMap((artifact) => artifact.raw === null ? [] : artifact.kind === "evidence" ? [evidenceRun(artifact, artifact.raw)] : artifact.kind === "swebench-run" ? [swebenchRun(artifact, artifact.raw)] : []);
	const benchmarks = artifacts.flatMap((artifact) => artifact.raw === null ? [] : artifact.kind === "benchmark-report" ? [benchmarkReport(artifact, artifact.raw)] : artifact.kind === "benchmark-summary" ? [benchmarkSummary(artifact, artifact.raw)] : []);
	return { artifacts, runs, benchmarks };
}

export function taskStatus(task: Record<string, unknown>): string | null { return asText(task.status); }
