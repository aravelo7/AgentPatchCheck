import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

import type { BenchmarkDefinition } from "./types";

const TASK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;

const benchmarkSpecSchema = z
	.object({
		version: z.literal(1),
		name: z.string().min(1).max(128).optional(),
		tasks: z.array(z.object({ id: z.string().regex(TASK_ID_PATTERN), taskSpec: z.string().min(1) }).strict()).min(1),
	})
	.strict()
	.superRefine((spec, context) => {
		const taskIds = new Set<string>();
		for (const [index, task] of spec.tasks.entries()) {
			if (taskIds.has(task.id)) {
				context.addIssue({
					code: z.ZodIssueCode.custom,
					message: "Benchmark task ids must be unique.",
					path: ["tasks", index, "id"],
				});
			}
			taskIds.add(task.id);
		}
	});

function isPathWithinDirectory(directory: string, candidate: string): boolean {
	const candidateRelativePath = relative(directory, candidate);
	return (
		candidateRelativePath !== "" &&
		candidateRelativePath !== ".." &&
		!candidateRelativePath.startsWith("..\\") &&
		!candidateRelativePath.startsWith("../") &&
		!isAbsolute(candidateRelativePath)
	);
}

export async function loadBenchmarkSpec(specPath: string): Promise<BenchmarkDefinition> {
	const sourcePath = resolve(specPath);
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(await readFile(sourcePath, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read BenchmarkSpec ${sourcePath}: ${message}`);
	}
	const parsed = benchmarkSpecSchema.safeParse(parsedJson);
	if (!parsed.success) throw new Error(`Invalid BenchmarkSpec ${sourcePath}: ${parsed.error.message}`);
	const sourceDirectory = dirname(sourcePath);
	return {
		version: 1,
		sourcePath,
		name: parsed.data.name ?? null,
		tasks: parsed.data.tasks.map((task) => {
			if (isAbsolute(task.taskSpec))
				throw new Error("Benchmark taskSpec paths must be relative to the BenchmarkSpec directory.");
			const taskSpecPath = resolve(sourceDirectory, task.taskSpec);
			if (!isPathWithinDirectory(sourceDirectory, taskSpecPath))
				throw new Error("Benchmark taskSpec paths must stay within the BenchmarkSpec directory.");
			return { id: task.id, taskSpecPath };
		}),
	};
}
