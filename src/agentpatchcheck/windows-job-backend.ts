import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HiddenOracleIsolationCapability, HiddenOraclePolicy } from "./types";

interface HelperManifest {
	protocolVersion: 1;
	helperVersion: string;
	file: "agentpatchcheck-job-helper.exe";
	sha256: string;
}

export interface WindowsJobResult {
	protocolVersion: 1;
	helperVersion: string;
	status: "exited" | "timed-out" | "error";
	exitCode: number;
	terminationReason: string;
	errorCode: number;
}

export interface WindowsJobBackendPaths {
	helperPath: string;
	manifestPath: string;
}

export function defaultWindowsJobBackendPaths(): WindowsJobBackendPaths {
	const moduleDirectory = dirname(fileURLToPath(import.meta.url));
	const packaged = join(moduleDirectory, "native", "windows");
	const development = resolve(moduleDirectory, "..", "..", "dist", "native", "windows");
	return {
		helperPath: join(packaged, "agentpatchcheck-job-helper.exe"),
		manifestPath: join(packaged, "agentpatchcheck-job-helper.manifest.json"),
		...((process.env.NODE_ENV === "development" || /[\\/]src[\\/]/.test(moduleDirectory)) && {
			helperPath: join(development, "agentpatchcheck-job-helper.exe"),
			manifestPath: join(development, "agentpatchcheck-job-helper.manifest.json"),
		}),
	};
}

function unavailable(requested: HiddenOraclePolicy["isolation"], reason: string): HiddenOracleIsolationCapability {
	return { version: 1, requested, platform: process.platform, available: false, backend: null, reason };
}

async function readVerifiedManifest(paths: WindowsJobBackendPaths): Promise<HelperManifest> {
	await access(paths.helperPath);
	const parsed: unknown = JSON.parse(await readFile(paths.manifestPath, "utf8"));
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		(parsed as Partial<HelperManifest>).protocolVersion !== 1 ||
		(parsed as Partial<HelperManifest>).helperVersion !== "1.0.0" ||
		(parsed as Partial<HelperManifest>).file !== "agentpatchcheck-job-helper.exe" ||
		typeof (parsed as Partial<HelperManifest>).sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test((parsed as Partial<HelperManifest>).sha256 ?? "")
	)
		throw new Error("Windows Job helper manifest is invalid.");
	const manifest = parsed as HelperManifest;
	const actualHash = createHash("sha256")
		.update(await readFile(paths.helperPath))
		.digest("hex");
	if (actualHash !== manifest.sha256) throw new Error("Windows Job helper hash does not match its manifest.");
	return manifest;
}

async function invokeHelper(
	paths: WindowsJobBackendPaths,
	args: string[],
	env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; output: string }> {
	return await new Promise((resolveResult, reject) => {
		let output = "";
		const child = spawn(paths.helperPath, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			output += chunk;
		});
		child.once("error", reject);
		child.once("close", (code) => resolveResult({ code, output }));
	});
}

export async function getWindowsJobCapability(
	oracle: HiddenOraclePolicy,
	paths = defaultWindowsJobBackendPaths(),
): Promise<HiddenOracleIsolationCapability> {
	if (process.platform !== "win32")
		return unavailable(oracle.isolation, "Windows Job isolation is only available on Windows.");
	if (process.arch !== "x64")
		return unavailable(
			oracle.isolation,
			`Windows Job helper supports x64 only; current architecture is ${process.arch}.`,
		);
	try {
		const manifest = await readVerifiedManifest(paths);
		const version = await invokeHelper(paths, ["--version"]);
		const advertised: unknown = JSON.parse(version.output);
		if (
			version.code !== 0 ||
			typeof advertised !== "object" ||
			advertised === null ||
			(advertised as Partial<WindowsJobResult>).protocolVersion !== 1 ||
			(advertised as Partial<WindowsJobResult>).helperVersion !== manifest.helperVersion
		) {
			throw new Error("Windows Job helper protocol verification failed.");
		}
		return {
			version: 1,
			requested: oracle.isolation,
			platform: process.platform,
			available: true,
			backend: "windows-job",
			reason: null,
			helper: { version: manifest.helperVersion, sha256: manifest.sha256 },
			limits: {
				memoryLimitBytes: oracle.memoryLimitBytes,
				cpuRatePercent: oracle.cpuRatePercent,
				timeoutMs: oracle.timeoutMs,
			},
		};
	} catch (error) {
		return unavailable(
			oracle.isolation,
			error instanceof Error ? error.message : "Windows Job helper is unavailable.",
		);
	}
}

export async function runWindowsJob(
	oracle: HiddenOraclePolicy,
	worktreePath: string,
	paths = defaultWindowsJobBackendPaths(),
): Promise<WindowsJobResult> {
	const result = await invokeHelper(
		paths,
		[
			"--timeout-ms",
			String(oracle.timeoutMs),
			"--memory-bytes",
			String(oracle.memoryLimitBytes),
			"--cpu-rate",
			String(oracle.cpuRatePercent * 100),
			"--cwd",
			dirname(oracle.scriptPath),
			"--",
			process.execPath,
			oracle.scriptPath,
		],
		{ ...process.env, AGENTPATCHCHECK_ORACLE_WORKTREE: worktreePath },
	);
	let payload: unknown;
	try {
		payload = JSON.parse(result.output);
	} catch {
		throw new Error("Windows Job helper returned an invalid result.");
	}
	if (
		typeof payload !== "object" ||
		payload === null ||
		(payload as Partial<WindowsJobResult>).protocolVersion !== 1 ||
		(payload as Partial<WindowsJobResult>).helperVersion !== "1.0.0" ||
		!(["exited", "timed-out", "error"] as const).includes(
			(payload as Partial<WindowsJobResult>).status as WindowsJobResult["status"],
		)
	) {
		throw new Error("Windows Job helper failed to start an isolated process.");
	}
	return payload as WindowsJobResult;
}
