import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadRiskPolicyProfile } from "../../src/agentpatchcheck/risk-policy-profile";

describe("RiskPolicy Profile", () => {
	it("loads a strict Harness-side profile and preserves its source hash", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agentpatchcheck-risk-profile-"));
		try {
			const path = join(directory, "strict.json");
			await writeFile(
				path,
				JSON.stringify({
					version: 1,
					name: "strict",
					risk: { protectedPaths: ["infra/", "README.md"], maxChangedFiles: 5 },
				}),
				"utf8",
			);
			const result = await loadRiskPolicyProfile(directory, "strict.json");
			expect(result).toMatchObject({
				configuration: { protectedPaths: ["README.md", "infra/"], sensitivePaths: [], maxChangedFiles: 5 },
				profile: { path, name: "strict" },
			});
			expect(result.profile.sha256).toMatch(/^[a-f0-9]{64}$/u);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("rejects escaping, malformed, and safety-loosening profiles", async () => {
		const directory = await mkdtemp(join(tmpdir(), "agentpatchcheck-risk-profile-"));
		try {
			await writeFile(
				join(directory, "loose.json"),
				JSON.stringify({ version: 1, name: "loose", risk: { maxChangedFiles: 26 } }),
				"utf8",
			);
			await writeFile(
				join(directory, "malformed.json"),
				JSON.stringify({ version: 1, name: "malformed", risk: {}, unexpected: true }),
				"utf8",
			);
			await writeFile(
				join(directory, "escaping-path.json"),
				JSON.stringify({ version: 1, name: "escaping-path", risk: { protectedPaths: ["../outside/"] } }),
				"utf8",
			);
			await expect(loadRiskPolicyProfile(directory, "../outside.json")).rejects.toThrow("must stay within");
			await expect(loadRiskPolicyProfile(directory, "loose.json")).rejects.toThrow("may not exceed");
			await expect(loadRiskPolicyProfile(directory, "malformed.json")).rejects.toThrow("Invalid RiskPolicy Profile");
			await expect(loadRiskPolicyProfile(directory, "escaping-path.json")).rejects.toThrow("dot segments");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
