import type {
	HarnessNativeHistoryProjection,
	HarnessNativeHistoryProjectionInteraction,
	HarnessNativeToolName,
} from "./types";

export const DEFAULT_MAX_PROJECTED_OBSERVATION_BYTES = 64 * 1024;
const OBSERVATION_SEPARATOR = "\n---\n";

const mutationTools = new Set<HarnessNativeToolName>([
	"apply-edit",
	"apply-patch",
	"apply-patch-batch",
	"apply-edit-batch",
	"create-file",
]);

function isProtectedInteraction(interaction: HarnessNativeHistoryProjectionInteraction): boolean {
	return (
		mutationTools.has(interaction.tool) ||
		interaction.tool === "run-public-verification" ||
		interaction.status !== "ok"
	);
}

function observationBytes(interactions: readonly HarnessNativeHistoryProjectionInteraction[]): number {
	return Buffer.byteLength(
		interactions.map((interaction) => interaction.observation).join(OBSERVATION_SEPARATOR),
		"utf8",
	);
}

function truncateUtf8Prefix(text: string, maxBytes: number): string {
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
	if (maxBytes <= 0) return "";
	let low = 0;
	let high = maxBytes;
	let best = "";
	while (low <= high) {
		const retainedBytes = Math.floor((low + high) / 2);
		const headBudget = Math.ceil(retainedBytes / 2);
		const tailBudget = Math.floor(retainedBytes / 2);
		const head = truncateUtf8Prefix(text, headBudget);
		const tail = Array.from(text).reverse().join("");
		const retainedTail = Array.from(truncateUtf8Prefix(tail, tailBudget)).reverse().join("");
		const omittedBytes = Math.max(
			0,
			Buffer.byteLength(text, "utf8") - Buffer.byteLength(head, "utf8") - Buffer.byteLength(retainedTail, "utf8"),
		);
		const candidate = `${head}\n[… omitted ${omittedBytes} UTF-8 bytes …]\n${retainedTail}`;
		if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
			best = candidate;
			low = retainedBytes + 1;
		} else high = retainedBytes - 1;
	}
	return best;
}

/**
 * Builds a bounded provider view without changing canonical Runtime history.
 * The processor is deliberately independent of retrieval tools and fact shapes:
 * it retains whole interactions until the observation budget requires elision,
 * while preserving outcome-relevant units.
 */
export function projectHistory(
	interactions: readonly HarnessNativeHistoryProjectionInteraction[],
	maxObservationBytes = DEFAULT_MAX_PROJECTED_OBSERVATION_BYTES,
): {
	interactions: HarnessNativeHistoryProjectionInteraction[];
	metadata: HarnessNativeHistoryProjection;
} {
	if (!Number.isSafeInteger(maxObservationBytes) || maxObservationBytes < 1)
		throw new Error("History projection observation budget must be a positive integer.");
	const projected = interactions.map((interaction) => structuredClone(interaction));
	const newestSequence = projected.at(-1)?.sequence;
	while (observationBytes(projected) > maxObservationBytes) {
		const dropIndex = projected.findIndex(
			(interaction) => interaction.sequence !== newestSequence && !isProtectedInteraction(interaction),
		);
		if (dropIndex < 0) break;
		projected.splice(dropIndex, 1);
	}
	const truncatedObservationSequences = new Set<number>();
	while (observationBytes(projected) > maxObservationBytes && projected.length > 0) {
		let longestIndex = 0;
		for (let index = 1; index < projected.length; index += 1) {
			if (
				Buffer.byteLength(projected[index]?.observation ?? "", "utf8") >
				Buffer.byteLength(projected[longestIndex]?.observation ?? "", "utf8")
			)
				longestIndex = index;
		}
		const interaction = projected[longestIndex];
		if (interaction === undefined) break;
		const previousBytes = Buffer.byteLength(interaction.observation, "utf8");
		const overflow = observationBytes(projected) - maxObservationBytes;
		const separatorBytes = Buffer.byteLength(OBSERVATION_SEPARATOR, "utf8") * Math.max(0, projected.length - 1);
		const fairShare = Math.max(0, Math.floor((maxObservationBytes - separatorBytes) / projected.length));
		const shortened = truncateObservation(interaction.observation, Math.max(fairShare, previousBytes - overflow));
		const shortenedBytes = Buffer.byteLength(shortened, "utf8");
		if (shortenedBytes >= previousBytes) break;
		projected[longestIndex] = { ...interaction, observation: shortened };
		truncatedObservationSequences.add(interaction.sequence);
	}
	if (observationBytes(projected) > maxObservationBytes)
		throw new Error("History projection fixed observation envelope exceeds its byte budget.");
	const canonicalObservationBytes = interactions.reduce(
		(total, interaction) => total + Buffer.byteLength(interaction.observation, "utf8"),
		0,
	);
	const retainedObservationBytes = projected.reduce(
		(total, interaction) => total + Buffer.byteLength(interaction.observation, "utf8"),
		0,
	);
	return {
		interactions: projected,
		metadata: {
			version: 1,
			canonicalInteractionCount: interactions.length,
			projectedInteractionCount: projected.length,
			elidedInteractionCount: interactions.length - projected.length,
			canonicalObservationCount: interactions.length,
			projectedObservationCount: projected.length,
			elidedObservationCount: interactions.length - projected.length,
			retainedInteractionIterations: [...new Set(projected.map((interaction) => interaction.iteration))],
			retainedEventSequences: projected.map((interaction) => interaction.sequence),
			projectedObservationBytes: observationBytes(projected),
			omittedObservationBytes: Math.max(0, canonicalObservationBytes - retainedObservationBytes),
			truncatedObservationCount: truncatedObservationSequences.size,
		},
	};
}
