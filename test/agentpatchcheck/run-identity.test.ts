import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRunId, isFilesystemSafeRunId, normalizeRunIdentity } from "../../src/agentpatchcheck/run-identity";

const longInstanceId = `owner__${"exceptionally-long-instance-name-".repeat(12)}12345`;

function identity(overrides: Partial<Parameters<typeof createRunId>[0]> = {}) {
	return {
		experiment: "swebench-multilingual-v1",
		task: longInstanceId,
		variant: "baseline",
		attempt: 1,
		repository: "owner/very-long-repository-name",
		baseCommit: "0123456789abcdef0123456789abcdef01234567",
		model: "provider/very-long-model-name",
		benchmark: "swe-bench/SWE-Bench_Multilingual",
		...overrides,
	};
}

describe("Run Identity", () => {
	it("is stable, compact, and filesystem-safe for a long task identity", () => {
		const first = createRunId(identity(), "sb");
		const second = createRunId(identity(), "sb");
		expect(first).toBe(second);
		expect(first.length).toBeLessThanOrEqual(32);
		expect(isFilesystemSafeRunId(first)).toBe(true);
		expect(first).not.toContain(longInstanceId);
	});

	it("separates task, variant, and retry identities", () => {
		const baseline = createRunId(identity(), "sb");
		expect(createRunId(identity({ task: "owner__other-12345" }), "sb")).not.toBe(baseline);
		expect(createRunId(identity({ variant: "candidate" }), "sb")).not.toBe(baseline);
		expect(createRunId(identity({ attempt: 2 }), "sb")).not.toBe(baseline);
	});

	it("retains the full identity as metadata", () => {
		expect(normalizeRunIdentity(identity())).toMatchObject({
			version: 1,
			experiment: "swebench-multilingual-v1",
			task: longInstanceId,
			variant: "baseline",
			attempt: 1,
			repository: "owner/very-long-repository-name",
		});
	});

	it("leaves room for a deep Windows runtime path", () => {
		const runId = createRunId(identity(), "sb");
		const runtimePath = join(`D:\\${"nested\\".repeat(29)}runtime`, `${runId}.jsonl`);
		expect(runtimePath.length).toBeLessThan(260);
		expect(runId.length).toBeLessThanOrEqual(32);
	});
});
