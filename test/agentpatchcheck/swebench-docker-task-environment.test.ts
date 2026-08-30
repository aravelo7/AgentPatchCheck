import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
	createDockerCommandExecutor,
	createSWEbenchDockerTaskEnvironment,
	deriveSWEbenchInstanceImageKey,
	type DockerCommandExecutor,
} from "../../src/agentpatchcheck/swebench-docker-task-environment";

const childProcessMocks = vi.hoisted(() => ({ spawn: vi.fn() }));
const terminationMocks = vi.hoisted(() => ({ terminateCodexProcess: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: childProcessMocks.spawn }));
vi.mock("../../src/agentpatchcheck/codex-runner", () => ({ terminateCodexProcess: terminationMocks.terminateCodexProcess }));

function createFakeChild() {
	const child = new EventEmitter() as EventEmitter & {
		pid: number;
		stdin: { end: ReturnType<typeof vi.fn> };
		stdout: EventEmitter;
		stderr: EventEmitter;
		kill: ReturnType<typeof vi.fn>;
	};
	child.pid = 123;
	child.stdin = { end: vi.fn() };
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.kill = vi.fn(() => true);
	return child;
}

describe("SWE-bench Docker task environment", () => {
	it("returns a normal Docker command result after close", async () => {
		const child = createFakeChild();
		childProcessMocks.spawn.mockReturnValueOnce(child);
		const executor = createDockerCommandExecutor();

		const resultPromise = executor.run({ args: ["exec", "container", "echo", "ok"], timeoutMs: 100 });
		child.stdout.emit("data", Buffer.from("out"));
		child.stderr.emit("data", Buffer.from("err"));
		child.emit("close", 0);

		await expect(resultPromise).resolves.toMatchObject({ exitCode: 0, stdout: "out", stderr: "err", timedOut: false });
		expect(child.stdin.end).toHaveBeenCalledOnce();
	});

	it("settles a hanging Docker command after bounded timeout cleanup", async () => {
		vi.useFakeTimers();
		try {
			const child = createFakeChild();
			childProcessMocks.spawn.mockReturnValueOnce(child);
			const executor = createDockerCommandExecutor();

			const resultPromise = executor.run({ args: ["exec", "container", "hang"], timeoutMs: 10 });
			await vi.advanceTimersByTimeAsync(10);
			await vi.advanceTimersByTimeAsync(5_000);
			await expect(resultPromise).resolves.toMatchObject({ exitCode: null, timedOut: true });
			expect(terminationMocks.terminateCodexProcess).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	function repositoryState(entries: Record<string, string>): string {
		return Object.entries(entries).map(([path, hash]) => `${hash.repeat(64)}  ${path}\0`).join("");
	}

	async function exportPatch(input: {
		baseline: Record<string, string>;
		terminal: Record<string, string>;
		mutationPaths: string[];
		modelPatch: string;
		changedFiles: string[];
	}) {
		const calls: string[][] = [];
		const stagedPathspecs: string[] = [];
		let stateCaptures = 0;
		const docker: DockerCommandExecutor = {
			run: async ({ args, stdin }) => {
				calls.push(args);
				const joined = args.join(" ");
				if (joined.includes(" stat -c %F:%s -- /testbed"))
					return { exitCode: 0, stdout: "directory:0\n", stderr: "", durationMs: 1, timedOut: false };
				if (joined.includes(" test -L /testbed"))
					return { exitCode: 1, stdout: "", stderr: "", durationMs: 1, timedOut: false };
				if (joined.includes("sha256sum -z")) {
					const state = stateCaptures++ === 0 ? input.baseline : input.terminal;
					return { exitCode: 0, stdout: repositoryState(state), stderr: "", durationMs: 1, timedOut: false };
				}
				if (joined.includes("git -C /testbed") && joined.includes("read-tree"))
					return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
				if (joined.includes("git -C /testbed") && joined.includes("add") && joined.includes("--pathspec-file-nul")) {
					stagedPathspecs.push(stdin ?? "");
					return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
				}
				if (joined.includes("git -C /testbed") && joined.includes("diff") && joined.includes("--binary") && joined.includes("--cached"))
					return { exitCode: 0, stdout: input.modelPatch, stderr: "", durationMs: 1, timedOut: false };
				if (joined.includes("git -C /testbed") && joined.includes("diff") && joined.includes("--name-only") && joined.includes("--cached"))
					return { exitCode: 0, stdout: input.changedFiles.join("\n"), stderr: "", durationMs: 1, timedOut: false };
				if (joined.includes(" npm test"))
					return { exitCode: 1, stdout: "test failure", stderr: "details", durationMs: 1, timedOut: false };
				return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
			},
		};
		const environment = await createSWEbenchDockerTaskEnvironment({
			runId: "docker-test",
			configuration: { image: { instanceId: "immutable-js__immutable-js-2006", arch: "x86_64", namespace: "swebench", instanceImageTag: "latest" } },
			docker,
		});
		const verification = await environment.repository.runCommand({
			command: { command: "npm", args: ["test"], timeoutMs: 100 },
			cwd: environment.path,
			outputLimitBytes: 1024,
		});
		const patch = await environment.collectModelPatch("a".repeat(40), input.mutationPaths);
		await environment.cleanup();
		return { calls, stagedPathspecs, verification, patch };
	}

	it("exports only content-changing successful mutation paths after verification creates an unrelated artifact", async () => {
		const result = await exportPatch({
			baseline: { "src/existing.ts": "a", "pre-existing.cache": "b" },
			terminal: {
				"src/existing.ts": "c",
				"src/created.ts": "d",
				"pre-existing.cache": "b",
				"verification-output.dat": "e",
			},
			mutationPaths: ["src/existing.ts", "src/created.ts"],
			modelPatch: "diff --git a/src/created.ts b/src/created.ts\ndiff --git a/src/existing.ts b/src/existing.ts\n",
			changedFiles: ["src/created.ts", "src/existing.ts"],
		});

		expect(result.patch.changedFiles).toEqual(["src/created.ts", "src/existing.ts"]);
		expect(result.patch.modelPatch).toContain("diff --git a/src/created.ts b/src/created.ts");
		expect(result.patch.modelPatch).toContain("diff --git a/src/existing.ts b/src/existing.ts");
		expect(result.patch.modelPatch).not.toContain("pre-existing.cache");
		expect(result.patch.modelPatch).not.toContain("verification-output.dat");
		expect(result.stagedPathspecs).toEqual(["src/created.ts\0src/existing.ts"]);
		const stageCall = result.calls.find((args) => args.includes("add") && args.includes("--pathspec-from-file=-"));
		expect(stageCall).toContainEqual(expect.stringMatching(/^GIT_INDEX_FILE=\/tmp\/apc-swebench-export-/u));
	});

	it("exports an Agent-created file", async () => {
		const result = await exportPatch({
			baseline: {},
			terminal: { "new.txt": "b" },
			mutationPaths: ["new.txt"],
			modelPatch: "diff --git a/new.txt b/new.txt\n",
			changedFiles: ["new.txt"],
		});

		expect(result.patch).toEqual({ modelPatch: "diff --git a/new.txt b/new.txt\n", changedFiles: ["new.txt"] });
		expect(result.stagedPathspecs).toEqual(["new.txt"]);
	});

	it("exports an Agent-modified tracked file", async () => {
		const result = await exportPatch({
			baseline: { "README.md": "a" },
			terminal: { "README.md": "b" },
			mutationPaths: ["README.md"],
			modelPatch: "diff --git a/README.md b/README.md\n",
			changedFiles: ["README.md"],
		});

		expect(result.patch.changedFiles).toEqual(["README.md"]);
		expect(result.stagedPathspecs).toEqual(["README.md"]);
	});

	it("exports a pre-existing untracked file when the Agent actually changes it", async () => {
		const result = await exportPatch({
			baseline: { "scratch.txt": "a" },
			terminal: { "scratch.txt": "b" },
			mutationPaths: ["scratch.txt"],
			modelPatch: "diff --git a/scratch.txt b/scratch.txt\n",
			changedFiles: ["scratch.txt"],
		});

		expect(result.patch.changedFiles).toEqual(["scratch.txt"]);
		expect(result.stagedPathspecs).toEqual(["scratch.txt"]);
	});

	it("captures repository entries without passing directories to sha256sum as files", async () => {
		const result = await exportPatch({
			baseline: { "nested": "a" },
			terminal: { "nested": "b" },
			mutationPaths: ["nested"],
			modelPatch: "diff --git a/nested b/nested\n",
			changedFiles: ["nested"],
		});

		const captureCommand = result.calls.find((args) => args.some((arg) => arg.includes("sha256sum -z") && arg.includes("git ls-files")));
		expect(captureCommand?.join(" ")).toContain("[ -f \"$path\" ]");
		expect(captureCommand?.join(" ")).toContain("[ -d \"$path\" ]");
	});

	it("derives the official image key from safe execution metadata only", () => {
		expect(
			deriveSWEbenchInstanceImageKey({
				instanceId: "immutable-js__immutable-js-2006",
				arch: "x86_64",
				namespace: "swebench",
				instanceImageTag: "latest",
			}),
		).toBe("swebench/sweb.eval.x86_64.immutable-js_1776_immutable-js-2006:latest");
	});

	it("preserves an existing source file mode when a managed mutation is written", async () => {
		const calls: string[][] = [];
		const docker: DockerCommandExecutor = {
			run: async ({ args }) => {
				calls.push(args);
				const joined = args.join(" ");
				if (joined.includes(" stat -c %F:%s -- /testbed"))
					return { exitCode: 0, stdout: "directory:0\n", stderr: "", durationMs: 1, timedOut: false };
				if (joined.includes(" test -L /testbed")) return { exitCode: 1, stdout: "", stderr: "", durationMs: 1, timedOut: false };
				if (joined.includes("sha256sum -z")) return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
				if (joined.includes(" test -e /testbed/source.go")) return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
				if (joined.includes(" stat -c %a -- /testbed/source.go")) return { exitCode: 0, stdout: "644\n", stderr: "", durationMs: 1, timedOut: false };
				return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, timedOut: false };
			},
		};
		const environment = await createSWEbenchDockerTaskEnvironment({
			runId: "mode-preservation",
			configuration: { image: { instanceId: "immutable-js__immutable-js-2006", arch: "x86_64", namespace: "swebench", instanceImageTag: "latest" } },
			docker,
		});
		await environment.repository.writeText("/testbed/source.go", "updated\n");
		await environment.cleanup();

		expect(calls.some((args) => args.join(" ").includes(" chmod 644 -- /testbed/source.go"))).toBe(true);
	});
});
