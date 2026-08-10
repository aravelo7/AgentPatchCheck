import { readdir, readFile, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { getApprovalHistoryPath, getApprovalRecordPath } from "./approval";
import { getAssessmentReportPath } from "./assessment-report";
import { auditEvidenceBundles } from "./evidence-audit";
import type { EvidenceRetentionResult } from "./types";

interface EvidenceRetentionDependencies {
	auditEvidence: typeof auditEvidenceBundles;
	removeFile: (path: string) => Promise<void>;
}

async function collectJsonFiles(root: string): Promise<string[]> {
	const resolvedRoot = resolve(root);
	if (!(await stat(resolvedRoot)).isDirectory())
		throw new Error(`Benchmark report root is not a directory: ${resolvedRoot}`);
	const paths: string[] = [];
	const visit = async (directory: string): Promise<void> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) await visit(path);
			else if (entry.isFile() && entry.name.endsWith(".json")) paths.push(path);
		}
	};
	await visit(resolvedRoot);
	return paths.sort((left, right) => left.localeCompare(right));
}

function getEvidencePathsFromBenchmarkReport(value: unknown): string[] {
	if (!value || typeof value !== "object" || !Array.isArray((value as { tasks?: unknown }).tasks)) return [];
	return (value as { tasks: Array<{ evidence?: { path?: unknown } | null }> }).tasks
		.map((task) => task.evidence?.path)
		.filter((path): path is string => typeof path === "string" && isAbsolute(path));
}

async function findBenchmarkReferences(roots: string[]): Promise<Map<string, string[]>> {
	const references = new Map<string, string[]>();
	for (const root of roots) {
		for (const reportPath of await collectJsonFiles(root)) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(await readFile(reportPath, "utf8"));
			} catch {
				continue;
			}
			for (const evidencePath of getEvidencePathsFromBenchmarkReport(parsed)) {
				const key = resolve(evidencePath);
				const existing = references.get(key) ?? [];
				existing.push(reportPath);
				references.set(key, existing);
			}
		}
	}
	return references;
}

export async function manageEvidenceRetention(
	options: {
		repositoryPath: string;
		olderThanDays: number;
		benchmarkReportRoots: string[];
		apply?: boolean;
		now?: Date;
	},
	dependencies: EvidenceRetentionDependencies = {
		auditEvidence: auditEvidenceBundles,
		removeFile: async (path) => {
			await rm(path, { force: true });
		},
	},
): Promise<EvidenceRetentionResult> {
	if (options.benchmarkReportRoots.length === 0)
		throw new Error("Retention requires at least one benchmarkReportRoots directory to protect referenced evidence.");
	const audit = await dependencies.auditEvidence({
		repositoryPath: options.repositoryPath,
		olderThanDays: options.olderThanDays,
		now: options.now,
	});
	const benchmarkReportRoots = options.benchmarkReportRoots.map((root) => resolve(root));
	const references = await findBenchmarkReferences(benchmarkReportRoots);
	const candidates = audit.expiredBundles
		.filter((entry) => entry.assessmentStatus === "valid" && !entry.worktreeExists)
		.map((entry) => ({
			runId: entry.runId,
			evidencePath: entry.evidencePath,
			assessmentPath: getAssessmentReportPath(entry.evidencePath),
			approvalPath: getApprovalRecordPath(entry.evidencePath),
			approvalHistoryPath: getApprovalHistoryPath(entry.evidencePath),
			createdAt: entry.createdAt,
			benchmarkReferences: references.get(resolve(entry.evidencePath)) ?? [],
		}));
	const protectedByBenchmark = candidates.filter((candidate) => candidate.benchmarkReferences.length > 0);
	const removable = candidates.filter((candidate) => candidate.benchmarkReferences.length === 0);
	if (options.apply === true) {
		for (const candidate of removable) {
			await Promise.all(
				[
					candidate.evidencePath,
					candidate.assessmentPath,
					candidate.approvalPath,
					candidate.approvalHistoryPath,
				].map(async (path) => await dependencies.removeFile(path)),
			);
		}
	}
	return {
		version: 1,
		status: options.apply === true ? "removed" : "dry-run",
		repositoryRoot: audit.repositoryRoot,
		olderThanDays: audit.olderThanDays,
		benchmarkReportRoots,
		candidates: removable,
		protectedByBenchmark,
		removedEvidencePaths: options.apply === true ? removable.map((candidate) => candidate.evidencePath) : [],
	};
}
