import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

import { DEFAULT_RISK_POLICY_CONFIGURATION } from "./risk-policy";
import type { RiskPolicyConfiguration, RiskPolicyInput } from "./types";

const RISK_PATH_PATTERN = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\/?$/u;

const riskPolicyConfigurationSchema = z
	.object({
		protectedPaths: z.array(z.string().regex(RISK_PATH_PATTERN)).max(128).optional(),
		sensitivePaths: z.array(z.string().regex(RISK_PATH_PATTERN)).max(128).optional(),
		maxChangedFiles: z.number().int().positive().optional(),
		maxTrackedPatchBytes: z.number().int().positive().optional(),
	})
	.strict();

const riskPolicyProfileSchema = z
	.object({
		version: z.literal(1),
		name: z.string().min(1).max(64),
		risk: riskPolicyConfigurationSchema,
	})
	.strict();

export type RiskPolicyProfile = z.infer<typeof riskPolicyProfileSchema>;

function assertPathInsideSpecDirectory(specDirectory: string, profilePath: string): void {
	if (isAbsolute(profilePath))
		throw new Error("TaskSpec riskPolicyProfile must be relative to the TaskSpec directory.");
	const relativePath = relative(specDirectory, resolve(specDirectory, profilePath));
	if (
		relativePath === "" ||
		relativePath === ".." ||
		relativePath.startsWith("../") ||
		relativePath.startsWith("..\\") ||
		isAbsolute(relativePath)
	)
		throw new Error("TaskSpec riskPolicyProfile must stay within the TaskSpec directory.");
}

function normalizePaths(paths: string[] | undefined): string[] {
	const normalizedPaths = (paths ?? []).map((path) => path.replaceAll("\\", "/"));
	for (const path of normalizedPaths) {
		if (path.split("/").some((segment) => segment === "." || segment === ".."))
			throw new Error("RiskPolicy Profile paths must be repository-relative and may not contain dot segments.");
	}
	return [...new Set(normalizedPaths)].sort();
}

function normalizeConfiguration(value: RiskPolicyProfile["risk"]): RiskPolicyConfiguration {
	const maxChangedFiles = value.maxChangedFiles ?? DEFAULT_RISK_POLICY_CONFIGURATION.maxChangedFiles;
	const maxTrackedPatchBytes = value.maxTrackedPatchBytes ?? DEFAULT_RISK_POLICY_CONFIGURATION.maxTrackedPatchBytes;
	if (maxChangedFiles > DEFAULT_RISK_POLICY_CONFIGURATION.maxChangedFiles)
		throw new Error("RiskPolicy Profile maxChangedFiles may not exceed the built-in safety limit.");
	if (maxTrackedPatchBytes > DEFAULT_RISK_POLICY_CONFIGURATION.maxTrackedPatchBytes)
		throw new Error("RiskPolicy Profile maxTrackedPatchBytes may not exceed the built-in safety limit.");
	return {
		protectedPaths: normalizePaths(value.protectedPaths),
		sensitivePaths: normalizePaths(value.sensitivePaths),
		maxChangedFiles,
		maxTrackedPatchBytes,
	};
}

export async function loadRiskPolicyProfile(specDirectory: string, profilePath: string): Promise<RiskPolicyInput> {
	assertPathInsideSpecDirectory(specDirectory, profilePath);
	const resolvedProfilePath = resolve(specDirectory, profilePath);
	let profileJson: string;
	let parsedJson: unknown;
	try {
		profileJson = await readFile(resolvedProfilePath, "utf8");
		parsedJson = JSON.parse(profileJson);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not read RiskPolicy Profile ${resolvedProfilePath}: ${message}`);
	}
	const parsed = riskPolicyProfileSchema.safeParse(parsedJson);
	if (!parsed.success) throw new Error(`Invalid RiskPolicy Profile ${resolvedProfilePath}: ${parsed.error.message}`);
	return {
		configuration: normalizeConfiguration(parsed.data.risk),
		profile: {
			path: resolvedProfilePath,
			name: parsed.data.name,
			sha256: createHash("sha256").update(profileJson, "utf8").digest("hex"),
		},
	};
}
