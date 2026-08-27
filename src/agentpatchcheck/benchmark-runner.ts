import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	buildWindowsCmdArgsCommandLine,
	resolveWindowsComSpec,
	shouldUseWindowsCmdLaunch,
} from "../core/windows-cmd-launch";
import { lockedFileSystem } from "../fs/locked-file-system";
import { getApprovalRecordPath, getApprovalState, readApprovalRecord } from "./approval";
import { HEADLESS_CLI_VERSION } from "./cli-version";
import { applyDeepSeekV4ModelSelection, type DeepSeekV4Model } from "./deepseek-v4-model";
import { executeAgentPatchCheck } from "./execute";
import { readEvidenceBundle } from "./git-patch-verifier";
import { evaluateRiskPolicy } from "./risk-policy";
import { createRunId as createCompactRunId, type RunIdentityInput } from "./run-identity";
import { validateTaskPolicy } from "./task-policy";
import { loadTaskSpec } from "./task-spec";
import type {
	AgentPatchCheckResult,
	BenchmarkDefinition,
	BenchmarkFailureClassification,
	BenchmarkRepairCycleResult,
	BenchmarkReport,
	BenchmarkReportReference,
	BenchmarkResult,
	BenchmarkTaskResult,
	BenchmarkTaskStatus,
	TaskPolicyInput,
} from "./types";

interface BenchmarkDependencies {
	loadTaskSpec: (path: string) => Promise<TaskPolicyInput>;
	validateTaskPolicy: typeof validateTaskPolicy;
	execute: typeof executeAgentPatchCheck;
	writeReport: typeof writeBenchmarkReport;
	createRunId: (identity: RunIdentityInput) => string;
	readEvidence: typeof readEvidenceBundle;
	readAgentVersion: (executable: string) => Promise<string | null>;
}

export interface BenchmarkRunConfiguration {
	deepseekModel?: DeepSeekV4Model;
}

const allStatuses: BenchmarkTaskStatus[] = [
	"passed",
	"timed-out",
	"agent-failed",
	"verification-failed",
	"hidden-oracle-failed",
	"hidden-oracle-error",
	"assessment-failed",
	"setup-failed",
];

async function readAgentVersion(executable: string): Promise<string | null> {
	return await new Promise((resolveVersion) => {
		const windowsCmd = shouldUseWindowsCmdLaunch(executable, process.platform, process.env);
		const child = spawn(
			windowsCmd ? resolveWindowsComSpec(process.env) : executable,
			windowsCmd
				? ["/d", "/s", "/c", buildWindowsCmdArgsCommandLine(executable, ["--version"]).slice("/d /s /c ".length)]
				: ["--version"],
			{ stdio: ["ignore", "pipe", "ignore"], windowsHide: true, windowsVerbatimArguments: windowsCmd },
		);
		let output = "";
		const timeout = setTimeout(() => child.kill(), 5_000);
		child.stdout?.on("data", (chunk: Buffer | string) => {
			output = `${output}${chunk.toString()}`.slice(0, 4_096);
		});
		child.once("error", () => {
			clearTimeout(timeout);
			resolveVersion(null);
		});
		child.once("close", (code) => {
			clearTimeout(timeout);
			resolveVersion(code === 0 && output.trim() ? (output.trim().split(/\r?\n/u)[0] ?? null) : null);
		});
	});
}

async function createTaskExecutionIdentity(
	policy: Awaited<ReturnType<typeof validateTaskPolicy>>,
	result: AgentPatchCheckResult,
	readVersion: (executable: string) => Promise<string | null>,
): Promise<BenchmarkTaskResult["executionIdentity"]> {
	const requestedExecutable =
		policy.agentAdapter === "script"
			? process.execPath
			: policy.agentAdapter === "harness-native"
				? "harness-native"
				: (policy.codexExecutable ?? "codex");
	let hiddenOracleSha256: string | null = null;
	if (policy.hiddenOracle !== null) {
		try {
			hiddenOracleSha256 = createHash("sha256")
				.update(await readFile(policy.hiddenOracle.scriptPath))
				.digest("hex");
		} catch {
			hiddenOracleSha256 = null;
		}
	}
	return {
		baseCommit: policy.baseCommit,
		hiddenOracleSha256,
		modelProvider:
			policy.nativeAgent === null || policy.model === undefined
				? null
				: {
						provider: policy.nativeAgent.modelProvider.provider,
						protocol: policy.nativeAgent.modelProvider.protocol,
						thinkingMode: policy.nativeAgent.modelProvider.thinkingMode,
						endpointSha256: policy.nativeAgent.modelProvider.endpointSha256,
						credentialRef: policy.nativeAgent.modelProvider.credentialRef,
						implementation: policy.nativeAgent.modelProvider.implementation,
						configuredModel: policy.model,
						actualModel: result.agent.runtime?.providerIdentity.actualModel ?? null,
					},
		agent: {
			requestedExecutable,
			launchExecutable: result.agent.executable,
			version:
				policy.agentAdapter === "harness-native" ? (policy.model ?? null) : await readVersion(requestedExecutable),
		},
	};
}

