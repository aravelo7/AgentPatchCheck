import { createHash } from "node:crypto";

const RUN_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const LABEL_PATTERN = /[^a-z0-9]+/gu;

export interface RunIdentity {
	version: 1;
	experiment: string;
	task: string;
	variant: string;
	attempt: number;
	repository: string | null;
	baseCommit: string | null;
	model: string | null;
	benchmark: string | null;
}

export interface RunIdentityInput
	extends Omit<RunIdentity, "version" | "repository" | "baseCommit" | "model" | "benchmark"> {
	repository?: string | null;
	baseCommit?: string | null;
	model?: string | null;
	benchmark?: string | null;
}

function required(value: string, name: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`Run identity ${name} is required.`);
	return normalized;
}

function optional(value: string | null | undefined): string | null {
	if (value === undefined || value === null) return null;
	return required(value, "metadata");
}

export function normalizeRunIdentity(input: RunIdentityInput): RunIdentity {
	if (!Number.isSafeInteger(input.attempt) || input.attempt < 1 || input.attempt > 9_999)
		throw new Error("Run identity attempt must be an integer from 1 through 9999.");
	return {
		version: 1,
		experiment: required(input.experiment, "experiment"),
		task: required(input.task, "task"),
		variant: required(input.variant, "variant"),
		attempt: input.attempt,
		repository: optional(input.repository),
		baseCommit: optional(input.baseCommit),
		model: optional(input.model),
		benchmark: optional(input.benchmark),
	};
}

function label(value: string): string {
	const normalized = value
		.toLowerCase()
		.replace(LABEL_PATTERN, "-")
		.replace(/^-+|-+$/gu, "");
	return (normalized || "run").slice(0, 6);
}

/**
 * Produces a compact filesystem identifier. The hash covers the complete,
 * persisted identity; the readable segment is only a convenience label.
 */
export function createRunId(identityInput: RunIdentityInput, prefix = "ap"): string {
	const identity = normalizeRunIdentity(identityInput);
	const normalizedPrefix = prefix.trim().toLowerCase();
	if (!/^[a-z][a-z0-9]{0,3}$/u.test(normalizedPrefix)) throw new Error("Run id prefix is invalid.");
	const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 10);
	const runId = `${normalizedPrefix}-${label(identity.variant)}-a${identity.attempt}-${digest}`;
	if (!RUN_ID_PATTERN.test(runId)) throw new Error("Generated run id is invalid.");
	return runId;
}

export function isFilesystemSafeRunId(runId: string): boolean {
	return RUN_ID_PATTERN.test(runId);
}
