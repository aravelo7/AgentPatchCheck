import { basename } from "node:path";

import type {
	VerificationCommand,
	VerificationCommandInput,
	VerificationPolicy,
	VerificationPolicyInput,
} from "./types";

export const DEFAULT_VERIFICATION_TIMEOUT_MS = 5 * 60 * 1_000;
export const MAX_VERIFICATION_TIMEOUT_MS = 15 * 60 * 1_000;
export const DEFAULT_VERIFICATION_OUTPUT_LIMIT_BYTES = 256 * 1_024;
export const MAX_VERIFICATION_OUTPUT_LIMIT_BYTES = 1_024 * 1_024;
export const MAX_VERIFICATION_COMMANDS = 8;

const SHELL_EXECUTABLES = new Set([
	"cmd",
	"cmd.exe",
	"powershell",
	"powershell.exe",
	"pwsh",
	"pwsh.exe",
	"sh",
	"bash",
	"zsh",
	"fish",
]);

function assertSafeString(value: string, label: string, maxLength: number): string {
	const normalized = value.trim();
	if (!normalized || normalized.length > maxLength || normalized.includes("\0")) {
		throw new Error(`${label} must be a non-empty string no longer than ${maxLength} characters.`);
	}
	return normalized;
}

function normalizeTimeout(timeoutMs: number | undefined): number {
	const normalized = timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS;
	if (!Number.isSafeInteger(normalized) || normalized <= 0 || normalized > MAX_VERIFICATION_TIMEOUT_MS) {
		throw new Error(
			`Verification timeout must be a positive integer no greater than ${MAX_VERIFICATION_TIMEOUT_MS} milliseconds.`,
		);
	}
	return normalized;
}

function normalizeCommand(input: VerificationCommandInput): VerificationCommand {
	const command = assertSafeString(input.command, "Verification command", 1_024);
	const executableName = basename(command).toLowerCase();
	if (SHELL_EXECUTABLES.has(executableName)) {
		throw new Error("Verification commands must not launch a shell.");
	}
	const args = (input.args ?? []).map((arg, index) =>
		assertSafeString(arg, `Verification argument ${index + 1}`, 8_192),
	);
	if (args.some((arg) => arg.includes("--dangerously-bypass-approvals-and-sandbox"))) {
		throw new Error("Verification commands must not contain dangerous parameters.");
	}
	return { command, args, timeoutMs: normalizeTimeout(input.timeoutMs) };
}

export function validateVerificationPolicy(input: VerificationPolicyInput | undefined): VerificationPolicy {
	const commands = input?.commands ?? [];
	if (commands.length > MAX_VERIFICATION_COMMANDS) {
		throw new Error(`Verification policy must not contain more than ${MAX_VERIFICATION_COMMANDS} commands.`);
	}
	const outputLimitBytes = input?.outputLimitBytes ?? DEFAULT_VERIFICATION_OUTPUT_LIMIT_BYTES;
	if (
		!Number.isSafeInteger(outputLimitBytes) ||
		outputLimitBytes <= 0 ||
		outputLimitBytes > MAX_VERIFICATION_OUTPUT_LIMIT_BYTES
	) {
		throw new Error(
			`Verification output limit must be a positive integer no greater than ${MAX_VERIFICATION_OUTPUT_LIMIT_BYTES} bytes.`,
		);
	}
	return {
		commands: commands.map(normalizeCommand),
		outputLimitBytes,
		allowShell: false,
		allowNetwork: false,
	};
}
