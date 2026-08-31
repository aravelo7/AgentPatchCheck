import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

const REQUIRED_EVALUATOR_FIELDS = ["image", "eval_type", "log_parser", "eval_script"] as const;
const SEMANTIC_FIELDS = [
	"instance_id",
	"repo",
	"base_commit",
	"problem_statement",
	"FAIL_TO_PASS",
	"PASS_TO_PASS",
	"environment_setup_commit",
] as const;
const AUTHORITY_ALIGNMENT_FIELDS = [
	"repo",
	"base_commit",
	"problem_statement",
	"FAIL_TO_PASS",
	"PASS_TO_PASS",
] as const;

export interface SWEbenchSourceDatasetIdentity {
	name: string;
	split: string;
	revision: string;
	sha256: string;
}

export interface SWEbenchEvaluatorMetadataAuthority {
	dataset: string;
	split: string;
	revision: string;
	primitive: string;
}

export interface SWEbenchEvaluatorDatasetPreparationInput {
	sourceDatasetPath: string;
	sourceDatasetSha256: string;
	sourceDataset: SWEbenchSourceDatasetIdentity;
	evaluatorRevision: string;
	evaluatorPythonPath: string;
	evaluatorSourceRoot: string;
	metadataAuthority?: SWEbenchEvaluatorMetadataAuthority;
	outputPath: string;
	provenancePath: string;
}

export interface SWEbenchEvaluatorDatasetPreparationResult {
	datasetPath: string;
	provenancePath: string;
	sha256: string;
	rowCount: number;
}

export interface SWEbenchEvaluatorDatasetPreparationDependencies {
	loadOfficialMetadata?: (
		input: SWEbenchEvaluatorDatasetPreparationInput,
		instanceIds: readonly string[],
	) => Promise<Map<string, JsonRecord>>;
}

type JsonRecord = Record<string, unknown>;

const OFFICIAL_METADATA_SCRIPT = [
	"import json, sys",
	"from datasets import load_dataset",
	"rows = load_dataset(sys.argv[1], split=sys.argv[2], revision=sys.argv[3])",
	"wanted = set(json.loads(sys.argv[4]))",
	"selected = [dict(row) for row in rows if row.get('instance_id') in wanted]",
	"print(json.dumps(selected, ensure_ascii=False, separators=(',', ':')))",
].join("; ");

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0)
		throw new Error(`SWE-bench evaluator metadata ${field} is required.`);
	return value;
}

function parseJsonRecord(value: unknown, label: string): JsonRecord {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error(`${label} must be a JSON object.`);
	return value as JsonRecord;
}

async function readJsonl(path: string): Promise<JsonRecord[]> {
	const lines = (await readFile(path, "utf8")).split(/\r?\n/u).filter((line) => line.trim().length > 0);
	return lines.map((line, index) => parseJsonRecord(JSON.parse(line), `${path}:${index + 1}`));
}

function assertUniqueInstanceIds(rows: readonly JsonRecord[], label: string): string[] {
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const [index, row] of rows.entries()) {
		const instanceId = requireString(row.instance_id, `${label}[${index}].instance_id`);
		if (seen.has(instanceId)) throw new Error(`${label} contains duplicate instance_id: ${instanceId}`);
		seen.add(instanceId);
		ids.push(instanceId);
	}
	return ids;
}

function missingEvaluatorFields(row: JsonRecord): string[] {
	return REQUIRED_EVALUATOR_FIELDS.filter(
		(field) => typeof row[field] !== "string" || (row[field] as string).trim().length === 0,
	);
}

function assertSemanticFieldsPreserved(source: JsonRecord, derived: JsonRecord): void {
	for (const field of SEMANTIC_FIELDS) {
		if (JSON.stringify(source[field]) !== JSON.stringify(derived[field])) {
			throw new Error(`Derived evaluator dataset changed semantic field ${field}.`);
		}
	}
}

function normalizeComparableValue(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return value;
	}
}

function assertAuthorityAlignment(source: JsonRecord, authority: JsonRecord, instanceId: string): void {
	for (const field of AUTHORITY_ALIGNMENT_FIELDS) {
		if (
			JSON.stringify(normalizeComparableValue(source[field])) !==
			JSON.stringify(normalizeComparableValue(authority[field]))
		) {
			throw new Error(`Authoritative metadata disagrees with source for ${field} on ${instanceId}`);
		}
	}
}

