import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	createEvidenceBundle,
	getEvidenceBundlePath,
	writeEvidenceBundle,
} from "../../src/agentpatchcheck/evidence-bundle";
import { validateTaskPolicy } from "../../src/agentpatchcheck/task-policy";
import type { AgentPatchCheckExecutionResult } from "../../src/agentpatchcheck/types";

describe("EvidenceBundle", () => {
	it("captures execution evidence while redacting the prompt and credentials", async () => {
		const prompt = "Inspect API_KEY=super-secret-value";
		const policy = await validateTaskPolicy({
			repositoryRoot: process.cwd(),
			prompt,
			runId: "evidence-test",
		});
		const execution: AgentPatchCheckExecutionResult = {
			status: "failed",
			workspace: {
				runId: "evidence-test",
				repositoryPath: process.cwd(),
				path: join(process.cwd(), ".agentpatchcheck", "worktrees", "evidence-test"),
				baseRef: "HEAD",
				baseCommit: policy.baseCommit,
			},
			agent: {
				executable: "codex",
				args: ["exec", `cmd.exe /c Do^ not^ run^ ${prompt}`],
				exitCode: 1,
				signal: null,
				stdout: `Bearer abcdefghijklmnop ${prompt}`,
				stderr: "password=super-secret-value",
				durationMs: 42,
				timedOut: false,
			},
			patch: {
				changedFiles: ["README.md"],
				trackedPatch: "diff --git a/README.md b/README.md\n",
			},
			commandVerification: {
				status: "not-run",
				cwd: join(process.cwd(), ".agentpatchcheck", "worktrees", "evidence-test"),
				commands: [],
			},
		};

		const bundle = createEvidenceBundle({
			policy,
			execution,
			createdAt: new Date("2026-08-07T00:00:00.000Z"),
		});
		const serialized = JSON.stringify(bundle);

		expect(bundle.policy.promptLength).toBe(prompt.length);
		expect(bundle.policy.promptSha256).toMatch(/^[a-f0-9]{64}$/u);
		expect(bundle.result).toEqual({ status: "failed", durationMs: 42 });
		expect(serialized).not.toContain("super-secret-value");
		expect(serialized).not.toContain("abcdefghijklmnop");
		expect(serialized).toContain("[REDACTED_PROMPT]");
		expect(serialized).toContain("[REDACTED_SECRET]");
	});

	it("writes the bundle atomically outside the worktree", async () => {
		const evidenceRoot = await mkdtemp(join(tmpdir(), "agentpatchcheck-evidence-"));
		try {
			const path = getEvidenceBundlePath(join(evidenceRoot, "worktrees"), "run-1");
			const reference = await writeEvidenceBundle({
				path,
				bundle: {
					version: 1,
					createdAt: "2026-08-07T00:00:00.000Z",
					policy: {
						repositoryRoot: "D:\\repo",
						baseRef: "HEAD",
						baseCommit: "abc123",
						worktreeRoot: join(evidenceRoot, "worktrees"),
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
						patchExpectation: "changes-required",
					},
					repository: { root: "D:\\repo", baseRef: "HEAD", baseCommit: "abc123" },
					workspace: {
						runId: "run-1",
						repositoryPath: "D:\\repo",
						path: join(evidenceRoot, "worktrees", "run-1"),
						baseRef: "HEAD",
						baseCommit: "abc123",
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
					patch: {
						changedFiles: [],
						trackedPatch: "",
						trackedPatchSha256: "hash",
					},
					commandVerification: {
						status: "not-run",
						cwd: join(evidenceRoot, "worktrees", "run-1"),
						commands: [],
					},
					result: { status: "succeeded", durationMs: 1 },
				},
			});

			expect(reference.path).toBe(path);
			expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
				version: 1,
				result: { status: "succeeded" },
			});
		} finally {
			await rm(evidenceRoot, { recursive: true, force: true });
		}
	});
});
