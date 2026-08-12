import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadTaskSpec } from "../../src/agentpatchcheck/task-spec";

describe("TaskSpec", () => {
	it("loads a strict local specification and resolves its prompt file", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agentpatchcheck-task-spec-"));
		try {
			await writeFile(join(directory, "prompt.txt"), "Inspect the requested change.", "utf8");
			const specPath = join(directory, "task.json");
			await writeFile(
				specPath,
				JSON.stringify({
					version: 1,
					repositoryRoot: process.cwd(),
					promptFile: "prompt.txt",
					patchExpectation: "changes-required",
					verification: {
						commands: [{ command: process.execPath, args: ["--version"], timeoutMs: 1_000 }],
					},
				}),
				"utf8",
			);

			const input = await loadTaskSpec(specPath);

			expect(input).toMatchObject({
				repositoryRoot: process.cwd(),
				prompt: "Inspect the requested change.",
				patchExpectation: "changes-required",
				verification: { commands: [{ command: process.execPath, args: ["--version"], timeoutMs: 1_000 }] },
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("loads a reusable verification profile and records its source", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agentpatchcheck-task-spec-"));
		try {
			const profileDirectory = join(directory, ".agentpatchcheck", "profiles");
			await mkdir(profileDirectory, { recursive: true });
			const profilePath = join(profileDirectory, "node-version.json");
			await writeFile(
				profilePath,
				JSON.stringify({
					version: 1,
					name: "node-version",
					verification: {
						commands: [{ command: process.execPath, args: ["--version"], timeoutMs: 1_000 }],
					},
				}),
				"utf8",
			);
			const specPath = join(directory, "task.json");
			await writeFile(
				specPath,
				JSON.stringify({
					version: 1,
					repositoryRoot: ".",
					prompt: "Inspect the requested change.",
					patchExpectation: "changes-required",
					verificationProfile: "node-version",
				}),
				"utf8",
			);

			const input = await loadTaskSpec(specPath);

			expect(input.verification).toMatchObject({
				commands: [{ command: process.execPath, args: ["--version"], timeoutMs: 1_000 }],
			});
			expect(input.verificationProfile).toMatchObject({ path: profilePath, name: "node-version" });
			expect(input.verificationProfile?.sha256).toMatch(/^[a-f0-9]{64}$/u);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("loads a Harness-side RiskPolicy Profile with an auditable hash", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agentpatchcheck-task-spec-"));
		try {
			const profilePath = join(directory, "risk-policy.json");
			await writeFile(
				profilePath,
				JSON.stringify({
					version: 1,
					name: "strict-local",
					risk: {
						protectedPaths: ["infra/"],
						sensitivePaths: ["deploy/secrets/"],
						maxChangedFiles: 10,
						maxTrackedPatchBytes: 10_000,
					},
				}),
				"utf8",
			);
			const specPath = join(directory, "task.json");
			await writeFile(
				specPath,
				JSON.stringify({
					version: 1,
					repositoryRoot: process.cwd(),
					prompt: "Inspect the requested change.",
					patchExpectation: "changes-required",
					riskPolicyProfile: "risk-policy.json",
				}),
				"utf8",
			);

			const input = await loadTaskSpec(specPath);

			expect(input.riskPolicy).toMatchObject({
				configuration: { protectedPaths: ["infra/"], sensitivePaths: ["deploy/secrets/"], maxChangedFiles: 10 },
				profile: { path: profilePath, name: "strict-local" },
			});
			expect(input.riskPolicy?.profile.sha256).toMatch(/^[a-f0-9]{64}$/u);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("requires an explicit credential reference for Harness-native TaskSpecs", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agentpatchcheck-task-spec-"));
		try {
			const missingCredential = join(directory, "missing-credential.json");
			const compatibleProvider = join(directory, "compatible.json");
			await writeFile(
				missingCredential,
				JSON.stringify({
					version: 1,
					repositoryRoot: process.cwd(),
					prompt: "Inspect.",
					agentAdapter: "harness-native",
					model: "test-model",
					nativeAgent: {},
					patchExpectation: "changes-required",
				}),
				"utf8",
			);
			await writeFile(
				compatibleProvider,
				JSON.stringify({
					version: 1,
					repositoryRoot: process.cwd(),
					prompt: "Inspect.",
					agentAdapter: "harness-native",
					model: "gateway-model",
					nativeAgent: {
						provider: "openai-compatible",
						protocol: "chat-completions",
						thinkingMode: "disabled",
						baseUrl: "https://gateway.example/v1",
						credentialRef: "provider-a-primary",
					},
					patchExpectation: "changes-required",
				}),
				"utf8",
			);

			await expect(loadTaskSpec(missingCredential)).rejects.toThrow("requires nativeAgent.credentialRef");
			await expect(loadTaskSpec(compatibleProvider)).resolves.toMatchObject({
				nativeAgent: {
					provider: "openai-compatible",
					protocol: "chat-completions",
					thinkingMode: "disabled",
					credentialRef: "provider-a-primary",
				},
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("rejects catalog paths and profile files with a mismatched name", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agentpatchcheck-task-spec-"));
		try {
			const profileDirectory = join(directory, ".agentpatchcheck", "profiles");
			await mkdir(profileDirectory, { recursive: true });
			await writeFile(
				join(profileDirectory, "node-version.json"),
				JSON.stringify({ version: 1, name: "different-name", verification: { commands: [] } }),
				"utf8",
			);
			const pathSpec = join(directory, "path.json");
			await writeFile(
				pathSpec,
				JSON.stringify({
					version: 1,
					repositoryRoot: ".",
					prompt: "Inspect.",
					patchExpectation: "changes-required",
					verificationProfile: "../node-version",
				}),
				"utf8",
			);
			const mismatchedNameSpec = join(directory, "mismatched.json");
			await writeFile(
				mismatchedNameSpec,
				JSON.stringify({
					version: 1,
					repositoryRoot: ".",
					prompt: "Inspect.",
					patchExpectation: "changes-required",
					verificationProfile: "node-version",
				}),
				"utf8",
			);
			const missingProfileSpec = join(directory, "missing.json");
			await writeFile(
				missingProfileSpec,
				JSON.stringify({
					version: 1,
					repositoryRoot: ".",
					prompt: "Inspect.",
					patchExpectation: "changes-required",
					verificationProfile: "missing-profile",
				}),
				"utf8",
			);

			await expect(loadTaskSpec(pathSpec)).rejects.toThrow("Verification profile name must contain");
			await expect(loadTaskSpec(mismatchedNameSpec)).rejects.toThrow("does not match its catalog entry");
			await expect(loadTaskSpec(missingProfileSpec)).rejects.toThrow("Could not read verification profile");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("rejects unknown fields and prompt files outside the TaskSpec directory", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agentpatchcheck-task-spec-"));
		try {
			const unknownFieldPath = join(directory, "unknown.json");
			await writeFile(
				unknownFieldPath,
				JSON.stringify({
					version: 1,
					repositoryRoot: process.cwd(),
					prompt: "Inspect.",
					patchExpectation: "changes-required",
					unexpected: true,
				}),
				"utf8",
			);
			const escapingPromptPath = join(directory, "escaping-prompt.json");
			await writeFile(
				escapingPromptPath,
				JSON.stringify({
					version: 1,
					repositoryRoot: process.cwd(),
					promptFile: "../outside.txt",
					patchExpectation: "changes-required",
				}),
				"utf8",
			);

			await expect(loadTaskSpec(unknownFieldPath)).rejects.toThrow("Invalid TaskSpec");
			await expect(loadTaskSpec(escapingPromptPath)).rejects.toThrow("must stay within");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("rejects conflicting inline and profile verification declarations", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agentpatchcheck-task-spec-"));
		try {
			const specPath = join(directory, "conflict.json");
			await writeFile(
				specPath,
				JSON.stringify({
					version: 1,
					repositoryRoot: process.cwd(),
					prompt: "Inspect.",
					patchExpectation: "changes-required",
					verification: { commands: [] },
					verificationProfile: "node-version",
				}),
				"utf8",
			);

			await expect(loadTaskSpec(specPath)).rejects.toThrow("must not define both");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
