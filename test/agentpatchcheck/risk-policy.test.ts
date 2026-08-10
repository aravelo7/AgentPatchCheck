import { describe, expect, it } from "vitest";

import { evaluateRiskPolicy } from "../../src/agentpatchcheck/risk-policy";
import type { EvidenceBundle } from "../../src/agentpatchcheck/types";

function bundle(files: string[], patch = ""): EvidenceBundle {
	return {
		version: 1,
		createdAt: "2026-08-08T00:00:00.000Z",
		policy: {
			repositoryRoot: "D:\\repo",
			baseRef: "HEAD",
			baseCommit: "base",
			worktreeRoot: "D:\\repo\\.agentpatchcheck",
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
		repository: { root: "D:\\repo", baseRef: "HEAD", baseCommit: "base" },
		workspace: {
			runId: "run",
			repositoryPath: "D:\\repo",
			path: "D:\\repo\\work",
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
		commandVerification: { status: "passed", cwd: "D:\\repo", commands: [] },
		patch: { changedFiles: files, trackedPatch: patch, trackedPatchSha256: "hash" },
		result: { status: "succeeded", durationMs: 1 },
	};
}

describe("evaluateRiskPolicy", () => {
	it("permits a small ordinary patch without approval", () => {
		const result = evaluateRiskPolicy(bundle(["src/value.ts"]), null);
		expect(result).toMatchObject({ level: "low", requiresApproval: false, blocksApply: false, findings: [] });
	});

	it("requires approval for protected build and dependency paths", () => {
		const result = evaluateRiskPolicy(bundle([".github/workflows/check.yml", "package-lock.json"]), null);
		expect(result).toMatchObject({ level: "high", requiresApproval: true, blocksApply: false });
		expect(result.findings.map((finding) => finding.code)).toEqual(
			expect.arrayContaining(["build-or-ci-change", "dependency-change"]),
		);
	});

	it("detects deleted or bypassed public tests", () => {
		const deleted = evaluateRiskPolicy(bundle(["test/unit/value.test.ts"], "deleted file mode 100644"), null);
		expect(deleted.findings.map((finding) => finding.code)).toContain("test-deleted");
		const bypass = evaluateRiskPolicy(bundle(["test/unit/value.test.ts"], "+describe.skip('nope', () => {})"), null);
		expect(bypass.findings.map((finding) => finding.code)).toContain("test-weakening-pattern");
	});

	it("prohibits sensitive path changes and non-passing hidden oracle", () => {
		const sensitive = evaluateRiskPolicy(bundle([".env.production"]), null);
		expect(sensitive).toMatchObject({ level: "critical", blocksApply: true });
		const oracleBundle = bundle(["src/value.ts"]);
		oracleBundle.hiddenOracle = {
			id: "oracle",
			kind: "hidden-oracle",
			status: "failed",
			durationMs: 1,
			exitCode: 1,
			signal: null,
			diagnostic: "failed",
		};
		const oracle = evaluateRiskPolicy(oracleBundle, null);
		expect(oracle.findings.map((finding) => finding.code)).toContain("hidden-oracle-failed");
		expect(oracle.blocksApply).toBe(true);
	});

	it("applies profile additions and stricter thresholds without replacing built-in rules", () => {
		const configured = bundle(["infra/release.yml", "deploy/secrets/key.txt"]);
		configured.policy.riskPolicy = {
			configuration: {
				protectedPaths: ["infra/"],
				sensitivePaths: ["deploy/secrets/"],
				maxChangedFiles: 2,
				maxTrackedPatchBytes: 100,
			},
			profile: { path: "D:\\harness\\risk.json", name: "strict", sha256: "a".repeat(64) },
		};
		const result = evaluateRiskPolicy(configured, null);
		expect(result.findings.map((finding) => finding.code)).toEqual(
			expect.arrayContaining(["profile-protected-path-change", "profile-sensitive-path-change"]),
		);
		expect(result.blocksApply).toBe(true);
	});
});
