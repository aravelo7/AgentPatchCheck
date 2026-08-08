import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { runGit } from "../workspace/git-utils";
import { getAssessmentReportPath } from "./assessment-report";
import { getEvidenceBundlePath } from "./evidence-bundle";
import { readEvidenceBundle } from "./git-patch-verifier";
import type { AssessmentReport, CleanupResult, EvidenceBundle } from "./types";

interface CleanupDependencies {
	readBundle: (path: string) => Promise<EvidenceBundle>;
	readAssessment: (path: string) => Promise<AssessmentReport>;
	pathExists: (path: string) => Promise<boolean>;
	listWorktreePaths: (repositoryRoot: string) => Promise<string[]>;
	removeWorktree: (repositoryRoot: string, worktreePath: string) => Promise<void>;
}

function pathsEqual(left: string, right: string): boolean {
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function assertDescendant(root: string, candidate: string, label: string): void {
	const relativePath = relative(root, candidate);
	if (
		!relativePath ||
		relativePath === ".." ||
		relativePath.startsWith("../") ||
		relativePath.startsWith("..\\") ||
		isAbsolute(relativePath)
	) {
		throw new Error(`${label} must be a descendant of the repository root.`);
	}
}

function assertManagedPaths(bundle: EvidenceBundle, evidencePath: string): void {
	const repositoryRoot = resolve(bundle.repository.root);
	const policyRepositoryRoot = resolve(bundle.policy.repositoryRoot);
	if (!pathsEqual(repositoryRoot, policyRepositoryRoot)) {
		throw new Error("Evidence repository root does not match the recorded TaskPolicy.");
	}

	const runId = bundle.workspace.runId;
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(runId)) {
		throw new Error("Evidence contains an invalid managed worktree run id.");
	}

	const worktreeRoot = resolve(bundle.policy.worktreeRoot);
	assertDescendant(repositoryRoot, worktreeRoot, "Worktree root");
	const expectedWorktreePath = join(worktreeRoot, runId);
	if (!pathsEqual(resolve(bundle.workspace.path), expectedWorktreePath)) {
		throw new Error("Evidence worktree path is not the managed path for its recorded run.");
	}
	if (!pathsEqual(resolve(evidencePath), getEvidenceBundlePath(worktreeRoot, runId))) {
		throw new Error("Evidence path is not the managed evidence path for its recorded run.");
	}
}

function isCompletedAssessmentReport(
	value: unknown,
	evidencePath: string,
	evidenceCreatedAt: string,
): value is AssessmentReport {
	if (!value || typeof value !== "object") {
		return false;
	}
	const report = value as Partial<AssessmentReport>;
	return (
		report.version === 1 &&
		typeof report.createdAt === "string" &&
		typeof report.evidence?.path === "string" &&
		report.evidence.createdAt === evidenceCreatedAt &&
		pathsEqual(resolve(report.evidence.path), resolve(evidencePath)) &&
		(report.verdict?.status === "pass" ||
			report.verdict?.status === "fail" ||
			report.verdict?.status === "inconclusive")
	);
}

async function readAssessmentReport(path: string): Promise<AssessmentReport> {
	const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
	return parsed as AssessmentReport;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function listWorktreePaths(repositoryRoot: string): Promise<string[]> {
	const result = await runGit(repositoryRoot, ["worktree", "list", "--porcelain"]);
	if (!result.ok) {
		throw new Error(result.error ?? "Could not list Git worktrees.");
	}
	return result.stdout
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => resolve(line.slice("worktree ".length)));
}

async function removeWorktree(repositoryRoot: string, worktreePath: string): Promise<void> {
	const result = await runGit(repositoryRoot, ["worktree", "remove", "--force", worktreePath]);
	if (!result.ok) {
		throw new Error(result.error ?? "Could not remove managed Git worktree.");
	}
}

const defaultDependencies: CleanupDependencies = {
	readBundle: readEvidenceBundle,
	readAssessment: readAssessmentReport,
	pathExists,
	listWorktreePaths,
	removeWorktree,
};

export async function cleanupEvidenceWorktree(
	options: { evidencePath: string; apply?: boolean },
	dependencies: CleanupDependencies = defaultDependencies,
): Promise<CleanupResult> {
	const evidencePath = resolve(options.evidencePath);
	const bundle = await dependencies.readBundle(evidencePath);
	assertManagedPaths(bundle, evidencePath);

	const assessmentPath = getAssessmentReportPath(evidencePath);
	const assessment = await dependencies.readAssessment(assessmentPath);
	if (!isCompletedAssessmentReport(assessment, evidencePath, bundle.createdAt)) {
		throw new Error("Cleanup requires a completed assessment that matches the EvidenceBundle.");
	}

	const worktreePath = resolve(bundle.workspace.path);
	const exists = await dependencies.pathExists(worktreePath);
	if (!exists) {
		return { status: "already-removed", evidencePath, assessmentPath, worktreePath };
	}

	const registeredWorktrees = await dependencies.listWorktreePaths(resolve(bundle.repository.root));
	if (!registeredWorktrees.some((path) => pathsEqual(path, worktreePath))) {
		throw new Error("Managed worktree is not registered with the recorded Git repository.");
	}

	if (options.apply !== true) {
		return { status: "dry-run", evidencePath, assessmentPath, worktreePath };
	}

	await dependencies.removeWorktree(resolve(bundle.repository.root), worktreePath);
	return { status: "removed", evidencePath, assessmentPath, worktreePath };
}
