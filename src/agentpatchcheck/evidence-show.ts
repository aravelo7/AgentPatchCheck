import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { getAssessmentReportPath } from "./assessment-report";
import { readEvidenceBundle } from "./git-patch-verifier";
import type { AssessmentReport, EvidenceAssessmentStatus, EvidenceBundle, EvidenceShowResult } from "./types";

interface EvidenceShowDependencies {
	readBundle: (path: string) => Promise<EvidenceBundle>;
	readAssessment: (path: string) => Promise<unknown | null>;
}

function pathsEqual(left: string, right: string): boolean {
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function readAssessment(path: string): Promise<unknown | null> {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return null;
		}
		return undefined;
	}
}

function getMatchingAssessment(
	value: unknown,
	evidencePath: string,
	evidenceCreatedAt: string,
): { status: EvidenceAssessmentStatus; report: AssessmentReport | null } {
	if (!value || typeof value !== "object") {
		return { status: value === null ? "missing" : "invalid", report: null };
	}
	const report = value as Partial<AssessmentReport>;
	const verdictStatus = report.verdict?.status;
	if (
		report.version !== 1 ||
		typeof report.createdAt !== "string" ||
		report.evidence?.createdAt !== evidenceCreatedAt ||
		typeof report.evidence.path !== "string" ||
		!pathsEqual(resolve(report.evidence.path), resolve(evidencePath)) ||
		(verdictStatus !== "pass" && verdictStatus !== "fail" && verdictStatus !== "inconclusive")
	) {
		return { status: "invalid", report: null };
	}
	return { status: "valid", report: report as AssessmentReport };
}

const defaultDependencies: EvidenceShowDependencies = {
	readBundle: readEvidenceBundle,
	readAssessment,
};

export async function showEvidenceBundle(
	options: { evidencePath: string },
	dependencies: EvidenceShowDependencies = defaultDependencies,
): Promise<EvidenceShowResult> {
	const evidencePath = resolve(options.evidencePath);
	const bundle = await dependencies.readBundle(evidencePath);
	const assessmentPath = getAssessmentReportPath(evidencePath);
	const assessment = getMatchingAssessment(
		await dependencies.readAssessment(assessmentPath),
		evidencePath,
		bundle.createdAt,
	);

	return {
		evidence: { path: evidencePath, createdAt: bundle.createdAt },
		policy: bundle.policy,
		workspace: bundle.workspace,
		agent: {
			executable: bundle.agent.executable,
			args: bundle.agent.args,
			exitCode: bundle.agent.exitCode,
			signal: bundle.agent.signal,
			durationMs: bundle.agent.durationMs,
			timedOut: bundle.agent.timedOut,
			stdoutBytes: Buffer.byteLength(bundle.agent.stdout, "utf8"),
			stderrBytes: Buffer.byteLength(bundle.agent.stderr, "utf8"),
		},
		commandVerification: {
			status: bundle.commandVerification.status,
			cwd: bundle.commandVerification.cwd,
			commands: bundle.commandVerification.commands.map((command) => ({
				command: command.command,
				args: command.args,
				exitCode: command.exitCode,
				signal: command.signal,
				durationMs: command.durationMs,
				timedOut: command.timedOut,
				stdoutBytes: Buffer.byteLength(command.stdout, "utf8"),
				stderrBytes: Buffer.byteLength(command.stderr, "utf8"),
			})),
		},
		patch: {
			changedFiles: bundle.patch.changedFiles,
			trackedPatchSha256: bundle.patch.trackedPatchSha256,
			trackedPatchBytes: Buffer.byteLength(bundle.patch.trackedPatch, "utf8"),
			untrackedFileCount: bundle.patch.untrackedFiles?.length ?? 0,
			untrackedFileBytes: (bundle.patch.untrackedFiles ?? []).reduce((total, file) => total + file.byteLength, 0),
		},
		result: bundle.result,
		assessment: {
			status: assessment.status,
			path: assessmentPath,
			report:
				assessment.report === null
					? null
					: {
							createdAt: assessment.report.createdAt,
							verdict: assessment.report.verdict,
							gitPatchVerification: assessment.report.gitPatchVerification,
						},
		},
	};
}
