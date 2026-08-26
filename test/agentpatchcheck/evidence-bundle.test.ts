import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	createEvidenceBundle,
	getEvidenceBundlePath,
	writeEvidenceBundle,
} from "../../src/agentpatchcheck/evidence-bundle";
import { validateTaskPolicy } from "../../src/agentpatchcheck/task-policy";
import type { AgentPatchCheckExecutionResult } from "../../src/agentpatchcheck/types";

describe("EvidenceBundle", () => {
	it("captures execution evidence while redacting the prompt and credentials", async () => {
		const prompt = "Inspect API_KEY=super-secret-value";
		const policy = await validateTaskPolicy({
			repositoryRoot: process.cwd(),
			prompt,
			runId: "evidence-test",
			verificationProfile: {
				path: "D:\\profiles\\node-version.json",
				name: "node-version",
				sha256: "a".repeat(64),
			},
		});
		const execution: AgentPatchCheckExecutionResult = {
			status: "failed",
			workspace: {
				runId: "evidence-test",
				repositoryPath: process.cwd(),
				path: join(process.cwd(), ".agentpatchcheck", "worktrees", "evidence-test"),
				baseRef: "HEAD",
				baseCommit: policy.baseCommit,
			},
			agent: {
				executable: "codex",
				args: ["exec", `cmd.exe /c Do^ not^ run^ ${prompt}`],
				exitCode: 1,
				signal: null,
				stdout: `Bearer abcdefghijklmnop ${prompt}`,
				stderr: "password=super-secret-value",
				durationMs: 42,
				timedOut: false,
				attemptReview: {
					version: 1,
					attempt: 1,
					decision: "stop",
					reason: "terminal-termination",
					successfulMutationCount: 1,
					affectedPaths: [prompt],
					latestVerificationOutcome: null,
					executionCheckpoint: null,
					remainingAttempts: 1,
					remainingTimeMs: 1_000,
				},
				publicVerificationRepair: {
					eligible: false,
					reason: "initial-agent-failed",
					initialChangedFiles: [prompt],
				},
				runtime: {
					version: 1,
					provider: "openai:responses",
					providerIdentity: {
						provider: "openai",
						protocol: "responses",
						thinkingMode: "default",
						endpointSha256: "b".repeat(64),
						credentialRef: "openai-primary",
						implementation: "openai-compatible-v1",
						configuredModel: "test-model",
						actualModel: "test-model",
					},
					model: "test-model",
					status: "failed",
					terminationReason: "model-failed",
					providerFailure: {
						kind: "malformed-response",
						detail: "invalid-tool-arguments",
						code: null,
						httpStatus: null,
						requestId: "req_test-123",
						validationIssue: {
							path: "$.plan[0].status",
							issue: "invalid-enum",
							receivedType: "string",
							constraint: "plan-step-status",
						},
					},
					iterations: 2,
					toolCalls: 1,
					rejectedToolCalls: 0,
					transportRetries: 0,
					budget: {
						maxIterations: 2,
						maxToolCalls: 2,
						maxRejectedToolCalls: 4,
						maxObservationBytes: 1024,
						maxTransportRetries: 0,
					},
					usage: { inputTokens: null, outputTokens: null },
					trajectory: [
						{
							iteration: 1,
							decision: "tool",
							tool: "read-file",
							arguments: { path: prompt },
							toolStatus: "ok",
							observationSummary: "Read a regular workspace file.",
							facts: {
								kind: "retrieval",
								tool: "read-file",
								path: prompt,
								query: null,
								inspectedPaths: [prompt],
								candidatePaths: [],
								search: null,
							},
						},
					],
					convergenceCheckpoint: {
						version: 1,
						triggered: false,
						triggerIteration: null,
						discoveryActionsAtTrigger: null,
						successfulFileReadsAtTrigger: null,
						mutationActionsAtTrigger: null,
						targetedRetrieval: null,
						firstMutationIteration: null,
						firstPublicVerificationIteration: null,
						finishIteration: null,
						outcome: "not-triggered",
					},
					historyProjection: {
						version: 1,
						canonicalInteractionCount: 9,
						projectedInteractionCount: 4,
						elidedInteractionCount: 5,
						canonicalObservationCount: 9,
						projectedObservationCount: 4,
						elidedObservationCount: 5,
						retainedInteractionIterations: [4, 5, 6, 7],
					},
					workingContext: {
						version: 1,
						phase: "failed",
						inspectedPaths: [prompt],
						candidatePaths: [],
						retrieval: { successfulActions: 1, rejectedActions: 0, recent: [] },
						mutation: { successfulActions: 0, paths: [], firstIteration: null },
						publicVerification: { runs: 0, latestStatus: null, latestIteration: null },
					},
					planning: {
						version: 1,
						enabled: true,
						maxRevisions: 4,
						revisions: [
							{
								version: 1,
								revision: 1,
								iteration: 1,
								trigger: "initial-observation",
								plan: {
									version: 1,
									objective: prompt,
									steps: [
										{ step: `Inspect ${prompt}`, kind: "diagnosis", status: "completed" },
										{ step: "Implement repair", kind: "implementation", status: "in_progress" },
									],
								},
							},
						],
						currentPlan: {
							version: 1,
							objective: prompt,
							steps: [
								{ step: `Inspect ${prompt}`, kind: "diagnosis", status: "completed" },
								{ step: "Implement repair", kind: "implementation", status: "in_progress" },
							],
						},
					},
				},
			},
			patch: {
				changedFiles: ["README.md"],
				trackedPatch: "diff --git a/README.md b/README.md\n",
			},
			commandVerification: {
				status: "not-run",
				cwd: join(process.cwd(), ".agentpatchcheck", "worktrees", "evidence-test"),
				commands: [],
			},
		};

		const bundle = createEvidenceBundle({
			policy,
			execution,
			taskDefinition: {
				version: 1,
				path: "D:\\repo\\.agentpatchcheck\\task-definitions\\definition.json",
				sha256: "c".repeat(64),
			},
			createdAt: new Date("2026-08-07T00:00:00.000Z"),
		});
		const serialized = JSON.stringify(bundle);

		expect(bundle.policy.promptLength).toBe(prompt.length);
		expect(bundle.taskDefinition).toEqual({
			version: 1,
			path: "D:\\repo\\.agentpatchcheck\\task-definitions\\definition.json",
			sha256: "c".repeat(64),
		});
		expect(bundle.policy.promptSha256).toMatch(/^[a-f0-9]{64}$/u);
		expect(bundle.policy.verificationProfile).toEqual({
			path: "D:\\profiles\\node-version.json",
			name: "node-version",
			sha256: "a".repeat(64),
		});
		expect(bundle.policy.riskPolicy).toMatchObject({
			configuration: { maxChangedFiles: 25, maxTrackedPatchBytes: 131_072 },
			profile: null,
		});
		expect(bundle.result).toEqual({ status: "failed", durationMs: 42 });
		expect(serialized).not.toContain("super-secret-value");
		expect(serialized).not.toContain("abcdefghijklmnop");
		expect(serialized).not.toContain("https://api.openai.com/v1");
		expect(serialized).toContain("[REDACTED_PROMPT]");
		expect(bundle.agent.runtime?.providerFailure).toEqual({
			kind: "malformed-response",
			detail: "invalid-tool-arguments",
			code: null,
			httpStatus: null,
			requestId: "req_test-123",
			validationIssue: {
				path: "$.plan[0].status",
				issue: "invalid-enum",
				receivedType: "string",
				constraint: "plan-step-status",
			},
		});
		expect(serialized).toContain("[REDACTED_SECRET]");
		expect(bundle.agent.runtime?.trajectory[0]?.arguments?.path).toBe("[REDACTED_PROMPT]");
		expect(bundle.agent.runtime?.historyProjection).toEqual({
			version: 1,
			canonicalInteractionCount: 9,
			projectedInteractionCount: 4,
			elidedInteractionCount: 5,
			canonicalObservationCount: 9,
			projectedObservationCount: 4,
			elidedObservationCount: 5,
			retainedInteractionIterations: [4, 5, 6, 7],
		});
		expect(bundle.agent.publicVerificationRepair?.initialChangedFiles).toEqual(["[REDACTED_PROMPT]"]);
		expect(bundle.agent.attemptReview?.affectedPaths).toEqual(["[REDACTED_PROMPT]"]);
	});

	it("writes the bundle atomically outside the worktree", async () => {
		const evidenceRoot = await mkdtemp(join(tmpdir(), "agentpatchcheck-evidence-"));
		try {
			const path = getEvidenceBundlePath(join(evidenceRoot, "worktrees"), "run-1");
			const reference = await writeEvidenceBundle({
				path,
				bundle: {
					version: 1,
					createdAt: "2026-08-07T00:00:00.000Z",
					policy: {
						repositoryRoot: "D:\\repo",
						baseRef: "HEAD",
						baseCommit: "abc123",
						worktreeRoot: join(evidenceRoot, "worktrees"),
						promptLength: 4,
						promptSha256: "hash",
						codexExecutable: null,
						model: null,
						timeoutMs: 1_000,
						sandbox: "read-only",
						allowNetwork: false,
						allowDangerousParameters: false,
						verification: {
							commands: [],
							outputLimitBytes: 1_000,
							allowShell: false,
							allowNetwork: false,
						},
						verificationProfile: null,
						patchExpectation: "changes-required",
					},
					repository: { root: "D:\\repo", baseRef: "HEAD", baseCommit: "abc123" },
					workspace: {
						runId: "run-1",
						repositoryPath: "D:\\repo",
						path: join(evidenceRoot, "worktrees", "run-1"),
						baseRef: "HEAD",
						baseCommit: "abc123",
					},
					agent: {
						executable: "codex",
						args: ["exec"],
						exitCode: 0,
						signal: null,
						stdout: "done",
						stderr: "",
						durationMs: 1,
						timedOut: false,
					},
					patch: {
						changedFiles: [],
						trackedPatch: "",
						trackedPatchSha256: "hash",
					},
					commandVerification: {
						status: "not-run",
						cwd: join(evidenceRoot, "worktrees", "run-1"),
						commands: [],
					},
					result: { status: "succeeded", durationMs: 1 },
				},
			});

			expect(reference.path).toBe(path);
			expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
				version: 1,
				result: { status: "succeeded" },
			});
		} finally {
			await rm(evidenceRoot, { recursive: true, force: true });
		}
	});
});
