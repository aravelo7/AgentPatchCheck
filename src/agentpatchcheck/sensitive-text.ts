const REDACTED_PROMPT = "[REDACTED_PROMPT]";
const REDACTED_SECRET = "[REDACTED_SECRET]";

export function redactSensitiveText(value: string, prompt?: string): string {
	let redacted = prompt === undefined || prompt.length === 0 ? value : value.replaceAll(prompt, REDACTED_PROMPT);
	redacted = redacted.replace(
		/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu,
		REDACTED_SECRET,
	);
	redacted = redacted.replace(/\b(?:sk|rk|sess)_[a-zA-Z0-9_-]{12,}\b/gu, REDACTED_SECRET);
	redacted = redacted.replace(/\bBearer\s+[a-zA-Z0-9._~+/-]{12,}\b/giu, `Bearer ${REDACTED_SECRET}`);
	return redacted.replace(
		/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password)\b\s*[:=]\s*([^\s,;]+)/giu,
		`$1=${REDACTED_SECRET}`,
	);
}
