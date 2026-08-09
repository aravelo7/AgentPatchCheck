import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { getApprovalHistoryPath, getApprovalRecordPath } from "./approval";
import { listEvidenceBundles } from "./evidence-list";
import type { EvidenceAuditResult, EvidenceListEntry } from "./types";

const DEFAULT_RETENTION_DAYS = 30;

function validateOlderThanDays(value: number | undefined): number {
	const resolved = value ?? DEFAULT_RETENTION_DAYS;
	if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 36_500)
		throw new Error("olderThanDays must be a whole number between 1 and 36500.");
	return resolved;
}

function isOlderThan(entry: EvidenceListEntry, olderThanDays: number, now: Date): boolean {
	const createdAt = Date.parse(entry.createdAt);
	return Number.isFinite(createdAt) && createdAt <= now.getTime() - olderThanDays * 24 * 60 * 60 * 1_000;
}

async function listApprovalPaths(evidenceDirectory: string): Promise<string[]> {
	try {
		const entries = await readdir(evidenceDirectory, { withFileTypes: true });
		return entries
			.filter(
				(entry) =>
					entry.isFile() &&
					(entry.name.endsWith(".approval.json") || entry.name.endsWith(".approval-history.jsonl")),
			)
			.map((entry) => join(evidenceDirectory, entry.name))
			.sort((left, right) => left.localeCompare(right));
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
}

export async function auditEvidenceBundles(options: {
	repositoryPath: string;
	olderThanDays?: number;
	now?: Date;
}): Promise<EvidenceAuditResult> {
	const olderThanDays = validateOlderThanDays(options.olderThanDays);
	const result = await listEvidenceBundles({ repositoryPath: options.repositoryPath });
	const approvalPaths = await listApprovalPaths(result.evidenceDirectory);
	const knownApprovalPaths = new Set(
		result.entries.flatMap((entry) => [
			getApprovalRecordPath(entry.evidencePath),
			getApprovalHistoryPath(entry.evidencePath),
		]),
	);
	const now = options.now ?? new Date();
	return {
		version: 1,
		repositoryRoot: result.repositoryRoot,
		auditedAt: now.toISOString(),
		olderThanDays,
		missingAssessments: result.entries.filter((entry) => entry.assessmentStatus === "missing"),
		missingWorktrees: result.entries.filter((entry) => !entry.worktreeExists),
		expiredBundles: result.entries.filter((entry) => isOlderThan(entry, olderThanDays, now)),
		orphanApprovalPaths: approvalPaths.filter((path) => !knownApprovalPaths.has(path)),
		invalidEvidence: result.invalidEvidence,
	};
}

export function getEvidenceRetentionDefaultDays(): number {
	return DEFAULT_RETENTION_DAYS;
}
