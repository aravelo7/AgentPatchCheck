import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { deriveHarnessNativeContextViews } from "../../src/agentpatchcheck/context-view";
import {
	createHarnessNativeRuntime,
	type HarnessNativeModelProvider,
} from "../../src/agentpatchcheck/harness-native-runtime";
import { createIsolatedWorkspace } from "../../src/agentpatchcheck/isolated-workspace";
import { deriveHarnessNativeResourceLedger } from "../../src/agentpatchcheck/resource-ledger";
import { HarnessNativeRuntimeEventSpine } from "../../src/agentpatchcheck/runtime-events";
import {
	fingerprintHarnessNativeWorktree,
	getHarnessNativeRuntimeRecordPath,
	HarnessNativeRuntimeRecord,
	hashHarnessNativeTaskIdentity,
	loadHarnessNativeRuntimeRecord,
} from "../../src/agentpatchcheck/runtime-record";
import { validateTaskPolicy } from "../../src/agentpatchcheck/task-policy";
import type { HarnessNativeRuntimeEvent, TaskPolicy } from "../../src/agentpatchcheck/types";
import { runGit } from "../../src/workspace/git-utils";

const temporaryPaths: string[] = [];

afterEach(async () => {
	for (const path of temporaryPaths.splice(0)) await rm(path, { recursive: true, force: true });
});

async function repository(): Promise<{ root: string; baseCommit: string }> {
	const root = await mkdtemp(join(tmpdir(), "agentpatchcheck-runtime-record-"));
	temporaryPaths.push(root);
	for (const args of [
		["init"],
		["config", "user.email", "agentpatchcheck@example.invalid"],
		["config", "user.name", "AgentPatchCheck"],
	] as const) {
		const result = await runGit(root, [...args]);
		if (!result.ok) throw new Error(result.error ?? `git ${args.join(" ")} failed`);
	}
	await writeFile(join(root, "README.md"), "before\n", "utf8");
	for (const args of [
		["add", "README.md"],
		["commit", "-m", "fixture"],
	] as const) {
		const result = await runGit(root, [...args]);
		if (!result.ok) throw new Error(result.error ?? `git ${args.join(" ")} failed`);
	}
	const head = await runGit(root, ["rev-parse", "HEAD"]);
	if (!head.ok) throw new Error(head.error ?? "Could not read fixture HEAD.");
	return { root, baseCommit: head.stdout.trim() };
}

function retrievalEvent(
	actionId: string,
): Omit<Extract<HarnessNativeRuntimeEvent, { type: "tool-result" }>, "sequence"> {
	return {
		version: 1,
		attempt: 1,
		iteration: 1,
		type: "tool-result",
		actionId,
		tool: "read-file",
		arguments: { path: "README.md" },
		status: "ok",
		observation: "before\n",
		observationSummary: "Read a regular workspace file.",
		facts: {
			kind: "retrieval",
			tool: "read-file",
			path: "README.md",
			query: null,
			inspectedPaths: ["README.md"],
			candidatePaths: [],
			search: null,
		},
	};
}

async function policyFor(root: string, baseCommit: string, worktreeRoot: string, runId: string): Promise<TaskPolicy> {
	void baseCommit;
	return await validateTaskPolicy({
		repositoryRoot: root,
		baseRef: "HEAD",
		worktreeRoot,
		runId,
		prompt: "Inspect README and finish.",
		agentAdapter: "harness-native",
		model: "test-model",
		nativeAgent: {
			credentialRef: "openai-primary",
			maxIterations: 3,
			maxToolCalls: 2,
			maxAttempts: 1,
		},
	});
}

