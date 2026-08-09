import type {
	EvidenceBundle,
	GitPatchVerification,
	PatchExpectation,
	PatchVerdict,
	PatchVerdictReasonCode,
} from "./types";

export interface PatchVerdictInput {
	bundle: Pick<EvidenceBundle, "agent" | "patch" | "result" | "commandVerification" | "hiddenOracle">;
	verification: GitPatchVerification;
	expectation: PatchExpectation;
}

interface VerdictFailure {
	code: PatchVerdictReasonCode;
	message: string;
}

function getFailure(input: PatchVerdictInput): VerdictFailure | undefined {
	if (input.verification.status !== "verified") {
		return {
			code: "git-verification-failed",
			message: "Git patch verification did not confirm the recorded worktree state.",
		};
	}
	if (input.bundle.agent.timedOut) {
		return {
			code: "agent-timed-out",
			message: "Agent execution timed out.",
		};
	}
	if (input.bundle.result.status !== "succeeded" || input.bundle.agent.exitCode !== 0) {
		return {
			code: "agent-failed",
			message: "Agent execution did not complete successfully.",
		};
	}
	if (input.bundle.commandVerification.status === "failed") {
		return {
			code: "command-verification-failed",
			message: "An authorized verification command did not complete successfully.",
		};
	}
	if (input.bundle.hiddenOracle?.status === "failed") {
		return {
			code: "hidden-oracle-failed",
			message: "Hidden Oracle rejected the patch.",
		};
	}
	if (input.bundle.hiddenOracle?.status === "timed-out") {
		return {
			code: "hidden-oracle-timed-out",
			message: "Hidden Oracle timed out.",
		};
	}
	if (input.bundle.hiddenOracle?.status === "error") {
		return {
			code: "hidden-oracle-error",
			message: "Hidden Oracle infrastructure failed.",
		};
	}
	return undefined;
}

export function decidePatchVerdict(input: PatchVerdictInput): PatchVerdict {
	const failure = getFailure(input);
	if (failure) {
		return {
			status: "fail",
			expectation: input.expectation,
			reasonCodes: [failure.code],
			reasons: [failure.message],
		};
	}
	if (input.expectation === "changes-required" && input.bundle.patch.changedFiles.length === 0) {
		return {
			status: "inconclusive",
			expectation: input.expectation,
			reasonCodes: ["changes-required-but-none-recorded"],
			reasons: ["The task required changes, but the recorded patch is empty."],
		};
	}
	return {
		status: "pass",
		expectation: input.expectation,
		reasonCodes: [],
		reasons: [],
	};
}
