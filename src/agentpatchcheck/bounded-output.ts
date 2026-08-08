export function appendBoundedOutput(current: string, chunk: Buffer | string, outputLimitBytes: number): string {
	const currentBytes = Buffer.byteLength(current, "utf8");
	if (currentBytes >= outputLimitBytes) {
		return current;
	}
	const text = String(chunk);
	const remainingBytes = outputLimitBytes - currentBytes;
	if (Buffer.byteLength(text, "utf8") <= remainingBytes) {
		return `${current}${text}`;
	}
	return `${current}${Buffer.from(text, "utf8").subarray(0, remainingBytes).toString("utf8")}`;
}
