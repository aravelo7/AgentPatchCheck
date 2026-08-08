import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { createGitProcessEnv } from "../core/git-process-env";
import { getGitStdout } from "../workspace/git-utils";
import { createApplyPlan } from "./apply-plan";
import { readEvidenceBundle } from "./git-patch-verifier";
import type { ApplyExecutionResult, ApplyPlanResult, EvidenceBundle } from "./types";

interface ApplyDependencies {
	createPlan: (options: { evidencePath: string }) => Promise<ApplyPlanResult>;
	resolveRepositoryRoot: (path: string) => Promise<string>;
	readBundle: (path: string) => Promise<EvidenceBundle>;
	applyPatch: (repositoryRoot: string, patch: string) => Promise<void>;
	readHeadCommit: (repositoryRoot: string) => Promise<string>;
}

function pathsEqual(left: string, right: string): boolean {
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function resolveRepositoryRoot(path: string): Promise<string> {
	return resolve(await getGitStdout(["rev-parse", "--show-toplevel"], path));
}

async function applyPatch(repositoryRoot: string, patch: string): Promise<void> {
	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn("git", ["-c", "core.quotepath=false", "apply", "--binary", "--"], {
			cwd: repositoryRoot,
			env: createGitProcessEnv(),
			stdio: ["pipe", "ignore", "pipe"],
			windowsHide: true,
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString("utf8")}`.slice(0, 16_384);
		});
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) resolvePromise();
			else reject(new Error(stderr.trim() || "git apply failed."));
		});
		child.stdin.end(patch, "utf8");
	});
}

const defaultDependencies: ApplyDependencies = {
	createPlan: createApplyPlan,
	resolveRepositoryRoot,
	readBundle: readEvidenceBundle,
	applyPatch,
	readHeadCommit: async (repositoryRoot) => await getGitStdout(["rev-parse", "--verify", "HEAD"], repositoryRoot),
};

export async function applyRecordedPatch(
	options: { evidencePath: string; repositoryPath: string; apply?: boolean },
	dependencies: ApplyDependencies = defaultDependencies,
): Promise<ApplyExecutionResult> {
	const plan = await dependencies.createPlan({ evidencePath: options.evidencePath });
	const targetRepositoryRoot = await dependencies.resolveRepositoryRoot(options.repositoryPath);
	if (plan.repositoryRoot === null || !pathsEqual(targetRepositoryRoot, plan.repositoryRoot)) {
		return {
			status: "blocked",
			plan,
			targetRepositoryRoot,
			failures: ["Explicit target repository does not match the repository recorded by the EvidenceBundle."],
			appliedFiles: [],
			headCommit: null,
		};
	}
	if (plan.status !== "ready") {
		return {
			status: "blocked",
			plan,
			targetRepositoryRoot,
			failures: plan.failures,
			appliedFiles: [],
			headCommit: null,
		};
	}
	if (options.apply !== true) {
		return { status: "dry-run", plan, targetRepositoryRoot, failures: [], appliedFiles: [], headCommit: null };
	}

	const bundle = await dependencies.readBundle(resolve(options.evidencePath));
	await dependencies.applyPatch(targetRepositoryRoot, bundle.patch.trackedPatch);
	return {
		status: "applied",
		plan,
		targetRepositoryRoot,
		failures: [],
		appliedFiles: plan.changedFiles,
		headCommit: await dependencies.readHeadCommit(targetRepositoryRoot),
	};
}
