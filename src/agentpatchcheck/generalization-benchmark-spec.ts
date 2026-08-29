import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

export type GeneralizationBenchmarkSplit = "development" | "validation" | "held-out";

export interface GeneralizationBenchmarkTask {
	id: string;
	family: string;
	split: GeneralizationBenchmarkSplit;
	repository: { id: string; root: string; baseCommit: string };
	taskSpec: { path: string; sha256: string };
}

export interface GeneralizationBenchmarkManifest {
	version: 1;
	id: string;
	manifestVersion: string;
	sourcePath: string;
	sourceSha256: string;
	tasks: GeneralizationBenchmarkTask[];
}

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/u;
const schema = z
	.object({
		version: z.literal(1),
		id: z.string().regex(idPattern),
		manifestVersion: z.string().min(1).max(64),
		tasks: z
			.array(
				z
					.object({
						id: z.string().regex(idPattern),
						family: z.string().regex(idPattern),
						split: z.enum(["development", "validation", "held-out"]),
						repository: z
							.object({
								id: z.string().regex(idPattern),
								root: z.string().min(1),
								baseCommit: z.string().min(1),
							})
							.strict(),
						taskSpec: z.string().min(1),
					})
					.strict(),
			)
			.min(1),
	})
	.strict()
	.superRefine((value, context) => {
		const ids = new Set<string>();
		for (const [index, task] of value.tasks.entries()) {
			if (ids.has(task.id))
				context.addIssue({ code: "custom", message: "Task ids must be unique.", path: ["tasks", index, "id"] });
			ids.add(task.id);
		}
	});

function resolveChild(root: string, input: string, label: string): string {
	if (isAbsolute(input)) throw new Error(`${label} must be relative to the manifest.`);
	const path = resolve(root, input);
	const child = relative(root, path);
	if (
		!child ||
		child === ".." ||
		child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
		isAbsolute(child)
	)
		throw new Error(`${label} must stay within the manifest directory.`);
	return path;
}

export async function loadGeneralizationBenchmarkManifest(path: string): Promise<GeneralizationBenchmarkManifest> {
	const sourcePath = resolve(path);
	const source = await readFile(sourcePath, "utf8");
	let json: unknown;
	try {
		json = JSON.parse(source);
	} catch (error) {
		throw new Error(
			`Could not parse GeneralizationBenchmarkManifest ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const parsed = schema.safeParse(json);
	if (!parsed.success)
		throw new Error(`Invalid GeneralizationBenchmarkManifest ${sourcePath}: ${parsed.error.message}`);
	const root = dirname(sourcePath);
	return {
		version: 1,
		id: parsed.data.id,
		manifestVersion: parsed.data.manifestVersion,
		sourcePath,
		sourceSha256: createHash("sha256").update(source).digest("hex"),
		tasks: await Promise.all(
			parsed.data.tasks.map(async (task) => {
				const taskSpecPath = resolveChild(root, task.taskSpec, "taskSpec");
				const taskSpec = await readFile(taskSpecPath, "utf8");
				return {
					id: task.id,
					family: task.family,
					split: task.split,
					repository: { ...task.repository, root: resolveChild(root, task.repository.root, "repository.root") },
					taskSpec: { path: taskSpecPath, sha256: createHash("sha256").update(taskSpec).digest("hex") },
				};
			}),
		),
	};
}
