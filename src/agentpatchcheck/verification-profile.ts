import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { z } from "zod";

import type { VerificationPolicyInput, VerificationProfileReference } from "./types";

export const verificationCommandSchema = z
	.object({
		command: z.string(),
		args: z.array(z.string()).optional(),
		timeoutMs: z.number().int().optional(),
	})
	.strict();

export const verificationPolicyInputSchema = z
	.object({
		commands: z.array(verificationCommandSchema).optional(),
		outputLimitBytes: z.number().int().optional(),
	})
	.strict();

const verificationProfileSchema = z
	.object({
		version: z.literal(1),
		name: z.string().min(1).max(128).optional(),
		verification: verificationPolicyInputSchema,
	})
	.strict();

export type VerificationProfile = z.infer<typeof verificationProfileSchema>;

export interface LoadedVerificationProfile {
	verification: VerificationPolicyInput;
	reference: VerificationProfileReference;
}

export async function loadVerificationProfile(
	taskSpecDirectory: string,
	profilePath: string,
): Promise<LoadedVerificationProfile> {
	if (isAbsolute(profilePath)) {
		throw new Error("TaskSpec verificationProfile must be relative to the TaskSpec directory.");
	}
	const resolvedProfilePath = resolve(taskSpecDirectory, profilePath);
	let profileJson: string;
	let parsedJson: unknown;
	try {
		profileJson = await readFile(resolvedProfilePath, "utf8");
		parsedJson = JSON.parse(profileJson);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read verification profile ${resolvedProfilePath}: ${message}`);
	}
	const parsed = verificationProfileSchema.safeParse(parsedJson);
	if (!parsed.success) {
		throw new Error(`Invalid verification profile ${resolvedProfilePath}: ${parsed.error.message}`);
	}
	return {
		verification: parsed.data.verification,
		reference: {
			path: resolvedProfilePath,
			name: parsed.data.name ?? null,
			sha256: createHash("sha256").update(profileJson, "utf8").digest("hex"),
		},
	};
}
