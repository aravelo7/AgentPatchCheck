import { describe, expect, it } from "vitest";

import {
	createRepetitionCompatibility,
	createQualityBaseline,
	createTaskAggregate,
	sumNativeQuality,
} from "../../scripts/harness-native-repetition-report.mjs";
import { evaluateQualityGate, parseQualityGate } from "../../scripts/harness-native-quality-gate.mjs";

function report(options = {}) {
	return {
		benchmark: { suite: { id: "native-suite", fixtureVersion: "v2" } },
		executionIdentity: {
			cliVersion: "0.1.70",
			coreSchemaVersion: 1,
			nodeVersion: "v22.0.0",
			platform: "win32",
			arch: "x64",
			suite: { sourceSha256: "suite-sha", id: "native-suite", fixtureVersion: "v2" },
		},
		tasks: [
			{
				taskId: "repair",
				configuration: {
					taskSpecSha256: "task-sha",
					verificationProfile: { name: "public", sha256: "verification-sha" },
					riskPolicyProfile: { name: "risk", sha256: "risk-sha" },
					model: "model-a",
					modelProvider: { provider: "openai-compatible", protocol: "chat-completions" },
					agentAdapter: "harness-native",
				},
				executionIdentity: {
					baseCommit: "base-sha",
					hiddenOracleSha256: "oracle-sha",
					agent: null,
					modelProvider: { actualModel: "model-a" },
				},
			},
		],
		...options,
	};
}

describe("Harness-native repetition report", () => {
	it("counts public-verification false positives without counting Oracle infrastructure errors", () => {
		const outputs = [
			{
				taskResults: [
					{ id: "exact", status: "hidden-oracle-failed", verificationStatus: "passed", hiddenOracleStatus: "failed" },
					{ id: "error", status: "hidden-oracle-error", verificationStatus: "passed", hiddenOracleStatus: "error" },
				],
				nativeQuality: { nativeTasks: 2, hiddenOraclePassed: 0 },
			},
			{
				taskResults: [
					{ id: "exact", status: "passed", verificationStatus: "passed", hiddenOracleStatus: "passed" },
					{ id: "error", status: "passed", verificationStatus: "passed", hiddenOracleStatus: "passed" },
				],
				nativeQuality: { nativeTasks: 2, hiddenOraclePassed: 2 },
			},
		];

		expect(createTaskAggregate(outputs)).toEqual([
			{
				id: "error",
				passedRuns: 1,
				publicVerificationFalsePositives: 0,
				statusCounts: { "hidden-oracle-error": 1, passed: 1 },
			},
			{
				id: "exact",
				passedRuns: 1,
				publicVerificationFalsePositives: 1,
				statusCounts: { "hidden-oracle-failed": 1, passed: 1 },
			},
		]);
		expect(sumNativeQuality(outputs)).toMatchObject({ nativeTasks: 4, hiddenOraclePassed: 2 });
	});

	it("only marks repeated rates comparable when all persisted experiment identities match", () => {
		const comparable = createRepetitionCompatibility([report(), report()]);
		expect(comparable).toMatchObject({ status: "comparable", fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u), reasons: [] });
		expect(createRepetitionCompatibility([report(), report({
			tasks: [{ ...report().tasks[0], executionIdentity: { ...report().tasks[0].executionIdentity, baseCommit: "other-base" } }],
	})])).toMatchObject({ status: "identity-drift", fingerprint: null });
		expect(createRepetitionCompatibility([report({ executionIdentity: undefined })])).toMatchObject({
			status: "incomplete",
			fingerprint: null,
		});
	});

	it("creates quality rates only for a comparable experiment identity", () => {
		const outputs = [
			{
				benchmarkOk: true,
				taskResults: [
					{ id: "repair", status: "passed", verificationStatus: "passed", hiddenOracleStatus: "passed" },
				],
				nativeQuality: {
					nativeTasks: 1,
					finalPublicVerificationPassed: 1,
					hiddenOraclePassed: 1,
					publicRepairAttempted: 1,
					publicRepairRecovered: 1,
					providerFailureTasks: 0,
					agentExecutionFailureTasks: 0,
				},
			},
			{
				benchmarkOk: false,
				taskResults: [
					{ id: "repair", status: "hidden-oracle-failed", verificationStatus: "passed", hiddenOracleStatus: "failed" },
				],
				nativeQuality: {
					nativeTasks: 1,
					finalPublicVerificationPassed: 1,
					hiddenOraclePassed: 0,
					publicRepairAttempted: 0,
					publicRepairRecovered: 0,
					providerFailureTasks: 0,
					agentExecutionFailureTasks: 0,
				},
			},
		];
		const ready = createQualityBaseline(outputs, { status: "comparable", fingerprint: "fixture", reasons: [] });
		expect(ready).toMatchObject({
			status: "ready",
			rates: {
				runPassRate: { numerator: 1, denominator: 2, rate: 0.5 },
				taskPassRate: { numerator: 1, denominator: 2, rate: 0.5 },
				hiddenOraclePassRate: { numerator: 1, denominator: 2, rate: 0.5 },
				publicVerificationFalsePositiveRate: { numerator: 1, denominator: 2, rate: 0.5 },
			},
			failureClassification: { byTaskStatus: { "hidden-oracle-failed": 1, passed: 1 } },
		});
		expect(createQualityBaseline(outputs, { status: "identity-drift", fingerprint: null, reasons: ["drift"] })).toEqual({
			status: "not-comparable",
			reasons: ["drift"],
			rates: null,
			failureClassification: null,
		});
	});

	it("fails closed when a versioned quality gate sees an incomparable or insufficient experiment", () => {
		const gate = parseQualityGate({
			version: 1,
			name: "fixture gate",
			suite: { id: "native-suite", fixtureVersion: "v2" },
			minimumRuns: 3,
			minimumRates: { taskPassRate: 0.9, hiddenOraclePassRate: 0.9 },
			maximumPublicVerificationFalsePositiveRate: 0.05,
		});
		const incomplete = {
			suite: { id: "native-suite", fixtureVersion: "v2" },
			experimentIdentity: { status: "identity-drift" },
			qualityBaseline: { status: "not-comparable", rates: null, failureClassification: null },
			summary: { totalRuns: 2 },
		};
		expect(evaluateQualityGate(gate, incomplete)).toMatchObject({
			status: "failed",
			reasons: expect.arrayContaining([
				"The repetition report is not comparable.",
				"The repetition report has fewer than 3 runs.",
			]),
		});
	});

	it("passes only when every configured quality threshold is met", () => {
		const gate = parseQualityGate({
			version: 1,
			name: "fixture gate",
			suite: { id: "native-suite", fixtureVersion: "v2" },
			minimumRuns: 3,
			minimumRates: { taskPassRate: 0.9, hiddenOraclePassRate: 0.9 },
			maximumPublicVerificationFalsePositiveRate: 0.05,
			maximumAgentExecutionFailureTasks: 1,
		});
		const report = {
			suite: { id: "native-suite", fixtureVersion: "v2" },
			experimentIdentity: { status: "comparable" },
			summary: { totalRuns: 3 },
			qualityBaseline: {
				status: "ready",
				rates: {
					taskPassRate: { rate: 1 },
					hiddenOraclePassRate: { rate: 1 },
					publicVerificationFalsePositiveRate: { rate: 0 },
				},
				failureClassification: { providerFailureTasks: 0, agentExecutionFailureTasks: 1 },
			},
		};
		expect(evaluateQualityGate(gate, report)).toEqual({ version: 1, name: "fixture gate", status: "passed", reasons: [] });
	});
});
