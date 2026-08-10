import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyGitPatchEvidence } from "../../src/agentpatchcheck/git-patch-verifier";
import type { EvidenceBundle } from "../../src/agentpatchcheck/types";

function createBundle(): EvidenceBundle {
	const trackedPatch = "diff --git a/README.md b/README.md\n";
	return {
		version: 1,
		createdAt: "2026-08-07T00:00:00.000Z",
		policy: {
			repositoryRoot: "D:\\repo",
			baseRef: "HEAD",
			baseCommit: "base-commit",
			worktreeRoot: "D:\\repo\\.agentpatchcheck\\worktrees",
			promptLength: 4,
			promptSha256: "hash",
			codexExecutable: null,
			model: null,
			timeoutMs: 1_000,
			sandbox: "read-only",
			allowNetwork: false,
			allowDangerousParameters: false,
			verification: {
				commands: [],
				outputLimitBytes: 1_000,
				allowShell: false,
				allowNetwork: false,
			},
			verificationProfile: null,
			patchExpectation: "changes-required",
		},
		repository: { root: "D:\\repo", baseRef: "HEAD", baseCommit: "base-commit" },
		workspace: {
			runId: "run-1",
			repositoryPath: "D:\\repo",
			path: "D:\\repo\\.agentpatchcheck\\worktrees\\run-1",
			baseRef: "HEAD",
			baseCommit: "base-commit",
		},
		agent: {
			executable: "codex",
			args: ["exec"],
			exitCode: 0,
			signal: null,
			stdout: "done",
			stderr: "",
			durationMs: 1,
			timedOut: false,
		},
		commandVerification: {
			status: "not-run",
			cwd: "D:\\repo\\.agentpatchcheck\\worktrees\\run-1",
			commands: [],
		},
		patch: {
			changedFiles: ["README.md"],
			trackedPatch,
			trackedPatchSha256: createHash("sha256").update(trackedPatch, "utf8").digest("hex"),
		},
		result: { status: "succeeded", durationMs: 1 },
	};
}

describe("GitPatchVerifier", () => {
	it("fails cleanly when the retained worktree is missing", async () => {
		const bundle = createBundle();
		const result = await verifyGitPatchEvidence("D:\\evidence\\run-1.json", {
			readBundle: async () => bundle,
			pathExists: async () => false,
			readHeadCommit: async () => "base-commit",
			collectPatch: async () => ({ changedFiles: [], trackedPatch: "" }),
			listUntrackedFiles: async () => [],
		});

		expect(result.status).toBe("failed");
		expect(result.checks.worktreeExists).toBe(false);
		expect(result.failures).toEqual(["Worktree does not exist."]);
	});

	it("verifies an unchanged worktree against its EvidenceBundle", async () => {
		const bundle = createBundle();
		const result = await verifyGitPatchEvidence("D:\\evidence\\run-1.json", {
			readBundle: async () => bundle,
			pathExists: async () => true,
			readHeadCommit: async () => "base-commit",
			collectPatch: async () => ({
				changedFiles: ["README.md"],
				trackedPatch: bundle.patch.trackedPatch,
			}),
			listUntrackedFiles: async () => [],
		});

		expect(result.status).toBe("verified");
		expect(result.failures).toEqual([]);
		expect(result.checks).toMatchObject({
			worktreeExists: true,
			headMatchesBaseCommit: true,
			changedFilesMatch: true,
			trackedPatchMatches: true,
		});
	});

	it("reports changes made after the evidence was recorded", async () => {
		const bundle = createBundle();
		const result = await verifyGitPatchEvidence("D:\\evidence\\run-1.json", {
			readBundle: async () => bundle,
			pathExists: async () => true,
			readHeadCommit: async () => "different-commit",
			collectPatch: async () => ({
				changedFiles: ["README.md", "src/new.ts"],
				trackedPatch: "different diff",
			}),
			listUntrackedFiles: async () => ["src/new.ts"],
		});

		expect(result.status).toBe("failed");
		expect(result.checks.headMatchesBaseCommit).toBe(false);
		expect(result.checks.changedFilesMatch).toBe(false);
		expect(result.checks.trackedPatchMatches).toBe(false);
		expect(result.checks.unrecordedUntrackedFiles).toEqual(["src/new.ts"]);
		expect(result.failures).toHaveLength(4);
	});
});
