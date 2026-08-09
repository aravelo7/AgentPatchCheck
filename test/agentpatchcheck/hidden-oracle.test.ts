import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { HIDDEN_ORACLE_WORKTREE_ENV, runHiddenOracle } from "../../src/agentpatchcheck/hidden-oracle";

describe("Hidden Oracle", () => {
	it("runs outside the agent workspace and records only a structural result", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agentpatchcheck-hidden-oracle-"));
		try {
			const scriptPath = join(directory, "oracle.mjs");
			await writeFile(
				scriptPath,
				`if (process.env.${HIDDEN_ORACLE_WORKTREE_ENV} !== "worktree-path") process.exit(2); process.stdout.write("hidden body");`,
				"utf8",
			);

			const result = await runHiddenOracle({ scriptPath, timeoutMs: 5_000 }, "worktree-path");

			expect(result).toEqual({
				id: "hidden-oracle",
				kind: "hidden-oracle",
				status: "passed",
				durationMs: expect.any(Number),
				exitCode: 0,
				signal: null,
				diagnostic: null,
			});
			expect(JSON.stringify(result)).not.toContain("hidden body");
			expect(JSON.stringify(result)).not.toContain(scriptPath);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("distinguishes rejection, timeout, and Oracle infrastructure failure", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agentpatchcheck-hidden-oracle-"));
		try {
			const rejectedPath = join(directory, "rejected.mjs");
			const timeoutPath = join(directory, "timeout.mjs");
			const infrastructurePath = join(directory, "infrastructure.mjs");
			await writeFile(rejectedPath, "process.exit(1)", "utf8");
			await writeFile(timeoutPath, "setTimeout(() => process.exit(0), 1_000)", "utf8");
			await writeFile(infrastructurePath, "process.exit(2)", "utf8");

			const rejected = await runHiddenOracle({ scriptPath: rejectedPath, timeoutMs: 5_000 }, "worktree-path");
			const timedOut = await runHiddenOracle({ scriptPath: timeoutPath, timeoutMs: 10 }, "worktree-path");
			const infrastructureFailure = await runHiddenOracle(
				{ scriptPath: infrastructurePath, timeoutMs: 5_000 },
				"worktree-path",
			);

			expect(rejected).toMatchObject({
				status: "failed",
				exitCode: 1,
				diagnostic: "Hidden Oracle rejected the patch.",
			});
			expect(timedOut).toMatchObject({ status: "timed-out", diagnostic: "Hidden Oracle timed out." });
			expect(infrastructureFailure).toMatchObject({
				status: "error",
				exitCode: 2,
				diagnostic: "Hidden Oracle infrastructure failed.",
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
