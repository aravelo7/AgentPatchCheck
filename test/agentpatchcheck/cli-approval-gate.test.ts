import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { getAssessmentReportPath } from "../../src/agentpatchcheck/assessment-report";
import { HEADLESS_CLI_CONTRACT_VERSION, type HeadlessCliResponse, runHeadlessCli } from "../../src/agentpatchcheck/cli";
import type { AssessmentReport, EvidenceBundle } from "../../src/agentpatchcheck/types";

const execFile = promisify(execFileCallback);

async function git(repository: string, args: string[]): Promise<void> {
	await execFile("git", args, { cwd: repository, windowsHide: true });
}

function trackedPatch(path: string, before: string, after: string): string {
	return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${before}\n+${after}\n`;
}

function createBundle(
	repository: string,
	baseCommit: string,
	path: string,
	patch: string,
	createdAt: string,
): EvidenceBundle {
	return {
		version: 1,
		createdAt,
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
			runId: path.replaceAll(/[^a-z]/gu, "") || "run",
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
			trackedPatch: patch,
			trackedPatchSha256: createHash("sha256").update(patch).digest("hex"),
		},
		result: { status: "succeeded", durationMs: 1 },
	};
}

async function writePassingAssessment(evidencePath: string, bundle: EvidenceBundle): Promise<void> {
	const report: AssessmentReport = {
		version: 1,
		createdAt: "2026-08-09T00:01:00.000Z",
		evidence: { path: evidencePath, createdAt: bundle.createdAt },
		gitPatchVerification: {
			status: "verified",
			evidencePath,
			worktreePath: bundle.workspace.path,
			checkedAt: "2026-08-09T00:01:00.000Z",
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

async function invoke(argv: string[]): Promise<{ response: HeadlessCliResponse<unknown>; exitCode: number }> {
	const output: string[] = [];
	const exitCodes: number[] = [];
	await runHeadlessCli(["node", "agentpatchcheck", ...argv], {
		write: (value) => output.push(value),
		setExitCode: (code) => exitCodes.push(code),
	});
	return {
		response: JSON.parse(output[0] ?? "{}") as HeadlessCliResponse<unknown>,
		exitCode: exitCodes[0] ?? 0,
	};
}

function expectFailure(
	result: { response: HeadlessCliResponse<unknown>; exitCode: number },
	command: string,
	code: string,
): void {
	expect(result).toMatchObject({
		exitCode: 1,
		response: { contractVersion: HEADLESS_CLI_CONTRACT_VERSION, command, ok: false, error: { code } },
	});
}

describe("CLI approval gate contract", () => {
	it("requires approval, permits an explicit approval, preserves rejection, and prohibits critical risk", async () => {
		const repository = await mkdtemp(join(tmpdir(), "agentpatchcheck-cli-approval-"));
		try {
			await writeFile(join(repository, "package.json"), "before\n");
			await writeFile(join(repository, ".env.production"), "before\n");
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

			const approvedPath = join(evidenceDirectory, "approved.json");
			const approved = createBundle(
				repository,
				baseCommit,
				"package.json",
				trackedPatch("package.json", "before", "after"),
				"2026-08-09T00:00:00.000Z",
			);
			await writeFile(approvedPath, JSON.stringify(approved), "utf8");
			await writePassingAssessment(approvedPath, approved);
			expectFailure(await invoke(["apply-plan", "--evidence", approvedPath]), "apply-plan", "apply-plan-blocked");
			expectFailure(
				await invoke(["apply", "--evidence", approvedPath, "--repository", repository, "--apply"]),
				"apply",
				"apply-blocked",
			);
			const approve = await invoke(["approve", "--evidence", approvedPath, "--reason", "reviewed"]);
			expect(approve).toMatchObject({
				exitCode: 0,
				response: { contractVersion: HEADLESS_CLI_CONTRACT_VERSION, command: "approve", ok: true, error: null },
			});
			expect((approve.response.data as { approval: { decision: string } }).approval.decision).toBe("approved");
			expect(await invoke(["apply-plan", "--evidence", approvedPath])).toMatchObject({
				response: {
					contractVersion: HEADLESS_CLI_CONTRACT_VERSION,
					command: "apply-plan",
					ok: true,
					data: { status: "ready", decision: "ready" },
					error: null,
				},
				exitCode: 0,
			});

			const rejectedPath = join(evidenceDirectory, "rejected.json");
			const rejected = createBundle(
				repository,
				baseCommit,
				"package.json",
				trackedPatch("package.json", "before", "after"),
				"2026-08-09T00:02:00.000Z",
			);
			await writeFile(rejectedPath, JSON.stringify(rejected), "utf8");
			await writePassingAssessment(rejectedPath, rejected);
			const reject = await invoke(["reject", "--evidence", rejectedPath, "--reason", "not approved"]);
			expect(reject).toMatchObject({
				exitCode: 0,
				response: { contractVersion: HEADLESS_CLI_CONTRACT_VERSION, command: "reject", ok: true, error: null },
			});
			expectFailure(await invoke(["apply-plan", "--evidence", rejectedPath]), "apply-plan", "apply-plan-blocked");
			expectFailure(
				await invoke(["apply", "--evidence", rejectedPath, "--repository", repository, "--apply"]),
				"apply",
				"apply-blocked",
			);

			const prohibitedPath = join(evidenceDirectory, "prohibited.json");
			const prohibited = createBundle(
				repository,
				baseCommit,
				".env.production",
				trackedPatch(".env.production", "before", "after"),
				"2026-08-09T00:03:00.000Z",
			);
			await writeFile(prohibitedPath, JSON.stringify(prohibited), "utf8");
			await writePassingAssessment(prohibitedPath, prohibited);
			const prohibitedApproval = await invoke(["approve", "--evidence", prohibitedPath]);
			expectFailure(prohibitedApproval, "approve", "apply-plan-blocked");
			expect(prohibitedApproval.response.data).toMatchObject({
				decision: "prohibited",
				risk: { blocksApply: true },
			});
		} finally {
			await rm(repository, { recursive: true, force: true });
		}
	});
});