async function loadOfficialMetadata(
	input: SWEbenchEvaluatorDatasetPreparationInput,
	instanceIds: readonly string[],
): Promise<Map<string, JsonRecord>> {
	const authority = input.metadataAuthority;
	if (authority === undefined)
		throw new Error("Authoritative SWE-bench evaluator metadata is required for an incomplete dataset.");
	const child = spawn(
		resolve(input.evaluatorPythonPath),
		[
			"-c",
			OFFICIAL_METADATA_SCRIPT,
			authority.dataset,
			authority.split,
			authority.revision,
			JSON.stringify(instanceIds),
		],
		{
			cwd: resolve(input.evaluatorSourceRoot),
			env: {
				...process.env,
				PYTHONIOENCODING: "utf-8",
				PYTHONUTF8: "1",
				PYTHONPATH: [resolve(input.evaluatorSourceRoot), process.env.PYTHONPATH]
					.filter(Boolean)
					.join(sep === "\\" ? ";" : ":"),
			},
			shell: false,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	const exitCode = await new Promise<number | null>((resolveExit) => {
		child.once("error", () => resolveExit(null));
		child.once("close", (code) => resolveExit(code));
	});
	if (exitCode !== 0)
		throw new Error(
			`Official SWE-bench metadata materialization failed: ${stderr.trim() || `exitCode=${exitCode ?? "unknown"}`}`,
		);
	const selected = JSON.parse(stdout.trim()) as unknown;
	if (!Array.isArray(selected)) throw new Error("Official SWE-bench metadata materialization returned a non-array.");
	const rows = selected.map((row, index) => parseJsonRecord(row, `official metadata row ${index}`));
	const result = new Map<string, JsonRecord>();
	for (const [index, row] of rows.entries()) {
		const instanceId = requireString(row.instance_id, `official metadata row ${index}.instance_id`);
		if (result.has(instanceId))
			throw new Error(`Official SWE-bench metadata contains duplicate instance_id: ${instanceId}`);
		result.set(instanceId, row);
	}
	return result;
}

export async function prepareSWEbenchEvaluatorDataset(
	input: SWEbenchEvaluatorDatasetPreparationInput,
	dependencies: SWEbenchEvaluatorDatasetPreparationDependencies = {},
): Promise<SWEbenchEvaluatorDatasetPreparationResult> {
	const sourceRows = await readJsonl(resolve(input.sourceDatasetPath));
	const instanceIds = assertUniqueInstanceIds(sourceRows, "source evaluator dataset");
	const needsAuthority = sourceRows.some((row) => missingEvaluatorFields(row).length > 0);
	const officialMetadata = needsAuthority
		? await (dependencies.loadOfficialMetadata ?? loadOfficialMetadata)(input, instanceIds)
		: new Map<string, JsonRecord>();

	const derivedRows = sourceRows.map((sourceRow, index) => {
		const instanceId = instanceIds[index] as string;
		const authorityRow = officialMetadata.get(instanceId);
		if (needsAuthority && authorityRow === undefined)
			throw new Error(`Authoritative metadata is missing instance_id: ${instanceId}`);
		if (authorityRow !== undefined) assertAuthorityAlignment(sourceRow, authorityRow, instanceId);
		const derived = { ...sourceRow };
		for (const field of REQUIRED_EVALUATOR_FIELDS) {
			const sourceValue = derived[field];
			const authorityValue = authorityRow?.[field];
			if (authorityRow !== undefined) {
				if (typeof authorityValue !== "string" || authorityValue.trim().length === 0) {
					throw new Error(`Authoritative metadata is missing ${field} for ${instanceId}`);
				}
				if (typeof sourceValue === "string" && sourceValue.trim().length > 0 && sourceValue !== authorityValue) {
					throw new Error(`Source evaluator metadata disagrees with authority for ${field} on ${instanceId}`);
				}
				if (typeof sourceValue !== "string" || sourceValue.trim().length === 0) derived[field] = authorityValue;
			}
		}
		for (const field of REQUIRED_EVALUATOR_FIELDS) {
			if (typeof derived[field] !== "string" || (derived[field] as string).trim().length === 0) {
				throw new Error(`Derived evaluator dataset is missing ${field} for ${instanceId}`);
			}
		}
		assertSemanticFieldsPreserved(sourceRow, derived);
		return derived;
	});

	if (derivedRows.length !== sourceRows.length) throw new Error("Derived evaluator dataset row count changed.");
	const content = `${derivedRows.map((row) => JSON.stringify(row)).join("\n")}\n`;
	await mkdir(dirname(resolve(input.outputPath)), { recursive: true });
	await writeFile(resolve(input.outputPath), content, "utf8");
	const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
	const provenance = {
		version: 1,
		sourceDataset: input.sourceDataset,
		sourceArtifact: { path: resolve(input.sourceDatasetPath), sha256: input.sourceDatasetSha256 },
		evaluatorRevision: input.evaluatorRevision,
		metadataAuthority: input.metadataAuthority ?? { primitive: "source evaluator metadata validation" },
		derivedDataset: { path: resolve(input.outputPath), sha256, rowCount: derivedRows.length, instanceIds },
	};
	await writeFile(resolve(input.provenancePath), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
	return {
		datasetPath: resolve(input.outputPath),
		provenancePath: resolve(input.provenancePath),
		sha256,
		rowCount: derivedRows.length,
	};
}
