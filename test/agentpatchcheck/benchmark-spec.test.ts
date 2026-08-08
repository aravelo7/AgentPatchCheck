import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadBenchmarkSpec } from "../../src/agentpatchcheck/benchmark-spec";

describe("BenchmarkSpec", () => {
	it("loads unique relative task spec references", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agentpatchcheck-benchmark-spec-"));
		try {
			const specPath = join(directory, "benchmark.json");
			await writeFile(
				specPath,
				JSON.stringify({
					version: 1,
					name: "smoke",
					tasks: [
						{ id: "first", taskSpec: "tasks/first.json" },
						{ id: "second", taskSpec: "tasks/second.json" },
					],
				}),
				"utf8",
			);

			const result = await loadBenchmarkSpec(specPath);

			expect(result).toMatchObject({ version: 1, sourcePath: specPath, name: "smoke" });
			expect(result.tasks).toEqual([
				{ id: "first", taskSpecPath: join(directory, "tasks", "first.json") },
				{ id: "second", taskSpecPath: join(directory, "tasks", "second.json") },
			]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("rejects duplicate task ids and task specs outside the benchmark directory", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agentpatchcheck-benchmark-spec-"));
		try {
			const duplicatePath = join(directory, "duplicate.json");
			await writeFile(
				duplicatePath,
				JSON.stringify({
					version: 1,
					tasks: [
						{ id: "same", taskSpec: "a.json" },
						{ id: "same", taskSpec: "b.json" },
					],
				}),
				"utf8",
			);
			const escapedPath = join(directory, "escaped.json");
			await writeFile(
				escapedPath,
				JSON.stringify({ version: 1, tasks: [{ id: "escaped", taskSpec: "../task.json" }] }),
				"utf8",
			);

			await expect(loadBenchmarkSpec(duplicatePath)).rejects.toThrow("must be unique");
			await expect(loadBenchmarkSpec(escapedPath)).rejects.toThrow("must stay within");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
