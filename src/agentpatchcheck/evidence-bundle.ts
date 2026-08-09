import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { lockedFileSystem } from "../fs/locked-file-system";
import type {
	AgentExecution,
	AgentPatchCheckExecutionResult,
	CommandVerification,
	EvidenceBundle,
	EvidenceBundleReference,
	PatchSnapshot,
	TaskPolicy,
} from "./types";

const EVIDENCE_DIRECTORY_NAME = "evidence";
const REDACTED_PROMPT = "[REDACTED_PROMPT]";
const REDACTED_SECRET = "[REDACTED_SECRET]";

function redactSensitiveText(value: string, prompt: string): string {
	let redacted = value.replaceAll(prompt, REDACTED_PROMPT);
	redacted = redacted.replace(
		/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu,
		REDACTED_SECRET,
	);
	redacted = redacted.replace(/\b(?:sk|rk|sess)_[a-zA-Z0-9_-]{12,}\b/gu, REDACTED_SECRET);
	redacted = redacted.replace(/\bBearer\s+[a-zA-Z0-9._~+/-]{12,}\b/giu, `Bearer ${REDACTED_SECRET}`);
	return redacted.replace(
		/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password)\b\s*[:=]\s*([^\s,;]+)/giu,
		`$1=${REDACTED_SECRET}`,
	);
}

function argumentContainsPrompt(value: string, prompt: string): boolean {
	return value.includes(prompt) || value.replaceAll("^", "").includes(prompt);
}

function redactAgentExecution(agent: AgentExecution, prompt: string): AgentExecution {
	return {
		...agent,
		args: agent.args.map((arg) =>
			argumentContainsPrompt(arg, prompt) ? REDACTED_PROMPT : redactSensitiveText(arg, prompt),
		),
		stdout: redactSensitiveText(agent.stdout, prompt),
		stderr: redactSensitiveText(agent.stderr, prompt),
	};
}

function redactPatchSnapshot(patch: PatchSnapshot, prompt: string): PatchSnapshot {
	return {
		...patch,
		changedFiles: patch.changedFiles.map((path) => redactSensitiveText(path, prompt)),
		trackedPatch: redactSensitiveText(patch.trackedPatch, prompt),
	};
}

function redactCommandVerification(verification: CommandVerification, prompt: string): CommandVerification {
	return {
		...verification,
		commands: verification.commands.map((command) => ({
			...command,
			args: command.args.map((arg) => redactSensitiveText(arg, prompt)),
			stdout: redactSensitiveText(command.stdout, prompt),
			stderr: redactSensitiveText(command.stderr, prompt),
		})),
	};
}

export function getEvidenceBundlePath(worktreeRoot: string, runId: string): string {
	return join(dirname(worktreeRoot), EVIDENCE_DIRECTORY_NAME, `${runId}.json`);
}

export function createEvidenceBundle(options: {
	policy: TaskPolicy;
	execution: AgentPatchCheckExecutionResult;
	createdAt?: Date;
}): EvidenceBundle {
	const createdAt = (options.createdAt ?? new Date()).toISOString();
	const promptSha256 = createHash("sha256").update(options.policy.prompt, "utf8").digest("hex");
	const agent = redactAgentExecution(options.execution.agent, options.policy.prompt);
	const patch = redactPatchSnapshot(options.execution.patch, options.policy.prompt);
	const commandVerification = redactCommandVerification(options.execution.commandVerification, options.policy.prompt);
	const trackedPatchSha256 = createHash("sha256").update(patch.trackedPatch, "utf8").digest("hex");

	return {
		version: 1,
		createdAt,
		policy: {
			repositoryRoot: options.policy.repositoryRoot,
			baseRef: options.policy.baseRef,
			baseCommit: options.policy.baseCommit,
			worktreeRoot: options.policy.worktreeRoot,
			promptLength: options.policy.prompt.length,
			promptSha256,
			codexExecutable: options.policy.codexExecutable ?? null,
			model: options.policy.model ?? null,
			timeoutMs: options.policy.timeoutMs,
			sandbox: options.policy.sandbox,
			allowNetwork: options.policy.allowNetwork,
			allowDangerousParameters: false,
			verification: options.policy.verification,
			verificationProfile: options.policy.verificationProfile,
			riskPolicy: options.policy.riskPolicy,
			hiddenOracle:
				options.policy.hiddenOracle === null
					? null
					: { configured: true, timeoutMs: options.policy.hiddenOracle.timeoutMs },
			patchExpectation: options.policy.patchExpectation,
		},
		repository: {
			root: options.execution.workspace.repositoryPath,
			baseRef: options.execution.workspace.baseRef,
			baseCommit: options.execution.workspace.baseCommit,
		},
		workspace: options.execution.workspace,
		agent,
		commandVerification,
		hiddenOracle: options.execution.hiddenOracle,
		patch: {
			...patch,
			trackedPatchSha256,
		},
		result: {
			status: options.execution.status,
			durationMs: options.execution.agent.durationMs,
		},
	};
}

export async function writeEvidenceBundle(options: {
	path: string;
	bundle: EvidenceBundle;
}): Promise<EvidenceBundleReference> {
	await lockedFileSystem.writeJsonFileAtomic(options.path, options.bundle);
	return {
		path: options.path,
		createdAt: options.bundle.createdAt,
	};
}
