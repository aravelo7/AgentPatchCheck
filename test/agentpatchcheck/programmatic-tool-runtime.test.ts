import { describe, expect, it } from "vitest";

import { runProgrammaticToolComposition } from "../../src/agentpatchcheck/programmatic-tool-runtime";

describe("programmatic tool runtime", () => {
	it("composes dependent tool operations through the Harness dispatcher", async () => {
		const calls: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
		const result = await runProgrammaticToolComposition({
			code: `
const listing = await tools["list-directory"]({ path: "." });
const file = await tools["read-file"]({ path: listing.trim() });
console.log("inspected", listing.trim());
return { file };
`,
			tools: ["list-directory", "read-file"],
			dispatch: async (call) => {
				calls.push(call);
				return call.tool === "list-directory"
					? { ok: true, observation: "README.md" }
					: { ok: true, observation: "bounded contents" };
			},
		});

		expect(calls).toEqual([
			{ tool: "list-directory", arguments: { path: "." } },
			{ tool: "read-file", arguments: { path: "README.md" } },
		]);
		expect(result.dispatches).toBe(2);
		expect(result.observation).toContain("inspected README.md");
		expect(result.observation).toContain('"file": "bounded contents"');
	});

	it("lets model code handle a rejected nested tool without exposing Node globals", async () => {
		const result = await runProgrammaticToolComposition({
			code: `
let failure = "none";
try { await tools["read-file"]({ path: "missing" }); } catch (error) { failure = error.name; }
return { failure, processType: typeof process, requireType: typeof require };
`,
			tools: ["read-file"],
			dispatch: async () => ({ ok: false, observation: "Rejected by path safety" }),
		});

		expect(result.observation).toContain('"failure": "ToolCallError"');
		expect(result.observation).toContain('"processType": "undefined"');
		expect(result.observation).toContain('"requireType": "undefined"');
	});

	it("rejects output beyond the configured observation bound", async () => {
		await expect(
			runProgrammaticToolComposition({
				code: `return "123456";`,
				tools: [],
				dispatch: async () => ({ ok: true, observation: "unused" }),
				maxOutputBytes: 5,
			}),
		).rejects.toThrow("output exceeded 5 bytes");
	});
});
