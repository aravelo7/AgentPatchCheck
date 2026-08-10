import { describe, expect, it } from "vitest";

import { listEvidenceBundles } from "../../src/agentpatchcheck/evidence-list";
import type { AssessmentReport, EvidenceBundle } from "../../src/agentpatchcheck/types";

const repositoryRoot = "D:\\repo";
const olderEvidencePath = "D:\\repo\\.agentpatchcheck\\evidence\\run-old.json";
const newerEvidencePath = "D:\\repo\\.agentpatchcheck\\evidence\\run-new.json";

function createBundle(runId: string, createdAt: string): EvidenceBundle {
	return {
		version: 1,
		createdAt,
		policy: {
			repositoryRoot,
			baseRef: "HEAD",
			baseCommit: "base",
			worktreeRoot: "D:\\repo\\.agentpatchcheck\\worktrees",
			promptLength: 1,
			promptSha256: "hash",
			codexExecutable: null,
			model: null,
			timeoutMs: 1_000,
			sandbox: "read-only",
			allowNetwork: false,
			allowDangerousParameters: false,
			verification: { commands: [], outputLimitBytes: 1_000, allowShell: false, allowNetwork: false },
			verificationProfile: null,
			patchExpectation: "changes-optional",
		},
		repository: { root: repositoryRoot, baseRef: "HEAD", baseCommit: "base" },
		workspace: {
			runId,
			repositoryPath: repositoryRoot,
			path: `D:\\repo\\.agentpatchcheck\\worktrees\\${runId}`,
			baseRef: "HEAD",
			baseCommit: "base",
		},
		agent: {
			executable: "codex",
			args: [],
			exitCode: 0,
			signal: null,
			stdout: "",
			stderr: "",
			durationMs: 1,
			timedOut: false,
		},
		commandVerification: { status: "not-run", cwd: repositoryRoot, commands: [] },
		patch: { changedFiles: [], trackedPatch: "", trackedPatchSha256: "hash" },
		result: { status: "succeeded", durationMs: 1 },
	};
}

function createAssessment(evidencePath: string, createdAt: string): AssessmentReport {
	return {
		version: 1,
		createdAt: "2026-08-08T01:00:00.000Z",
		evidence: { path: evidencePath, createdAt },
		gitPatchVerification: {
			status: "verified",
			evidencePath,
			worktreePath: "D:\\repo\\.agentpatchcheck\\worktrees\\run-new",
			checkedAt: "2026-08-08T01:00:00.000Z",
			durationMs: 1,
			checks: {
				worktreeExists: true,
				headMatchesBaseCommit: true,
				changedFilesMatch: true,
				trackedPatchMatches: true,
				unrecordedUntrackedFiles: [],
			},
			failures: [],
		},
		verdict: { status: "pass", expectation: "changes-optional", reasonCodes: [], reasons: [] },
	};
}

describe("listEvidenceBundles", () => {
	it("lists valid evidence in reverse chronological order without writing state", async () => {
		const older = createBundle("run-old", "2026-08-08T00:00:00.000Z");
		const newer = createBundle("run-new", "2026-08-08T02:00:00.000Z");
		const result = await listEvidenceBundles(
			{ repositoryPath: repositoryRoot },
			{
				resolveRepositoryRoot: async () => repositoryRoot,
				listEvidenceFiles: async () => [
					olderEvidencePath,
					newerEvidencePath,
					"D:\\repo\\.agentpatchcheck\\evidence\\bad.json",
				],
				readBundle: async (path) => {
					if (path === olderEvidencePath) return older;
					if (path === newerEvidencePath) return newer;
					throw new Error("invalid");
				},
				readAssessment: async (path) =>
					path.includes("run-new") ? createAssessment(newerEvidencePath, newer.createdAt) : null,
				pathExists: async (path) => path.includes("run-new"),
			},
		);

		expect(result.repositoryRoot).toBe(repositoryRoot);
		expect(result.entries).toMatchObject([
			{ runId: "run-new", assessmentStatus: "valid", verdict: "pass", worktreeExists: true },
			{ runId: "run-old", assessmentStatus: "missing", verdict: null, worktreeExists: false },
		]);
		expect(result.invalidEvidence).toEqual(["D:\\repo\\.agentpatchcheck\\evidence\\bad.json"]);
	});

	it("reports a non-matching assessment as invalid without rejecting valid evidence", async () => {
		const bundle = createBundle("run-new", "2026-08-08T02:00:00.000Z");
		const result = await listEvidenceBundles(
			{ repositoryPath: repositoryRoot },
			{
				resolveRepositoryRoot: async () => repositoryRoot,
				listEvidenceFiles: async () => [newerEvidencePath],
				readBundle: async () => bundle,
				readAssessment: async () => createAssessment(olderEvidencePath, bundle.createdAt),
				pathExists: async () => true,
			},
		);

		expect(result.entries[0]).toMatchObject({ assessmentStatus: "invalid", verdict: null });
	});

	it("applies exact run, status, assessment, and timestamp filters after stable ordering", async () => {
		const older = createBundle("run-old", "2026-08-08T00:00:00.000Z");
		const newer = createBundle("run-new", "2026-08-08T02:00:00.000Z");
		const result = await listEvidenceBundles(
			{
				repositoryPath: repositoryRoot,
				filter: {
					status: "succeeded",
					assessmentStatus: "valid",
					runId: "run-new",
					createdAfter: "2026-08-08T01:00:00.000Z",
					createdBefore: "2026-08-08T03:00:00.000Z",
				},
			},
			{
				resolveRepositoryRoot: async () => repositoryRoot,
				listEvidenceFiles: async () => [olderEvidencePath, newerEvidencePath],
				readBundle: async (path) => (path === olderEvidencePath ? older : newer),
				readAssessment: async (path) =>
					path.includes("run-new") ? createAssessment(newerEvidencePath, newer.createdAt) : null,
				pathExists: async (path) => path.includes("run-new"),
			},
		);

		expect(result.entries.map((entry) => entry.runId)).toEqual(["run-new"]);
	});
});
