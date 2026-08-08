import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadTaskSpec } from "../../src/agentpatchcheck/task-spec";

describe("TaskSpec", () => {
	it("loads a strict local specification and resolves its prompt file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agentpatchcheck-task-spec-"));
		try {
			await writeFile(join(directory, "prompt.txt"), "Inspect the requested change.", "utf8");
			const specPath = join(directory, "task.json");
			await writeFile(
				specPath,
				JSON.stringify({
					version: 1,
					repositoryRoot: process.cwd(),
					promptFile: "prompt.txt",
					patchExpectation: "changes-required",
					verification: {
						commands: [{ command: process.execPath, args: ["--version"], timeoutMs: 1_000 }],
					},
				}),
				"utf8",
			);

			const input = await loadTaskSpec(specPath);

			expect(input).toMatchObject({
				repositoryRoot: process.cwd(),
				prompt: "Inspect the requested change.",
				patchExpectation: "changes-required",
				verification: { commands: [{ command: process.execPath, args: ["--version"], timeoutMs: 1_000 }] },
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("rejects unknown fields and prompt files outside the TaskSpec directory", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agentpatchcheck-task-spec-"));
		try {
			const unknownFieldPath = join(directory, "unknown.json");
			await writeFile(
				unknownFieldPath,
				JSON.stringify({
					version: 1,
					repositoryRoot: process.cwd(),
					prompt: "Inspect.",
					patchExpectation: "changes-required",
					unexpected: true,
				}),
				"utf8",
			);
			const escapingPromptPath = join(directory, "escaping-prompt.json");
			await writeFile(
				escapingPromptPath,
				JSON.stringify({
					version: 1,
					repositoryRoot: process.cwd(),
					promptFile: "../outside.txt",
					patchExpectation: "changes-required",
				}),
				"utf8",
			);

			await expect(loadTaskSpec(unknownFieldPath)).rejects.toThrow("Invalid TaskSpec");
			await expect(loadTaskSpec(escapingPromptPath)).rejects.toThrow("must stay within");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
