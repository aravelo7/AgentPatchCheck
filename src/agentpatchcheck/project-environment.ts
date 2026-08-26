import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ProjectEnvironmentLoadStatus = "loaded" | "missing";

let defaultEnvironmentLoaded = false;

/** Locates the AgentPatchCheck package root without relying on a target repository cwd. */
export function findAgentPatchCheckProjectRoot(startDirectory = dirname(fileURLToPath(import.meta.url))): string {
	let directory = resolve(startDirectory);
	while (true) {
		if (existsSync(join(directory, "package.json"))) return directory;
		const parent = dirname(directory);
		if (parent === directory) return resolve(startDirectory, "..", "..");
		directory = parent;
	}
}

/** Loads a project-local .env once at process startup. Existing process environment values take precedence. */
export function loadProjectEnvironment(envPath: string): ProjectEnvironmentLoadStatus {
	if (!existsSync(envPath)) return "missing";
	process.loadEnvFile(envPath);
	return "loaded";
}

export function initializeAgentPatchCheckEnvironment(): ProjectEnvironmentLoadStatus | "already-loaded" {
	if (defaultEnvironmentLoaded) return "already-loaded";
	defaultEnvironmentLoaded = true;
	return loadProjectEnvironment(join(findAgentPatchCheckProjectRoot(), ".env"));
}
