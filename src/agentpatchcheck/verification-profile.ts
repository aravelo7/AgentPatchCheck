import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

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
		name: z.string().min(1).max(64),
		verification: verificationPolicyInputSchema,
	})
	.strict();

export type VerificationProfile = z.infer<typeof verificationProfileSchema>;

export interface LoadedVerificationProfile {
	verification: VerificationPolicyInput;
	reference: VerificationProfileReference;
}

const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function getVerificationProfilePath(repositoryRoot: string, profileName: string): string {
	const normalizedProfileName = profileName.trim();
	if (!PROFILE_NAME_PATTERN.test(normalizedProfileName)) {
		throw new Error("Verification profile name must contain 1-64 letters, numbers, underscores, or hyphens.");
	}
	return join(resolve(repositoryRoot), ".agentpatchcheck", "profiles", `${normalizedProfileName}.json`);
}

export async function loadVerificationProfile(
	repositoryRoot: string,
	profileName: string,
): Promise<LoadedVerificationProfile> {
	const resolvedProfilePath = getVerificationProfilePath(repositoryRoot, profileName);
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
	if (parsed.data.name !== profileName) {
		throw new Error(`Verification profile name does not match its catalog entry: ${resolvedProfilePath}`);
	}
	return {
		verification: parsed.data.verification,
		reference: {
			path: resolvedProfilePath,
			name: parsed.data.name,
			sha256: createHash("sha256").update(profileJson, "utf8").digest("hex"),
		},
	};
}
