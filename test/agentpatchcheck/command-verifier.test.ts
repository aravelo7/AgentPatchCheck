import { describe, expect, it } from "vitest";

import { runCommandVerification } from "../../src/agentpatchcheck/command-verifier";
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
});
