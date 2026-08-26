import { createHash } from "node:crypto";
import { dirname, join } from "node:path";

import { lockedFileSystem } from "../fs/locked-file-system";
import { redactSensitiveText } from "./sensitive-text";
import type {
	AgentExecution,
	AgentPatchCheckExecutionResult,
	CommandVerification,
	EvidenceBundle,
	EvidenceBundleReference,
	HarnessNativeAttemptContinuation,
	HarnessNativeAttemptReview,
	HarnessNativeExecutionPlan,
	HarnessNativePlanningResult,
	HarnessNativeRuntimeEvent,
	HarnessNativeToolResultFacts,
	PatchSnapshot,
	TaskDefinitionSnapshotReference,
	TaskPolicy,
} from "./types";

const EVIDENCE_DIRECTORY_NAME = "evidence";
const REDACTED_PROMPT = "[REDACTED_PROMPT]";
const REDACTED_RUNTIME_OBSERVATION = "[REDACTED_RUNTIME_OBSERVATION]";

function redactAttemptReview(review: HarnessNativeAttemptReview, prompt: string): HarnessNativeAttemptReview {
	return {
		...review,
		affectedPaths: review.affectedPaths.map((path) => redactSensitiveText(path, prompt)),
	};
}

function redactAttemptContinuation(
	continuation: HarnessNativeAttemptContinuation,
	prompt: string,
): HarnessNativeAttemptContinuation {
	return {
		...continuation,
		affectedPaths: continuation.affectedPaths.map((path) => redactSensitiveText(path, prompt)),
	};
}

function argumentContainsPrompt(value: string, prompt: string): boolean {
	return value.includes(prompt) || value.replaceAll("^", "").includes(prompt);
}

function redactToolResultFacts(
	facts: HarnessNativeToolResultFacts | null,
	prompt: string,
): HarnessNativeToolResultFacts | null {
	if (facts === null || facts.kind === "other" || facts.kind === "verification") return facts;
	if (facts.kind === "mutation")
		return {
			...facts,
			affectedPaths: facts.affectedPaths.map((path) => redactSensitiveText(path, prompt)),
		};
	return {
		...facts,
		path: facts.path === null ? null : redactSensitiveText(facts.path, prompt),
		query: facts.query === null ? null : redactSensitiveText(facts.query, prompt),
		inspectedPaths: facts.inspectedPaths.map((path) => redactSensitiveText(path, prompt)),
		candidatePaths: facts.candidatePaths.map((path) => redactSensitiveText(path, prompt)),
		search:
			facts.search === null
				? null
				: {
						...facts.search,
						skipped: facts.search.skipped.map((entry) => ({
							...entry,
							path: redactSensitiveText(entry.path, prompt),
						})),
					},
	};
}

function redactPlanningResult(planning: HarnessNativePlanningResult, prompt: string): HarnessNativePlanningResult {
	const redactPlan = (plan: HarnessNativeExecutionPlan): HarnessNativeExecutionPlan => ({
		...plan,
		objective: redactSensitiveText(plan.objective, prompt),
		steps: plan.steps.map((step) => ({ ...step, step: redactSensitiveText(step.step, prompt) })),
	});
	return {
		...planning,
		revisions: planning.revisions.map((revision) => ({ ...revision, plan: redactPlan(revision.plan) })),
		currentPlan: planning.currentPlan === null ? null : redactPlan(planning.currentPlan),
	};
}

function redactRuntimeEvent(event: HarnessNativeRuntimeEvent, prompt: string): HarnessNativeRuntimeEvent {
	if (event.type === "tool-result" || event.type === "tool-dispatched")
		return {
			...event,
			arguments: Object.fromEntries(
				Object.entries(event.arguments).map(([key, value]) => [
					key,
					typeof value === "string" ? redactSensitiveText(value, prompt) : value,
				]),
			),
			...(event.type === "tool-result"
				? {
						observation: REDACTED_RUNTIME_OBSERVATION,
						observationSummary: redactSensitiveText(event.observationSummary, prompt),
						facts: redactToolResultFacts(event.facts, prompt) ?? { kind: "other" },
					}
				: {}),
		};
	if (event.type === "plan-revised")
		return {
			...event,
			revision: {
				...event.revision,
				plan: {
					...event.revision.plan,
					objective: redactSensitiveText(event.revision.plan.objective, prompt),
					steps: event.revision.plan.steps.map((step) => ({
						...step,
						step: redactSensitiveText(step.step, prompt),
					})),
				},
			},
		};
	if (event.type === "plan-execution-updated")
		return {
			...event,
			activeStep:
				event.activeStep === null
					? null
					: {
							...event.activeStep,
							objective: redactSensitiveText(event.activeStep.objective, prompt),
							step: redactSensitiveText(event.activeStep.step, prompt),
						},
		};
	if (event.type === "attempt-reviewed") return { ...event, review: redactAttemptReview(event.review, prompt) };
	return { ...event };
}

