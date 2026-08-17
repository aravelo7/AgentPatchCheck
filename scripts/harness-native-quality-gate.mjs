const rateNames = new Set([
	"runPassRate",
	"taskPassRate",
	"finalPublicVerificationPassRate",
	"hiddenOraclePassRate",
	"publicRepairRecoveryRate",
]);

function assertObject(value, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
	return value;
}

function assertRate(value, label) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
		throw new Error(`${label} must be a number from 0 through 1.`);
	return value;
}

function assertNonNegativeInteger(value, label) {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
	return value;
}

/**
 * Parses a Harness-owned quality gate. It intentionally accepts no unknown
 * keys so CI cannot silently run with a misspelled quality threshold.
 */
export function parseQualityGate(value) {
	const input = assertObject(value, "Quality gate");
	const allowed = new Set([
		"version",
		"name",
		"suite",
		"minimumRuns",
		"minimumRates",
		"maximumPublicVerificationFalsePositiveRate",
		"maximumProviderFailureTasks",
		"maximumAgentExecutionFailureTasks",
	]);
	for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Quality gate contains unknown field: ${key}.`);
	if (input.version !== 1) throw new Error("Quality gate version must be 1.");
	if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 128)
		throw new Error("Quality gate name must be a non-empty string up to 128 characters.");
	const suite = assertObject(input.suite, "Quality gate suite");
	if (typeof suite.id !== "string" || !suite.id || typeof suite.fixtureVersion !== "string" || !suite.fixtureVersion)
		throw new Error("Quality gate suite must define id and fixtureVersion.");
	if (Object.keys(suite).some((key) => key !== "id" && key !== "fixtureVersion"))
		throw new Error("Quality gate suite contains unknown fields.");
	const minimumRatesInput = assertObject(input.minimumRates, "Quality gate minimumRates");
	const minimumRates = {};
	for (const [name, rate] of Object.entries(minimumRatesInput)) {
		if (!rateNames.has(name)) throw new Error(`Quality gate does not support rate: ${name}.`);
		minimumRates[name] = assertRate(rate, `Quality gate minimumRates.${name}`);
	}
	return {
		version: 1,
		name: input.name.trim(),
		suite: { id: suite.id, fixtureVersion: suite.fixtureVersion },
		minimumRuns: assertNonNegativeInteger(input.minimumRuns, "Quality gate minimumRuns"),
		minimumRates,
		maximumPublicVerificationFalsePositiveRate:
			input.maximumPublicVerificationFalsePositiveRate === undefined
				? null
				: assertRate(input.maximumPublicVerificationFalsePositiveRate, "Quality gate maximumPublicVerificationFalsePositiveRate"),
		maximumProviderFailureTasks:
			input.maximumProviderFailureTasks === undefined
				? null
				: assertNonNegativeInteger(input.maximumProviderFailureTasks, "Quality gate maximumProviderFailureTasks"),
		maximumAgentExecutionFailureTasks:
			input.maximumAgentExecutionFailureTasks === undefined
				? null
				: assertNonNegativeInteger(input.maximumAgentExecutionFailureTasks, "Quality gate maximumAgentExecutionFailureTasks"),
	};
}

/** A gate is fail-closed: incomplete or incomparable experiments cannot pass. */
export function evaluateQualityGate(gate, report) {
	const reasons = [];
	if (report.suite?.id !== gate.suite.id || report.suite?.fixtureVersion !== gate.suite.fixtureVersion)
		reasons.push("The repetition report suite does not match the quality gate.");
	if (report.experimentIdentity?.status !== "comparable") reasons.push("The repetition report is not comparable.");
	if (report.summary?.totalRuns < gate.minimumRuns)
		reasons.push(`The repetition report has fewer than ${gate.minimumRuns} runs.`);
	const baseline = report.qualityBaseline;
	if (baseline?.status !== "ready" || baseline.rates === null || baseline.failureClassification === null)
		reasons.push("The repetition report does not contain a comparable quality baseline.");
	if (baseline?.status === "ready" && baseline.rates !== null && baseline.failureClassification !== null) {
		for (const [name, minimum] of Object.entries(gate.minimumRates)) {
			const actual = baseline.rates[name]?.rate;
			if (typeof actual !== "number" || actual < minimum)
				reasons.push(`${name} is below the required minimum of ${minimum}.`);
		}
		const falsePositiveRate = baseline.rates.publicVerificationFalsePositiveRate?.rate;
		if (
			gate.maximumPublicVerificationFalsePositiveRate !== null &&
			(typeof falsePositiveRate !== "number" || falsePositiveRate > gate.maximumPublicVerificationFalsePositiveRate)
		)
			reasons.push(
				`publicVerificationFalsePositiveRate exceeds the maximum of ${gate.maximumPublicVerificationFalsePositiveRate}.`,
			);
		const failures = baseline.failureClassification;
		if (
			gate.maximumProviderFailureTasks !== null &&
			failures.providerFailureTasks > gate.maximumProviderFailureTasks
		)
			reasons.push(`providerFailureTasks exceeds the maximum of ${gate.maximumProviderFailureTasks}.`);
		if (
			gate.maximumAgentExecutionFailureTasks !== null &&
			failures.agentExecutionFailureTasks > gate.maximumAgentExecutionFailureTasks
		)
			reasons.push(`agentExecutionFailureTasks exceeds the maximum of ${gate.maximumAgentExecutionFailureTasks}.`);
	}
	return {
		version: 1,
		name: gate.name,
		status: reasons.length === 0 ? "passed" : "failed",
		reasons,
	};
}
