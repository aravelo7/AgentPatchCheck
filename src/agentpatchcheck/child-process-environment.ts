const sensitiveEnvironmentName = /(?:api[_-]?key|token|secret|password|passwd|authorization)/iu;

/** Removes credential-shaped variables before executing target-repository code. */
export function sanitizedChildEnvironment(): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(process.env).filter(([name]) => !sensitiveEnvironmentName.test(name)));
}
