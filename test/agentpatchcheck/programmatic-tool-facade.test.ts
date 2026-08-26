import { describe, expect, it } from "vitest";

import {
	getProgrammaticToolFacade,
	mapProgrammaticToolFacadeCall,
	renderProgrammaticToolSdk,
} from "../../src/agentpatchcheck/programmatic-tool-facade";

describe("programmatic coding tool facade", () => {
	it("renders the DSH-style typed coding surface without APC-native mutation names", () => {
		const sdk = renderProgrammaticToolSdk(getProgrammaticToolFacade(true));

		expect(sdk).toContain('"read": {');
		expect(sdk).toContain('"edit": {');
		expect(sdk).toContain('"write": {');
		expect(sdk).toContain('"todo_write": {');
		expect(sdk).toContain(process.platform === "win32" ? '"pwsh": {' : '"bash": {');
		expect(sdk).toContain('"file_path": string');
		expect(sdk).toContain('"old_string": string');
		expect(sdk).toContain('"run_public_verification": {');
		expect(sdk).toContain("interface ToolOutputMap");
		expect(sdk).toContain('"lines": {');
		expect(sdk).toContain('"operation": "create" | "update"');
		expect(sdk).toContain("Promise<ToolOutputMap[K]>");
		expect(sdk).not.toContain("Promise<string>");
		expect(sdk).not.toContain("apply-edit");
		expect(sdk).not.toContain("create-file");
	});

	it("adapts DSH replace-all and todo progress calls", () => {
		expect(
			mapProgrammaticToolFacadeCall({
				tool: "edit",
				arguments: { file_path: "src/a.ts", old_string: "a", new_string: "b", replace_all: true },
			}),
		).toEqual({
			kind: "canonical",
			tool: "apply-edit",
			arguments: { path: "src/a.ts", expectedText: "a", replacementText: "b", replaceAll: true },
		});
		expect(
			mapProgrammaticToolFacadeCall({
				tool: "todo_write",
				arguments: { todos: [{ content: "Implement fix", status: "in_progress" }] },
			}),
		).toEqual({
			kind: "canonical",
			tool: "todo-write",
			arguments: { todos: [{ content: "Implement fix", status: "in_progress" }] },
		});
	});

	it("maps read, edit, and write to canonical APC Tool Executor calls", () => {
		expect(
			mapProgrammaticToolFacadeCall({ tool: "read", arguments: { file_path: "src/a.ts", offset: 4, limit: 10 } }),
		).toEqual({
			kind: "canonical",
			tool: "read-file",
			arguments: { path: "src/a.ts", offset: 4, limit: 10 },
		});
		expect(
			mapProgrammaticToolFacadeCall({
				tool: "edit",
				arguments: { file_path: "src/a.ts", old_string: "before", new_string: "after" },
			}),
		).toEqual({
			kind: "canonical",
			tool: "apply-edit",
			arguments: { path: "src/a.ts", expectedText: "before", replacementText: "after" },
		});
		expect(
			mapProgrammaticToolFacadeCall({ tool: "write", arguments: { file_path: "new.ts", content: "export {};\n" } }),
		).toEqual({
			kind: "canonical",
			tool: "write-file",
			arguments: { path: "new.ts", content: "export {};\n" },
		});
	});

	it("keeps public verification capability-dependent", () => {
		expect(getProgrammaticToolFacade(false).map((tool) => tool.name)).not.toContain("run_public_verification");
		expect(getProgrammaticToolFacade(true).map((tool) => tool.name)).toContain("run_public_verification");
	});
});
