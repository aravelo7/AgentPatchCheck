import type {
	HarnessNativeProtocolRecoveryFeedback,
	HarnessNativeProtocolRecoveryOwner,
	HarnessNativeProviderFailure,
} from "./types";

export const DEFAULT_MAX_PROTOCOL_RECOVERIES = 2;
export const MAX_PROTOCOL_RECOVERIES = 3;

/** Protocol-shape failures are correctable; transport, auth, and semantic failures are not. */
export function isRecoverableProtocolFailure(failure: HarnessNativeProviderFailure): boolean {
	return failure.kind === "malformed-response" || failure.kind === "unsupported-tool-calling";
}

function correction(failure: HarnessNativeProviderFailure): string {
	const issue = failure.validationIssue;
	if (issue !== undefined)
		return `Return one valid structured response. Correct ${issue.path}: ${issue.issue} (${issue.constraint}); received type ${issue.receivedType}.`;
	if (failure.detail === "no-tool-calls")
		return "Return exactly one supplied function call; do not answer with text only.";
	if (failure.detail === "multiple-tool-calls")
		return "Return exactly one planning function call for this planning decision.";
	if (failure.detail === "mixed-control-tool-calls")
		return "Do not combine finish or fail with execution tool calls in one response.";
	if (failure.detail === "unsupported-tool-name") return "Use only a function name from the supplied tool list.";
	if (failure.detail === "invalid-tool-arguments")
		return "Return tool arguments as one JSON object matching the selected function schema.";
	if (failure.detail === "invalid-tool-call-shape" || failure.detail === "missing-tool-function")
		return "Return a complete function call with a supported name and JSON-object arguments.";
	return "Return one valid structured function call matching the supplied schema.";
}

/** Builds bounded, value-free correction context from normalized Provider failure facts. */
export function createProtocolRecoveryFeedback(
	owner: HarnessNativeProtocolRecoveryOwner,
	failure: HarnessNativeProviderFailure,
	recovery: number,
	maxRecoveries: number,
): HarnessNativeProtocolRecoveryFeedback {
	if (!isRecoverableProtocolFailure(failure))
		throw new Error("Non-protocol failures cannot create recovery feedback.");
	return {
		version: 1,
		owner,
		recovery,
		maxRecoveries,
		failure: structuredClone(failure),
		correction: correction(failure),
	};
}
