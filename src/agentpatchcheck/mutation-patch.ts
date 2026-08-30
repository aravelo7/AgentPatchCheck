import { spawn } from "node:child_process";

import { createGitProcessEnv } from "../core/git-process-env";
import { terminateCodexProcessAndWait } from "./codex-runner";

const MAX_PATCH_BYTES = 128 * 1024;
const MAX_GIT_OUTPUT_BYTES = 256 * 1024;
const MAX_ERROR_DETAIL_BYTES = 8 * 1024;

export interface ManagedMutationPatchGitResult {
	exitCode: number;
	stdout: Buffer;
	stderr: Buffer;
	outputTruncated: boolean;
}

/** Repository-location-specific Git apply primitive. Validation remains shared below. */
export type ManagedMutationPatchGitRunner = (
	argumentsValue: string[],
	patch: string,
	signal?: AbortSignal,
) => Promise<ManagedMutationPatchGitResult>;

export class MutationPatchError extends Error {}

export interface ManagedMutationPatchResult {
	affectedPaths: string[];
}

function appendBounded(chunks: Buffer[], chunk: Buffer, state: { bytes: number; truncated: boolean }): void {
	const remaining = MAX_GIT_OUTPUT_BYTES - state.bytes;
	if (remaining <= 0) {
		state.truncated = true;
		return;
	}
	if (chunk.length > remaining) {
		chunks.push(chunk.subarray(0, remaining));
		state.bytes += remaining;
		state.truncated = true;
		return;
	}
	chunks.push(chunk);
	state.bytes += chunk.length;
}

export async function runHostManagedMutationPatchGit(
	root: string,
	argumentsValue: string[],
	patch: string,
	signal?: AbortSignal,
): Promise<ManagedMutationPatchGitResult> {
	return await new Promise((resolvePromise, rejectPromise) => {
		const child = spawn("git", ["-c", "core.quotepath=false", "apply", ...argumentsValue, "--"], {
			cwd: root,
			env: createGitProcessEnv(),
			stdio: ["pipe", "pipe", "pipe"],
		});
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		const stdoutState = { bytes: 0, truncated: false };
		const stderrState = { bytes: 0, truncated: false };
		let settled = false;
		let cancellation: Promise<void> | null = null;
		const onAbort = (): void => {
			cancellation ??= terminateCodexProcessAndWait(child);
		};
		child.stdout.on("data", (chunk: Buffer) => appendBounded(stdoutChunks, chunk, stdoutState));
		child.stderr.on("data", (chunk: Buffer) => appendBounded(stderrChunks, chunk, stderrState));
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			rejectPromise(new MutationPatchError(`Git patch engine could not start: ${error.message}`));
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			void (async () => {
				try {
					await cancellation;
					if (signal?.aborted) {
						rejectPromise(signal.reason);
						return;
					}
					resolvePromise({
						exitCode: code ?? -1,
						stdout: Buffer.concat(stdoutChunks),
						stderr: Buffer.concat(stderrChunks),
						outputTruncated: stdoutState.truncated || stderrState.truncated,
					});
				} catch (error) {
					rejectPromise(error);
				}
			})();
		});
		child.stdin.on("error", () => {
			// Git reports malformed input through its exit status and stderr.
		});
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		child.stdin.end(patch, "utf8");
	});
}

function errorDetail(result: ManagedMutationPatchGitResult): string {
	const detail = result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim();
	if (!detail) return `Git exited with code ${result.exitCode}.`;
	const encoded = Buffer.from(detail, "utf8");
	return encoded.length <= MAX_ERROR_DETAIL_BYTES
		? detail
		: `${encoded.subarray(0, MAX_ERROR_DETAIL_BYTES).toString("utf8")}\n[diagnostic truncated]`;
}

