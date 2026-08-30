import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";

import { describe, expect, it } from "vitest";

import {
	type DshCompatibleCodeInput,
	runDshCompatibleCode,
} from "../../src/agentpatchcheck/dsh-compatible-code-runtime";

function runtimeInput(overrides: Partial<DshCompatibleCodeInput>): DshCompatibleCodeInput {
	return {
		code: "return null;",
		tools: [],
		workspace: process.cwd(),
		dispatch: async () => ({ ok: false, error: "unused" }),
		executionMode: () => "exclusive",
		...overrides,
	};
}

describe("DSH-compatible code runtime", () => {
	it("binds ambient cwd, direct filesystem, subprocess, and structured tools to the managed workspace", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "agentpatchcheck-dsh-cwd-"));
		try {
			await writeFile(join(workspace, "marker.txt"), "workspace-marker\n", "utf8");
			const result = await runDshCompatibleCode(
				runtimeInput({
					workspace,
					tools: ["read"],
					code: `
const fs = await import("node:fs/promises");
const childProcess = await import("node:child_process");
const direct = await fs.readFile("marker.txt", "utf8");
const typed = await tools.read({ file_path: "marker.txt" });
const childCwd = childProcess.execFileSync(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { encoding: "utf8" });
return { cwd: process.cwd(), childCwd, direct, firstLine: typed.lines[0].text, envKeys: Object.keys(process.env) };
`,
					dispatch: async () => ({
						ok: true,
						value: {
							path: "marker.txt",
							offset: 1,
							lines: [{ number: 1, text: "workspace-marker" }],
							totalLines: 1,
						},
					}),
				}),
			);

			expect(result.observation).toContain(JSON.stringify(normalize(workspace)));
			expect(result.observation).toContain('"direct": "workspace-marker\\n"');
			expect(result.observation).toContain('"firstLine": "workspace-marker"');
			expect(result.observation).toContain('"envKeys": []');
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("uses DSH parallel/exclusive barriers and commits in submission order", async () => {
		const lifecycle: string[] = [];
		const result = await runDshCompatibleCode(
			runtimeInput({
				tools: ["read", "edit", "verify"],
				code: `
const first = tools.read({ id: 1 });
const mutation = tools.edit({ id: 2 });
const verification = tools.verify({ id: 3 });
return await Promise.all([first, mutation, verification]);
`,
				executionMode: (call) => (call.tool === "read" ? "parallel" : "exclusive"),
				dispatch: async (call) => {
					const id = String(call.arguments.id);
					lifecycle.push(`start-${id}`);
					await new Promise((resolve) => setTimeout(resolve, call.tool === "read" ? 30 : 5));
					lifecycle.push(`end-${id}`);
					return { ok: true, value: { id } };
				},
			}),
		);

		expect(result.dispatches).toBe(3);
		expect(lifecycle).toEqual(["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);
	});

	it("drains an unawaited nested dispatch before the outer run settles", async () => {
		let dispatchSettled = false;
		const result = await runDshCompatibleCode(
			runtimeInput({
				tools: ["edit"],
				code: `void tools.edit({ file_path: "a.txt" }); return "outer-returned";`,
				dispatch: async (_call, signal) => {
					await new Promise((resolve) => setTimeout(resolve, 30));
					expect(signal.aborted).toBe(true);
					dispatchSettled = true;
					return { ok: true, value: { path: "a.txt" } };
				},
			}),
		);

		expect(result.observation).toBe("outer-returned");
		expect(dispatchSettled).toBe(true);
	});

	it("propagates an outer abort and drains an active exclusive dispatch", async () => {
		const controller = new AbortController();
		let started = false;
		let drained = false;
		const run = runDshCompatibleCode(
			runtimeInput({
				tools: ["edit"],
				code: `await tools.edit({ file_path: "a.txt" });`,
				signal: controller.signal,
				dispatch: async (_call, signal) => {
					started = true;
					await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
					await new Promise((resolve) => setTimeout(resolve, 5));
					drained = true;
					return { ok: false, error: "cancelled" };
				},
			}),
		);
		while (!started) await new Promise((resolve) => setTimeout(resolve, 1));
		controller.abort(new Error("agent wall timeout"));

		await expect(run).rejects.toThrow("code run failed (abort)");
		expect(drained).toBe(true);
	});

	it("reports program exceptions, output limits, and wall-clock timeouts through the DSH failure taxonomy", async () => {
		await expect(runDshCompatibleCode(runtimeInput({ code: 'throw new Error("boom")' }))).rejects.toThrow(
			"code run failed (exception)",
		);
		await expect(
			runDshCompatibleCode(runtimeInput({ code: 'console.log("123456"); return null;', maxOutputBytes: 5 })),
		).rejects.toThrow("code run failed (output-limit)");
		await expect(
			runDshCompatibleCode(runtimeInput({ code: "await new Promise(() => undefined);", maxWallMs: 150 })),
		).rejects.toThrow("code run failed (timeout)");
	});

	it("does not mutate the host repository when a relative direct write is used", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "agentpatchcheck-dsh-write-"));
		try {
			await runDshCompatibleCode(
				runtimeInput({
					workspace,
					code: `const fs = await import("node:fs/promises"); await fs.writeFile("created.txt", "ok", "utf8");`,
				}),
			);
			expect(await readFile(join(workspace, "created.txt"), "utf8")).toBe("ok");
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});
});
