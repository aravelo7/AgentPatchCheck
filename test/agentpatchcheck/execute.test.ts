import { describe, expect, it } from "vitest";

import { executeAgentPatchCheck } from "../../src/agentpatchcheck/execute";
import { validateTaskPolicy } from "../../src/agentpatchcheck/task-policy";

describe("executeAgentPatchCheck", () => {
	it("returns the agent result and collected patch from an isolated workspace", async () => {
		const policy = await validateTaskPolicy({
			repositoryRoot: process.cwd(),
			prompt: "Create a file",
			runId: "smoke-1",
		});
		const result = await executeAgentPatchCheck(policy, {
			createWorkspace: async () => ({
				runId: "smoke-1",
				repositoryPath: "D:\\repo",
				path: "D:\\repo\\.agentpatchcheck\\worktrees\\smoke-1",
				baseRef: "HEAD",
				baseCommit: "abc123",
			}),
			runAgent: async () => ({
				executable: "codex",
				args: ["exec"],
				exitCode: 0,
				signal: null,
				stdout: "done",
				stderr: "",
				durationMs: 12,
				timedOut: false,
			}),
			collectPatch: async () => ({
				changedFiles: ["README.md"],
				trackedPatch: "diff --git a/README.md b/README.md\n",
			}),
		});

		expect(result.status).toBe("succeeded");
		expect(result.workspace.path).toContain(".agentpatchcheck");
		expect(result.patch.changedFiles).toEqual(["README.md"]);
	});
});
