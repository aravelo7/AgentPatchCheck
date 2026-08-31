import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	prepareSWEbenchEvaluatorDataset,
	type SWEbenchEvaluatorDatasetPreparationInput,
} from "../../src/agentpatchcheck/swebench-evaluator-dataset";

const sourceIdentity = {
	name: "MariusHobbhahn/swe-bench-verified-mini",
	split: "test",
	revision: "b".repeat(40),
	sha256: "upstream-sha256",
};

function sourceRow(instanceId: string, evaluatorMetadata = false): Record<string, unknown> {
	return {
		repo: "django/django",
		instance_id: instanceId,
		base_commit: "c".repeat(40),
		problem_statement: `Problem ${instanceId}`,
		FAIL_TO_PASS: ["test_failure"],
		PASS_TO_PASS: ["test_success"],
		environment_setup_commit: "",
		...(evaluatorMetadata
			? {
					image: `swebench/sweb.eval.x86_64.${instanceId.replaceAll("__", "_1776_")}:latest`,
					eval_type: "pass_and_fail",
					log_parser: "parse_log_django",
					eval_script: "#!/bin/bash\nset -uxo pipefail\n",
				}
			: {}),
	};
}

function preparationInput(
	root: string,
	sourceDatasetPath: string,
	overrides: Partial<SWEbenchEvaluatorDatasetPreparationInput> = {},
) {
	return {
		sourceDatasetPath,
		sourceDatasetSha256: "source-jsonl-sha256",
		sourceDataset: sourceIdentity,
		evaluatorRevision: "d".repeat(40),
		evaluatorPythonPath: join(root, "python.exe"),
		evaluatorSourceRoot: root,
		outputPath: join(root, "derived.jsonl"),
		provenancePath: join(root, "derived.provenance.json"),
		...overrides,
	} satisfies SWEbenchEvaluatorDatasetPreparationInput;
}

describe("SWE-bench evaluator dataset preparation", () => {
	it("merges authoritative metadata while preserving source order and semantics", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-evaluator-dataset-"));
		const sourceDatasetPath = join(root, "source.jsonl");
		const rows = [sourceRow("django__django-11790"), sourceRow("django__django-11815")];
		await writeFile(sourceDatasetPath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
		const result = await prepareSWEbenchEvaluatorDataset(
			preparationInput(root, sourceDatasetPath, {
				metadataAuthority: {
					dataset: "SWE-bench/SWE-bench_Verified",
					split: "test",
					revision: "e".repeat(40),
					primitive: "datasets.load_dataset",
				},
			}),
			{
				loadOfficialMetadata: async (_input, instanceIds) =>
					new Map(
						instanceIds.map((instanceId) => {
							const source = sourceRow(instanceId);
							return [
								instanceId,
								{
									...source,
									image: `swebench/${instanceId}`,
									eval_type: "pass_and_fail",
									log_parser: "parse_log_django",
									eval_script: "#!/bin/bash\nset -uxo pipefail\n",
								},
							] as const;
						}),
					),
			},
		);

		const derived = (await readFile(result.datasetPath, "utf8"))
			.trim()
			.split(/\r?\n/u)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(result.rowCount).toBe(2);
		expect(derived.map((row) => row.instance_id)).toEqual(rows.map((row) => row.instance_id));
		expect(derived[0]).toMatchObject({
			problem_statement: rows[0]?.problem_statement,
			FAIL_TO_PASS: rows[0]?.FAIL_TO_PASS,
			image: "swebench/django__django-11790",
		});
		const provenance = JSON.parse(await readFile(result.provenancePath, "utf8")) as Record<string, unknown>;
		expect(provenance).toMatchObject({
			evaluatorRevision: "d".repeat(40),
			sourceArtifact: { sha256: "source-jsonl-sha256" },
			derivedDataset: { rowCount: 2, instanceIds: rows.map((row) => row.instance_id) },
		});
	});

	it("uses a complete Formal-style source without invoking metadata authority", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-evaluator-dataset-"));
		const sourceDatasetPath = join(root, "source.jsonl");
		await writeFile(sourceDatasetPath, `${JSON.stringify(sourceRow("caddyserver__caddy-5626", true))}\n`);
		let authorityCalled = false;
		await prepareSWEbenchEvaluatorDataset(preparationInput(root, sourceDatasetPath), {
			loadOfficialMetadata: async () => {
				authorityCalled = true;
				return new Map();
			},
		});
		expect(authorityCalled).toBe(false);
	});

	it("fails closed when required metadata is missing and no authority is configured", async () => {
		const root = await mkdtemp(join(tmpdir(), "apc-swebench-evaluator-dataset-"));
		const sourceDatasetPath = join(root, "source.jsonl");
		await writeFile(sourceDatasetPath, `${JSON.stringify(sourceRow("django__django-11790"))}\n`);
		await expect(prepareSWEbenchEvaluatorDataset(preparationInput(root, sourceDatasetPath))).rejects.toThrow(
			"Authoritative SWE-bench evaluator metadata is required",
		);
	});
});
