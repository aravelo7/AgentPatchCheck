import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { getGitStdout } from "../workspace/git-utils";
import { getAssessmentReportPath } from "./assessment-report";
import { readEvidenceBundle } from "./git-patch-verifier";
import type { AssessmentReport, EvidenceBundle, EvidenceListEntry, EvidenceListResult } from "./types";

const EVIDENCE_DIRECTORY_NAME = "evidence";

interface EvidenceListDependencies {
	resolveRepositoryRoot: (repositoryPath: string) => Promise<string>;
	listEvidenceFiles: (evidenceDirectory: string) => Promise<string[]>;
	readBundle: (path: string) => Promise<EvidenceBundle>;
	readAssessment: (path: string) => Promise<unknown | null>;
	pathExists: (path: string) => Promise<boolean>;
}

function pathsEqual(left: string, right: string): boolean {
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function resolveRepositoryRoot(repositoryPath: string): Promise<string> {
	const candidate = resolve(repositoryPath);
	if (!(await stat(candidate)).isDirectory()) {
		throw new Error(`Repository path is not a directory: ${candidate}`);
	}
	return await realpath(await getGitStdout(["rev-parse", "--show-toplevel"], candidate));
}

async function listEvidenceFiles(evidenceDirectory: string): Promise<string[]> {
	try {
		const entries = await readdir(evidenceDirectory, { withFileTypes: true });
		return entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.endsWith(".assessment.json"))
			.map((entry) => join(evidenceDirectory, entry.name));
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return [];
		}
		throw error;
	}
}

async function readAssessment(path: string): Promise<unknown | null> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return null;
		}
		return undefined;
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

function getAssessmentState(
	value: unknown,
	evidencePath: string,
	evidenceCreatedAt: string,
): Pick<EvidenceListEntry, "assessmentStatus" | "verdict"> {
	if (value === null) {
		return { assessmentStatus: "missing", verdict: null };
	}
	if (!value || typeof value !== "object") {
		return { assessmentStatus: "invalid", verdict: null };
	}
	const report = value as Partial<AssessmentReport>;
	const verdictStatus = report.verdict?.status;
	if (
		report.version !== 1 ||
		report.evidence?.createdAt !== evidenceCreatedAt ||
		typeof report.evidence.path !== "string" ||
		!pathsEqual(resolve(report.evidence.path), resolve(evidencePath)) ||
		(verdictStatus !== "pass" && verdictStatus !== "fail" && verdictStatus !== "inconclusive")
	) {
		return { assessmentStatus: "invalid", verdict: null };
	}
	return { assessmentStatus: "valid", verdict: verdictStatus };
}

const defaultDependencies: EvidenceListDependencies = {
	resolveRepositoryRoot,
	listEvidenceFiles,
	readBundle: readEvidenceBundle,
	readAssessment,
	pathExists,
};

export async function listEvidenceBundles(
	options: { repositoryPath: string },
	dependencies: EvidenceListDependencies = defaultDependencies,
): Promise<EvidenceListResult> {
	const repositoryRoot = await dependencies.resolveRepositoryRoot(options.repositoryPath);
	const evidenceDirectory = join(repositoryRoot, ".agentpatchcheck", EVIDENCE_DIRECTORY_NAME);
	const evidencePaths = await dependencies.listEvidenceFiles(evidenceDirectory);
	const invalidEvidence: string[] = [];
	const entries: EvidenceListEntry[] = [];

	for (const evidencePath of evidencePaths) {
		let bundle: EvidenceBundle;
		try {
			bundle = await dependencies.readBundle(evidencePath);
		} catch {
			invalidEvidence.push(evidencePath);
			continue;
		}

		const assessmentPath = getAssessmentReportPath(evidencePath);
		const [assessment, worktreeExists] = await Promise.all([
			dependencies.readAssessment(assessmentPath),
			dependencies.pathExists(bundle.workspace.path),
		]);
		entries.push({
			runId: bundle.workspace.runId,
			createdAt: bundle.createdAt,
			status: bundle.result.status,
			...getAssessmentState(assessment, evidencePath, bundle.createdAt),
			worktreeExists,
			evidencePath,
			assessmentPath,
		});
	}

	entries.sort(
		(left, right) => right.createdAt.localeCompare(left.createdAt) || left.runId.localeCompare(right.runId),
	);
	invalidEvidence.sort((left, right) => left.localeCompare(right));
	return { repositoryRoot, evidenceDirectory, entries, invalidEvidence };
}
