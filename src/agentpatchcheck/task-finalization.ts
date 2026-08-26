import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { lockedFileSystem } from "../fs/locked-file-system";
import { getAssessmentReportPath } from "./assessment-report";
import { getEvidenceBundlePath } from "./evidence-bundle";
import { readEvidenceBundle } from "./git-patch-verifier";
import type {
	AgentPatchCheckResult,
	AssessmentReport,
	AssessmentResult,
	TaskDefinitionSnapshotReference,
	TaskPolicy,
} from "./types";

interface TaskFinalizationRecord {
	version: 1;
	kind: "agentpatchcheck-task-finalization";
	runId: string;
	completedAt: string;
	taskDefinitionSha256: string;
	evidence: { path: string; sha256: string; createdAt: string };
	assessment: { path: string; sha256: string; createdAt: string };
}

function samePath(left: string, right: string): boolean {
	const normalizedLeft = resolve(left);
	const normalizedRight = resolve(right);
	return process.platform === "win32"
		? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
		: normalizedLeft === normalizedRight;
}

async function sha256File(path: string): Promise<string> {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
}

function isAssessmentReport(value: unknown): value is AssessmentReport {
	if (typeof value !== "object" || value === null) return false;
	const report = value as Partial<AssessmentReport>;
	return (
		report.version === 1 &&
		typeof report.createdAt === "string" &&
		typeof report.evidence?.path === "string" &&
		typeof report.evidence?.createdAt === "string" &&
		typeof report.verdict?.status === "string" &&
		typeof report.gitPatchVerification?.status === "string"
	);
}

function isTaskFinalizationRecord(value: unknown): value is TaskFinalizationRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Partial<TaskFinalizationRecord>;
	return (
		record.version === 1 &&
		record.kind === "agentpatchcheck-task-finalization" &&
		typeof record.runId === "string" &&
		typeof record.completedAt === "string" &&
		typeof record.taskDefinitionSha256 === "string" &&
		typeof record.evidence?.path === "string" &&
		typeof record.evidence?.sha256 === "string" &&
		typeof record.evidence?.createdAt === "string" &&
		typeof record.assessment?.path === "string" &&
		typeof record.assessment?.sha256 === "string" &&
		typeof record.assessment?.createdAt === "string"
	);
}

export function getTaskFinalizationPath(worktreeRoot: string, runId: string): string {
	return join(dirname(worktreeRoot), "evidence", `${runId}.finalization.json`);
}

export async function withTaskFinalizationLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
	const operationPath = `${path}.operation`;
	return await lockedFileSystem.withLock(
		{ path: operationPath, type: "file", lockfilePath: `${operationPath}.lock`, staleMs: 60_000 },
		operation,
	);
}

export async function readCompletedTaskFinalization(options: {
	policy: TaskPolicy;
	runId: string;
	taskDefinition: TaskDefinitionSnapshotReference;
}): Promise<AgentPatchCheckResult | null> {
	const finalizationPath = getTaskFinalizationPath(options.policy.worktreeRoot, options.runId);
	let raw: string;
	try {
		raw = await readFile(finalizationPath, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`Corrupted task finalization record: ${finalizationPath}`);
	}
	if (!isTaskFinalizationRecord(parsed)) throw new Error(`Invalid task finalization record: ${finalizationPath}`);
	const record = parsed;
	const evidencePath = getEvidenceBundlePath(options.policy.worktreeRoot, options.runId);
	const assessmentPath = getAssessmentReportPath(evidencePath);
	if (
		record.runId !== options.runId ||
		record.taskDefinitionSha256 !== options.taskDefinition.sha256 ||
		!samePath(record.evidence.path, evidencePath) ||
		!samePath(record.assessment.path, assessmentPath)
	) {
		throw new Error(`Task finalization identity mismatch: ${finalizationPath}`);
	}
	if (
		(await sha256File(evidencePath)) !== record.evidence.sha256 ||
		(await sha256File(assessmentPath)) !== record.assessment.sha256
	) {
		throw new Error(`Task finalization integrity mismatch: ${finalizationPath}`);
	}
	const bundle = await readEvidenceBundle(evidencePath);
	const assessmentValue: unknown = JSON.parse(await readFile(assessmentPath, "utf8"));
	if (!isAssessmentReport(assessmentValue)) throw new Error(`Invalid AssessmentReport: ${assessmentPath}`);
	const report = assessmentValue;
	if (
		bundle.taskDefinition?.sha256 !== options.taskDefinition.sha256 ||
		bundle.workspace.runId !== options.runId ||
		bundle.createdAt !== record.evidence.createdAt ||
		report.createdAt !== record.assessment.createdAt ||
		!samePath(report.evidence.path, evidencePath) ||
		report.evidence.createdAt !== bundle.createdAt
	) {
		throw new Error(`Task finalization artifact mismatch: ${finalizationPath}`);
	}
	const assessment: AssessmentResult = {
		report,
		reference: { path: assessmentPath, createdAt: report.createdAt },
	};
	return {
		status: bundle.result.status,
		workspace: bundle.workspace,
		executionBootstrap: bundle.executionBootstrap,
		agent: bundle.agent,
		patch: bundle.patch,
		commandVerification: bundle.commandVerification,
		hiddenOracle: bundle.hiddenOracle,
		evidence: { path: evidencePath, createdAt: bundle.createdAt },
		assessment,
	};
}

export async function writeCompletedTaskFinalization(options: {
	policy: TaskPolicy;
	runId: string;
	taskDefinition: TaskDefinitionSnapshotReference;
	result: AgentPatchCheckResult;
}): Promise<void> {
	const finalizationPath = getTaskFinalizationPath(options.policy.worktreeRoot, options.runId);
	const record: TaskFinalizationRecord = {
		version: 1,
		kind: "agentpatchcheck-task-finalization",
		runId: options.runId,
		completedAt: new Date().toISOString(),
		taskDefinitionSha256: options.taskDefinition.sha256,
		evidence: {
			path: options.result.evidence.path,
			sha256: await sha256File(options.result.evidence.path),
			createdAt: options.result.evidence.createdAt,
		},
		assessment: {
			path: options.result.assessment.reference.path,
			sha256: await sha256File(options.result.assessment.reference.path),
			createdAt: options.result.assessment.reference.createdAt,
		},
	};
	await lockedFileSystem.writeJsonFileAtomic(finalizationPath, record);
}
