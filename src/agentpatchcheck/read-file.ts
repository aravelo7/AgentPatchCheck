import { createReadStream } from "node:fs";

/** Mature coding-agent default: one call returns at most this many lines. */
export const READ_FILE_MAX_LINES = 2_000;
/** Prevent a single newline-free line from dominating the model context. */
export const READ_FILE_MAX_LINE_LENGTH = 2_000;
/** Independent content cap; the Runtime observation cap may lower it further. */
export const READ_FILE_MAX_CONTENT_BYTES = 50 * 1_024;

export interface ReadFileInput {
	path: string;
	offset: number;
	limit: number;
}

export interface ReadFileLine {
	number: number;
	text: string;
}

export interface ReadFileWindow {
	offset: number;
	limit: number;
	lines: ReadFileLine[];
	totalLines: number;
	truncatedByBytes: boolean;
}

export interface ReadFileResult extends ReadFileWindow {
	observation: string;
}

function positiveInteger(value: unknown, name: "offset" | "limit", maximum?: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
		throw new Error(`${name} must be a positive integer.`);
	if (maximum !== undefined && value > maximum) throw new Error(`${name} must be at most ${maximum}.`);
	return value;
}

/** Validate and default the Provider-neutral read-file arguments. */
export function parseReadFileArguments(argumentsValue: Record<string, unknown>): ReadFileInput {
	const path = argumentsValue.path;
	if (typeof path !== "string" || path.trim().length === 0) throw new Error("path must be a non-empty string.");
	return {
		path,
		offset: argumentsValue.offset === undefined ? 1 : positiveInteger(argumentsValue.offset, "offset"),
		limit:
			argumentsValue.limit === undefined
				? READ_FILE_MAX_LINES
				: positiveInteger(argumentsValue.limit, "limit", READ_FILE_MAX_LINES),
	};
}

function truncatedLine(line: string): string {
	return line.length > READ_FILE_MAX_LINE_LENGTH
		? `${line.slice(0, READ_FILE_MAX_LINE_LENGTH)}... (line truncated to ${READ_FILE_MAX_LINE_LENGTH} chars)`
		: line;
}

/**
 * Build a line-numbered window from whole or streamed UTF-8 chunks. The line
 * buffer itself is capped, so a newline-free file does not require unbounded
 * memory. The scan continues to EOF to provide an exact total line count.
 */
export async function buildReadFileWindow(
	chunks: AsyncIterable<string> | Iterable<string>,
	input: Pick<ReadFileInput, "offset" | "limit">,
	maxContentBytes: number,
	displayPath: string,
): Promise<ReadFileWindow> {
	const lines: ReadFileLine[] = [];
	const lineBufferCap = READ_FILE_MAX_LINE_LENGTH + 1;
	let lineBuffer = "";
	let totalLines = 0;
	let outputBytes = 0;
	let truncatedByBytes = false;

	function append(segment: string): void {
		if (lineBuffer.length >= lineBufferCap) return;
		lineBuffer += segment;
		if (lineBuffer.length > lineBufferCap) lineBuffer = lineBuffer.slice(0, lineBufferCap);
	}

	function consume(): void {
		totalLines += 1;
		if (truncatedByBytes || totalLines < input.offset || lines.length >= input.limit) {
			lineBuffer = "";
			return;
		}
		const rawLine = lineBuffer.endsWith("\r") ? lineBuffer.slice(0, -1) : lineBuffer;
		const text = truncatedLine(rawLine);
		const bytes = Buffer.byteLength(text, "utf8") + (lines.length > 0 ? 1 : 0);
		if (outputBytes + bytes > maxContentBytes) truncatedByBytes = true;
		else {
			outputBytes += bytes;
			lines.push({ number: totalLines, text });
		}
		lineBuffer = "";
	}

	for await (const chunk of chunks) {
		let start = 0;
		let newline = chunk.indexOf("\n", start);
		while (newline !== -1) {
			append(chunk.slice(start, newline));
			consume();
			start = newline + 1;
			newline = chunk.indexOf("\n", start);
		}
		append(chunk.slice(start));
	}
	if (lineBuffer.length > 0) consume();
	if (input.offset > totalLines && !(totalLines === 0 && input.offset === 1))
		throw new Error(`offset ${input.offset} is out of range for "${displayPath}" (${totalLines} lines).`);
	return { ...input, lines, totalLines, truncatedByBytes };
}

function formatReadFileObservation(displayPath: string, window: ReadFileWindow): string {
	const endLine = window.lines.at(-1)?.number ?? Math.max(0, window.offset - 1);
	const footer = window.truncatedByBytes
		? `(Output capped. Showing lines ${window.offset}-${endLine}. Use offset=${endLine + 1} to continue.)`
		: endLine < window.totalLines
			? `(Showing lines ${window.offset}-${endLine} of ${window.totalLines}. Use offset=${endLine + 1} to continue.)`
			: `(End of file - total ${window.totalLines} lines)`;
	const body =
		window.lines.length === 0
			? footer
			: `${window.lines.map((line) => `${line.number}: ${line.text}`).join("\n")}\n\n${footer}`;
	return `<path>${displayPath}</path>\n<type>file</type>\n<content>\n${body}\n</content>`;
}

/** Render a bounded file observation from repository-provided UTF-8 text. */
export async function readBoundedTextWindow(options: {
	content: string;
	displayPath: string;
	input: ReadFileInput;
	maxObservationBytes: number;
}): Promise<ReadFileResult> {
	const window = await buildReadFileWindow(
		[options.content],
		options.input,
		Math.min(READ_FILE_MAX_CONTENT_BYTES, options.maxObservationBytes),
		options.displayPath,
	);
	const boundedWindow = { ...window, lines: [...window.lines] };
	let observation = formatReadFileObservation(options.displayPath, boundedWindow);
	while (Buffer.byteLength(observation, "utf8") > options.maxObservationBytes && boundedWindow.lines.length > 0) {
		boundedWindow.lines.pop();
		boundedWindow.truncatedByBytes = true;
		observation = formatReadFileObservation(options.displayPath, boundedWindow);
	}
	if (Buffer.byteLength(observation, "utf8") > options.maxObservationBytes)
		throw new Error("read-file observation metadata exceeds the configured byte limit.");
	return { ...boundedWindow, observation };
}

/** Stream and render one bounded, replay-safe model observation. */
export async function readBoundedFileWindow(options: {
	absolutePath: string;
	displayPath: string;
	input: ReadFileInput;
	maxObservationBytes: number;
}): Promise<ReadFileResult> {
	const chunks = createReadStream(options.absolutePath, { encoding: "utf8" });
	const window = await buildReadFileWindow(
		chunks,
		options.input,
		Math.min(READ_FILE_MAX_CONTENT_BYTES, options.maxObservationBytes),
		options.displayPath,
	);
	const boundedWindow = { ...window, lines: [...window.lines] };
	let observation = formatReadFileObservation(options.displayPath, boundedWindow);
	while (Buffer.byteLength(observation, "utf8") > options.maxObservationBytes && boundedWindow.lines.length > 0) {
		boundedWindow.lines.pop();
		boundedWindow.truncatedByBytes = true;
		observation = formatReadFileObservation(options.displayPath, boundedWindow);
	}
	if (Buffer.byteLength(observation, "utf8") > options.maxObservationBytes)
		throw new Error("read-file observation metadata exceeds the configured byte limit.");
	return { ...boundedWindow, observation };
}
