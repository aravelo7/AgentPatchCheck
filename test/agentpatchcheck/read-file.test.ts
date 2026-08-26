import { describe, expect, it } from "vitest";

import { buildReadFileWindow, parseReadFileArguments, READ_FILE_MAX_LINES } from "../../src/agentpatchcheck/read-file";

async function* chunks(...values: string[]): AsyncIterable<string> {
	for (const value of values) yield value;
}

describe("bounded read-file windows", () => {
	it("keeps path-only calls backward compatible", () => {
		expect(parseReadFileArguments({ path: "README.md" })).toEqual({
			path: "README.md",
			offset: 1,
			limit: READ_FILE_MAX_LINES,
		});
	});

	it("validates positive integer window arguments and the line cap", () => {
		expect(parseReadFileArguments({ path: "a.ts", offset: 4, limit: 20 })).toEqual({
			path: "a.ts",
			offset: 4,
			limit: 20,
		});
		expect(() => parseReadFileArguments({ path: "a.ts", offset: 0 })).toThrow("positive integer");
		expect(() => parseReadFileArguments({ path: "a.ts", limit: 1.5 })).toThrow("positive integer");
		expect(() => parseReadFileArguments({ path: "a.ts", limit: READ_FILE_MAX_LINES + 1 })).toThrow(
			`at most ${READ_FILE_MAX_LINES}`,
		);
	});

	it("numbers an offset window consistently across stream chunks", async () => {
		const window = await buildReadFileWindow(
			chunks("one\nt", "wo\nthree\nfour"),
			{ offset: 2, limit: 2 },
			50_000,
			"a.ts",
		);
		expect(window).toEqual({
			offset: 2,
			limit: 2,
			lines: [
				{ number: 2, text: "two" },
				{ number: 3, text: "three" },
			],
			totalLines: 4,
			truncatedByBytes: false,
		});
	});

	it("caps selected UTF-8 bytes while still counting total lines", async () => {
		const window = await buildReadFileWindow(chunks("aaaa\nbbbb\ncccc"), { offset: 1, limit: 10 }, 9, "a.ts");
		expect(window.lines).toEqual([
			{ number: 1, text: "aaaa" },
			{ number: 2, text: "bbbb" },
		]);
		expect(window.totalLines).toBe(3);
		expect(window.truncatedByBytes).toBe(true);
	});

	it("rejects offsets beyond EOF but permits an empty file at offset one", async () => {
		await expect(buildReadFileWindow(chunks(""), { offset: 1, limit: 10 }, 100, "empty.txt")).resolves.toMatchObject({
			lines: [],
			totalLines: 0,
		});
		await expect(buildReadFileWindow(chunks("one\ntwo"), { offset: 3, limit: 1 }, 100, "a.ts")).rejects.toThrow(
			'offset 3 is out of range for "a.ts" (2 lines)',
		);
	});
});
