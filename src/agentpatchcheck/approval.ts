import { readFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

import { lockedFileSystem } from "../fs/locked-file-system";
import type { ApprovalDecision, ApprovalRecord, ApprovalState, EvidenceBundleReference, RiskResult } from "./types";

export function getApprovalRecordPath(evidencePath: string): string {
	const absolutePath = resolve(evidencePath);
	const parsed = parse(absolutePath);
	return join(dirname(absolutePath), `${parsed.name}.approval.json`);
}

export async function readApprovalRecord(path: string): Promise<ApprovalRecord | null> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as ApprovalRecord;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
		return null;
	}
}

export function getApprovalState(
	record: ApprovalRecord | null,
	evidence: EvidenceBundleReference,
	risk: RiskResult,
): ApprovalState {
	if (!risk.requiresApproval) return { status: "not-required", record: null };
	if (!record) return { status: "pending", record: null };
	if (
		record.version !== 1 ||
		record.evidence.createdAt !== evidence.createdAt ||
		resolve(record.evidence.path) !== resolve(evidence.path) ||
		record.riskFingerprint !== risk.fingerprint
	)
		return { status: "invalid", record: null };
	return { status: record.decision === "approved" ? "approved" : "rejected", record };
}

export async function recordApprovalDecision(options: {
	evidence: EvidenceBundleReference;
	risk: RiskResult;
	decision: ApprovalDecision;
	reason?: string;
}): Promise<ApprovalRecord> {
	const record: ApprovalRecord = {
		version: 1,
		evidence: options.evidence,
		riskFingerprint: options.risk.fingerprint,
		decision: options.decision,
		createdAt: new Date().toISOString(),
		reason: options.reason?.trim() || null,
	};
	await lockedFileSystem.writeJsonFileAtomic(getApprovalRecordPath(options.evidence.path), record);
	return record;
}