function redactAgentExecution(agent: AgentExecution, prompt: string): AgentExecution {
	return {
		...agent,
		runtimeEvents: agent.runtimeEvents?.map((event) => redactRuntimeEvent(event, prompt)),
		attemptReview: agent.attemptReview === undefined ? undefined : redactAttemptReview(agent.attemptReview, prompt),
		publicVerificationRepair:
			agent.publicVerificationRepair === undefined
				? undefined
				: {
						...agent.publicVerificationRepair,
						initialChangedFiles: agent.publicVerificationRepair.initialChangedFiles.map((path) =>
							redactSensitiveText(path, prompt),
						),
					},
		attempts: agent.attempts?.map((attempt) => ({
			...attempt,
			continuation:
				attempt.continuation === undefined || attempt.continuation === null
					? attempt.continuation
					: redactAttemptContinuation(attempt.continuation, prompt),
			review: attempt.review === undefined ? undefined : redactAttemptReview(attempt.review, prompt),
			execution: redactAgentExecution(attempt.execution, prompt),
		})),
		runtime:
			agent.runtime === undefined
				? undefined
				: {
						...agent.runtime,
						runtimeEvents: agent.runtime.runtimeEvents?.map((event) => redactRuntimeEvent(event, prompt)),
						planning:
							agent.runtime.planning === undefined
								? undefined
								: redactPlanningResult(agent.runtime.planning, prompt),
						workingContext: {
							...agent.runtime.workingContext,
							inspectedPaths: agent.runtime.workingContext.inspectedPaths.map((path) =>
								redactSensitiveText(path, prompt),
							),
							candidatePaths: agent.runtime.workingContext.candidatePaths.map((path) =>
								redactSensitiveText(path, prompt),
							),
							retrieval: {
								...agent.runtime.workingContext.retrieval,
								recent: agent.runtime.workingContext.retrieval.recent.map((entry) => ({
									...entry,
									path: entry.path === null ? null : redactSensitiveText(entry.path, prompt),
									query: entry.query === null ? null : redactSensitiveText(entry.query, prompt),
									summary: redactSensitiveText(entry.summary, prompt),
									search:
										entry.search === null
											? null
											: {
													...entry.search,
													skipped: entry.search.skipped.map((skip) => ({
														...skip,
														path: redactSensitiveText(skip.path, prompt),
													})),
												},
								})),
							},
							mutation: {
								...agent.runtime.workingContext.mutation,
								paths: agent.runtime.workingContext.mutation.paths.map((path) =>
									redactSensitiveText(path, prompt),
								),
							},
						},
						trajectory: agent.runtime.trajectory.map((step) => ({
							...step,
							arguments:
								step.arguments === null
									? null
									: Object.fromEntries(
											Object.entries(step.arguments).map(([key, value]) => [
												key,
												typeof value === "string" ? redactSensitiveText(value, prompt) : value,
											]),
										),
							facts: redactToolResultFacts(step.facts, prompt),
						})),
						shadowControlPlane:
							agent.runtime.shadowControlPlane === undefined
								? undefined
								: {
										...agent.runtime.shadowControlPlane,
										finalState: {
											...agent.runtime.shadowControlPlane.finalState,
											visitedPaths: agent.runtime.shadowControlPlane.finalState.visitedPaths.map((path) =>
												redactSensitiveText(path, prompt),
											),
											inspectedPaths: agent.runtime.shadowControlPlane.finalState.inspectedPaths.map(
												(path) => redactSensitiveText(path, prompt),
											),
											candidatePaths: agent.runtime.shadowControlPlane.finalState.candidatePaths.map(
												(path) => redactSensitiveText(path, prompt),
											),
											mutation: {
												...agent.runtime.shadowControlPlane.finalState.mutation,
												affectedPaths:
													agent.runtime.shadowControlPlane.finalState.mutation.affectedPaths.map((path) =>
														redactSensitiveText(path, prompt),
													),
											},
										},
										evolution: agent.runtime.shadowControlPlane.evolution.map((entry) => ({
											...entry,
											state: {
												...entry.state,
												visitedPaths: entry.state.visitedPaths.map((path) =>
													redactSensitiveText(path, prompt),
												),
												inspectedPaths: entry.state.inspectedPaths.map((path) =>
													redactSensitiveText(path, prompt),
												),
												candidatePaths: entry.state.candidatePaths.map((path) =>
													redactSensitiveText(path, prompt),
												),
												mutation: {
													...entry.state.mutation,
													affectedPaths: entry.state.mutation.affectedPaths.map((path) =>
														redactSensitiveText(path, prompt),
													),
												},
											},
										})),
									},
					},
		clineRuntime:
			agent.clineRuntime === undefined
				? undefined
				: {
						...agent.clineRuntime,
						trajectory: agent.clineRuntime.trajectory.map((step) => ({
							...step,
							arguments:
								step.arguments === null
									? null
									: Object.fromEntries(
											Object.entries(step.arguments).map(([key, value]) => [
												key,
												typeof value === "string" ? redactSensitiveText(value, prompt) : value,
											]),
										),
							rejection:
								step.rejection === null
									? null
									: {
											...step.rejection,
											detail: redactSensitiveText(step.rejection.detail, prompt),
										},
							observationSummary:
								step.observationSummary === null ? null : redactSensitiveText(step.observationSummary, prompt),
						})),
					},
		args: agent.args.map((arg) =>
			argumentContainsPrompt(arg, prompt) ? REDACTED_PROMPT : redactSensitiveText(arg, prompt),
		),
		stdout: redactSensitiveText(agent.stdout, prompt),
		stderr: redactSensitiveText(agent.stderr, prompt),
	};
}

