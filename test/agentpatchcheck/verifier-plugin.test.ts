import { describe, expect, it } from "vitest";

import { summarizeCommandVerification } from "../../src/agentpatchcheck/verifier-plugin";

describe("Verifier Plugin result model", () => {
	it("maps public command verification outcomes to stable plugin statuses", () => {
		expect(summarizeCommandVerification({ status: "not-run", cwd: "D:\\repo", commands: [] })).toMatchObject({
			id: "command-verification",
			kind: "command",
			status: "not-run",
		});
		expect(
			summarizeCommandVerification({
				status: "failed",
				cwd: "D:\\repo",
				commands: [
					{
						command: "verify",
						args: [],
						exitCode: null,
						signal: null,
						stdout: "",
						stderr: "spawn failed",
						durationMs: 1,
						timedOut: false,
					},
				],
			}),
		).toMatchObject({ status: "error", diagnostic: "Verification command could not start." });
	});
});
