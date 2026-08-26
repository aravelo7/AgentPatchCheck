import { DEFAULT_MAX_PROJECTED_OBSERVATION_BYTES } from "./history-projection";
import type {
	HarnessNativeActivePlanStep,
	HarnessNativeAttemptReview,
	HarnessNativeContinuationContextView,
	HarnessNativeContinuationEvidence,
	HarnessNativeContinuationEvidenceKind,
	HarnessNativeExecutionPlan,
	HarnessNativeRuntimeEvent,
	HarnessNativeToolResultFacts,
} from "./types";

const MAX_REPOSITORY_EVIDENCE = 6;
const MAX_RECENT_TAIL = 4;

interface ContinuationSource {
	ended: Extract<HarnessNativeRuntimeEvent, { type: "attempt-ended" }> | undefined;
	reviewed: Extract<HarnessNativeRuntimeEvent, { type: "attempt-reviewed" }> | undefined;
	planEvent: Extract<HarnessNativeRuntimeEvent, { type: "plan-revised" }> | undefined;
	activeEvent: Extract<HarnessNativeRuntimeEvent, { type: "plan-execution-updated" }> | undefined;
	toolEvents: Array<Extract<HarnessNativeRuntimeEvent, { type: "tool-result" }>>;
}

function byteLength(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function utf8Prefix(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const points = Array.from(text);
	let low = 0;
	let high = points.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(points.slice(0, middle).join(""), "utf8") <= maxBytes) low = middle;
		else high = middle - 1;
	}
	return points.slice(0, low).join("");
}

function truncateObservation(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let low = 0;
	let high = Math.max(0, maxBytes);
	let best = "";
	const reversed = Array.from(text).reverse().join("");
	while (low <= high) {
		const retainedBytes = Math.floor((low + high) / 2);
		const head = utf8Prefix(text, Math.ceil(retainedBytes / 2));
		const tail = Array.from(utf8Prefix(reversed, Math.floor(retainedBytes / 2)))
			.reverse()
			.join("");
		const omittedBytes = Math.max(
			0,
			Buffer.byteLength(text, "utf8") - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8"),
		);
		const candidate = `${head}\n[… omitted ${omittedBytes} UTF-8 bytes …]\n${tail}`;
		if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
			best = candidate;
			low = retainedBytes + 1;
		} else high = retainedBytes - 1;
	}
	return best;
}

function pathsForFacts(facts: HarnessNativeToolResultFacts): string[] {
	if (facts.kind === "retrieval") return [...new Set([...facts.inspectedPaths, ...facts.candidatePaths])];
	if (facts.kind === "mutation") return [...facts.affectedPaths];
	return [];
}

function evidenceKind(
	event: Extract<HarnessNativeRuntimeEvent, { type: "tool-result" }>,
): HarnessNativeContinuationEvidenceKind {
	if (event.status !== "ok") return "failure";
	if (event.facts.kind === "retrieval") return "repository";
	if (event.facts.kind === "mutation") return "mutation";
	if (event.facts.kind === "verification") return "verification";
	return "recent";
}

function toEvidence(
	event: Extract<HarnessNativeRuntimeEvent, { type: "tool-result" }>,
): HarnessNativeContinuationEvidence {
	return {
		sequence: event.sequence,
		iteration: event.iteration,
		kind: evidenceKind(event),
		tool: event.tool,
		status: event.status,
		paths: pathsForFacts(event.facts),
		observation: event.observation,
	};
}

function repositoryEvidenceKey(event: Extract<HarnessNativeRuntimeEvent, { type: "tool-result" }>): string {
	if (event.facts.kind !== "retrieval") return `${event.tool}:${event.sequence}`;
	return JSON.stringify([event.tool, event.facts.path, event.facts.query]);
}

function findLastToolEvent(
	toolEvents: readonly Extract<HarnessNativeRuntimeEvent, { type: "tool-result" }>[],
	predicate: (event: Extract<HarnessNativeRuntimeEvent, { type: "tool-result" }>) => boolean,
): Extract<HarnessNativeRuntimeEvent, { type: "tool-result" }> | undefined {
	for (let index = toolEvents.length - 1; index >= 0; index -= 1) {
		const event = toolEvents[index];
		if (event !== undefined && predicate(event)) return event;
	}
	return undefined;
}