function validateSupportedOperations(patch: string): void {
	for (const line of patch.split(/\r\n|\r|\n/gu)) {
		if (/^\+\+\+ \/dev\/null(?:\t|$)/u.test(line))
			throw new MutationPatchError("Patch is unsafe: file deletion is not supported.");
		if (line.startsWith("deleted file mode "))
			throw new MutationPatchError("Patch is unsafe: file deletion is not supported.");
		if (/^(?:old mode|new mode|rename from|rename to|copy from|copy to) /u.test(line))
			throw new MutationPatchError("Patch is unsafe: rename, copy, deletion, or mode changes are not supported.");
		if (line.startsWith("new file mode ") && line !== "new file mode 100644")
			throw new MutationPatchError("Patch is unsafe: new files must use regular-file mode 100644.");
		if (line === "GIT binary patch" || line.startsWith("Binary files "))
			throw new MutationPatchError("Patch is unsafe: binary patches are not supported.");
	}
}

function parseNumstat(output: Buffer): string[] {
	if (output.length === 0 || output.at(-1) !== 0)
		throw new MutationPatchError("Patch is malformed: Git did not report any complete file changes.");
	const records = output.toString("utf8").split("\0");
	records.pop();
	const paths: string[] = [];
	for (const record of records) {
		const firstTab = record.indexOf("\t");
		const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
		if (firstTab <= 0 || secondTab <= firstTab + 1)
			throw new MutationPatchError("Patch is malformed: Git returned invalid change metadata.");
		const additions = record.slice(0, firstTab);
		const deletions = record.slice(firstTab + 1, secondTab);
		const path = record.slice(secondTab + 1);
		if (!/^\d+$/u.test(additions) || !/^\d+$/u.test(deletions) || !path)
			throw new MutationPatchError("Patch is unsafe: only textual file additions and updates are supported.");
		paths.push(path);
	}
	if (paths.length === 0) throw new MutationPatchError("Patch is malformed: no file changes were found.");
	return [...new Set(paths)];
}

export async function applyManagedMutationPatch(input: {
	root: string;
	patch: unknown;
	validateTarget: (relativePath: string) => Promise<void>;
	runGitApply?: ManagedMutationPatchGitRunner;
	signal?: AbortSignal;
}): Promise<ManagedMutationPatchResult> {
	if (typeof input.patch !== "string" || !input.patch.trim() || input.patch.includes("\0"))
		throw new MutationPatchError("Patch is malformed: expected a non-empty unified diff.");
	if (Buffer.byteLength(input.patch, "utf8") > MAX_PATCH_BYTES)
		throw new MutationPatchError(`Patch is malformed: input exceeds ${MAX_PATCH_BYTES} bytes.`);
	validateSupportedOperations(input.patch);

	// This invocation never writes. Let Git enumerate even traversal-shaped paths
	// so the Harness validator, rather than Git's implicit policy, makes the final decision.
	const runGitApply =
		input.runGitApply ?? ((args, patch, signal) => runHostManagedMutationPatchGit(input.root, args, patch, signal));
	input.signal?.throwIfAborted();
	const metadata = await runGitApply(["--numstat", "-z", "--binary", "--unsafe-paths"], input.patch, input.signal);
	if (metadata.outputTruncated)
		throw new MutationPatchError("Patch is malformed: Git change metadata exceeded the safety limit.");
	if (metadata.exitCode !== 0) throw new MutationPatchError(`Patch is malformed: ${errorDetail(metadata)}`);
	const affectedPaths = parseNumstat(metadata.stdout);
	for (const path of affectedPaths) {
		input.signal?.throwIfAborted();
		try {
			await input.validateTarget(path);
		} catch (error) {
			const detail = error instanceof Error ? error.message : "Target validation failed.";
			throw new MutationPatchError(`Patch target is unsafe (${path}): ${detail}`);
		}
	}

	input.signal?.throwIfAborted();
	const preflight = await runGitApply(["--check", "--binary"], input.patch, input.signal);
	if (preflight.exitCode !== 0)
		throw new MutationPatchError(`Patch does not apply cleanly: ${errorDetail(preflight)}`);
	input.signal?.throwIfAborted();
	const applied = await runGitApply(["--binary"], input.patch, input.signal);
	if (applied.exitCode !== 0)
		throw new MutationPatchError(`Patch application failed after preflight: ${errorDetail(applied)}`);
	return { affectedPaths };
}