function redactPatchSnapshot(patch: PatchSnapshot, prompt: string): PatchSnapshot {
	return {
		...patch,
		changedFiles: patch.changedFiles.map((path) => redactSensitiveText(path, prompt)),
		trackedPatch: redactSensitiveText(patch.trackedPatch, prompt),
	};
}

function redactCommandVerification(verification: CommandVerification, prompt: string): CommandVerification {
	return {
		...verification,
		commands: verification.commands.map((command) => ({
			...command,
			args: command.args.map((arg) => redactSensitiveText(arg, prompt)),
			stdout: redactSensitiveText(command.stdout, prompt),
			stderr: redactSensitiveText(command.stderr, prompt),
		})),
	};
}

export function getEvidenceBundlePath(worktreeRoot: string, runId: string): string {
	return join(dirname(worktreeRoot), EVIDENCE_DIRECTORY_NAME, `${runId}.json`);
}

export function createEvidenceBundle(options: {
	policy: TaskPolicy;
	execution: AgentPatchCheckExecutionResult;
	taskDefinition?: TaskDefinitionSnapshotReference;
	createdAt?: Date;
}): EvidenceBundle {
	const createdAt = (options.createdAt ?? new Date()).toISOString();
	const promptSha256 = createHash("sha256").update(options.policy.prompt, "utf8").digest("hex");
	const publicVerificationRepairInstruction =
		options.policy.publicVerificationRepairInstruction === null
			? null
			: {
					length: options.policy.publicVerificationRepairInstruction.length,
					sha256: createHash("sha256")
						.update(options.policy.publicVerificationRepairInstruction, "utf8")
						.digest("hex"),
				};
	const agent = redactAgentExecution(options.execution.agent, options.policy.prompt);
	const patch = redactPatchSnapshot(options.execution.patch, options.policy.prompt);
	const commandVerification = redactCommandVerification(options.execution.commandVerification, options.policy.prompt);
	const trackedPatchSha256 = createHash("sha256").update(patch.trackedPatch, "utf8").digest("hex");

	return {
		version: 1,
		createdAt,
		taskDefinition: options.taskDefinition,
		policy: {
			repositoryRoot: options.policy.repositoryRoot,
			baseRef: options.policy.baseRef,
			baseCommit: options.policy.baseCommit,
			worktreeRoot: options.policy.worktreeRoot,
			promptLength: options.policy.prompt.length,
			promptSha256,
			executionBootstrap: options.policy.executionBootstrap,
			publicVerificationRepairInstruction,
			codexExecutable: options.policy.codexExecutable ?? null,
			agentAdapter: options.policy.agentAdapter,
			model: options.policy.model ?? null,
			timeoutMs: options.policy.timeoutMs,
			sandbox: options.policy.sandbox,
			allowNetwork: options.policy.allowNetwork,
			allowDangerousParameters: false,
			verification: options.policy.verification,
			verificationProfile: options.policy.verificationProfile,
			riskPolicy: options.policy.riskPolicy,
			hiddenOracle:
				options.policy.hiddenOracle === null
					? null
					: {
							configured: true,
							timeoutMs: options.policy.hiddenOracle.timeoutMs,
							isolation: options.policy.hiddenOracle.isolation,
							memoryLimitBytes: options.policy.hiddenOracle.memoryLimitBytes,
							cpuRatePercent: options.policy.hiddenOracle.cpuRatePercent,
						},
			patchExpectation: options.policy.patchExpectation,
		},
		repository: {
			root: options.execution.workspace.repositoryPath,
			baseRef: options.execution.workspace.baseRef,
			baseCommit: options.execution.workspace.baseCommit,
		},
		workspace: options.execution.workspace,
		executionBootstrap: options.execution.executionBootstrap,
		agent,
		commandVerification,
		hiddenOracle: options.execution.hiddenOracle,
		patch: {
			...patch,
			trackedPatchSha256,
		},
		result: {
			status: options.execution.status,
			durationMs: options.execution.agent.durationMs,
		},
	};
}

export async function writeEvidenceBundle(options: {
	path: string;
	bundle: EvidenceBundle;
}): Promise<EvidenceBundleReference> {
	await lockedFileSystem.writeJsonFileAtomic(options.path, options.bundle);
	return {
		path: options.path,
		createdAt: options.bundle.createdAt,
	};
}
