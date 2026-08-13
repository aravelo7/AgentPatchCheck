import { describe, expect, it } from "vitest";

import {
	createRepetitionCompatibility,
	createTaskAggregate,
	sumNativeQuality,
} from "../../scripts/harness-native-repetition-report.mjs";

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
});
