import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
import { executeAgentPatchCheck } from "./execute";
import { readEvidenceBundle } from "./git-patch-verifier";
import { evaluateRiskPolicy } from "./risk-policy";
import { validateTaskPolicy } from "./task-policy";
import { loadTaskSpec } from "./task-spec";
import type {
	AgentPatchCheckResult,
	BenchmarkDefinition,
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
	createRunId: () => string;
	readEvidence: typeof readEvidenceBundle;
	readAgentVersion: (executable: string) => Promise<string | null>;
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

function createRunId(): string {
	return `benchmark-${randomUUID().slice(0, 12)}`;
}

function createTaskRunId(benchmarkRunId: string, taskId: string): string {
	return `${benchmarkRunId}-${taskId}`;
}

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

function createRepairCycle(
	policy: Awaited<ReturnType<typeof validateTaskPolicy>>,
	result: AgentPatchCheckResult,
): BenchmarkRepairCycleResult | null {
	if (policy.agentAdapter !== "harness-native") return null;
	const repairAttempt = result.agent.attempts?.find((attempt) => attempt.phase === "public-verification-repair");
	const initialAgent =
		result.agent.attempts?.find((attempt) => attempt.phase === "initial")?.execution ?? result.agent;
	const initialVerificationStatus = repairAttempt?.feedback?.status ?? result.commandVerification.status;
	if (initialAgent.timedOut)
		return {
			attempted: false,
			initialVerificationStatus,
			finalVerificationStatus: result.commandVerification.status,
			outcome: "initial-agent-timed-out",
		};
	if (initialAgent.exitCode !== 0)
		return {
			attempted: false,
			initialVerificationStatus,
			finalVerificationStatus: result.commandVerification.status,
			outcome: "initial-agent-failed",
		};
	if (repairAttempt === undefined)
		return {
			attempted: false,
			initialVerificationStatus,
			finalVerificationStatus: result.commandVerification.status,
			outcome: result.commandVerification.status === "passed" ? "initial-pass" : "initial-verification-not-run",
		};
	if (repairAttempt.execution.timedOut)
		return {
			attempted: true,
			initialVerificationStatus,
			finalVerificationStatus: result.commandVerification.status,
			outcome: "repair-timed-out",
		};
	return {
		attempted: true,
		initialVerificationStatus,
		finalVerificationStatus: result.commandVerification.status,
		outcome: result.commandVerification.status === "passed" ? "repaired" : "repair-failed",
	};
}

function createSummary(tasks: BenchmarkTaskResult[]): BenchmarkReport["summary"] {
	const byStatus = Object.fromEntries(allStatuses.map((status) => [status, 0])) as Record<BenchmarkTaskStatus, number>;
	for (const task of tasks) byStatus[task.status] += 1;
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
	return {
		total: tasks.length,
		passed: byStatus.passed,
		failed: tasks.length - byStatus.passed,
		byStatus,
		summaryText:
			failures.length === 0
				? `${byStatus.passed}/${tasks.length} tasks passed.`
				: `${byStatus.passed}/${tasks.length} tasks passed; ${tasks.length - byStatus.passed} failed (${failures.join(", ")}).`,
		...(repairCycleSummary === null ? {} : { repairCycles: repairCycleSummary }),
	};
}

export function getBenchmarkReportPath(sourcePath: string, runId: string): string {
	return join(dirname(sourcePath), ".agentpatchcheck", "benchmarks", `${runId}.json`);
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
	createRunId,
	readEvidence: readEvidenceBundle,
	readAgentVersion,
};

export async function runBenchmark(
	definition: BenchmarkDefinition,
	dependencies: Partial<BenchmarkDependencies> = {},
): Promise<BenchmarkResult> {
	const resolvedDependencies = { ...defaultDependencies, ...dependencies };
	const runId = resolvedDependencies.createRunId();
	const tasks: BenchmarkTaskResult[] = [];
	for (const task of definition.tasks) {
		const startedAt = Date.now();
		try {
			const input = await resolvedDependencies.loadTaskSpec(task.taskSpecPath);
			const policy = await resolvedDependencies.validateTaskPolicy({
				...input,
				runId: input.runId ?? createTaskRunId(runId, task.id),
			});
			const result = await resolvedDependencies.execute(policy);
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
				durationMs: Date.now() - startedAt,
				evidence: null,
				assessment: null,
				agent: null,
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
	return {
		report,
		reference: await resolvedDependencies.writeReport({
			path: getBenchmarkReportPath(definition.sourcePath, runId),
			report,
		}),
	};
}
