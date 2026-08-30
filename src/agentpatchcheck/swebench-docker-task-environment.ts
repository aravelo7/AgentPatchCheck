import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	HarnessNativeRepositoryDirectoryEntry,
	HarnessNativeRepositoryMetadata,
	HarnessNativeRepositoryPrimitives,
} from "./harness-native-runtime";
import { terminateCodexProcess } from "./codex-runner";
import { applyManagedMutationPatch, type ManagedMutationPatchGitResult } from "./mutation-patch";
import { readBoundedTextWindow } from "./read-file";
import type { VerificationCommand } from "./types";

const TESTBED = "/testbed";
const DOCKER_COMMAND_CLEANUP_GRACE_MS = 5_000;

export interface SafeSWEbenchVerificationImageDescriptor {
	instanceId: string;
	arch: string;
	namespace: string;
	instanceImageTag: string;
}

export interface SWEbenchDockerTaskEnvironmentConfiguration {
	image: SafeSWEbenchVerificationImageDescriptor;
}

export interface DockerCommandResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	durationMs: number;
	timedOut: boolean;
}

export interface DockerCommandExecutor {
	run(input: { args: string[]; stdin?: string; timeoutMs?: number }): Promise<DockerCommandResult>;
}

export function deriveSWEbenchInstanceImageKey(descriptor: SafeSWEbenchVerificationImageDescriptor): string {
	const normalized = descriptor.instanceId.toLowerCase().replace("__", "_1776_");
	return `${descriptor.namespace}/sweb.eval.${descriptor.arch}.${normalized}:${descriptor.instanceImageTag}`;
}

export function createDockerCommandExecutor(): DockerCommandExecutor {
	return {
		run: async ({ args, stdin, timeoutMs = 120_000 }) =>
			await new Promise<DockerCommandResult>((resolvePromise) => {
				const startedAt = Date.now();
				const child = spawn("docker", args, { shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
				let stdout = "";
				let stderr = "";
				let timedOut = false;
				let settled = false;
				let cleanupDeadline: NodeJS.Timeout | undefined;
				const finish = (result: DockerCommandResult): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timeout);
					if (cleanupDeadline !== undefined) clearTimeout(cleanupDeadline);
					resolvePromise(result);
				};
				const timeout = setTimeout(() => {
					timedOut = true;
					terminateCodexProcess(child);
					cleanupDeadline = setTimeout(() => {
						terminateCodexProcess(child);
						finish({
							exitCode: null,
							stdout,
							stderr,
							durationMs: Date.now() - startedAt,
							timedOut,
						});
					}, DOCKER_COMMAND_CLEANUP_GRACE_MS);
				}, timeoutMs);
				child.stdout.on("data", (chunk: Buffer) => {
					stdout += chunk.toString("utf8");
				});
				child.stderr.on("data", (chunk: Buffer) => {
					stderr += chunk.toString("utf8");
				});
				child.once("error", (error) => {
					finish({
						exitCode: null,
						stdout,
						stderr: `${stderr}${error.message}`,
						durationMs: Date.now() - startedAt,
						timedOut,
					});
				});
				child.once("close", (exitCode) => {
					finish({ exitCode, stdout, stderr, durationMs: Date.now() - startedAt, timedOut });
				});
				child.stdin.end(stdin, "utf8");
			}),
	};
}

function dockerFailure(stage: string, result: DockerCommandResult): Error {
	return new Error(`SWE-bench Docker task environment ${stage} failed: ${result.stderr.trim() || `exit ${result.exitCode ?? "unavailable"}`}`);
}

function metadata(kind: "file" | "directory" | "other", symlink: boolean, size: number): HarnessNativeRepositoryMetadata {
	return { isFile: () => kind === "file", isDirectory: () => kind === "directory", isSymbolicLink: () => symlink, size };
}

export class DockerRepositoryPrimitives implements HarnessNativeRepositoryPrimitives {
	constructor(
		private readonly containerId: string,
		private readonly docker: DockerCommandExecutor,
		private readonly root = TESTBED,
	) {}