function classifyTask(result: AgentPatchCheckResult): BenchmarkTaskStatus {
	if (result.agent.timedOut) return "timed-out";
	if (result.status !== "succeeded") return "agent-failed";
	if (result.commandVerification.status === "failed") return "verification-failed";
	if (result.hiddenOracle?.status === "failed") return "hidden-oracle-failed";
	if (result.hiddenOracle?.status === "timed-out" || result.hiddenOracle?.status === "error")
		return "hidden-oracle-error";
	if (result.assessment.report.verdict.status !== "pass") return "assessment-failed";
	return "passed";
}

function classifySemanticResult(result: AgentPatchCheckResult): BenchmarkFailureClassification["semantic"] {
	if (result.commandVerification.status === "failed") return "public-verification-failed";
	if (result.hiddenOracle?.status === "failed") return "hidden-oracle-failed";
	if (result.hiddenOracle?.status === "timed-out" || result.hiddenOracle?.status === "error")
		return "hidden-oracle-error";
	if (result.commandVerification.status === "passed" || result.hiddenOracle?.status === "passed") return "passed";
	if (result.assessment.report.verdict.status !== "pass") return "assessment-failed";
	if (result.commandVerification.status === "not-run") return "not-evaluated";
	return "passed";
}

function classifyFailure(result: AgentPatchCheckResult): BenchmarkFailureClassification {
	const semantic = classifySemanticResult(result);
	const runtime = result.agent.runtime;
	const execution: BenchmarkFailureClassification["execution"] = result.agent.timedOut
		? "timed-out"
		: result.status === "succeeded"
			? "completed"
			: runtime?.providerFailure !== null && runtime?.providerFailure !== undefined
				? "provider-failed"
				: runtime?.terminationReason === "tool-limit"
					? "tool-budget-exhausted"
					: runtime?.terminationReason === "iteration-limit"
						? "iteration-budget-exhausted"
						: runtime?.terminationReason === "rejected-tool-limit"
							? "rejected-tool-budget-exhausted"
							: "agent-execution-failed";
	return {
		execution,
		completion:
			result.status === "succeeded"
				? "completed"
				: semantic === "passed"
					? "completion-noncompliant"
					: "not-reached",
		semantic,
	};
}

function createRepairCycle(
	policy: Awaited<ReturnType<typeof validateTaskPolicy>>,
	result: AgentPatchCheckResult,
): BenchmarkRepairCycleResult | null {
	if (policy.agentAdapter !== "harness-native") return null;
	const withDecision = (cycle: BenchmarkRepairCycleResult): BenchmarkRepairCycleResult =>
		result.agent.publicVerificationRepair === undefined
			? cycle
			: { ...cycle, decision: result.agent.publicVerificationRepair };
	const attempts = result.agent.attempts ?? [];
	const repairAttemptIndex = attempts.findIndex((attempt) => attempt.phase === "public-verification-repair");
	const repairAttempt = repairAttemptIndex < 0 ? undefined : attempts[repairAttemptIndex];
	const initialAgent = repairAttemptIndex < 0 ? result.agent : attempts[repairAttemptIndex - 1]?.execution;
	const repairFinalAgent = repairAttemptIndex < 0 ? undefined : attempts.at(-1)?.execution;
	if (initialAgent === undefined) throw new Error("Public verification repair is missing its initial attempt.");
	const initialVerificationStatus = repairAttempt?.feedback?.status ?? result.commandVerification.status;
	if (initialAgent.timedOut)
		return withDecision({
			attempted: false,
			initialVerificationStatus,
			finalVerificationStatus: result.commandVerification.status,
			outcome: "initial-agent-timed-out",
		});
	if (initialAgent.exitCode !== 0)
		return withDecision({
			attempted: false,
			initialVerificationStatus,
			finalVerificationStatus: result.commandVerification.status,
			outcome: "initial-agent-failed",
		});
	if (repairAttempt === undefined)
		return withDecision({
			attempted: false,
			initialVerificationStatus,
			finalVerificationStatus: result.commandVerification.status,
			outcome: result.commandVerification.status === "passed" ? "initial-pass" : "initial-verification-not-run",
		});
	if (repairFinalAgent?.timedOut)
		return withDecision({
			attempted: true,
			initialVerificationStatus,
			finalVerificationStatus: result.commandVerification.status,
			outcome: "repair-timed-out",
		});
	return withDecision({
		attempted: true,
		initialVerificationStatus,
		finalVerificationStatus: result.commandVerification.status,
		outcome: result.commandVerification.status === "passed" ? "repaired" : "repair-failed",
	});
}

