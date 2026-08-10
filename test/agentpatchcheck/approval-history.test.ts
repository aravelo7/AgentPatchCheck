import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	getApprovalHistoryPath,
	getApprovalRecordPath,
	getApprovalState,
	readApprovalHistory,
	readApprovalRecord,
	recordApprovalDecision,
} from "../../src/agentpatchcheck/approval";
import { HEADLESS_CLI_VERSION } from "../../src/agentpatchcheck/cli-version";
import type { EvidenceBundleReference, RiskResult } from "../../src/agentpatchcheck/types";

const risk: RiskResult = {
	version: 1,
	level: "high",
	findings: [],
	requiresApproval: true,
	blocksApply: false,
	fingerprint: "risk-fingerprint",
};

describe("approval decision history", () => {
	it("appends every decision and uses the latest recorded decision for the existing apply gate", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agentpatchcheck-approval-history-"));
		try {
			const evidencePath = join(directory, "evidence", "run.json");
			const evidence: EvidenceBundleReference = { path: evidencePath, createdAt: "2026-08-09T00:00:00.000Z" };
			await mkdir(join(directory, "evidence"), { recursive: true });

			const approved = await recordApprovalDecision({
				evidence,
				risk,
				decision: "approved",
				reason: "reviewed",
			});
			const rejected = await recordApprovalDecision({
				evidence,
				risk,
				decision: "rejected",
				reason: "new concern",
			});

			const history = await readApprovalHistory(evidencePath);
			expect(history).toEqual([approved, rejected]);
			expect(history.every((record) => record.cliVersion === HEADLESS_CLI_VERSION)).toBe(true);
			expect(await readApprovalRecord(getApprovalRecordPath(evidencePath))).toEqual(rejected);
			expect(getApprovalState(rejected, evidence, risk).status).toBe("rejected");
			expect((await readFile(getApprovalHistoryPath(evidencePath), "utf8")).trim().split(/\r?\n/u)).toHaveLength(2);

			await writeFile(getApprovalRecordPath(evidencePath), JSON.stringify(approved), "utf8");
			expect(await readApprovalRecord(getApprovalRecordPath(evidencePath))).toEqual(rejected);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
