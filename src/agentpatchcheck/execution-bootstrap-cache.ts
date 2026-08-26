import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { ExecutionBootstrapCacheResult, ExecutionBootstrapPolicy } from "./types";

const CACHE_VERSION = 1;
const CACHE_METADATA_FILE = "bootstrap-cache.json";
const DEPENDENCY_METADATA_FILES = ["package.json", "package-lock.json", "npm-shrinkwrap.json", ".npmrc"] as const;

export interface ExecutionBootstrapCacheContext {
	repositoryRoot: string;
	baseCommit: string;
}

interface CacheMetadata {
	version: number;
	fingerprint: string;
}

export interface PreparedBootstrapCache {
	result: ExecutionBootstrapCacheResult;
	cacheDirectory: string | null;
}

async function readDependencyMetadata(worktreePath: string) {
	return await Promise.all(
		DEPENDENCY_METADATA_FILES.map(async (path) => {
			try {
				return { path, content: await readFile(join(worktreePath, path), "utf8") };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, content: null };
				throw error;
			}
		}),
	);
}

export async function getExecutionBootstrapCacheFingerprint(options: {
	bootstrap: ExecutionBootstrapPolicy;
	context: ExecutionBootstrapCacheContext;
	worktreePath: string;
}): Promise<string> {
	const metadata = await readDependencyMetadata(options.worktreePath);
	const identity = {
		version: CACHE_VERSION,
		repositoryRoot: resolve(options.context.repositoryRoot),
		baseCommit: options.context.baseCommit,
		nodeVersion: options.bootstrap.nodeVersion,
		npmVersion: options.bootstrap.npmVersion,
		npmInstall: options.bootstrap.npmInstall,
		dependencyMetadata: metadata,
	};
	return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function getCacheRoot(repositoryRoot: string): string {
	return join(resolve(repositoryRoot), ".agentpatchcheck", "bootstrap-cache");
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isDirectory();
	} catch {
		return false;
	}
}

async function readCacheMetadata(path: string): Promise<CacheMetadata | null> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (
			!value ||
			typeof value !== "object" ||
			(value as Partial<CacheMetadata>).version !== CACHE_VERSION ||
			typeof (value as Partial<CacheMetadata>).fingerprint !== "string"
		) {
			return null;
		}
		return value as CacheMetadata;
	} catch {
		return null;
	}
}

function cacheResult(
	status: ExecutionBootstrapCacheResult["status"],
	fingerprint: string | null,
	startedAt: number,
	diagnostic: string | null = null,
): ExecutionBootstrapCacheResult {
	return { status, fingerprint, durationMs: Date.now() - startedAt, diagnostic };
}

/**
 * Restores a content-addressed dependency snapshot by copying it into a fresh
 * worktree. No cache directory is linked or exposed as mutable agent state.
 */
export async function prepareExecutionBootstrapCache(options: {
	bootstrap: ExecutionBootstrapPolicy;
	context: ExecutionBootstrapCacheContext | undefined;
	worktreePath: string;
}): Promise<PreparedBootstrapCache> {
	const startedAt = Date.now();
	if (options.context === undefined) {
		return { result: cacheResult("not-used", null, startedAt), cacheDirectory: null };
	}
	let fingerprint: string;
	try {
		fingerprint = await getExecutionBootstrapCacheFingerprint({
			bootstrap: options.bootstrap,
			context: options.context,
			worktreePath: options.worktreePath,
		});
	} catch (error) {
		return {
			result: cacheResult(
				"miss",
				null,
				startedAt,
				error instanceof Error
					? `Bootstrap cache fingerprint failed: ${error.message}`
					: "Bootstrap cache fingerprint failed.",
			),
			cacheDirectory: null,
		};
	}
	const cacheDirectory = join(getCacheRoot(options.context.repositoryRoot), fingerprint);
	const metadata = await readCacheMetadata(join(cacheDirectory, CACHE_METADATA_FILE));
	const cachedNodeModules = join(cacheDirectory, "node_modules");
	if (metadata?.fingerprint !== fingerprint || !(await isDirectory(cachedNodeModules))) {
		return { result: cacheResult("miss", fingerprint, startedAt), cacheDirectory };
	}
	const targetNodeModules = join(options.worktreePath, "node_modules");
	if (await isDirectory(targetNodeModules)) {
		return {
			result: cacheResult("restore-failed", fingerprint, startedAt, "Fresh worktree already contains node_modules."),
			cacheDirectory,
		};
	}
	try {
		await cp(cachedNodeModules, targetNodeModules, { recursive: true, force: false, errorOnExist: true });
		if (!(await isDirectory(targetNodeModules))) throw new Error("Restored node_modules is unavailable.");
		return { result: cacheResult("hit", fingerprint, startedAt), cacheDirectory };
	} catch (error) {
		await rm(targetNodeModules, { recursive: true, force: true });
		return {
			result: cacheResult(
				"restore-failed",
				fingerprint,
				startedAt,
				error instanceof Error
					? `Bootstrap cache restore failed: ${error.message}`
					: "Bootstrap cache restore failed.",
			),
			cacheDirectory,
		};
	}
}

/** Publishes dependencies produced by a successful bootstrap without replacing an existing snapshot. */
export async function publishExecutionBootstrapCache(options: {
	cacheDirectory: string | null;
	worktreePath: string;
}): Promise<string | null> {
	if (options.cacheDirectory === null) return null;
	const sourceNodeModules = join(options.worktreePath, "node_modules");
	if (!(await isDirectory(sourceNodeModules))) return "Bootstrap cache source node_modules is unavailable.";
	const cacheRoot = resolve(options.cacheDirectory, "..");
	const temporaryDirectory = join(cacheRoot, `${options.cacheDirectory.split(/[/\\]/u).at(-1)}.tmp-${randomUUID()}`);
	try {
		await mkdir(cacheRoot, { recursive: true });
		await mkdir(temporaryDirectory);
		await cp(sourceNodeModules, join(temporaryDirectory, "node_modules"), {
			recursive: true,
			force: false,
			errorOnExist: true,
		});
		await writeFile(
			join(temporaryDirectory, CACHE_METADATA_FILE),
			JSON.stringify({ version: CACHE_VERSION, fingerprint: options.cacheDirectory.split(/[/\\]/u).at(-1) }),
			"utf8",
		);
		try {
			await rename(temporaryDirectory, options.cacheDirectory);
		} catch (error) {
			if (
				(error as NodeJS.ErrnoException).code !== "EEXIST" &&
				(error as NodeJS.ErrnoException).code !== "ENOTEMPTY"
			) {
				throw error;
			}
		}
		return null;
	} catch (error) {
		return error instanceof Error
			? `Bootstrap cache publish failed: ${error.message}`
			: "Bootstrap cache publish failed.";
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}
