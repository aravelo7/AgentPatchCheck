import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { describe, expect, it } from "vitest";

import { executeHarnessNativeTool } from "../../src/agentpatchcheck/harness-native-runtime";

async function applyPatch(root: string, patch: string) {
	return await executeHarnessNativeTool({
		root,
		tool: "apply-patch",
		arguments: { patch },
		maxObservationBytes: 16 * 1024,
		verification: undefined,
	});
}

describe("Harness-native mutation patch", () => {
	it("applies a multi-file unified diff after Git and Harness preflight", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentpatchcheck-mutation-patch-"));
		try {
			await writeFile(join(root, "existing.txt"), "before\n", "utf8");
			const patch = [
				"diff --git a/existing.txt b/existing.txt",
				"--- a/existing.txt",
				"+++ b/existing.txt",
				"@@ -1 +1 @@",
				"-before",
				"+after",
				"diff --git a/new.txt b/new.txt",
				"new file mode 100644",
				"--- /dev/null",
				"+++ b/new.txt",
				"@@ -0,0 +1 @@",
				"+created",
				"",
			].join("\n");

			const result = await applyPatch(root, patch);

			expect(result).toMatchObject({
				status: "ok",
				observation: "Patch applied to 2 files.",
				affectedPaths: ["existing.txt", "new.txt"],
			});
			expect((await readFile(join(root, "existing.txt"), "utf8")).replaceAll("\r\n", "\n")).toBe("after\n");
			expect((await readFile(join(root, "new.txt"), "utf8")).replaceAll("\r\n", "\n")).toBe("created\n");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("returns recoverable malformed and conflict diagnostics without writing", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentpatchcheck-mutation-patch-"));
		try {
			await writeFile(join(root, "target.txt"), "actual\n", "utf8");
			const malformed = await applyPatch(root, "not a unified diff");
			const conflict = await applyPatch(
				root,
				[
					"diff --git a/target.txt b/target.txt",
					"--- a/target.txt",
					"+++ b/target.txt",
					"@@ -1 +1 @@",
					"-expected",
					"+changed",
					"",
				].join("\n"),
			);

			expect(malformed).toMatchObject({ status: "rejected" });
			expect(malformed.observation).toContain("Patch is malformed");
			expect(conflict).toMatchObject({ status: "rejected" });
			expect(conflict.observation).toContain("Patch does not apply cleanly");
			expect(await readFile(join(root, "target.txt"), "utf8")).toBe("actual\n");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects traversal and deletion before applying either patch", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentpatchcheck-mutation-patch-"));
		const outsideName = `${basename(root)}-outside.txt`;
		const outside = join(root, "..", outsideName);
		try {
			await writeFile(outside, "outside\n", "utf8");
			await writeFile(join(root, "target.txt"), "inside\n", "utf8");
			const traversal = await applyPatch(
				root,
				[
					`diff --git a/../${outsideName} b/../${outsideName}`,
					`--- a/../${outsideName}`,
					`+++ b/../${outsideName}`,
					"@@ -1 +1 @@",
					"-outside",
					"+escaped",
					"",
				].join("\n"),
			);
			const deletion = await applyPatch(
				root,
				[
					"diff --git a/target.txt b/target.txt",
					"deleted file mode 100644",
					"--- a/target.txt",
					"+++ /dev/null",
					"@@ -1 +0,0 @@",
					"-inside",
					"",
				].join("\n"),
			);

			expect(traversal).toMatchObject({ status: "rejected" });
			expect(traversal.observation).toContain("unsafe");
			expect(deletion).toMatchObject({ status: "rejected" });
			expect(deletion.observation).toContain("file deletion is not supported");
			expect(await readFile(join(root, "target.txt"), "utf8")).toBe("inside\n");
			expect(await readFile(outside, "utf8")).toBe("outside\n");
		} finally {
			await rm(root, { recursive: true, force: true });
			await rm(outside, { force: true });
		}
	});

	it("rejects a patch target reached through a directory symlink", async () => {
		const root = await mkdtemp(join(tmpdir(), "agentpatchcheck-mutation-patch-"));
		try {
			await writeFile(join(root, "target.txt"), "before\n", "utf8");
			await symlink(root, join(root, "linked"), "junction");
			const result = await applyPatch(
				root,
				[
					"diff --git a/linked/target.txt b/linked/target.txt",
					"--- a/linked/target.txt",
					"+++ b/linked/target.txt",
					"@@ -1 +1 @@",
					"-before",
					"+after",
					"",
				].join("\n"),
			);

			expect(result).toMatchObject({ status: "rejected" });
			expect(result.observation).toContain("symbolic link");
			expect(await readFile(join(root, "target.txt"), "utf8")).toBe("before\n");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