	resolvePath(root: string, relativePath: string): string {
		return relativePath === "." ? root : `${root}/${relativePath.replaceAll("\\", "/")}`;
	}
	joinPath(...parts: string[]): string { return parts.join("/").replaceAll(/\/{2,}/gu, "/"); }
	relativePath(root: string, path: string): string { return path === root ? "" : path.slice(root.length + 1); }
	parentPath(path: string): string {
		const separator = path.lastIndexOf("/");
		return separator < 0 ? "." : path.slice(0, separator) || "/";
	}
	baseName(path: string): string { return path.slice(path.lastIndexOf("/") + 1); }

	private async exec(args: string[], stdin?: string, timeoutMs?: number): Promise<DockerCommandResult> {
		return await this.docker.run({ args: ["exec", "--workdir", this.root, this.containerId, ...args], stdin, timeoutMs });
	}

	async stat(path: string): Promise<HarnessNativeRepositoryMetadata> {
		const result = await this.exec(["stat", "-c", "%F:%s", "--", path]);
		if (result.exitCode !== 0) {
			const error = new Error(result.stderr || "missing") as NodeJS.ErrnoException;
			error.code = "ENOENT";
			throw error;
		}
		const [kindValue, sizeValue] = result.stdout.trim().split(":");
		const symlink = (await this.exec(["test", "-L", path])).exitCode === 0;
		return metadata(kindValue === "regular file" ? "file" : kindValue === "directory" ? "directory" : "other", symlink, Number(sizeValue) || 0);
	}

	async listDirectory(path: string): Promise<HarnessNativeRepositoryDirectoryEntry[]> {
		const result = await this.exec(["find", path, "-mindepth", "1", "-maxdepth", "1", "-printf", "%f\\0%y\\0"]);
		if (result.exitCode !== 0) throw dockerFailure("list directory", result);
		const values = result.stdout.split("\0").filter(Boolean);
		const entries: HarnessNativeRepositoryDirectoryEntry[] = [];
		for (let index = 0; index + 1 < values.length; index += 2) {
			const name = values[index] as string;
			const type = values[index + 1];
			entries.push({ name, isFile: () => type === "f", isDirectory: () => type === "d", isSymbolicLink: () => type === "l" });
		}
		return entries;
	}

	async readText(path: string): Promise<string> {
		const result = await this.exec(["cat", "--", path]);
		if (result.exitCode !== 0) throw dockerFailure("read file", result);
		return result.stdout;
	}

	async readWindow(input: { path: string; displayPath: string; input: { path: string; offset: number; limit: number }; maxObservationBytes: number }) {
		return await readBoundedTextWindow({
			content: await this.readText(input.path),
			displayPath: input.displayPath,
			input: input.input,
			maxObservationBytes: input.maxObservationBytes,
		});
	}

	async writeText(path: string, content: string, options?: { exclusive?: boolean }): Promise<void> {
		const exists = (await this.exec(["test", "-e", path])).exitCode === 0;
		if (options?.exclusive && exists) {
			const error = new Error("target exists") as NodeJS.ErrnoException;
			error.code = "EEXIST";
			throw error;
		}
		const mode = exists ? (await this.exec(["stat", "-c", "%a", "--", path])).stdout.trim() : "644";
		if (!/^\d{3,4}$/u.test(mode)) throw new Error("Could not preserve SWE-bench file mode.");
		const artifact = await mkdtemp(join(tmpdir(), "agentpatchcheck-docker-write-"));
		const source = join(artifact, "content");
		const target = `/tmp/apc-${randomUUID()}`;
		try {
			await writeFile(source, content, "utf8");
			const copy = await this.docker.run({ args: ["cp", source, `${this.containerId}:${target}`] });
			if (copy.exitCode !== 0) throw dockerFailure("copy file", copy);
			const move = await this.exec(["mv", "--", target, path]);
			if (move.exitCode !== 0) throw dockerFailure("write file", move);
			const chmod = await this.exec(["chmod", mode, "--", path]);
			if (chmod.exitCode !== 0) throw dockerFailure("preserve file mode", chmod);
		} finally {
			await this.exec(["rm", "-f", "--", target]).catch(() => undefined);
			await rm(artifact, { recursive: true, force: true });
		}
	}

