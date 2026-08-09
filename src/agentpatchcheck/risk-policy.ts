import { createHash } from "node:crypto";

import type { AssessmentReport, EvidenceBundle, RiskFinding, RiskLevel, RiskResult } from "./types";

const LEVEL_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const TEST_PATH = /(^|\/)(test|tests|__tests__)(\/|$)|\.(test|spec)\.[^/]+$/iu;
const CI_PATH =
	/(^|\/)(\.github\/workflows|\.gitlab-ci\.yml$|azure-pipelines\.ya?ml$|Jenkinsfile$|Dockerfile$|docker-compose[^/]*\.ya?ml$)/iu;
const DEPENDENCY_PATH = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/iu;
const SENSITIVE_PATH = /(^|\/)(\.env(?:$|\..*)|[^/]+\.(pem|key|p12|pfx))$/iu;
const SCRIPT_PATH = /(^|\/)(scripts\/|[^/]+\.(sh|ps1|bat|cmd))$/iu;

function add(
	findings: RiskFinding[],
	policyId: string,
	level: RiskLevel,
	code: string,
	message: string,
	files: string[],
) {
	findings.push({ policyId, level, code, message, files });
}

function diffFiles(bundle: EvidenceBundle, pattern: RegExp): string[] {
	return bundle.patch.changedFiles.filter((file) => pattern.test(file));
}

function maxLevel(findings: RiskFinding[]): RiskLevel {
	return findings.reduce<RiskLevel>(
		(current, finding) => (LEVEL_ORDER[finding.level] > LEVEL_ORDER[current] ? finding.level : current),
		"low",
	);
}

export function evaluateRiskPolicy(bundle: EvidenceBundle, assessment: AssessmentReport | null): RiskResult {
	const findings: RiskFinding[] = [];
	const files = bundle.patch.changedFiles;
	const testFiles = diffFiles(bundle, TEST_PATH);
	const ciFiles = diffFiles(bundle, CI_PATH);
	const dependencyFiles = diffFiles(bundle, DEPENDENCY_PATH);
	const sensitiveFiles = diffFiles(bundle, SENSITIVE_PATH);
	const scriptFiles = diffFiles(bundle, SCRIPT_PATH);
	if (sensitiveFiles.length)
		add(
			findings,
			"sensitive-path",
			"critical",
			"sensitive-path-change",
			"Patch changes a sensitive configuration or key-like path.",
			sensitiveFiles,
		);
	if (ciFiles.length)
		add(
			findings,
			"protected-build-path",
			"high",
			"build-or-ci-change",
			"Patch changes CI, workflow, or build configuration.",
			ciFiles,
		);
	if (dependencyFiles.length)
		add(
			findings,
			"dependency-manifest",
			"high",
			"dependency-change",
			"Patch changes a dependency manifest or lockfile.",
			dependencyFiles,
		);
	if (scriptFiles.length)
		add(
			findings,
			"executable-script",
			"high",
			"script-change",
			"Patch changes a script or command entrypoint.",
			scriptFiles,
		);
	if (testFiles.length) {
		const deleted = testFiles.filter(
			(file) =>
				new RegExp(
					`diff --git a/${file.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} b/${file.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\n(?:[\\s\\S]*?)deleted file mode`,
					"u",
				).test(bundle.patch.trackedPatch) ||
				(testFiles.length === 1 && bundle.patch.trackedPatch.includes("deleted file mode")),
		);
		if (deleted.length)
			add(findings, "test-integrity", "high", "test-deleted", "Patch deletes a public test file.", deleted);
		const weakening =
			/(^|\n)\+.*(?:\.skip\(|process\.exit\(0\)|expect\(true\)\.toBe\(true\)|return\s+true\b)/imu.test(
				bundle.patch.trackedPatch,
			);
		if (weakening)
			add(
				findings,
				"test-integrity",
				"high",
				"test-weakening-pattern",
				"Patch adds a deterministic test-bypass pattern.",
				testFiles,
			);
		else if (!deleted.length)
			add(findings, "test-integrity", "medium", "test-change", "Patch changes public test files.", testFiles);
	}
	if (files.length > 25)
		add(findings, "change-size", "medium", "changed-file-limit", "Patch changes more than 25 files.", files);
	if (Buffer.byteLength(bundle.patch.trackedPatch, "utf8") > 131_072)
		add(findings, "change-size", "medium", "diff-size-limit", "Tracked patch exceeds 128 KiB.", files);
	if (assessment && assessment.verdict.status !== "pass")
		add(findings, "assessment", "critical", "assessment-not-pass", "Assessment verdict is not pass.", []);
	if (bundle.hiddenOracle && bundle.hiddenOracle.status !== "passed")
		add(
			findings,
			"hidden-oracle",
			"critical",
			`hidden-oracle-${bundle.hiddenOracle.status}`,
			"Hidden Oracle did not pass.",
			[],
		);
	const level = maxLevel(findings);
	const blocksApply = findings.some((finding) => finding.level === "critical");
	const requiresApproval =
		!blocksApply && findings.some((finding) => finding.level === "medium" || finding.level === "high");
	const fingerprint = createHash("sha256")
		.update(JSON.stringify({ version: 1, findings }))
		.digest("hex");
	return { version: 1, level, findings, requiresApproval, blocksApply, fingerprint };
}
