import { describe, expect, it } from "vitest";

import { buildCodexLaunchPlan } from "../../src/agentpatchcheck/codex-runner";

describe("buildCodexLaunchPlan", () => {
	it("uses a direct executable on Unix", () => {
		const plan = buildCodexLaunchPlan({
			platform: "linux",
			cwd: "/tmp/run",
			prompt: "Update README",
			model: "gpt-5.4",
		});

		expect(plan).toEqual({
			executable: "codex",
			args: [
				"exec",
				"--json",
				"--model",
				"gpt-5.4",
				"--sandbox",
				"workspace-write",
				"-C",
				"/tmp/run",
				"Update README",
			],
		});
	});

	it("uses cmd.exe only as the Windows npm shim bridge", () => {
		const plan = buildCodexLaunchPlan({
			platform: "win32",
			env: {
				ComSpec: "C:\\Windows\\System32\\cmd.exe",
				PATH: "",
			},
			cwd: "D:\\worktree",
			prompt: "Update README",
		});

		expect(plan.executable).toBe("C:\\Windows\\System32\\cmd.exe");
		expect(plan.windowsVerbatimArguments).toBe(true);
		expect(plan.args).toEqual([
			"/d",
			"/s",
			"/c",
			'"codex ^"exec^" ^"--json^" ^"--sandbox^" ^"workspace-write^" ^"-C^" ^"D:\\worktree^" ^"Update^ README^""',
		]);
	});
});
