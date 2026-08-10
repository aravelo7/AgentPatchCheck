import { readFile } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";

import { lockedFileSystem } from "../fs/locked-file-system";
import { HEADLESS_CLI_VERSION } from "./cli-version";
import type { ApprovalDecision, ApprovalRecord, ApprovalState, EvidenceBundleReference, RiskResult } from "./types";

export function getApprovalRecordPath(evidencePath: string): string {
	const absolutePath = resolve(evidencePath);
	const parsed = parse(absolutePath);
	return join(dirname(absolutePath), `${parsed.name}.approval.json`);
}

export function getApprovalHistoryPath(evidencePath: string): string {
	const absolutePath = resolve(evidencePath);
	const parsed = parse(absolutePath);
	return join(dirname(absolutePath), `${parsed.name}.approval-history.jsonl`);
}

function getApprovalHistoryPathFromRecordPath(recordPath: string): string {
	const absolutePath = resolve(recordPath);
	const parsed = parse(absolutePath);
	const evidenceName = parsed.name.endsWith(".approval") ? parsed.name.slice(0, -".approval".length) : parsed.name;
	return join(dirname(absolutePath), `${evidenceName}.approval-history.jsonl`);
}

export async function readApprovalHistory(evidencePath: string): Promise<ApprovalRecord[]> {
	try {
		const content = await readFile(getApprovalHistoryPath(evidencePath), "utf8");
		const records: ApprovalRecord[] = [];
		for (const line of content.split(/\r?\n/u)) {
			if (!line.trim()) continue;
			const value: unknown = JSON.parse(line);
			if (value && typeof value === "object") records.push(value as ApprovalRecord);
		}
		return records;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
		return [];
	}
}

export async function readApprovalRecord(path: string): Promise<ApprovalRecord | null> {
	const history = await readApprovalHistoryFromRecordPath(path);
	if (history.length > 0) return history.at(-1) ?? null;
	try {
		return JSON.parse(await readFile(path, "utf8")) as ApprovalRecord;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
		return null;
	}
}

async function readApprovalHistoryFromRecordPath(recordPath: string): Promise<ApprovalRecord[]> {
	try {
		const content = await readFile(getApprovalHistoryPathFromRecordPath(recordPath), "utf8");
		return content
			.split(/\r?\n/u)
			.filter((line) => line.trim())
			.map((line) => JSON.parse(line) as ApprovalRecord);
	} catch {
		return [];
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
	cliVersion?: string;
}): Promise<ApprovalRecord> {
	const record: ApprovalRecord = {
		version: 1,
		evidence: options.evidence,
		riskFingerprint: options.risk.fingerprint,
		decision: options.decision,
		createdAt: new Date().toISOString(),
		reason: options.reason?.trim() || null,
		cliVersion: options.cliVersion ?? HEADLESS_CLI_VERSION,
	};
	const historyPath = getApprovalHistoryPath(options.evidence.path);
	await lockedFileSystem.withLock({ path: historyPath, type: "file" }, async () => {
		let history = "";
		try {
			history = await readFile(historyPath, "utf8");
		} catch (error) {
			if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
		}
		await lockedFileSystem.writeTextFileAtomic(historyPath, `${history}${JSON.stringify(record)}\n`, { lock: null });
		await lockedFileSystem.writeJsonFileAtomic(getApprovalRecordPath(options.evidence.path), record, { lock: null });
	});
	return record;
}