function createNativeRuntimeSummary(result: AgentPatchCheckResult): BenchmarkTaskResult["nativeRuntime"] {
	const executions = result.agent.attempts?.map((attempt) => attempt.execution) ?? [result.agent];
	const runtimes = executions.flatMap((execution) => (execution.runtime === undefined ? [] : [execution.runtime]));
	if (runtimes.length === 0) return null;
	return {
		attempts: executions.length,
		iterations: runtimes.reduce((total, runtime) => total + runtime.iterations, 0),
		toolCalls: runtimes.reduce((total, runtime) => total + runtime.toolCalls, 0),
		rejectedToolCalls: runtimes.reduce((total, runtime) => total + runtime.rejectedToolCalls, 0),
		transportRetries: runtimes.reduce((total, runtime) => total + runtime.transportRetries, 0),
		protocolRecoveries: runtimes.reduce((total, runtime) => total + (runtime.protocolRecoveries ?? 0), 0),
		completionDeferrals: runtimes.reduce((total, runtime) => total + (runtime.completionDeferrals ?? 0), 0),
		providerFailureKinds: runtimes.flatMap((runtime) =>
			runtime.providerFailure === null ? [] : [runtime.providerFailure.kind],
		),
	};
}

function createSummary(tasks: BenchmarkTaskResult[]): BenchmarkReport["summary"] {
	const byStatus = Object.fromEntries(allStatuses.map((status) => [status, 0])) as Record<BenchmarkTaskStatus, number>;
	for (const task of tasks) byStatus[task.status] += 1;
	const countClassifications = <T extends string>(
		selector: (classification: BenchmarkFailureClassification) => T,
	): Partial<Record<T, number>> => {
		const counts: Partial<Record<T, number>> = {};
		for (const task of tasks) {
			const classification = task.failureClassification;
			if (classification === undefined) continue;
			const value = selector(classification);
			counts[value] = (counts[value] ?? 0) + 1;
		}
		return counts;
	};
	const failures = allStatuses
		.filter((status) => status !== "passed" && byStatus[status] > 0)
		.map((status) => `${status}=${byStatus[status]}`);
	const repairCycles = tasks.flatMap((task) =>
		task.repairCycle === null || task.repairCycle === undefined ? [] : [task.repairCycle],
	);
	const repairCycleSummary =
		repairCycles.length === 0
			? null
			: {
					nativeTasks: repairCycles.length,
					initialPasses: repairCycles.filter((cycle) => cycle.outcome === "initial-pass").length,
					attempted: repairCycles.filter((cycle) => cycle.attempted).length,
					repaired: repairCycles.filter((cycle) => cycle.outcome === "repaired").length,
					failed: repairCycles.filter((cycle) => cycle.outcome === "repair-failed").length,
					timedOut: repairCycles.filter(
						(cycle) => cycle.outcome === "initial-agent-timed-out" || cycle.outcome === "repair-timed-out",
					).length,
				};
	const nativeTasks = tasks.filter((task) => task.configuration.agentAdapter === "harness-native");
	const nativeQuality =
		nativeTasks.length === 0
			? null
			: {
					nativeTasks: nativeTasks.length,
					initialPublicVerificationPassed: nativeTasks.filter(
						(task) => task.repairCycle?.outcome === "initial-pass",
					).length,
					publicRepairAttempted: nativeTasks.filter((task) => task.repairCycle?.attempted).length,
					publicRepairRecovered: nativeTasks.filter((task) => task.repairCycle?.outcome === "repaired").length,
					finalPublicVerificationPassed: nativeTasks.filter((task) => task.verificationStatus === "passed").length,
					hiddenOraclePassed: nativeTasks.filter((task) => task.hiddenOracleStatus === "passed").length,
					transportRetries: nativeTasks.reduce(
						(total, task) => total + (task.nativeRuntime?.transportRetries ?? 0),
						0,
					),
					rejectedToolCalls: nativeTasks.reduce(
						(total, task) => total + (task.nativeRuntime?.rejectedToolCalls ?? 0),
						0,
					),
					providerFailureTasks: nativeTasks.filter(
						(task) => (task.nativeRuntime?.providerFailureKinds.length ?? 0) > 0,
					).length,
					agentExecutionFailureTasks: nativeTasks.filter(
						(task) =>
							task.status === "agent-failed" && (task.nativeRuntime?.providerFailureKinds.length ?? 0) === 0,
					).length,
				};
	return {
		total: tasks.length,
		passed: byStatus.passed,
		failed: tasks.length - byStatus.passed,
		byStatus,
		failureClassification: {
			byExecution: countClassifications((classification) => classification.execution),
			byCompletion: countClassifications((classification) => classification.completion),
			bySemantic: countClassifications((classification) => classification.semantic),
		},
		summaryText:
			failures.length === 0
				? `${byStatus.passed}/${tasks.length} tasks passed.`
				: `${byStatus.passed}/${tasks.length} tasks passed; ${tasks.length - byStatus.passed} failed (${failures.join(", ")}).`,
		...(repairCycleSummary === null ? {} : { repairCycles: repairCycleSummary }),
		...(nativeQuality === null ? {} : { nativeQuality }),
	};
}