describe("Harness-native durable Runtime record", () => {
	it("persists, reloads, and replays equivalent context and explicit unknown usage", async () => {
		const { root, baseCommit } = await repository();
		const recordPath = join(root, ".agentpatchcheck-test", "runtime.jsonl");
		const record = await HarnessNativeRuntimeRecord.open({
			path: recordPath,
			identity: {
				version: 1,
				kind: "agentpatchcheck-runtime",
				runId: "record-test",
				taskSha256: "a".repeat(64),
				worktreePath: root,
				repositoryRoot: root,
				baseCommit,
			},
		});
		const spine = new HarnessNativeRuntimeEventSpine([], record);
		spine.append({
			version: 1,
			recordedAtMs: 1_000,
			attempt: 1,
			iteration: null,
			type: "attempt-started",
			phase: "initial",
			continuationFromAttempt: null,
		});
		spine.append({
			version: 1,
			recordedAtMs: 1_001,
			attempt: 1,
			iteration: 1,
			type: "model-call-started",
			callId: "executor-1",
			owner: "executor",
		});
		spine.append({
			version: 1,
			recordedAtMs: 1_002,
			attempt: 1,
			iteration: 1,
			type: "model-call-completed",
			callId: "executor-1",
			owner: "executor",
			outcome: "succeeded",
			inputTokens: null,
			outputTokens: null,
			transportRetries: null,
			actualModel: null,
		});
		spine.append({
			version: 1,
			recordedAtMs: 1_003,
			attempt: 1,
			iteration: 1,
			type: "tool-dispatched",
			actionId: "action-1",
			tool: "read-file",
			arguments: { path: "README.md" },
		});
		spine.append(retrievalEvent("action-1"));
		spine.append({
			version: 1,
			attempt: 1,
			iteration: 1,
			type: "plan-revised",
			revision: {
				version: 1,
				revision: 1,
				iteration: 1,
				trigger: "initial-observation",
				plan: {
					version: 1,
					objective: "Apply the required change",
					steps: [{ step: "Edit the implementation", kind: "implementation", status: "in_progress" }],
				},
			},
		});
		spine.append({
			version: 1,
			attempt: 1,
			iteration: 1,
			type: "plan-execution-updated",
			actionId: "action-1",
			activeStep: {
				version: 1,
				executionId: 1,
				revision: 1,
				stepIndex: 0,
				objective: "Apply the required change",
				step: "Edit the implementation",
				attempts: 1,
				lastOutcome: "evidence",
				executionCheckpoint: null,
			},
			executionEvent: {
				version: 1,
				executionId: 1,
				actionId: "action-1",
				revision: 1,
				stepIndex: 0,
				iteration: 1,
				tool: "read-file",
				toolStatus: "ok",
				outcome: "evidence",
			},
		});

		const beforeEvents = spine.snapshot();
		const beforeView = deriveHarnessNativeContextViews(beforeEvents, 1);
		const loaded = await loadHarnessNativeRuntimeRecord(recordPath);
		const ledger = deriveHarnessNativeResourceLedger(loaded.events);

		expect(loaded.events).toEqual(beforeEvents);
		expect(deriveHarnessNativeContextViews(loaded.events, 1)).toEqual(beforeView);
		expect(beforeView.executor.activePlanStep).toMatchObject({ executionId: 1, revision: 1 });
		expect(ledger).toMatchObject({
			attempts: 1,
			executorIterations: 1,
			toolCalls: 1,
			provider: {
				total: { calls: 1, completedCalls: 1, unknownUsageCalls: 1, inputTokens: 0, outputTokens: 0 },
			},
		});
		expect(await readFile(recordPath, "utf8")).not.toContain("api_key");
	});

	it("repairs only a torn final line and rejects corruption of a complete event", async () => {
		const { root, baseCommit } = await repository();
		const recordPath = join(root, ".agentpatchcheck-test", "torn.jsonl");
		const record = await HarnessNativeRuntimeRecord.open({
			path: recordPath,
			identity: {
				version: 1,
				kind: "agentpatchcheck-runtime",
				runId: "torn-test",
				taskSha256: "d".repeat(64),
				worktreePath: root,
				repositoryRoot: root,
				baseCommit,
			},
		});
		new HarnessNativeRuntimeEventSpine([], record).append({
			version: 1,
			attempt: 1,
			iteration: null,
			type: "attempt-started",
			phase: "initial",
			continuationFromAttempt: null,
		});
		await appendFile(recordPath, '{"kind":"event"', "utf8");
		expect((await loadHarnessNativeRuntimeRecord(recordPath)).events).toHaveLength(1);
		await appendFile(recordPath, '{"kind":"event","event":{},"sha256":"bad"}\n', "utf8");
		await expect(loadHarnessNativeRuntimeRecord(recordPath)).rejects.toThrow("checksum mismatch");
	});

	it("resumes the same attempt without resetting iteration or Provider-call consumption", async () => {
		const { root, baseCommit } = await repository();
		const worktreeRoot = join(root, ".agentpatchcheck-test", "worktrees");
		const runId = "resume-test";
		const policy = await policyFor(root, baseCommit, worktreeRoot, runId);
		const workspace = await createIsolatedWorkspace({
			repositoryPath: root,
			runId,
			baseRef: "HEAD",
			baseCommit,
			worktreeRoot,
		});
		const provider: HarnessNativeModelProvider = {
			id: "test-provider",
			decide: async ({ observations }) => {
				expect(observations).toContain("before\n");
				return { decision: { kind: "finish" }, usage: { inputTokens: 7, outputTokens: 2 } };
			},
		};
		const recordPath = getHarnessNativeRuntimeRecordPath(worktreeRoot, runId);
		const record = await HarnessNativeRuntimeRecord.open({
			path: recordPath,
			identity: {
				version: 1,
				kind: "agentpatchcheck-runtime",
				runId,
				taskSha256: hashHarnessNativeTaskIdentity({
					prompt: policy.prompt,
					model: policy.model ?? "",
					provider: provider.id,
					policy: policy.nativeAgent ?? {},
				}),
				worktreePath: workspace.path,
				repositoryRoot: root,
				baseCommit,
			},
		});
		const spine = new HarnessNativeRuntimeEventSpine([], record);
		spine.append({
			version: 1,
			attempt: 1,
			iteration: null,
			type: "attempt-started",
			phase: "initial",
			continuationFromAttempt: null,
		});
		spine.append({
			version: 1,
			attempt: 1,
			iteration: 1,
			type: "model-call-started",
			callId: "attempt-1:iteration-1:executor-call-1",
			owner: "executor",
		});
		spine.append({
			version: 1,
			attempt: 1,
			iteration: 1,
			type: "model-call-completed",
			callId: "attempt-1:iteration-1:executor-call-1",
			owner: "executor",
			outcome: "succeeded",
			inputTokens: null,
			outputTokens: null,
			transportRetries: null,
			actualModel: null,
		});
		spine.append({
			version: 1,
			attempt: 1,
			iteration: 1,
			type: "tool-dispatched",
			actionId: "attempt-1:iteration-1:action-1",
			tool: "read-file",
			arguments: { path: "README.md" },
		});
		spine.append(retrievalEvent("attempt-1:iteration-1:action-1"));

		const runtime = createHarnessNativeRuntime(provider, { durable: true });
		const first = await runtime.execute({
			policy,
			worktreePath: workspace.path,
			repairContext: { phase: "initial", publicVerificationFeedback: null },
		});
		expect(first.runtime).toMatchObject({
			status: "succeeded",
			iterations: 2,
			resourceLedger: {
				executorIterations: 2,
				provider: { total: { calls: 2, unknownUsageCalls: 1, inputTokens: 7, outputTokens: 2 } },
			},
		});

		let replayProviderCalls = 0;
		const replay = await createHarnessNativeRuntime(
			{
				...provider,
				decide: async () => {
					replayProviderCalls += 1;
					return { decision: { kind: "fail" } };
				},
			},
			{ durable: true },
		).execute({
			policy,
			worktreePath: workspace.path,
			repairContext: { phase: "initial", publicVerificationFeedback: null },
		});
		expect(replayProviderCalls).toBe(0);
		expect(replay.runtimeEvents).toEqual(first.runtimeEvents);
	});

	it("fails closed when the worktree drifts or a durable tool dispatch has no result", async () => {
		const { root, baseCommit } = await repository();
		const firstPath = join(root, ".agentpatchcheck-test", "drift.jsonl");
		await HarnessNativeRuntimeRecord.open({
			path: firstPath,
			identity: {
				version: 1,
				kind: "agentpatchcheck-runtime",
				runId: "drift-test",
				taskSha256: "b".repeat(64),
				worktreePath: root,
				repositoryRoot: root,
				baseCommit,
			},
		});
		await writeFile(join(root, "README.md"), "drifted\n", "utf8");
		await expect(
			HarnessNativeRuntimeRecord.open({
				path: firstPath,
				identity: {
					version: 1,
					kind: "agentpatchcheck-runtime",
					runId: "drift-test",
					taskSha256: "b".repeat(64),
					worktreePath: root,
					repositoryRoot: root,
					baseCommit,
				},
			}),
		).rejects.toThrow("latest durable checkpoint");

		await writeFile(join(root, "README.md"), "before\n", "utf8");
		const secondPath = join(root, ".agentpatchcheck-test", "dispatch.jsonl");
		const second = await HarnessNativeRuntimeRecord.open({
			path: secondPath,
			identity: {
				version: 1,
				kind: "agentpatchcheck-runtime",
				runId: "dispatch-test",
				taskSha256: "c".repeat(64),
				worktreePath: root,
				repositoryRoot: root,
				baseCommit,
			},
		});
		const dispatchSpine = new HarnessNativeRuntimeEventSpine([], second);
		dispatchSpine.append({
			version: 1,
			attempt: 1,
			iteration: null,
			type: "attempt-started",
			phase: "initial",
			continuationFromAttempt: null,
		});
		dispatchSpine.append({
			version: 1,
			attempt: 1,
			iteration: 1,
			type: "tool-dispatched",
			actionId: "unresolved-action",
			tool: "apply-edit",
			arguments: { path: "README.md" },
		});
		await expect(
			HarnessNativeRuntimeRecord.open({
				path: secondPath,
				identity: {
					version: 1,
					kind: "agentpatchcheck-runtime",
					runId: "dispatch-test",
					taskSha256: "c".repeat(64),
					worktreePath: root,
					repositoryRoot: root,
					baseCommit,
				},
			}),
		).rejects.toThrow("unresolved tool dispatch");
	});

	it("binds a mutation checkpoint to the exact worktree content", async () => {
		const { root } = await repository();
		const before = await fingerprintHarnessNativeWorktree(root);
		await writeFile(join(root, "README.md"), "after\n", "utf8");
		const after = await fingerprintHarnessNativeWorktree(root);
		expect(after).not.toBe(before);
		expect(after).toMatch(/^[a-f0-9]{64}$/u);
	});

	it("accepts a durable checkpoint for mutation attributed on an error result", async () => {
		const { root, baseCommit } = await repository();
		const recordRoot = await mkdtemp(join(tmpdir(), "agentpatchcheck-error-mutation-record-"));
		temporaryPaths.push(recordRoot);
		const recordPath = join(recordRoot, "error-mutation.jsonl");
		const identity = {
			version: 1 as const,
			kind: "agentpatchcheck-runtime" as const,
			runId: "error-mutation-test",
			taskSha256: "e".repeat(64),
			worktreePath: root,
			repositoryRoot: root,
			baseCommit,
		};
		const record = await HarnessNativeRuntimeRecord.open({ path: recordPath, identity });
		const spine = new HarnessNativeRuntimeEventSpine([], record);
		spine.append({
			version: 1,
			attempt: 1,
			iteration: null,
			type: "attempt-started",
			phase: "initial",
			continuationFromAttempt: null,
		});
		spine.append({
			version: 1,
			attempt: 1,
			iteration: 1,
			type: "tool-dispatched",
			actionId: "failed-mutation",
			tool: "run_code",
			arguments: { codeBytes: 10 },
		});
		await writeFile(join(root, "README.md"), "after\n", "utf8");
		spine.append({
			version: 1,
			attempt: 1,
			iteration: 1,
			type: "tool-result",
			actionId: "failed-mutation",
			tool: "run_code",
			arguments: { codeBytes: 10 },
			status: "error",
			observation: "run_code failed after mutation",
			observationSummary: "run_code failed after changing one path.",
			facts: { kind: "mutation", tool: "run-code", affectedPaths: ["README.md"] },
			countsTowardToolBudget: false,
		});
		spine.append({
			version: 1,
			attempt: 1,
			iteration: 1,
			type: "worktree-checkpoint",
			actionId: "failed-mutation",
			worktreeSha256: await fingerprintHarnessNativeWorktree(root),
		});

		await expect(HarnessNativeRuntimeRecord.open({ path: recordPath, identity })).resolves.toBeDefined();
	});
});
