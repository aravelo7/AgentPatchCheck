import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createGitProcessEnv } from "../core/git-process-env";
import { getGitStdout } from "../workspace/git-utils";
import { getAssessmentReportPath } from "./assessment-report";
import { readEvidenceBundle } from "./git-patch-verifier";
import type { ApplyPlanResult, AssessmentReport, EvidenceBundle } from "./types";

interface ApplyPlanDependencies {
	readBundle: (path: string) => Promise<EvidenceBundle>;
	readAssessment: (path: string) => Promise<unknown | null>;
	resolveRepositoryRoot: (path: string) => Promise<string>;
	readHeadCommit: (repositoryRoot: string) => Promise<string>;
	checkPatch: (repositoryRoot: string, patch: string) => Promise<{ ok: boolean; error: string | null }>;
}

function pathsEqual(left: string, right: string): boolean {
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function readAssessment(path: string): Promise<unknown | null> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
		return undefined;
	}
}

function hasPassingAssessment(value: unknown, evidencePath: string, createdAt: string): boolean {
	if (!value || typeof value !== "object") return false;
	const report = value as Partial<AssessmentReport>;
	return (
		report.version === 1 &&
		report.evidence?.createdAt === createdAt &&
		typeof report.evidence.path === "string" &&
		pathsEqual(resolve(report.evidence.path), resolve(evidencePath)) &&
		report.verdict?.status === "pass"
	);
}

async function resolveRepositoryRoot(path: string): Promise<string> {
	return resolve(await getGitStdout(["rev-parse", "--show-toplevel"], path));
}

async function checkPatch(repositoryRoot: string, patch: string): Promise<{ ok: boolean; error: string | null }> {
	return await new Promise((resolvePromise, reject) => {
		const child = spawn("git", ["-c", "core.quotepath=false", "apply", "--check", "--binary", "--"], {
			cwd: repositoryRoot,
			env: createGitProcessEnv(),
			stdio: ["pipe", "ignore", "pipe"],
			windowsHide: true,
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString("utf8")}`.slice(0, 16_384);
		});
		child.once("error", reject);
		child.once("close", (code) =>
			resolvePromise({ ok: code === 0, error: code === 0 ? null : stderr.trim() || "git apply --check failed." }),
		);
		child.stdin.end(patch, "utf8");
	});
}

function findUnmaterializedFiles(bundle: EvidenceBundle): string[] {
	const snapshots = new Map((bundle.patch.untrackedFiles ?? []).map((file) => [file.path, file]));
	return bundle.patch.changedFiles.filter(
		(file) =>
			(!snapshots.has(file) ||
				snapshots.get(file)?.sha256 !==
					createHash("sha256")
						.update(snapshots.get(file)?.content ?? "", "utf8")
						.digest("hex")) &&
			!bundle.patch.trackedPatch.includes(`diff --git a/${file} b/${file}`) &&
			!bundle.patch.trackedPatch.includes(`+++ b/${file}\n`) &&
			!bundle.patch.trackedPatch.includes(`--- a/${file}\n`),
	);
}

const defaultDependencies: ApplyPlanDependencies = {
	readBundle: readEvidenceBundle,
	readAssessment,
	resolveRepositoryRoot,
	readHeadCommit: async (repositoryRoot) => await getGitStdout(["rev-parse", "--verify", "HEAD"], repositoryRoot),
	checkPatch,
};

export async function createApplyPlan(
	options: { evidencePath: string },
	dependencies: ApplyPlanDependencies = defaultDependencies,
): Promise<ApplyPlanResult> {
	const evidencePath = resolve(options.evidencePath);
	const bundle = await dependencies.readBundle(evidencePath);
	const assessmentPath = getAssessmentReportPath(evidencePath);
	const failures: string[] = [];
	const assessmentPasses = hasPassingAssessment(
		await dependencies.readAssessment(assessmentPath),
		evidencePath,
		bundle.createdAt,
	);
	if (!assessmentPasses) failures.push("A matching passing assessment is required.");

	let repositoryRoot: string | null = null;
	let headMatchesBaseCommit = false;
	try {
		repositoryRoot = await dependencies.resolveRepositoryRoot(bundle.repository.root);
		if (!pathsEqual(repositoryRoot, resolve(bundle.repository.root)))
			failures.push("Recorded repository root no longer matches its Git root.");
		else headMatchesBaseCommit = (await dependencies.readHeadCommit(repositoryRoot)) === bundle.repository.baseCommit;
		if (!headMatchesBaseCommit) failures.push("Repository HEAD does not match the recorded base commit.");
	} catch {
		failures.push("Recorded repository is unavailable as a Git repository.");
	}

	const unmaterializedFiles = findUnmaterializedFiles(bundle);
	if (unmaterializedFiles.length > 0)
		failures.push("Some changed files are not materialized in the recorded tracked patch.");
	let patchApplies = bundle.patch.trackedPatch.length === 0;
	if (repositoryRoot && failures.length === 0 && bundle.patch.trackedPatch.length > 0) {
		const check = await dependencies.checkPatch(repositoryRoot, bundle.patch.trackedPatch);
		patchApplies = check.ok;
		if (!check.ok) failures.push(check.error ?? "Recorded patch cannot be applied cleanly.");
	}

	return {
		status:
			failures.length === 0 ? (bundle.patch.changedFiles.length === 0 ? "nothing-to-apply" : "ready") : "blocked",
		evidencePath,
		assessmentPath,
		repositoryRoot,
		baseCommit: bundle.repository.baseCommit,
		changedFiles: bundle.patch.changedFiles,
		unmaterializedFiles,
		checks: { assessmentPasses, headMatchesBaseCommit, patchApplies },
		failures,
	};
}
