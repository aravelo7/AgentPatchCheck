import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { lockedFileSystem } from "../fs/locked-file-system";
import type {
	TaskDefinitionArtifactReference,
	TaskDefinitionSnapshot,
	TaskDefinitionSnapshotReference,
	TaskPolicy,
} from "./types";

const TASK_DEFINITION_DIRECTORY_NAME = "task-definitions";

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

async function referenceExternalArtifact(path: string): Promise<TaskDefinitionArtifactReference> {
	return { path, sha256: sha256(await readFile(path)) };
}

async function createTaskDefinitionSnapshot(policy: TaskPolicy): Promise<TaskDefinitionSnapshot> {
	const agentScript = policy.agentScript === null ? null : await referenceExternalArtifact(policy.agentScript);
	const hiddenOracle =
		policy.hiddenOracle === null
			? null
			: {
					script: await referenceExternalArtifact(policy.hiddenOracle.scriptPath),
					timeoutMs: policy.hiddenOracle.timeoutMs,
					isolation: policy.hiddenOracle.isolation,
					memoryLimitBytes: policy.hiddenOracle.memoryLimitBytes,
					cpuRatePercent: policy.hiddenOracle.cpuRatePercent,
				};

	return {
		version: 1,
		policy: {
			repositoryRoot: policy.repositoryRoot,
			baseRef: policy.baseRef,
			baseCommit: policy.baseCommit,
			worktreeRoot: policy.worktreeRoot,
			runIdentity: policy.runIdentity,
			prompt: policy.prompt,
			executionBootstrap: policy.executionBootstrap,
			publicVerificationRepairInstruction: policy.publicVerificationRepairInstruction,
			codexExecutable: policy.codexExecutable ?? null,
			agentAdapter: policy.agentAdapter,
			agentScript,
			nativeAgent: policy.nativeAgent,
			model: policy.model ?? null,
			timeoutMs: policy.timeoutMs,
			sandbox: policy.sandbox,
			allowNetwork: policy.allowNetwork,
			allowDangerousParameters: false,
			verification: policy.verification,
			verificationProfile: policy.verificationProfile,
			riskPolicy: policy.riskPolicy,
			hiddenOracle,
			patchExpectation: policy.patchExpectation,
		},
	};
}

export function getTaskDefinitionSnapshotPath(worktreeRoot: string, sha256Value: string): string {
	return join(dirname(worktreeRoot), TASK_DEFINITION_DIRECTORY_NAME, `${sha256Value}.json`);
}

/**
 * Stores the fully normalized definition outside the disposable worktree.
 * The content hash is calculated over exactly the UTF-8 JSON written to disk.
 */
export async function persistTaskDefinitionSnapshot(policy: TaskPolicy): Promise<TaskDefinitionSnapshotReference> {
	const snapshot = await createTaskDefinitionSnapshot(policy);
	const serialized = JSON.stringify(snapshot, null, 2);
	const snapshotSha256 = sha256(serialized);
	const path = getTaskDefinitionSnapshotPath(policy.worktreeRoot, snapshotSha256);
	await lockedFileSystem.writeTextFileAtomic(path, serialized);
	return { version: 1, path, sha256: snapshotSha256 };
}

/** Reads a referenced snapshot only when its on-disk bytes still match Evidence. */
export async function readTaskDefinitionSnapshot(
	reference: TaskDefinitionSnapshotReference,
): Promise<TaskDefinitionSnapshot> {
	const serialized = await readFile(reference.path, "utf8");
	if (sha256(serialized) !== reference.sha256) {
		throw new Error(`Task Definition snapshot integrity check failed: ${reference.path}`);
	}
	const parsed: unknown = JSON.parse(serialized);
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		!("version" in parsed) ||
		parsed.version !== 1 ||
		!("policy" in parsed)
	) {
		throw new Error(`Task Definition snapshot is invalid: ${reference.path}`);
	}
	return parsed as TaskDefinitionSnapshot;
}
