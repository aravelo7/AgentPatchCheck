import { describe, expect, it } from "vitest";

import { HEADLESS_CLI_CONTRACT_VERSION, runHeadlessCli } from "../../src/agentpatchcheck/cli";

describe("Headless CLI contract", () => {
	it("returns a versioned JSON envelope and exit code 2 for invalid command arguments", async () => {
		const output: string[] = [];
		const exitCodes: number[] = [];
		await runHeadlessCli(["node", "agentpatchcheck", "show"], {
			write: (value) => output.push(value),
			setExitCode: (code) => exitCodes.push(code),
		});

		expect(output).toHaveLength(1);
		expect(JSON.parse(output[0] ?? "{}")).toEqual({
			contractVersion: HEADLESS_CLI_CONTRACT_VERSION,
			command: "show",
			ok: false,
			data: null,
			error: expect.objectContaining({ code: "invalid-arguments" }),
		});
		expect(exitCodes).toEqual([2]);
	});

	it("returns a versioned JSON envelope for an operation failure", async () => {
		const output: string[] = [];
		const exitCodes: number[] = [];
		await runHeadlessCli(["node", "agentpatchcheck", "show", "--evidence", "missing.json"], {
			write: (value) => output.push(value),
			setExitCode: (code) => exitCodes.push(code),
		});

		expect(JSON.parse(output[0] ?? "{}")).toEqual({
			contractVersion: HEADLESS_CLI_CONTRACT_VERSION,
			command: "show",
			ok: false,
			data: null,
			error: expect.objectContaining({ code: "operation-failed" }),
		});
		expect(exitCodes).toEqual([1]);
	});
});
