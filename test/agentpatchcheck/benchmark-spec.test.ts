import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadBenchmarkSpec } from "../../src/agentpatchcheck/benchmark-spec";

describe("BenchmarkSpec", () => {
	it("loads unique relative task spec references", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agentpatchcheck-benchmark-spec-"));
		try {
			const specPath = join(directory, "benchmark.json");
			await mkdir(join(directory, "tasks"));
			await writeFile(join(directory, "tasks", "first.json"), '{"version":1}', "utf8");
			await writeFile(join(directory, "tasks", "second.json"), '{"version":1}', "utf8");
			await writeFile(
				specPath,
				JSON.stringify({
					version: 1,
					name: "smoke",
					suite: { id: "smoke-suite", fixtureVersion: "fixture-v1" },
					tasks: [
						{ id: "first", taskSpec: "tasks/first.json", expectedStatus: "passed" },
						{ id: "second", taskSpec: "tasks/second.json" },
					],
				}),
				"utf8",
			);

			const result = await loadBenchmarkSpec(specPath);

			expect(result).toMatchObject({
				version: 1,
				sourcePath: specPath,
				name: "smoke",
				suite: { id: "smoke-suite", fixtureVersion: "fixture-v1" },
			});
			expect(result.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
			expect(result.tasks).toMatchObject([
				{ id: "first", taskSpecPath: join(directory, "tasks", "first.json"), expectedStatus: "passed" },
				{ id: "second", taskSpecPath: join(directory, "tasks", "second.json"), expectedStatus: null },
			]);
			for (const task of result.tasks) expect(task.taskSpecSha256).toMatch(/^[a-f0-9]{64}$/);
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
