import { asRecord, asText, parseArtifactText, type ImportedArtifact, type RunReadModel } from "./artifact-read-model";

export interface WorkspaceImportResult {
	artifacts: ImportedArtifact[];
	evaluationArtifacts: ImportedArtifact[];
	failures: string[];
	skipped: number;
	workspaceName: string;
}

function isCanonicalEvaluationAnalysis(path: string): boolean {
	return /phase-[23]-(failure-taxonomy|aggregate-data-analysis)\.json$/i.test(path.replaceAll("\\", "/"));
}

export interface ArtifactAssociation {
	artifact: ImportedArtifact;
	runId: string | null;
}

const recognizedName = /(evidence|\.apc-run\.json$|benchmark|final-summary\.json$|summary\.json$|report\.json$|grading|trace|prediction|evaluator|taxonomy|aggregate-data-analysis|\.jsonl$|\.log$|\.diff$|\.patch$)/i;

export function isWorkspaceArtifactCandidate(path: string): boolean {
	return recognizedName.test(path.replaceAll("\\", "/"));
}

function relativePath(file: File): string {
	return file.webkitRelativePath || file.name;
}

function workspaceName(files: File[]): string {
	const first = files[0];
	const firstPath = first === undefined ? "Local Workspace" : relativePath(first);
	return firstPath.split("/").filter(Boolean)[0] ?? "Local Workspace";
}

export async function importWorkspaceFiles(files: FileList): Promise<WorkspaceImportResult> {
	const selected = Array.from(files);
	const candidates = selected.filter((file) => isWorkspaceArtifactCandidate(relativePath(file)));
	const artifacts: ImportedArtifact[] = [];
	const evaluationArtifacts: ImportedArtifact[] = [];
	const failures: string[] = [];
	for (const file of candidates) {
		try {
			const artifact = parseArtifactText(await file.text(), relativePath(file));
			if (isCanonicalEvaluationAnalysis(relativePath(file))) evaluationArtifacts.push(artifact);
			else artifacts.push(artifact);
		} catch (error) {
			failures.push(`${relativePath(file)}: ${error instanceof Error ? error.message : "Import failed"}`);
		}
	}
	return { artifacts, evaluationArtifacts, failures, skipped: selected.length - candidates.length, workspaceName: workspaceName(selected) };
}

function directRunId(artifact: ImportedArtifact): string | null {
	const raw = artifact.raw;
	if (raw === null) return null;
	return asText(raw.runId) ?? asText(asRecord(raw.workspace)?.runId);
}

export function associateArtifacts(artifacts: ImportedArtifact[], runs: RunReadModel[]): ArtifactAssociation[] {
	const runIds = runs.map((run) => run.runId).filter((runId): runId is string => runId !== null).sort((left, right) => right.length - left.length);
	return artifacts.map((artifact) => {
		const direct = directRunId(artifact);
		if (direct !== null && runIds.includes(direct)) return { artifact, runId: direct };
		const fromPath = runIds.find((runId) => artifact.fileName.includes(runId));
		return { artifact, runId: fromPath ?? null };
	});
}