function selectEvidence(toolEvents: readonly Extract<HarnessNativeRuntimeEvent, { type: "tool-result" }>[]): {
	evidence: HarnessNativeContinuationEvidence[];
	candidateCount: number;
} {
	const selected = new Map<number, Extract<HarnessNativeRuntimeEvent, { type: "tool-result" }>>();
	const repositoryByKey = new Map<string, Extract<HarnessNativeRuntimeEvent, { type: "tool-result" }>>();
	for (const event of toolEvents) {
		if (event.status === "ok" && event.facts.kind === "retrieval")
			repositoryByKey.set(repositoryEvidenceKey(event), event);
	}
	for (const event of [...repositoryByKey.values()].slice(-MAX_REPOSITORY_EVIDENCE))
		selected.set(event.sequence, event);
	for (const kind of ["mutation", "verification"] as const) {
		const event = findLastToolEvent(
			toolEvents,
			(candidate) => candidate.status === "ok" && candidate.facts.kind === kind,
		);
		if (event !== undefined) selected.set(event.sequence, event);
	}
	const failure = findLastToolEvent(toolEvents, (event) => event.status !== "ok");
	if (failure !== undefined) selected.set(failure.sequence, failure);
	for (const event of toolEvents.slice(-MAX_RECENT_TAIL)) selected.set(event.sequence, event);
	const evidence = [...selected.values()].sort((left, right) => left.sequence - right.sequence).map(toEvidence);
	return { evidence, candidateCount: evidence.length };
}

function locateSource(events: readonly HarnessNativeRuntimeEvent[], previousAttempt: number): ContinuationSource {
	const source: ContinuationSource = {
		ended: undefined,
		reviewed: undefined,
		planEvent: undefined,
		activeEvent: undefined,
		toolEvents: [],
	};
	for (const event of events) {
		if (event.attempt !== previousAttempt) continue;
		if (event.type === "attempt-ended") source.ended = event;
		else if (event.type === "attempt-reviewed") source.reviewed = event;
		else if (event.type === "plan-revised") source.planEvent = event;
		else if (event.type === "plan-execution-updated") source.activeEvent = event;
		else if (event.type === "tool-result") source.toolEvents.push(event);
	}
	return source;
}

function unresolvedWork(
	activeStep: HarnessNativeActivePlanStep | null,
): HarnessNativeContinuationContextView["unresolvedWork"] {
	if (activeStep === null) return null;
	return {
		objective: activeStep.objective,
		step: activeStep.step,
		executionCheckpoint: activeStep.executionCheckpoint,
		previousRevision: activeStep.revision,
		previousExecutionId: activeStep.executionId,
	};
}

