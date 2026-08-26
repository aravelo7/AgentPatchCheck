import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	getExecutionBootstrapCacheFingerprint,
	prepareExecutionBootstrapCache,
	publishExecutionBootstrapCache,
} from "../../src/agentpatchcheck/execution-bootstrap-cache";
import type { ExecutionBootstrapPolicy } from "../../src/agentpatchcheck/types";

const bootstrap: ExecutionBootstrapPolicy = {
	nodeVersion: "v24.13.0",
	npmVersion: "11.6.2",
	npmInstall: { legacyPeerDeps: true, packageLock: false },
	timeoutMs: 60_000,
};

const temporaryRoots: string[] = [];

async function createFixture() {
	const root = await mkdtemp(join(tmpdir(), "agentpatchcheck-bootstrap-cache-"));
	temporaryRoots.push(root);
	const repositoryRoot = join(root, "repository");
	const firstWorktree = join(root, "first-worktree");
	const secondWorktree = join(root, "second-worktree");
	for (const worktree of [repositoryRoot, firstWorktree, secondWorktree]) {
		await mkdir(worktree, { recursive: true });
		await writeFile(join(worktree, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
		await writeFile(join(worktree, "package-lock.json"), '{"lockfileVersion":3}\n');
		await writeFile(join(worktree, ".npmrc"), "package-lock=false\n");
	}
	return {
		repositoryRoot,
		firstWorktree,
		secondWorktree,
		context: { repositoryRoot, baseCommit: "a".repeat(40) },
	};
}

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

describe("execution bootstrap dependency cache", () => {
	it("publishes a cold snapshot and restores an isolated warm worktree", async () => {
		const fixture = await createFixture();
		const cold = await prepareExecutionBootstrapCache({
			bootstrap,
			context: fixture.context,
			worktreePath: fixture.firstWorktree,
		});
		expect(cold.result).toMatchObject({ status: "miss" });
		await mkdir(join(fixture.firstWorktree, "node_modules", "fixture-dependency"), { recursive: true });
		await writeFile(
			join(fixture.firstWorktree, "node_modules", "fixture-dependency", "index.js"),
			"module.exports = 1;\n",
		);
		expect(
			await publishExecutionBootstrapCache({
				cacheDirectory: cold.cacheDirectory,
				worktreePath: fixture.firstWorktree,
			}),
		).toBeNull();

		const warm = await prepareExecutionBootstrapCache({
			bootstrap,
			context: fixture.context,
			worktreePath: fixture.secondWorktree,
		});
		expect(warm.result).toMatchObject({ status: "hit", fingerprint: cold.result.fingerprint });
		const restoredDependency = join(fixture.secondWorktree, "node_modules", "fixture-dependency", "index.js");
		expect(await readFile(restoredDependency, "utf8")).toBe("module.exports = 1;\n");
		await writeFile(restoredDependency, "module.exports = 2;\n");
		expect(
			await readFile(join(cold.cacheDirectory ?? "", "node_modules", "fixture-dependency", "index.js"), "utf8"),
		).toBe("module.exports = 1;\n");
	});

	it("misses when dependency metadata, base identity, or runtime bootstrap identity changes", async () => {
		const fixture = await createFixture();
		const original = await getExecutionBootstrapCacheFingerprint({
			bootstrap,
			context: fixture.context,
			worktreePath: fixture.firstWorktree,
		});
		await writeFile(join(fixture.firstWorktree, "package.json"), '{"name":"fixture","version":"2.0.0"}\n');
		expect(
			await getExecutionBootstrapCacheFingerprint({
				bootstrap,
				context: fixture.context,
				worktreePath: fixture.firstWorktree,
			}),
		).not.toBe(original);
		await writeFile(join(fixture.firstWorktree, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
		await writeFile(join(fixture.firstWorktree, "package-lock.json"), '{"lockfileVersion":4}\n');
		expect(
			await getExecutionBootstrapCacheFingerprint({
				bootstrap,
				context: fixture.context,
				worktreePath: fixture.firstWorktree,
			}),
		).not.toBe(original);
		await writeFile(join(fixture.firstWorktree, "package-lock.json"), '{"lockfileVersion":3}\n');
		await writeFile(join(fixture.firstWorktree, ".npmrc"), "ignore-scripts=true\n");
		expect(
			await getExecutionBootstrapCacheFingerprint({
				bootstrap,
				context: fixture.context,
				worktreePath: fixture.firstWorktree,
			}),
		).not.toBe(original);
		await writeFile(join(fixture.firstWorktree, ".npmrc"), "package-lock=false\n");
		expect(
			await getExecutionBootstrapCacheFingerprint({
				bootstrap: { ...bootstrap, npmVersion: "11.7.0" },
				context: fixture.context,
				worktreePath: fixture.firstWorktree,
			}),
		).not.toBe(original);
		expect(
			await getExecutionBootstrapCacheFingerprint({
				bootstrap,
				context: { ...fixture.context, baseCommit: "b".repeat(40) },
				worktreePath: fixture.firstWorktree,
			}),
		).not.toBe(original);
	});

	it("reports a cache restore failure without retaining partial worktree dependencies", async () => {
		const fixture = await createFixture();
		const cold = await prepareExecutionBootstrapCache({
			bootstrap,
			context: fixture.context,
			worktreePath: fixture.firstWorktree,
		});
		await mkdir(join(fixture.firstWorktree, "node_modules"), { recursive: true });
		await writeFile(join(fixture.firstWorktree, "node_modules", "index.js"), "module.exports = true;\n");
		await publishExecutionBootstrapCache({
			cacheDirectory: cold.cacheDirectory,
			worktreePath: fixture.firstWorktree,
		});
		await writeFile(join(fixture.secondWorktree, "node_modules"), "not a directory\n");

		const restored = await prepareExecutionBootstrapCache({
			bootstrap,
			context: fixture.context,
			worktreePath: fixture.secondWorktree,
		});
		expect(restored.result.status).toBe("restore-failed");
		expect(restored.result.diagnostic).toContain("restore failed");
	});
});
