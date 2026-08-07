import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { MAX_TASK_PROMPT_LENGTH, validateTaskPolicy } from "../../src/agentpatchcheck/task-policy";

describe("validateTaskPolicy", () => {
	it("resolves a repository-rooted policy with safe defaults", async () => {
		const policy = await validateTaskPolicy({
			repositoryRoot: process.cwd(),
			prompt: "Inspect the change.",
		});

		expect(policy.repositoryRoot).toBe(process.cwd());
		expect(policy.worktreeRoot).toBe(join(process.cwd(), ".agentpatchcheck", "worktrees"));
		expect(policy.baseRef).toBe("HEAD");
		expect(policy.baseCommit).toMatch(/^[a-f0-9]{40}$/u);
		expect(policy.sandbox).toBe("workspace-write");
		expect(policy.allowNetwork).toBe(false);
		expect(policy.allowDangerousParameters).toBe(false);
	});

	it("rejects a worktree root outside the repository", async () => {
		await expect(
			validateTaskPolicy({
				repositoryRoot: process.cwd(),
				worktreeRoot: join(process.cwd(), "..", "outside-worktrees"),
				prompt: "Inspect the change.",
			}),
		).rejects.toThrow("Worktree root must be a descendant");
	});

	it("rejects an oversized prompt and dangerous parameter opt-in", async () => {
		await expect(
			validateTaskPolicy({
				repositoryRoot: process.cwd(),
				prompt: "x".repeat(MAX_TASK_PROMPT_LENGTH + 1),
			}),
		).rejects.toThrow("Prompt must not exceed");
		await expect(
			validateTaskPolicy({
				repositoryRoot: process.cwd(),
				prompt: "Inspect the change.",
				allowDangerousParameters: true,
			}),
		).rejects.toThrow("Dangerous Codex parameters are not supported");
	});

	it("rejects a base ref that could be interpreted as a Git option", async () => {
		await expect(
			validateTaskPolicy({
				repositoryRoot: process.cwd(),
				baseRef: "--upload-pack=unexpected",
				prompt: "Inspect the change.",
			}),
		).rejects.toThrow("Base ref must not begin with a dash");
	});
});
