import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { getAgentAdapter, SCRIPT_ADAPTER_WORKTREE_ENV } from "../../src/agentpatchcheck/agent-adapter";
import { validateTaskPolicy } from "../../src/agentpatchcheck/task-policy";

describe("AgentAdapter", () => {
	it("runs the controlled external Script Adapter against the supplied worktree", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agentpatchcheck-script-adapter-"));
		try {
			const scriptPath = join(directory, "agent.mjs");
			await writeFile(
				scriptPath,
				`import { writeFile } from "node:fs/promises"; import { join } from "node:path"; await writeFile(join(process.env.${SCRIPT_ADAPTER_WORKTREE_ENV}, "adapter.txt"), "created\\n"); console.log("script adapter ran");`,
				"utf8",
			);
			const policy = await validateTaskPolicy({
				repositoryRoot: process.cwd(),
				prompt: "Use the scripted adapter.",
				agentAdapter: "script",
				agentScript: scriptPath,
			});

			const result = await getAgentAdapter("script").execute({ policy, worktreePath: directory });

			expect(result).toMatchObject({ executable: process.execPath, exitCode: 0, timedOut: false });
			expect(result.stdout).toContain("script adapter ran");
			expect(await readFile(join(directory, "adapter.txt"), "utf8")).toBe("created\n");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("rejects Script Adapter code placed inside the target repository", async () => {
		await expect(
			validateTaskPolicy({
				repositoryRoot: process.cwd(),
				prompt: "Unsafe script.",
				agentAdapter: "script",
				agentScript: join(process.cwd(), "package.json"),
			}),
		).rejects.toThrow("Agent script must be outside the repository root");
	});
});
