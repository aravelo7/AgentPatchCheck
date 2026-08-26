import { describe, expect, it } from "vitest";

import { projectHistory } from "../../src/agentpatchcheck/history-projection";
import type { HarnessNativeHistoryProjectionInteraction } from "../../src/agentpatchcheck/types";

function interaction(
	sequence: number,
	tool: HarnessNativeHistoryProjectionInteraction["tool"],
	status: HarnessNativeHistoryProjectionInteraction["status"] = "ok",
	facts?: HarnessNativeHistoryProjectionInteraction["facts"],
): HarnessNativeHistoryProjectionInteraction {
	return {
		sequence,
		iteration: sequence,
		actionId: `action-${sequence}`,
		tool,
		arguments: { path: `path-${sequence}` },
		status,
		observation: `observation-${sequence}`,
		facts,
	};
}

describe("deterministic History Projection", () => {
	it("keeps canonical interactions unchanged while budget elision retains the latest protected outcomes", () => {
		const canonical = [
			interaction(1, "list-directory"),
			interaction(2, "search-text", "rejected"),
			interaction(3, "apply-patch"),
			interaction(4, "run-public-verification"),
			...Array.from({ length: 8 }, (_, index) => interaction(index + 5, "list-directory")),
		];
		const before = structuredClone(canonical);

		const projection = projectHistory(canonical, 100);

		expect(canonical).toEqual(before);
		expect(projection.interactions.map((entry) => entry.sequence)).toEqual(expect.arrayContaining([2, 3, 4, 12]));
		expect(projection.interactions.map((entry) => entry.sequence)).not.toContain(1);
		expect(projection.metadata.canonicalInteractionCount).toBe(12);
		expect(projection.metadata.projectedInteractionCount).toBeLessThan(12);
		expect(projection.metadata.elidedInteractionCount).toBeGreaterThan(0);
		expect(projection.metadata.projectedObservationBytes).toBeLessThanOrEqual(100);
	});

	it("is deterministic and budget-bounded with many interactions", () => {
		const canonical = Array.from({ length: 40 }, (_, index) => ({
			...interaction(index + 1, "search-text"),
			observation: `observation-${index + 1}-${"x".repeat(40)}`,
		}));

		const first = projectHistory(canonical, 180);
		const second = projectHistory(canonical, 180);

		expect(first).toEqual(second);
		expect(first.interactions.length).toBeLessThan(canonical.length);
		expect(first.metadata.projectedObservationBytes).toBeLessThanOrEqual(180);
		expect(first.interactions.at(-1)?.sequence).toBe(40);
	});

	it("does not elide interactions merely because history exceeds eight entries", () => {
		const canonical = Array.from({ length: 11 }, (_, index) =>
			interaction(index + 1, index === 3 ? "read-file" : "list-directory"),
		);

		const projection = projectHistory(canonical);

		expect(projection.interactions.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
		expect(projection.interactions.map((entry) => entry.observation)).toContain("observation-4");
		expect(projection.metadata).toMatchObject({
			canonicalInteractionCount: 11,
			projectedInteractionCount: 11,
			elidedInteractionCount: 0,
		});
	});

	it("retains an old successful retrieval while the observation budget permits it", () => {
		const canonical = [
			interaction(1, "search-text", "ok", {
				kind: "retrieval",
				tool: "search-text",
				path: "src",
				query: "target",
				inspectedPaths: [],
				candidatePaths: ["src/target.ts"],
				search: { matchCount: 1, coverage: "complete", skippedCount: 0, skipped: [] },
			}),
			...Array.from({ length: 9 }, (_, index) => interaction(index + 2, "list-directory")),
		];

		const projection = projectHistory(canonical);

		expect(projection.interactions.map((entry) => entry.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
	});

	it("fits retained outcomes and the newest tail into an exact UTF-8 byte budget", () => {
		const canonical = [
			{ ...interaction(1, "apply-edit"), observation: `mutation-${"界".repeat(100)}` },
			{ ...interaction(2, "read-file"), observation: `old-read-${"x".repeat(300)}` },
			{ ...interaction(3, "list-directory"), observation: `latest-${"界".repeat(100)}` },
		];

		const projection = projectHistory(canonical, 180);

		expect(projection.interactions.map((entry) => entry.sequence)).toEqual([1, 3]);
		expect(
			Buffer.byteLength(projection.interactions.map((entry) => entry.observation).join("\n---\n"), "utf8"),
		).toBeLessThanOrEqual(180);
		expect(projection.interactions[0]?.observation).toContain("omitted");
		expect(projection.interactions[1]?.observation).toContain("omitted");
		expect(projection.metadata).toMatchObject({
			retainedEventSequences: [1, 3],
			projectedObservationBytes: expect.any(Number),
			truncatedObservationCount: 2,
		});
		expect(projection.metadata.omittedObservationBytes).toBeGreaterThan(0);
	});
});
