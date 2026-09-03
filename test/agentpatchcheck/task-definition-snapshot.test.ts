import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	persistTaskDefinitionSnapshot,
	readTaskDefinitionSnapshot,
} from "../../src/agentpatchcheck/task-definition-snapshot";
import { validateTaskPolicy } from "../../src/agentpatchcheck/task-policy";

describe("Task Definition snapshots", () => {
	it("persists one normalized, content-addressed definition outside the disposable worktree", async () => {
		const artifactRoot = await mkdtemp(join(tmpdir(), "agentpatchcheck-task-definition-"));
		const hiddenOraclePath = join(artifactRoot, "hidden-oracle.mjs");
		const agentScriptPath = join(artifactRoot, "agent.mjs");
		const worktreeRoot = join(process.cwd(), ".agentpatchcheck", "task-definition-test", "worktrees");
		const secret = "sk_should-not-be-persisted-from-configuration";
		try {
			await writeFile(hiddenOraclePath, "process.exit(0);\n", "utf8");
			await writeFile(agentScriptPath, "process.exit(0);\n", "utf8");
			const physicalAgentScriptPath = await realpath(agentScriptPath);
			const physicalHiddenOraclePath = await realpath(hiddenOraclePath);
			const policy = await validateTaskPolicy({
				repositoryRoot: process.cwd(),
				worktreeRoot,
				prompt: "Repair the parser without exposing credentials.",
				agentAdapter: "script",
				agentScript: agentScriptPath,
				executionBootstrap: {
					nodeVersion: "v24.13.0",
					npmVersion: "11.6.2",
					npmInstall: { legacyPeerDeps: true, packageLock: false },
				},
				hiddenOracle: { scriptPath: hiddenOraclePath, isolation: "none" },
				verification: { commands: [{ command: "node", args: ["--version"] }] },
				patchExpectation: "changes-required",
			});

			const first = await persistTaskDefinitionSnapshot(policy);
			const second = await persistTaskDefinitionSnapshot(policy);
			const serialized = await readFile(first.path, "utf8");
			const snapshot = JSON.parse(serialized) as {
				version: number;
				policy: {
					prompt: string;
					worktreeRoot: string;
					executionBootstrap: { timeoutMs: number } | null;
					agentScript: { path: string; sha256: string } | null;
					hiddenOracle: { script: { path: string; sha256: string } } | null;
				};
			};

			expect(second).toEqual(first);
			expect(first.path).not.toContain(`${worktreeRoot}\\`);
			expect(first.path).toContain("task-definitions");
			expect(first.sha256).toBe(createHash("sha256").update(serialized, "utf8").digest("hex"));
			expect(snapshot).toMatchObject({
				version: 1,
				policy: {
					prompt: "Repair the parser without exposing credentials.",
					worktreeRoot,
					executionBootstrap: { timeoutMs: 300_000 },
					agentScript: {
						path: physicalAgentScriptPath,
						sha256: createHash("sha256").update("process.exit(0);\n", "utf8").digest("hex"),
					},
					hiddenOracle: {
						script: {
							path: physicalHiddenOraclePath,
							sha256: createHash("sha256").update("process.exit(0);\n", "utf8").digest("hex"),
						},
					},
				},
			});
			expect(serialized).not.toContain(secret);
			expect(serialized).not.toContain("process.exit(0);");
			expect((await readTaskDefinitionSnapshot(first)).policy.prompt).toBe(
				"Repair the parser without exposing credentials.",
			);
			await writeFile(first.path, `${serialized}\n`, "utf8");
			await expect(readTaskDefinitionSnapshot(first)).rejects.toThrow("integrity check failed");
		} finally {
			await rm(artifactRoot, { recursive: true, force: true });
			await rm(join(process.cwd(), ".agentpatchcheck", "task-definition-test"), {
				recursive: true,
				force: true,
			});
		}
	});
});
