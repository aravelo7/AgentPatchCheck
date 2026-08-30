import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	executeAgentAdapterUnderDeadline,
	getAgentAdapter,
	SCRIPT_ADAPTER_WORKTREE_ENV,
} from "../../src/agentpatchcheck/agent-adapter";
import { ProcessTreeTerminationError } from "../../src/agentpatchcheck/codex-runner";
import { validateTaskPolicy } from "../../src/agentpatchcheck/task-policy";

describe("AgentAdapter", () => {
	it("owns one whole-agent deadline scope and awaits cancellation acknowledgement", async () => {
		const policy = await validateTaskPolicy({
			repositoryRoot: process.cwd(),
			prompt: "Wait for cancellation.",
			agentAdapter: "codex",
			timeoutMs: 10,
		});
		let invocations = 0;
		let acknowledged = false;
		const result = await executeAgentAdapterUnderDeadline(
			{
				id: "harness-native",
				execute: async ({ signal }) => {
					invocations += 1;
					await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
					await new Promise((resolve) => setTimeout(resolve, 5));
					acknowledged = true;
					return {
						executable: "synthetic",
						args: [],
						exitCode: 1,
						signal: null,
						stdout: "",
						stderr: "timeout",
						durationMs: 15,
						timedOut: true,
					};
				},
			},
			{
				policy,
				worktreePath: process.cwd(),
				repairContext: { phase: "initial", publicVerificationFeedback: null, repairInstruction: null },
			},
		);

		expect(result.timedOut).toBe(true);
		expect(acknowledged).toBe(true);
		expect(invocations).toBe(1);
	});

	it("fails closed when deadline cancellation cannot produce a confirmed timeout terminal", async () => {
		const policy = await validateTaskPolicy({
			repositoryRoot: process.cwd(),
			prompt: "Wait for cancellation.",
			agentAdapter: "codex",
			timeoutMs: 10,
		});
		await expect(
			executeAgentAdapterUnderDeadline(
				{
					id: "harness-native",
					execute: async ({ signal }) => {
						await new Promise<void>((resolve) =>
							signal?.addEventListener("abort", () => resolve(), { once: true }),
						);
						throw new Error("cleanup acknowledgement failed");
					},
				},
				{
					policy,
					worktreePath: process.cwd(),
					repairContext: { phase: "initial", publicVerificationFeedback: null, repairInstruction: null },
				},
			),
		).rejects.toBeInstanceOf(ProcessTreeTerminationError);
	});

	it("registers the Cline control runtime without replacing Harness-native", () => {
		expect(getAgentAdapter("cline-runtime").id).toBe("cline-runtime");
		expect(getAgentAdapter("harness-native").id).toBe("harness-native");
	});

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

			const result = await getAgentAdapter("script").execute({
				policy,
				worktreePath: directory,
				repairContext: { phase: "initial", publicVerificationFeedback: null },
			});

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