export function getBenchmarkReportPath(worktreeRoot: string, runId: string): string {
	return join(dirname(worktreeRoot), "benchmarks", `${runId}.json`);
}

function getBenchmarkWorktreeRoot(input: TaskPolicyInput): string {
	return input.worktreeRoot ?? join(input.repositoryRoot, ".agentpatchcheck", "worktrees");
}

export async function writeBenchmarkReport(options: {
	path: string;
	report: BenchmarkReport;
}): Promise<BenchmarkReportReference> {
	await lockedFileSystem.writeJsonFileAtomic(options.path, options.report);
	return { path: options.path, createdAt: options.report.createdAt };
}

const defaultDependencies: BenchmarkDependencies = {
	loadTaskSpec,
	validateTaskPolicy,
	execute: executeAgentPatchCheck,
	writeReport: writeBenchmarkReport,
	createRunId: (identity) => createCompactRunId(identity, "bm"),
	readEvidence: readEvidenceBundle,
	readAgentVersion,
};

export async function runBenchmark(
	definition: BenchmarkDefinition,
	dependencies: Partial<BenchmarkDependencies> = {},
	configuration: BenchmarkRunConfiguration = {},
): Promise<BenchmarkResult> {
	const resolvedDependencies = { ...defaultDependencies, ...dependencies };
	const benchmarkIdentity: RunIdentityInput = {
		experiment: definition.suite?.id ?? definition.name ?? "benchmark",
		task: definition.sourceSha256,
		variant: definition.variant ?? "suite",
		attempt: definition.attempt ?? 1,
		benchmark: definition.sourcePath,
	};
	const runId = resolvedDependencies.createRunId(benchmarkIdentity);
	const tasks: BenchmarkTaskResult[] = [];
	let benchmarkWorktreeRoot: string | null = null;
	for (const task of definition.tasks) {
		const startedAt = Date.now();
		try {
			const input = applyDeepSeekV4ModelSelection(
				await resolvedDependencies.loadTaskSpec(task.taskSpecPath),
				configuration.deepseekModel,
			);
			benchmarkWorktreeRoot ??= getBenchmarkWorktreeRoot(input);
			const taskIdentity: RunIdentityInput = {
				experiment: definition.suite?.id ?? definition.name ?? "benchmark",
				task: task.id,
				variant: definition.variant ?? input.model ?? input.agentAdapter ?? "default",
				attempt: definition.attempt ?? 1,
				repository: input.repositoryRoot,
				benchmark: definition.sourcePath,
			};
			const taskRunId = input.runId ?? createCompactRunId(taskIdentity, "bm");
			const policy = await resolvedDependencies.validateTaskPolicy({
				...input,
				runId: taskRunId,
				runIdentity: input.runIdentity ?? taskIdentity,
			});
			const result = await resolvedDependencies.execute(policy);
			const failureClassification = classifyFailure(result);
			const executionIdentity = await createTaskExecutionIdentity(
				policy,
				result,
				resolvedDependencies.readAgentVersion,
			);
			let riskLevel: BenchmarkTaskResult["riskLevel"] = null;
			let approvalStatus: BenchmarkTaskResult["approvalStatus"] = null;
			try {
				const bundle = await resolvedDependencies.readEvidence(result.evidence.path);
				const risk = evaluateRiskPolicy(bundle, result.assessment.report);
				riskLevel = risk.level;
				approvalStatus = getApprovalState(
					await readApprovalRecord(getApprovalRecordPath(result.evidence.path)),
					result.evidence,
					risk,
				).status;
			} catch {
				riskLevel = null;
			}
			tasks.push({
				taskId: task.id,
				runId: policy.runId,
				taskSpecPath: task.taskSpecPath,
				configuration: {
					taskSpecSha256: task.taskSpecSha256,
					expectedStatus: task.expectedStatus,
					verificationProfile: policy.verificationProfile,
					riskPolicyProfile: policy.riskPolicy.profile,
					codexExecutable: policy.codexExecutable ?? null,
					model: policy.model ?? null,
					modelProvider:
						policy.nativeAgent === null
							? null
							: {
									provider: policy.nativeAgent.modelProvider.provider,
									protocol: policy.nativeAgent.modelProvider.protocol,
									thinkingMode: policy.nativeAgent.modelProvider.thinkingMode,
									endpointSha256: policy.nativeAgent.modelProvider.endpointSha256,
									credentialRef: policy.nativeAgent.modelProvider.credentialRef,
									implementation: policy.nativeAgent.modelProvider.implementation,
								},
					agentAdapter: policy.agentAdapter,
				},
				executionIdentity,
				status: classifyTask(result),
				failureClassification,
				durationMs: Date.now() - startedAt,
				evidence: result.evidence,
				assessment: result.assessment.reference,
				agent: {
					executable: result.agent.executable,
					args: result.agent.args,
					exitCode: result.agent.exitCode,
					signal: result.agent.signal,
					durationMs: result.agent.durationMs,
					timedOut: result.agent.timedOut,
				},
				nativeRuntime: policy.agentAdapter === "harness-native" ? createNativeRuntimeSummary(result) : null,
				verificationStatus: result.commandVerification.status,
				repairCycle: createRepairCycle(policy, result),
				hiddenOracleStatus: result.hiddenOracle?.status ?? null,
				riskLevel,
				approvalStatus,
				verdict: result.assessment.report.verdict.status,
				error: null,
			});
		} catch (error) {
			tasks.push({
				taskId: task.id,
				taskSpecPath: task.taskSpecPath,
				configuration: {
					taskSpecSha256: task.taskSpecSha256,
					expectedStatus: task.expectedStatus,
					verificationProfile: null,
					riskPolicyProfile: null,
					codexExecutable: null,
					model: null,
					modelProvider: null,
					agentAdapter: "codex",
				},
				executionIdentity: null,
				status: "setup-failed",
				failureClassification: {
					execution: "setup-failed",
					completion: "not-reached",
					semantic: "not-evaluated",
				},
				durationMs: Date.now() - startedAt,
				evidence: null,
				assessment: null,
				agent: null,
				nativeRuntime: null,
				verificationStatus: null,
				repairCycle: null,
				hiddenOracleStatus: null,
				riskLevel: null,
				approvalStatus: null,
				verdict: null,
				error: { code: "task-failed", message: error instanceof Error ? error.message : String(error) },
			});
		}
	}
	const report: BenchmarkReport = {
		version: 1,
		createdAt: new Date().toISOString(),
		benchmark: {
			sourcePath: definition.sourcePath,
			sourceSha256: definition.sourceSha256,
			name: definition.name,
			suite: definition.suite,
			runId,
		},
		environment: {
			nodeVersion: process.version,
			platform: process.platform,
			arch: process.arch,
			coreSchemaVersion: 1,
		},
		executionIdentity: {
			cliVersion: HEADLESS_CLI_VERSION,
			coreSchemaVersion: 1,
			nodeVersion: process.version,
			platform: process.platform,
			arch: process.arch,
			suite: {
				sourceSha256: definition.sourceSha256,
				id: definition.suite?.id ?? null,
				fixtureVersion: definition.suite?.fixtureVersion ?? null,
			},
		},
		tasks,
		summary: createSummary(tasks),
	};
	if (benchmarkWorktreeRoot === null) {
		throw new Error("Benchmark report output requires at least one valid task worktree root.");
	}
	return {
		report,
		reference: await resolvedDependencies.writeReport({
			path: getBenchmarkReportPath(benchmarkWorktreeRoot, runId),
			report,
		}),
	};
}
