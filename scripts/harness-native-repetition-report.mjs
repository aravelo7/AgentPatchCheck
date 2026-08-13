import { createHash } from "node:crypto";

function sha256(value) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function taskIdentity(task) {
	return {
		taskId: task.taskId,
		configuration: {
			taskSpecSha256: task.configuration.taskSpecSha256,
			verificationProfile: task.configuration.verificationProfile === null ? null : {
				name: task.configuration.verificationProfile.name,
				sha256: task.configuration.verificationProfile.sha256,
			},
			riskPolicyProfile: task.configuration.riskPolicyProfile === null ? null : {
				name: task.configuration.riskPolicyProfile.name,
				sha256: task.configuration.riskPolicyProfile.sha256,
			},
			model: task.configuration.model,
			modelProvider: task.configuration.modelProvider ?? null,
			agentAdapter: task.configuration.agentAdapter,
		},
		execution: task.executionIdentity === undefined ? null : {
			baseCommit: task.executionIdentity.baseCommit,
			hiddenOracleSha256: task.executionIdentity.hiddenOracleSha256,
			agent: task.executionIdentity.agent,
			modelProvider: task.executionIdentity.modelProvider ?? null,
		},
	};
}

function benchmarkIdentity(report) {
	return {
		execution: report.executionIdentity ?? null,
		suite: report.benchmark.suite,
		tasks: report.tasks.map(taskIdentity).sort((left, right) => left.taskId.localeCompare(right.taskId)),
	};
}

/**
 * Repetitions are rate-bearing only when every persisted BenchmarkReport has
 * the same immutable execution identity. Status differences never affect this.
 */
export function createRepetitionCompatibility(reports) {
	if (reports.length === 0) return { status: "incomplete", fingerprint: null, reasons: ["No BenchmarkReports were recorded."] };
	const identities = reports.map(benchmarkIdentity);
	if (identities.some((identity) => identity.execution === null || identity.tasks.some((task) => task.execution === null)))
		return {
			status: "incomplete",
			fingerprint: null,
			reasons: ["One or more BenchmarkReports lack execution identity."],
		};
	const baseline = identities[0];
	const baselineJson = JSON.stringify(baseline);
	const driftedRuns = identities.flatMap((identity, index) => (JSON.stringify(identity) === baselineJson ? [] : [index + 1]));
	if (driftedRuns.length > 0)
		return {
			status: "identity-drift",
			fingerprint: null,
			reasons: [`Execution identity differs in repetition run(s): ${driftedRuns.join(", ")}.`],
		};
	return { status: "comparable", fingerprint: sha256(baseline), reasons: [] };
}

export function createTaskAggregate(outputs) {
	const aggregate = new Map();
	for (const output of outputs) {
		for (const task of output.taskResults) {
			const current = aggregate.get(task.id) ?? {
				id: task.id,
				passedRuns: 0,
				publicVerificationFalsePositives: 0,
				statusCounts: {},
			};
			current.passedRuns += task.status === "passed" ? 1 : 0;
			current.publicVerificationFalsePositives +=
				task.verificationStatus === "passed" && task.hiddenOracleStatus === "failed" ? 1 : 0;
			current.statusCounts[task.status] = (current.statusCounts[task.status] ?? 0) + 1;
			aggregate.set(task.id, current);
		}
	}
	return [...aggregate.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function sumNativeQuality(outputs) {
	const keys = [
		"nativeTasks",
		"initialPublicVerificationPassed",
		"publicRepairAttempted",
		"publicRepairRecovered",
		"finalPublicVerificationPassed",
		"hiddenOraclePassed",
		"transportRetries",
		"rejectedToolCalls",
		"providerFailureTasks",
		"agentExecutionFailureTasks",
	];
	const totals = Object.fromEntries(keys.map((key) => [key, 0]));
	for (const output of outputs) {
		if (output.nativeQuality === null || output.nativeQuality === undefined) continue;
		for (const key of keys) totals[key] += output.nativeQuality[key] ?? 0;
	}
	return totals;
}