	async git(root: string, args: string[], options?: { trimStdout?: boolean }) {
		const result = await this.exec(["git", "-C", root, "-c", "core.quotepath=false", ...args]);
		const stdout = options?.trimStdout === false ? result.stdout : result.stdout.trim();
		const stderr = result.stderr.trim();
		return { ok: result.exitCode === 0 && !result.timedOut, stdout, stderr, output: [stdout, stderr].filter(Boolean).join("\n"), error: result.exitCode === 0 ? null : `git ${args.join(" ")} failed`, exitCode: result.exitCode ?? -1 };
	}

	async runCommand(input: { command: VerificationCommand; cwd: string; outputLimitBytes: number; signal?: AbortSignal }) {
		const result = await this.exec(input.command.args.length === 0 ? [input.command.command] : [input.command.command, ...input.command.args], undefined, input.command.timeoutMs);
		return { command: input.command.command, args: input.command.args, exitCode: result.exitCode, signal: null, stdout: result.stdout.slice(0, input.outputLimitBytes), stderr: result.stderr.slice(0, input.outputLimitBytes), durationMs: result.durationMs, timedOut: result.timedOut };
	}

	async applyPatch(input: { root: string; patch: unknown; validateTarget: (relativePath: string) => Promise<void> }) {
		return await applyManagedMutationPatch({
			...input,
			runGitApply: async (args, patch): Promise<ManagedMutationPatchGitResult> => {
				const result = await this.exec(["git", "-C", input.root, "-c", "core.quotepath=false", "apply", ...args, "--"], patch);
				return { exitCode: result.exitCode ?? -1, stdout: Buffer.from(result.stdout), stderr: Buffer.from(result.stderr), outputTruncated: false };
			},
		});
	}

	async fingerprint(root: string): Promise<string> {
		const result = await this.exec(["git", "-C", root, "status", "--porcelain=v1", "-z"]);
		if (result.exitCode !== 0) throw dockerFailure("fingerprint", result);
		return createHash("sha256").update(result.stdout).digest("hex");
	}

	async captureMutationSurface(root: string) {
		const result = await this.exec(["git", "-C", root, "status", "--porcelain=v1", "-z"]);
		if (result.exitCode !== 0) throw dockerFailure("mutation surface", result);
		const pathSha256 = new Map<string, string>();
		for (const record of result.stdout.split("\0").filter(Boolean)) {
			const path = record.slice(3);
			const content = await this.readText(`${root}/${path}`);
			pathSha256.set(path, createHash("sha256").update(content).digest("hex"));
		}
		return { pathSha256 };
	}
}

export interface SWEbenchDockerTaskEnvironment {
	path: string;
	repository: HarnessNativeRepositoryPrimitives;
	collectModelPatch(baseCommit: string, mutationPaths: readonly string[]): Promise<{ modelPatch: string; changedFiles: string[] }>;
	cleanup(): Promise<void>;
}

type RepositoryFileState = ReadonlyMap<string, string>;

function parseRepositoryFileState(output: string): RepositoryFileState {
	const files = new Map<string, string>();
	for (const record of output.split("\0")) {
		if (!record) continue;
		const match = /^([a-f\d]{64}) {2}(.*)$/su.exec(record);
		if (match === null) throw new Error("Could not parse SWE-bench repository baseline state.");
		const [, sha256, path] = match;
		if (sha256 === undefined || path === undefined || !path) throw new Error("SWE-bench repository baseline state is invalid.");
		files.set(path, sha256);
	}
	return files;
}

function changedRepositoryPaths(baseline: RepositoryFileState, terminal: RepositoryFileState): string[] {
	const paths = new Set([...baseline.keys(), ...terminal.keys()]);
	return [...paths].filter((path) => baseline.get(path) !== terminal.get(path)).sort((left, right) => left.localeCompare(right));
}

