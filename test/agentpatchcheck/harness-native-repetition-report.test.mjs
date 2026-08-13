import { describe, expect, it } from "vitest";

import { createTaskAggregate, sumNativeQuality } from "../../scripts/harness-native-repetition-report.mjs";

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
});
