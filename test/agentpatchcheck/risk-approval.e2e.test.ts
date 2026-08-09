import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { createApplyPlan } from "../../src/agentpatchcheck/apply-plan";
import { applyRecordedPatch } from "../../src/agentpatchcheck/apply-recorded-patch";
import { recordApprovalDecision } from "../../src/agentpatchcheck/approval";
import { getAssessmentReportPath } from "../../src/agentpatchcheck/assessment-report";
import type { AssessmentReport, EvidenceBundle } from "../../src/agentpatchcheck/types";

const execFile = promisify(execFileCallback);

async function git(repository: string, args: string[]): Promise<void> {
	await execFile("git", args, { cwd: repository, windowsHide: true });
}

function patch(path: string, before: string, after: string): string {
	return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${before}\n+${after}\n`;
}

function bundle(repository: string, baseCommit: string, path: string, trackedPatch: string): EvidenceBundle {
	return {
		version: 1,
		createdAt: "2026-08-08T00:00:00.000Z",
		policy: {
			repositoryRoot: repository,
			baseRef: "HEAD",
			baseCommit,
			worktreeRoot: join(repository, ".agentpatchcheck", "worktrees"),
			promptLength: 1,
			promptSha256: "hash",
			codexExecutable: null,
			model: null,
			timeoutMs: 1,
			sandbox: "workspace-write",
			allowNetwork: false,
			allowDangerousParameters: false,
			verification: { commands: [], outputLimitBytes: 1, allowShell: false, allowNetwork: false },
			verificationProfile: null,
			patchExpectation: "changes-required",
		},
		repository: { root: repository, baseRef: "HEAD", baseCommit },
		workspace: {
			runId: "run",
			repositoryPath: repository,
			path: join(repository, "worktree"),
			baseRef: "HEAD",
			baseCommit,
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
		commandVerification: { status: "passed", cwd: repository, commands: [] },
		patch: {
			changedFiles: [path],
			trackedPatch,
			trackedPatchSha256: createHash("sha256").update(trackedPatch).digest("hex"),
		},
		result: { status: "succeeded", durationMs: 1 },
	};
}

async function writePassingAssessment(evidencePath: string, value: EvidenceBundle): Promise<void> {
	const report: AssessmentReport = {
		version: 1,
		createdAt: "2026-08-08T00:01:00.000Z",
		evidence: { path: evidencePath, createdAt: value.createdAt },
		gitPatchVerification: {
			status: "verified",
			evidencePath,
			worktreePath: value.workspace.path,
			checkedAt: "2026-08-08T00:01:00.000Z",
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
		verdict: { status: "pass", expectation: "changes-required", reasonCodes: [], reasons: [] },
	};
	await writeFile(getAssessmentReportPath(evidencePath), JSON.stringify(report), "utf8");
}

describe("risk approval apply fixture", () => {
	it("applies a low-risk patch, requires approval for a dependency change, and honours rejection", async () => {
		const repository = await mkdtemp(join(tmpdir(), "agentpatchcheck-risk-"));
		try {
			await writeFile(join(repository, "README.md"), "before\n");
			await writeFile(join(repository, "package.json"), "before\n");
			await git(repository, ["init"]);
			await git(repository, ["config", "user.email", "fixture@example.invalid"]);
			await git(repository, ["config", "user.name", "Fixture"]);
			await git(repository, ["add", "."]);
			await git(repository, ["commit", "-m", "base"]);
			const baseCommit = (
				await execFile("git", ["rev-parse", "HEAD"], { cwd: repository, windowsHide: true })
			).stdout.trim();
			const evidenceDirectory = join(repository, ".agentpatchcheck", "evidence");
			await mkdir(evidenceDirectory, { recursive: true });

			const lowPath = join(evidenceDirectory, "low.json");
			const low = bundle(repository, baseCommit, "README.md", patch("README.md", "before", "after"));
			await writeFile(lowPath, JSON.stringify(low), "utf8");
			await writePassingAssessment(lowPath, low);
			expect((await createApplyPlan({ evidencePath: lowPath })).decision).toBe("ready");
			expect(
				(await applyRecordedPatch({ evidencePath: lowPath, repositoryPath: repository, apply: true })).status,
			).toBe("applied");
			expect((await readFile(join(repository, "README.md"), "utf8")).replace(/\r\n/gu, "\n")).toBe("after\n");

			await git(repository, ["reset", "--hard", baseCommit]);
			const highPath = join(evidenceDirectory, "high.json");
			const high = bundle(repository, baseCommit, "package.json", patch("package.json", "before", "after"));
			await writeFile(highPath, JSON.stringify(high), "utf8");
			await writePassingAssessment(highPath, high);
			const pending = await createApplyPlan({ evidencePath: highPath });
			expect(pending.decision).toBe("requires-approval");
			expect(
				(await applyRecordedPatch({ evidencePath: highPath, repositoryPath: repository, apply: true })).status,
			).toBe("blocked");
			await recordApprovalDecision({
				evidence: { path: highPath, createdAt: high.createdAt },
				risk: pending.risk,
				decision: "approved",
			});
			expect(
				(await applyRecordedPatch({ evidencePath: highPath, repositoryPath: repository, apply: true })).status,
			).toBe("applied");

			await git(repository, ["reset", "--hard", baseCommit]);
			await recordApprovalDecision({
				evidence: { path: highPath, createdAt: high.createdAt },
				risk: pending.risk,
				decision: "rejected",
			});
			expect(
				(await applyRecordedPatch({ evidencePath: highPath, repositoryPath: repository, apply: true })).status,
			).toBe("blocked");
		} finally {
			await rm(repository, { recursive: true, force: true });
		}
	});
});