function fitEvidence(
	base: Omit<HarnessNativeContinuationContextView, "evidence" | "retention">,
	candidates: HarnessNativeContinuationEvidence[],
	maxBytes: number,
): HarnessNativeContinuationContextView {
	const evidence = candidates.map((entry) => structuredClone(entry));
	const originalObservationBytes = evidence.reduce(
		(sum, entry) => sum + Buffer.byteLength(entry.observation, "utf8"),
		0,
	);
	const truncated = new Set<number>();
	const render = (): HarnessNativeContinuationContextView => {
		const retainedObservationBytes = evidence.reduce(
			(sum, entry) => sum + Buffer.byteLength(entry.observation, "utf8"),
			0,
		);
		return {
			...base,
			evidence,
			retention: {
				maxBytes,
				// Reserve the configured cap's digit width while fitting the self-describing envelope.
				renderedBytes: maxBytes,
				candidateEvidenceCount: candidates.length,
				retainedEvidenceCount: evidence.length,
				omittedEvidenceCount: candidates.length - evidence.length,
				omittedObservationBytes: Math.max(0, originalObservationBytes - retainedObservationBytes),
				truncatedEvidenceCount: truncated.size,
			},
		};
	};
	while (byteLength(render()) > maxBytes) {
		const dropIndex = evidence.findIndex((entry, index) => entry.kind === "recent" && index !== evidence.length - 1);
		if (dropIndex < 0) break;
		evidence.splice(dropIndex, 1);
	}
	while (byteLength(render()) > maxBytes && evidence.length > 0) {
		let longestIndex = 0;
		for (let index = 1; index < evidence.length; index += 1) {
			if (
				Buffer.byteLength(evidence[index]?.observation ?? "", "utf8") >
				Buffer.byteLength(evidence[longestIndex]?.observation ?? "", "utf8")
			)
				longestIndex = index;
		}
		const entry = evidence[longestIndex];
		if (entry === undefined) break;
		const previousBytes = Buffer.byteLength(entry.observation, "utf8");
		const overflow = byteLength(render()) - maxBytes;
		const fixedBytes =
			byteLength(render()) - evidence.reduce((sum, item) => sum + Buffer.byteLength(item.observation, "utf8"), 0);
		const fairShare = Math.max(0, Math.floor((maxBytes - fixedBytes) / evidence.length));
		const observation = truncateObservation(entry.observation, Math.max(fairShare, previousBytes - overflow));
		if (Buffer.byteLength(observation, "utf8") >= previousBytes) break;
		evidence[longestIndex] = { ...entry, observation };
		truncated.add(entry.sequence);
	}
	const result = render();
	let renderedBytes = byteLength(result);
	result.retention.renderedBytes = renderedBytes;
	renderedBytes = byteLength(result);
	result.retention.renderedBytes = renderedBytes;
	if (result.retention.renderedBytes > maxBytes)
		throw new Error("Continuation context fixed envelope exceeds its byte budget.");
	return result;
}

/** Derives one replayable attempt-boundary checkpoint plus a bounded recent evidence tail. */
export function deriveHarnessNativeContinuationContext(
	events: readonly HarnessNativeRuntimeEvent[],
	currentAttempt: number,
	maxBytes = DEFAULT_MAX_PROJECTED_OBSERVATION_BYTES,
): HarnessNativeContinuationContextView | null {
	if (!Number.isSafeInteger(currentAttempt) || currentAttempt < 1)
		throw new Error("Continuation attempt must be positive.");
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1_024)
		throw new Error("Continuation context byte budget must be at least 1024.");
	const previousReview = [...events]
		.reverse()
		.find((event) => event.attempt < currentAttempt && event.type === "attempt-reviewed");
	if (previousReview === undefined) return null;
	const previousStart = events.find(
		(event) => event.attempt === previousReview.attempt && event.type === "attempt-started",
	);
	if (previousStart === undefined) throw new Error("Continuation review has no attempt-started owner.");
	const source = locateSource(events, previousReview.attempt);
	const plan: HarnessNativeExecutionPlan | null =
		source.planEvent === undefined ? null : structuredClone(source.planEvent.revision.plan);
	const activeStep =
		source.activeEvent?.activeStep === undefined || source.activeEvent.activeStep === null
			? null
			: structuredClone(source.activeEvent.activeStep);
	const selected = selectEvidence(source.toolEvents);
	const sourceEventSequences = [
		previousStart.sequence,
		source.planEvent?.sequence,
		source.activeEvent?.sequence,
		...selected.evidence.map((entry) => entry.sequence),
		source.ended?.sequence,
		source.reviewed?.sequence,
	].filter((sequence): sequence is number => sequence !== undefined);
	return fitEvidence(
		{
			version: 2,
			previousAttempt: previousStart.attempt,
			throughEventSequence: Math.max(...sourceEventSequences),
			sourceEventSequences: [...new Set(sourceEventSequences)].sort((left, right) => left - right),
			terminationReason: source.ended?.terminationReason ?? null,
			review:
				source.reviewed === undefined
					? null
					: (structuredClone(source.reviewed.review) as HarnessNativeAttemptReview),
			plan,
			activePlanStep: activeStep,
			unresolvedWork: unresolvedWork(activeStep),
		},
		selected.evidence,
		maxBytes,
	);
}
