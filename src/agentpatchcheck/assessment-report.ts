import { dirname, join, parse } from "node:path";

import { lockedFileSystem } from "../fs/locked-file-system";
import { readEvidenceBundle, verifyGitPatchBundle } from "./git-patch-verifier";
import { decidePatchVerdict } from "./patch-verdict";
import type {
	AssessmentReport,
	AssessmentReportReference,
	AssessmentResult,
	EvidenceBundle,
	GitPatchVerification,
	PatchExpectation,
} from "./types";
import { summarizeCommandVerification } from "./verifier-plugin";

interface AssessmentDependencies {
	readBundle: (path: string) => Promise<EvidenceBundle>;
	verifyGitPatch: (bundle: EvidenceBundle, evidencePath: string) => Promise<GitPatchVerification>;
	writeReport: typeof writeAssessmentReport;
}

export function getAssessmentReportPath(evidencePath: string): string {
	const parsed = parse(evidencePath);
	return join(dirname(evidencePath), `${parsed.name}.assessment.json`);
}

export async function writeAssessmentReport(options: {
	path: string;
	report: AssessmentReport;
}): Promise<AssessmentReportReference> {
	await lockedFileSystem.writeJsonFileAtomic(options.path, options.report);
	return { path: options.path, createdAt: options.report.createdAt };
}

const defaultDependencies: AssessmentDependencies = {
	readBundle: readEvidenceBundle,
	verifyGitPatch: verifyGitPatchBundle,
	writeReport: writeAssessmentReport,
};

export async function assessEvidenceBundle(
	options: {
		evidencePath: string;
		expectation?: PatchExpectation;
	},
	dependencies: AssessmentDependencies = defaultDependencies,
): Promise<AssessmentResult> {
	const bundle = await dependencies.readBundle(options.evidencePath);
	const gitPatchVerification = await dependencies.verifyGitPatch(bundle, options.evidencePath);
	const report: AssessmentReport = {
		version: 1,
		createdAt: new Date().toISOString(),
		evidence: {
			path: options.evidencePath,
			createdAt: bundle.createdAt,
		},
		gitPatchVerification,
		verifiers: {
			command: summarizeCommandVerification(bundle.commandVerification),
			hiddenOracle: bundle.hiddenOracle ?? null,
		},
		verdict: decidePatchVerdict({
			bundle,
			verification: gitPatchVerification,
			expectation: options.expectation ?? bundle.policy.patchExpectation,
		}),
	};
	const reference = await dependencies.writeReport({ path: getAssessmentReportPath(options.evidencePath), report });
	return { report, reference };
}
