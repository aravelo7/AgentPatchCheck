import { describe, expect, it } from "vitest";

import {
	createPublicVerificationFeedback,
	runCommandVerification,
	runVerificationCommand,
} from "../../src/agentpatchcheck/command-verifier";
import { validateVerificationPolicy } from "../../src/agentpatchcheck/verification-policy";

describe("CommandVerifier", () => {
	it("runs authorized argv commands directly in the supplied worktree", async () => {
		const policy = validateVerificationPolicy({
			commands: [
				{
					command: process.execPath,
					args: ["-e", "process.stdout.write(process.cwd())"],
				},
			],
		});

		const result = await runCommandVerification(policy, process.cwd());

		expect(result.status).toBe("passed");
		expect(result.cwd).toBe(process.cwd());
		expect(result.commands[0]).toMatchObject({ exitCode: 0, timedOut: false, stdout: process.cwd() });
	});

	it.runIf(process.platform === "win32")("runs the bundled npm CLI without spawning npm.cmd directly", async () => {
		const result = await runCommandVerification(
			validateVerificationPolicy({ commands: [{ command: "npm", args: ["--version"] }] }),
			process.cwd(),
		);

		expect(result).toMatchObject({ status: "passed", commands: [{ command: "npm", exitCode: 0 }] });
		expect(result.commands[0]?.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/u);
	});

	it("stops after the first failed authorized command", async () => {
		const policy = validateVerificationPolicy({
			commands: [
				{ command: process.execPath, args: ["-e", "process.exit(3)"] },
				{ command: process.execPath, args: ["-e", 'process.stdout.write("must not run")'] },
			],
		});

		const result = await runCommandVerification(policy, process.cwd());

		expect(result.status).toBe("failed");
		expect(result.commands).toHaveLength(1);
		expect(result.commands[0]?.exitCode).toBe(3);
	});

	it("returns not-run when the policy has no authorized command", async () => {
		const result = await runCommandVerification(validateVerificationPolicy(undefined), process.cwd());

		expect(result).toEqual({ status: "not-run", cwd: process.cwd(), commands: [] });
	});

	it("bounds captured command output according to the policy", async () => {
		const policy = validateVerificationPolicy({
			outputLimitBytes: 4,
			commands: [{ command: process.execPath, args: ["-e", 'process.stdout.write("abcdef")'] }],
		});

		const result = await runCommandVerification(policy, process.cwd());

		expect(result.commands[0]?.stdout).toBe("abcd");
	});

	it("records an unstartable command as a failed command result", async () => {
		const command = "agentpatchcheck-command-that-does-not-exist";
		const policy = validateVerificationPolicy({ commands: [{ command }] });

		const result = await runCommandVerification(policy, process.cwd());

		expect(result.status).toBe("failed");
		expect(result.commands).toHaveLength(1);
		expect(result.commands[0]).toMatchObject({ command, exitCode: null, signal: null, timedOut: false });
		expect(result.commands[0]?.stderr.length).toBeGreaterThan(0);
	});

	it("does not expose credential-shaped environment variables to verification commands", async () => {
		const previous = process.env.DEEPSEEK_API_KEY;
		process.env.DEEPSEEK_API_KEY = "test-provider-secret";
		try {
			const result = await runVerificationCommand({
				command: {
					command: process.execPath,
					args: ["-e", "process.exit(process.env.DEEPSEEK_API_KEY ? 1 : 0)"],
					timeoutMs: 1_000,
				},
				cwd: process.cwd(),
				outputLimitBytes: 1_024,
			});

			expect(result).toMatchObject({ exitCode: 0, timedOut: false });
		} finally {
			if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
			else process.env.DEEPSEEK_API_KEY = previous;
		}
	});

	it("waits for an aborted Host command to exit before returning", async () => {
		const controller = new AbortController();
		const command = runVerificationCommand({
			command: {
				command: process.execPath,
				args: ["-e", "setInterval(() => process.stdout.write('still-running'), 20)"],
				timeoutMs: 10_000,
			},
			cwd: process.cwd(),
			outputLimitBytes: 1_024,
			signal: controller.signal,
		});
		await new Promise((resolve) => setTimeout(resolve, 30));
		controller.abort(new Error("agent wall timeout"));

		const result = await command;
		const outputAtReturn = result.stdout;
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toBe(outputAtReturn);
		expect(result.durationMs).toBeLessThan(10_000);
	});

	it("creates repair feedback without verifier output or command arguments", () => {
		const feedback = createPublicVerificationFeedback({
			status: "failed",
			cwd: process.cwd(),
			commands: [
				{
					command: process.execPath,
					args: ["-e", "process.stderr.write('API_KEY=secret')"],
					exitCode: 1,
					signal: null,
					stdout: "password=secret",
					stderr: "API_KEY=secret",
					durationMs: 1,
					timedOut: false,
				},
			],
		});

		expect(feedback).toMatchObject({ status: "failed", commands: [{ exitCode: 1, timedOut: false }] });
		expect(JSON.stringify(feedback)).not.toContain("secret");
		expect(JSON.stringify(feedback)).not.toContain("process.stderr.write");
	});
});
