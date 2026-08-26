import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveCredential } from "../../src/agentpatchcheck/credential-resolver";
import { loadProjectEnvironment } from "../../src/agentpatchcheck/project-environment";

const credentialKey = "DEEPSEEK_API_KEY";
const originalCredential = process.env[credentialKey];
const temporaryPaths: string[] = [];

afterEach(async () => {
	if (originalCredential === undefined) delete process.env[credentialKey];
	else process.env[credentialKey] = originalCredential;
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true })));
});

async function writeTemporaryEnv(content: string): Promise<string> {
	const path = join(tmpdir(), `agentpatchcheck-project-environment-${crypto.randomUUID()}.env`);
	temporaryPaths.push(path);
	await writeFile(path, content, "utf8");
	return path;
}

describe("project environment", () => {
	it("loads a project env credential for the existing credential resolver", async () => {
		delete process.env[credentialKey];
		const envPath = await writeTemporaryEnv(`${credentialKey}=from-project-env\n`);

		expect(loadProjectEnvironment(envPath)).toBe("loaded");
		expect(resolveCredential("deepseek-primary")).toMatchObject({ ok: true, secret: "from-project-env" });
	});

	it("preserves an explicit process environment credential", async () => {
		process.env[credentialKey] = "explicit-process-value";
		const envPath = await writeTemporaryEnv(`${credentialKey}=from-project-env\n`);

		expect(loadProjectEnvironment(envPath)).toBe("loaded");
		expect(process.env[credentialKey]).toBe("explicit-process-value");
	});

	it("continues when the project env file is absent", () => {
		expect(loadProjectEnvironment(join(tmpdir(), `agentpatchcheck-missing-${crypto.randomUUID()}.env`))).toBe(
			"missing",
		);
	});
});
