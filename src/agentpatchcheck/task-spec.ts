import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

import type { TaskPolicyInput } from "./types";
import { loadVerificationProfile, verificationPolicyInputSchema } from "./verification-profile";

const taskSpecSchema = z
	.object({
		version: z.literal(1),
		repositoryRoot: z.string(),
		prompt: z.string().optional(),
		promptFile: z.string().optional(),
		baseRef: z.string().optional(),
		worktreeRoot: z.string().optional(),
		runId: z.string().optional(),
		codexExecutable: z.string().optional(),
		model: z.string().optional(),
		timeoutMs: z.number().int().optional(),
		sandbox: z.enum(["read-only", "workspace-write"]).optional(),
		allowNetwork: z.boolean().optional(),
		patchExpectation: z.enum(["changes-required", "changes-optional"]),
		verification: verificationPolicyInputSchema.optional(),
		verificationProfile: z.string().optional(),
	})
	.strict()
	.superRefine((spec, context) => {
		if (Boolean(spec.prompt) === Boolean(spec.promptFile)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "TaskSpec must contain exactly one of prompt or promptFile.",
				path: ["prompt"],
			});
		}
		if (spec.verification !== undefined && spec.verificationProfile !== undefined) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: "TaskSpec must not define both verification and verificationProfile.",
				path: ["verification"],
			});
		}
	});

export type TaskSpec = z.infer<typeof taskSpecSchema>;

function resolveFromSpecDirectory(specDirectory: string, value: string): string {
	return resolve(specDirectory, value);
}

function isPathWithinDirectory(directory: string, candidate: string): boolean {
	const candidateRelativePath = relative(directory, candidate);
	return (
		candidateRelativePath !== "" &&
		candidateRelativePath !== ".." &&
		!candidateRelativePath.startsWith(`..\\`) &&
		!candidateRelativePath.startsWith("../") &&
		!isAbsolute(candidateRelativePath)
	);
}

function resolveExecutable(specDirectory: string, executable: string | undefined): string | undefined {
	if (executable === undefined) {
		return undefined;
	}
	return executable.includes("/") || executable.includes("\\") || executable.startsWith(".")
		? resolveFromSpecDirectory(specDirectory, executable)
		: executable;
}

async function readPromptFile(specDirectory: string, promptFile: string): Promise<string> {
	if (isAbsolute(promptFile)) {
		throw new Error("TaskSpec promptFile must be relative to the TaskSpec directory.");
	}
	const promptPath = resolveFromSpecDirectory(specDirectory, promptFile);
	if (!isPathWithinDirectory(specDirectory, promptPath)) {
		throw new Error("TaskSpec promptFile must stay within the TaskSpec directory.");
	}
	const promptStat = await stat(promptPath);
	if (!promptStat.isFile()) {
		throw new Error(`TaskSpec promptFile is not a file: ${promptPath}`);
	}
	return await readFile(promptPath, "utf8");
}

export async function loadTaskSpec(specPath: string): Promise<TaskPolicyInput> {
	const resolvedSpecPath = resolve(specPath);
	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(await readFile(resolvedSpecPath, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read TaskSpec ${resolvedSpecPath}: ${message}`);
	}
	const parsed = taskSpecSchema.safeParse(parsedJson);
	if (!parsed.success) {
		throw new Error(`Invalid TaskSpec ${resolvedSpecPath}: ${parsed.error.message}`);
	}
	const specDirectory = dirname(resolvedSpecPath);
	const prompt = parsed.data.prompt ?? (await readPromptFile(specDirectory, parsed.data.promptFile ?? ""));
	const loadedVerificationProfile =
		parsed.data.verificationProfile === undefined
			? undefined
			: await loadVerificationProfile(specDirectory, parsed.data.verificationProfile);

	return {
		repositoryRoot: resolveFromSpecDirectory(specDirectory, parsed.data.repositoryRoot),
		prompt,
		baseRef: parsed.data.baseRef,
		worktreeRoot:
			parsed.data.worktreeRoot === undefined
				? undefined
				: resolveFromSpecDirectory(specDirectory, parsed.data.worktreeRoot),
		runId: parsed.data.runId,
		codexExecutable: resolveExecutable(specDirectory, parsed.data.codexExecutable),
		model: parsed.data.model,
		timeoutMs: parsed.data.timeoutMs,
		sandbox: parsed.data.sandbox,
		allowNetwork: parsed.data.allowNetwork,
		patchExpectation: parsed.data.patchExpectation,
		verification: loadedVerificationProfile?.verification ?? parsed.data.verification,
		verificationProfile: loadedVerificationProfile?.reference,
	};
}
