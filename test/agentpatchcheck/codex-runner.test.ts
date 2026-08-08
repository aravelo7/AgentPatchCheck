import { describe, expect, it } from "vitest";

import { buildCodexLaunchPlan, terminateCodexProcess } from "../../src/agentpatchcheck/codex-runner";

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
				"--config",
				"sandbox_workspace_write.network_access=false",
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
			'"codex ^"exec^" ^"--json^" ^"--config^" ^"sandbox_workspace_write.network_access=false^" ^"--sandbox^" ^"workspace-write^" ^"-C^" ^"D:\\worktree^" ^"Update^ README^""',
		]);
	});

	it("terminates the complete Windows cmd shim process tree on timeout", () => {
		let childKilled = false;
		let treePid: number | undefined;
		const child = {
			pid: 42,
			kill: () => {
				childKilled = true;
				return true;
			},
		};
		terminateCodexProcess(child, "win32", (pid, callback) => {
			treePid = pid;
			callback();
		});

		expect(treePid).toBe(42);
		expect(childKilled).toBe(false);
	});

	it("uses direct process termination outside Windows", () => {
		let childKilled = false;
		const child = {
			pid: 42,
			kill: () => {
				childKilled = true;
				return true;
			},
		};
		terminateCodexProcess(child, "linux");

		expect(childKilled).toBe(true);
	});
});
