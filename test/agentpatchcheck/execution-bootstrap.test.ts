import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { runExecutionBootstrap } from "../../src/agentpatchcheck/execution-bootstrap";
import {
	prepareExecutionBootstrapCache,
	publishExecutionBootstrapCache,
} from "../../src/agentpatchcheck/execution-bootstrap-cache";

function createUnclosedChild() {
	const child = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
		kill: ReturnType<typeof vi.fn>;
	};
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = vi.fn();
	return child;
}

function createClosingChild(options: { stdout?: string; beforeClose?: () => Promise<void> | void } = {}) {
	const child = createUnclosedChild();
	setTimeout(async () => {
		await options.beforeClose?.();
		if (options.stdout !== undefined) child.stdout.emit("data", options.stdout);
		child.emit("close", 0, null);
	}, 0);
	return child;
}

beforeEach(() => {
	spawnMock.mockReset();
});

describe("runExecutionBootstrap", () => {
	it("returns a timed-out result when npm never emits close or error", async () => {
		const child = createUnclosedChild();
		spawnMock.mockReturnValueOnce(child);

		const result = await runExecutionBootstrap(
			{
				nodeVersion: process.version,
				npmVersion: "11.6.2",
				npmInstall: { legacyPeerDeps: true, packageLock: false },
				timeoutMs: 5,
			},
			"D:\\isolated-worktree",
		);

		expect(child.kill).toHaveBeenCalledOnce();
		expect(result).toMatchObject({
			status: "failed",
			npmVersion: null,
			npmInstall: null,
			diagnostic: "Configured npm version is unavailable.",
		});
	});

	it("falls back to a normal npm install when cache restoration fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentpatchcheck-bootstrap-fallback-"));
		const repositoryRoot = join(root, "repository");
		const worktreePath = join(root, "worktree");
		const policy = {
			nodeVersion: process.version,
			npmVersion: "11.6.2",
			npmInstall: { legacyPeerDeps: true as const, packageLock: false as const },
			timeoutMs: 1_000,
		};
		const context = { repositoryRoot, baseCommit: "a".repeat(40) };
		try {
			for (const path of [repositoryRoot, worktreePath]) {
				await mkdir(path, { recursive: true });
				await writeFile(join(path, "package.json"), '{"name":"fixture"}\n');
			}
			const coldCache = await prepareExecutionBootstrapCache({ bootstrap: policy, context, worktreePath });
			await mkdir(join(worktreePath, "node_modules"), { recursive: true });
			await writeFile(join(worktreePath, "node_modules", "index.js"), "module.exports = true;\n");
			await publishExecutionBootstrapCache({ cacheDirectory: coldCache.cacheDirectory, worktreePath });
			await rm(join(worktreePath, "node_modules"), { recursive: true, force: true });
			await writeFile(join(worktreePath, "node_modules"), "invalid restore target\n");

			spawnMock.mockImplementationOnce(() => createClosingChild({ stdout: "11.6.2\n" }));
			spawnMock.mockImplementationOnce(() =>
				createClosingChild({
					beforeClose: async () => {
						await rm(join(worktreePath, "node_modules"), { recursive: true, force: true });
						await mkdir(join(worktreePath, "node_modules"));
					},
				}),
			);
			const result = await runExecutionBootstrap(policy, worktreePath, context);

			expect(spawnMock).toHaveBeenCalledTimes(2);
			expect(result).toMatchObject({
				status: "succeeded",
				cache: { status: "restore-failed" },
				npmInstall: { exitCode: 0, timedOut: false },
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
