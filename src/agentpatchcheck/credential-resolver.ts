const CREDENTIAL_ENVIRONMENT_VARIABLES = {
	"openai-primary": "OPENAI_API_KEY",
	"openai-secondary": "OPENAI_API_KEY_SECONDARY",
	"deepseek-primary": "DEEPSEEK_API_KEY",
	"provider-a-primary": "AGENTPATCHCHECK_KEY_PROVIDER_A",
	"provider-b-primary": "AGENTPATCHCHECK_KEY_PROVIDER_B",
} as const;

export type CredentialRef = keyof typeof CREDENTIAL_ENVIRONMENT_VARIABLES;

export type CredentialResolution =
	| { ok: true; credentialRef: CredentialRef; secret: string }
	| { ok: false; kind: "missing-credential" | "invalid-credential-reference"; credentialRef: string };

export function isCredentialRef(value: string): value is CredentialRef {
	return Object.hasOwn(CREDENTIAL_ENVIRONMENT_VARIABLES, value);
}

/** Resolves only a fixed logical reference. Callers must never persist `secret`. */
export function resolveCredential(
	credentialRef: string,
	environment: NodeJS.ProcessEnv = process.env,
): CredentialResolution {
	if (!isCredentialRef(credentialRef)) {
		return { ok: false, kind: "invalid-credential-reference", credentialRef };
	}
	const secret = environment[CREDENTIAL_ENVIRONMENT_VARIABLES[credentialRef]]?.trim();
	return secret ? { ok: true, credentialRef, secret } : { ok: false, kind: "missing-credential", credentialRef };
}