export async function createSWEbenchDockerTaskEnvironment(input: {
	runId: string;
	configuration: SWEbenchDockerTaskEnvironmentConfiguration;
	docker?: DockerCommandExecutor;
}): Promise<SWEbenchDockerTaskEnvironment> {
	const docker = input.docker ?? createDockerCommandExecutor();
	const containerId = `apc-swebench-${input.runId.replace(/[^a-zA-Z0-9_.-]/gu, "-")}-${randomUUID().slice(0, 8)}`;
	const image = deriveSWEbenchInstanceImageKey(input.configuration.image);
	let created = false;
	const cleanup = async (): Promise<void> => { if (created) await docker.run({ args: ["rm", "-f", containerId] }).catch(() => undefined); };
	try {
		const create = await docker.run({ args: ["create", "--name", containerId, "--network", "none", image, "/bin/sh", "-c", "sleep infinity"] });
		if (create.exitCode !== 0) throw dockerFailure("create", create);
		created = true;
		const start = await docker.run({ args: ["start", containerId] });
		if (start.exitCode !== 0) throw dockerFailure("start", start);
		const repository = new DockerRepositoryPrimitives(containerId, docker);
		const ready = await repository.stat(TESTBED);
		if (!ready.isDirectory() || ready.isSymbolicLink()) throw new Error("SWE-bench Docker task environment /testbed is not a regular directory.");
		const captureState = async (): Promise<RepositoryFileState> => {
			const result = await docker.run({
				args: [
					"exec",
					"--workdir",
					TESTBED,
					containerId,
					"sh",
					"-c",
					"git ls-files -co --exclude-standard -z | xargs -0 -r -n1 sh -c 'path=$1; index=$(git ls-files --stage -- \"$path\"); mode=$(printf \"%s\\n\" \"$index\" | cut -d \" \" -f1); object=$(printf \"%s\\n\" \"$index\" | cut -d \" \" -f2); if [ \"$mode\" = 160000 ]; then identity=\"gitlink:$object\"; elif [ -f \"$path\" ] && [ ! -L \"$path\" ]; then sha256sum -z -- \"$path\"; exit 0; elif [ -L \"$path\" ]; then identity=\"symlink:$(readlink -- \"$path\")\"; elif [ -d \"$path\" ]; then identity=directory; else identity=other; fi; printf \"%s\" \"$identity\" | sha256sum -z | sed \"s/  -$/  $path/\"' sh",
				],
			});
			if (result.exitCode !== 0 || result.timedOut) throw dockerFailure("capture repository state", result);
			return parseRepositoryFileState(result.stdout);
		};
		const baselineState = await captureState();
		return {
			path: TESTBED,
			repository,
			collectModelPatch: async (baseCommit, mutationPaths) => {
				const terminalState = await captureState();
				const ownedPaths = new Set(mutationPaths);
				const changedPaths = changedRepositoryPaths(baselineState, terminalState).filter((path) => ownedPaths.has(path));
				if (changedPaths.length === 0) return { modelPatch: "", changedFiles: [] };
				const indexPath = `/tmp/apc-swebench-export-${randomUUID()}.index`;
				const indexedGit = async (args: string[], stdin?: string) =>
					await docker.run({
						args: ["exec", "--workdir", TESTBED, containerId, "env", `GIT_INDEX_FILE=${indexPath}`, "git", "-C", TESTBED, ...args],
						stdin,
					});
				try {
					const initialize = await indexedGit(["read-tree", baseCommit]);
					if (initialize.exitCode !== 0 || initialize.timedOut) throw dockerFailure("initialize patch export", initialize);
					const stage = await indexedGit(["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul", "--"], changedPaths.join("\0"));
					if (stage.exitCode !== 0 || stage.timedOut) throw dockerFailure("stage patch export", stage);
					const [patch, files] = await Promise.all([
						indexedGit(["diff", "--binary", "--cached", baseCommit, "--"]),
						indexedGit(["diff", "--name-only", "--cached", baseCommit, "--"]),
					]);
					if (patch.exitCode !== 0 || files.exitCode !== 0 || patch.timedOut || files.timedOut)
						throw new Error("Could not export Docker task environment patch.");
					return {
						modelPatch: patch.stdout,
						changedFiles: files.stdout.split("\n").map((path) => path.trim()).filter(Boolean).sort((left, right) => left.localeCompare(right)),
					};
				} finally {
					await docker.run({ args: ["exec", "--workdir", TESTBED, containerId, "rm", "-f", "--", indexPath] }).catch(() => undefined);
				}
			},
			cleanup,
		};
	} catch (error) {
		await cleanup();
		throw error;
	}
}
