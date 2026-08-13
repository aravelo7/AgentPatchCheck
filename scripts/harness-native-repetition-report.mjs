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
