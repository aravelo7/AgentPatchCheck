import { describe, expect, it } from "vitest";

import { decidePatchVerdict } from "../../src/agentpatchcheck/patch-verdict";
import type { EvidenceBundle, GitPatchVerification, PatchExpectation } from "../../src/agentpatchcheck/types";

function createBundle(
	changedFiles: string[] = ["README.md"],
): Pick<EvidenceBundle, "agent" | "patch" | "result" | "commandVerification" | "hiddenOracle"> {
	return {
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
			changedFiles,
			trackedPatch: "diff --git a/README.md b/README.md\n",
			trackedPatchSha256: "hash",
		},
		result: { status: "succeeded", durationMs: 1 },
		commandVerification: {
			status: "not-run",
			cwd: "D:\\repo\\.agentpatchcheck\\worktrees\\run-1",
			commands: [],
		},
	};
}

function createVerification(status: GitPatchVerification["status"] = "verified"): GitPatchVerification {
	return {
		status,
		evidencePath: "D:\\evidence\\run-1.json",
		worktreePath: "D:\\repo\\.agentpatchcheck\\worktrees\\run-1",
		checkedAt: "2026-08-07T00:00:00.000Z",
		durationMs: 1,
		checks: {
			worktreeExists: status === "verified",
			headMatchesBaseCommit: status === "verified",
			changedFilesMatch: status === "verified",
			trackedPatchMatches: status === "verified",
			unrecordedUntrackedFiles: [],
		},
		failures: status === "verified" ? [] : ["Worktree does not exist."],
	};
}

function decide(
	options: {
		bundle?: Pick<EvidenceBundle, "agent" | "patch" | "result" | "commandVerification" | "hiddenOracle">;
		verification?: GitPatchVerification;
		expectation?: PatchExpectation;
	} = {},
) {
	return decidePatchVerdict({
		bundle: options.bundle ?? createBundle(),
		verification: options.verification ?? createVerification(),
		expectation: options.expectation ?? "changes-required",
	});
}

describe("PatchVerdict", () => {
	it("passes a verified successful run with a required patch", () => {
		expect(decide()).toMatchObject({ status: "pass", reasonCodes: [] });
	});

	it("fails when Git verification did not confirm the evidence", () => {
		expect(decide({ verification: createVerification("failed") })).toMatchObject({
			status: "fail",
			reasonCodes: ["git-verification-failed"],
		});
	});

	it("fails a timed-out or unsuccessful agent execution", () => {
		const timedOut = createBundle();
		timedOut.agent.timedOut = true;
		const unsuccessful = createBundle();
		unsuccessful.agent.exitCode = 1;
		unsuccessful.result.status = "failed";

		expect(decide({ bundle: timedOut })).toMatchObject({
			status: "fail",
			reasonCodes: ["agent-timed-out"],
		});
		expect(decide({ bundle: unsuccessful })).toMatchObject({
			status: "fail",
			reasonCodes: ["agent-failed"],
		});
	});

	it("is inconclusive only when a task required changes but recorded none", () => {
		expect(decide({ bundle: createBundle([]) })).toMatchObject({
			status: "inconclusive",
			reasonCodes: ["changes-required-but-none-recorded"],
		});
		expect(decide({ bundle: createBundle([]), expectation: "changes-optional" })).toMatchObject({
			status: "pass",
			reasonCodes: [],
		});
	});

	it("fails when an authorized verification command fails", () => {
		const bundle = createBundle();
		bundle.commandVerification.status = "failed";

		expect(decide({ bundle })).toMatchObject({
			status: "fail",
			reasonCodes: ["command-verification-failed"],
		});
	});

	it("distinguishes a rejected patch from Hidden Oracle infrastructure failure", () => {
		const rejected = createBundle();
		rejected.hiddenOracle = {
			id: "hidden-oracle",
			kind: "hidden-oracle",
			status: "failed",
			durationMs: 1,
			exitCode: 1,
			signal: null,
			diagnostic: "Hidden Oracle rejected the patch.",
		};
		const infrastructureFailure = createBundle();
		infrastructureFailure.hiddenOracle = { ...rejected.hiddenOracle, status: "error", exitCode: 2 };

		expect(decide({ bundle: rejected })).toMatchObject({
			status: "fail",
			reasonCodes: ["hidden-oracle-failed"],
		});
		expect(decide({ bundle: infrastructureFailure })).toMatchObject({
			status: "fail",
			reasonCodes: ["hidden-oracle-error"],
		});
	});
});
