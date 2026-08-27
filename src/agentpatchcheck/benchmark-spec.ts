import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

import type { BenchmarkDefinition } from "./types";

const TASK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,39}$/;
const benchmarkTaskStatuses = [
	"passed",
	"timed-out",
	"agent-failed",
	"verification-failed",
	"hidden-oracle-failed",
	"hidden-oracle-error",
	"assessment-failed",
	"setup-failed",
] as const;

const benchmarkSpecSchema = z
	.object({
		version: z.literal(1),
		name: z.string().min(1).max(128).optional(),
		variant: z.string().min(1).max(128).optional(),
		attempt: z.number().int().min(1).max(9_999).optional(),
		suite: z
			.object({ id: z.string().regex(TASK_ID_PATTERN), fixtureVersion: z.string().min(1).max(128) })
			.strict()
			.optional(),
		tasks: z
			.array(
				z
					.object({
						id: z.string().regex(TASK_ID_PATTERN),
						taskSpec: z.string().min(1),
						expectedStatus: z.enum(benchmarkTaskStatuses).optional(),
					})
					.strict(),
			)
			.min(1),
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
	let sourceJson: string;
	let parsedJson: unknown;
	try {
		sourceJson = await readFile(sourcePath, "utf8");
		parsedJson = JSON.parse(sourceJson);
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
		sourceSha256: createHash("sha256").update(sourceJson, "utf8").digest("hex"),
		name: parsed.data.name ?? null,
		suite: parsed.data.suite ?? null,
		variant: parsed.data.variant,
		attempt: parsed.data.attempt,
		tasks: await Promise.all(
			parsed.data.tasks.map(async (task) => {
				if (isAbsolute(task.taskSpec))
					throw new Error("Benchmark taskSpec paths must be relative to the BenchmarkSpec directory.");
				const taskSpecPath = resolve(sourceDirectory, task.taskSpec);
				if (!isPathWithinDirectory(sourceDirectory, taskSpecPath))
					throw new Error("Benchmark taskSpec paths must stay within the BenchmarkSpec directory.");
				let taskSpecJson: string;
				try {
					taskSpecJson = await readFile(taskSpecPath, "utf8");
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					throw new Error(`Could not read Benchmark taskSpec ${taskSpecPath}: ${message}`);
				}
				return {
					id: task.id,
					taskSpecPath,
					taskSpecSha256: createHash("sha256").update(taskSpecJson, "utf8").digest("hex"),
					expectedStatus: task.expectedStatus ?? null,
				};
			}),
		),
	};
}
