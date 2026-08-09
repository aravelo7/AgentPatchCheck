import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { manageEvidenceRetention } from "../../src/agentpatchcheck/evidence-retention";
import type { EvidenceAuditResult } from "../../src/agentpatchcheck/types";

function createAudit(evidencePath: string): EvidenceAuditResult {
	return {
		version: 1,
		repositoryRoot: "D:\\repo",
		auditedAt: "2026-08-09T00:00:00.000Z",
		olderThanDays: 90,
		missingAssessments: [],
		missingWorktrees: [],
		expiredBundles: [
			{
				runId: "old-run",
				createdAt: "2025-01-01T00:00:00.000Z",
				status: "succeeded",
				assessmentStatus: "valid",
				verdict: "pass",
				worktreeExists: false,
				evidencePath,
				assessmentPath: `${evidencePath}.assessment.json`,
			},
		],
		orphanApprovalPaths: [],
		invalidEvidence: [],
	};
}

describe("Evidence retention", () => {
	it("defaults to dry-run and protects evidence referenced by a BenchmarkReport", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agentpatchcheck-retention-"));
		try {
			const evidencePath = join(directory, "old-run.json");
			const reportRoot = join(directory, "reports");
			await mkdir(reportRoot);
			await writeFile(
				join(reportRoot, "report.json"),
				JSON.stringify({ tasks: [{ evidence: { path: evidencePath } }] }),
				"utf8",
			);
			const removed: string[] = [];

			const result = await manageEvidenceRetention(
				{ repositoryPath: "D:\\repo", olderThanDays: 90, benchmarkReportRoots: [reportRoot] },
				{
					auditEvidence: async () => createAudit(evidencePath),
					removeFile: async (path) => {
						removed.push(path);
					},
				},
			);

			expect(result).toMatchObject({ status: "dry-run", candidates: [], removedEvidencePaths: [] });
			expect(result.protectedByBenchmark[0]).toMatchObject({
				evidencePath,
				benchmarkReferences: [join(reportRoot, "report.json")],
			});
			expect(removed).toEqual([]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("requires explicit apply before removing only an eligible evidence triplet", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agentpatchcheck-retention-"));
		try {
			const evidencePath = join(directory, "old-run.json");
			const reportRoot = join(directory, "reports");
			await mkdir(reportRoot);
			const removed: string[] = [];
			const result = await manageEvidenceRetention(
				{ repositoryPath: "D:\\repo", olderThanDays: 90, benchmarkReportRoots: [reportRoot], apply: true },
				{
					auditEvidence: async () => createAudit(evidencePath),
					removeFile: async (path) => {
						removed.push(path);
					},
				},
			);

			expect(result).toMatchObject({ status: "removed", removedEvidencePaths: [evidencePath] });
			expect(removed).toHaveLength(4);
			expect(removed).toContain(evidencePath);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
