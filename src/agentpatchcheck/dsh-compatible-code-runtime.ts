/**
 * DeepSeek Harness Code Runtime and Code Mode lifecycle adapter.
 *
 * Directly adapted from these MIT-licensed DeepSeek Harness primitives:
 * - packages/code-runtime/code-runtime-worker-thread/src/{bootstrap,index,protocol}.ts
 * - packages/core/tools/src/code-mode.ts
 *
 * The published DSH worker package on npm trails the checked-out master and
 * requires the complete Cordis/session peer graph. This adapter therefore
 * keeps DSH's public seam and lifecycle locally, while delegating every tool
 * operation to APC's canonical Tool Executor.
 *
 * Node Worker threads cannot own a distinct cwd. A tiny empty-environment Node
 * host is launched at the managed worktree and owns one fresh DSH-style Worker;
 * this makes ambient relative filesystem and subprocess calls resolve against
 * the same workspace as APC tools without process-wide chdir races.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";

import { terminateCodexProcess } from "./codex-runner";
import type { ProgrammaticToolDispatch, ProgrammaticToolRunResult } from "./programmatic-tool-runtime";

export type DshCodeJsonValue =
	| null
	| boolean
	| number
	| string
	| DshCodeJsonValue[]
	| { [key: string]: DshCodeJsonValue };

export type DshCompatibleDispatchResult = { ok: true; value: DshCodeJsonValue } | { ok: false; error: string };

export type DshCompatibleExecutionMode = "parallel" | "exclusive";

export interface DshCompatibleCodeInput {
	code: string;
	tools: readonly string[];
	workspace: string;
	dispatch: (call: ProgrammaticToolDispatch, signal: AbortSignal) => Promise<DshCompatibleDispatchResult>;
	executionMode: (call: ProgrammaticToolDispatch) => DshCompatibleExecutionMode;
	signal?: AbortSignal;
	maxWallMs?: number;
	maxOutputBytes?: number;
}

const DEFAULT_WALL_MS = 600_000;
const DEFAULT_OUTPUT_BYTES = 64 * 1024;
const MAX_PARALLEL_DISPATCHES = 8;
const PROGRAM_PREFIX = "async function __dsh_program__() {\n";
const PROGRAM_SUFFIX = "\n}";

type WorkerFailureKind = "exception" | "timeout" | "abort" | "worker-exit" | "invalid-output" | "output-limit";

type WorkerTerminal =
	| { type: "done"; value?: DshCodeJsonValue; error?: undefined }
	| { type: "done"; error: { kind: WorkerFailureKind; message: string } };

type ChildMessage =
	| { type: "call"; id: number; name: string; args: unknown }
	| { type: "log"; text: string }
	| { type: "output-limit" }
	| WorkerTerminal;

const WORKER_BOOTSTRAP = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const { inspect } = require("node:util");
if (!parentPort) throw new Error("dsh-compatible worker requires a parent port");

const maxOutputBytes = workerData.maxOutputBytes;
let outputBytes = 2;
let outputLimited = false;
let nextId = 1;
const pending = new Map();

const jsonBytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const emitLog = (text) => {
  if (outputLimited) return;
  const charge = jsonBytes(text) + (outputBytes > 2 ? 1 : 0);
  if (outputBytes + charge > maxOutputBytes) {
    outputLimited = true;
    parentPort.postMessage({ type: "output-limit" });
    return;
  }
  outputBytes += charge;
  parentPort.postMessage({ type: "log", text });
};
const format = (values) => values.map((value) =>
  typeof value === "string" ? value : inspect(value, { depth: 4, maxArrayLength: 100, maxStringLength: 10000 })
).join(" ");
const consoleBinding = Object.freeze({
  log: (...values) => emitLog(format(values)),
  info: (...values) => emitLog(format(values)),
  warn: (...values) => emitLog(format(values)),
  error: (...values) => emitLog(format(values)),
  debug: (...values) => emitLog(format(values)),
});

for (const stream of [process.stdout, process.stderr]) {
  Object.defineProperty(stream, "write", {
    configurable: true,
    value: (chunk, encoding, callback) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === "string" ? encoding : "utf8") : String(chunk);
      emitLog(text);
      if (typeof encoding === "function") encoding();
      else if (typeof callback === "function") callback();
      return true;
    },
  });
}

class ToolCallError extends Error {
  constructor(toolName, message) {
    super(message);
    this.name = "ToolCallError";
    Object.defineProperty(this, "toolName", { enumerable: true, value: toolName });
  }
}

const tools = Object.create(null);
for (const name of workerData.tools) {
  Object.defineProperty(tools, name, {
    enumerable: true,
    value: (args) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject, name });
      parentPort.postMessage({ type: "call", id, name, args });
    }),
  });
}

parentPort.on("message", (message) => {
  if (!message || message.type !== "reply" || typeof message.id !== "number") return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.ok) entry.resolve(message.value);
  else entry.reject(new ToolCallError(entry.name, message.message));
});

const normalizeJson = (root) => {
  const seen = new Set();
  const visit = (value) => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("completion value contains a non-finite number");
      return value;
    }
    if (typeof value !== "object") throw new Error("completion value is not lossless JSON");
    if (seen.has(value)) throw new Error("completion value contains a cycle");
    seen.add(value);
    let result;
    if (Array.isArray(value)) result = value.map(visit);
    else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        throw new Error("completion value contains a non-plain object");
      result = Object.create(null);
      for (const [key, child] of Object.entries(value)) result[key] = visit(child);
    }
    seen.delete(value);
    return result;
  };
  return visit(root);
};

(async () => {
  try {
    const AsyncFunction = (async () => {}).constructor;
    const fn = new AsyncFunction("tools", "ToolCallError", "console", "'use strict';\n" + workerData.code);
    const rawValue = await fn(Object.freeze(tools), ToolCallError, consoleBinding);
    if (outputLimited) return;
    if (rawValue === undefined) {
      parentPort.postMessage({ type: "done" });
      return;
    }
    let value;
    try { value = normalizeJson(rawValue); }
    catch (error) {
      parentPort.postMessage({ type: "done", error: { kind: "invalid-output", message: error.message } });
      return;
    }
    if (outputBytes + jsonBytes(value) > maxOutputBytes) {
      parentPort.postMessage({ type: "output-limit" });
      return;
    }
    parentPort.postMessage({ type: "done", value });
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    if (outputBytes + jsonBytes(message) > maxOutputBytes) {
      parentPort.postMessage({ type: "output-limit" });
      return;
    }
    parentPort.postMessage({ type: "done", error: { kind: "exception", message } });
  }
})();
`;

const WORKSPACE_HOST_BOOTSTRAP = `
const { Worker } = require("node:worker_threads");
let worker;
const send = (message) => { if (process.send) process.send(message); };
process.on("message", async (message) => {
  if (!message || typeof message !== "object") return;
  if (message.type === "boot" && !worker) {
    worker = new Worker(message.bootstrap, {
      eval: true,
      workerData: message.workerData,
      env: {},
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 128 },
      stdout: true,
      stderr: true,
    });
    worker.on("message", send);
    worker.stdout.on("data", (chunk) => send({ type: "log", text: chunk.toString("utf8") }));
    worker.stderr.on("data", (chunk) => send({ type: "log", text: chunk.toString("utf8") }));
    worker.on("error", (error) => send({ type: "done", error: { kind: "worker-exit", message: error.message } }));
    worker.on("exit", (code) => {
      if (code !== 0) send({ type: "done", error: { kind: "worker-exit", message: "worker exited with code " + code } });
    });
    return;
  }
  if (message.type === "reply" && worker) {
    try { worker.postMessage(message); } catch {}
    return;
  }
  if (message.type === "shutdown") {
    if (worker) await worker.terminate();
    if (process.connected) process.disconnect();
    process.exitCode = 0;
  }
});
`;

interface PendingDispatch {
	call: ProgrammaticToolDispatch;
	classify(): DshCompatibleExecutionMode;
	abandon(): void;
	start(): void;
	commit(): void;
	flight: Promise<void>;
	settled: boolean;
	mode?: DshCompatibleExecutionMode;
}

class DshSubdispatchScheduler {
	readonly #controller = new AbortController();
	readonly #pendingQueue: PendingDispatch[] = [];
	readonly #commitQueue: PendingDispatch[] = [];
	readonly #inFlight = new Set<Promise<void>>();
	readonly #dispatch: DshCompatibleCodeInput["dispatch"];
	readonly #executionMode: DshCompatibleCodeInput["executionMode"];
	#exclusiveActive = false;
	#driving = false;
	#driverRun: Promise<void> = Promise.resolve();
	#wake: (() => void) | undefined;

	constructor(input: Pick<DshCompatibleCodeInput, "dispatch" | "executionMode">) {
		this.#dispatch = input.dispatch;
		this.#executionMode = input.executionMode;
	}

	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	abort(reason: unknown): void {
		if (!this.#controller.signal.aborted) this.#controller.abort(reason);
		this.#wakeup();
	}

	schedule(call: ProgrammaticToolDispatch): Promise<DshCompatibleDispatchResult> {
		if (this.signal.aborted)
			return Promise.resolve({ ok: false, error: `run_code run is over (${String(this.signal.reason)})` });
		return new Promise<DshCompatibleDispatchResult>((resolve) => {
			let outcome: DshCompatibleDispatchResult | undefined;
			const entry: PendingDispatch = {
				call,
				flight: Promise.resolve(),
				settled: false,
				classify: () => this.#executionMode(call),
				abandon: () => resolve({ ok: false, error: `run_code run is over (${String(this.signal.reason)})` }),
				start: () => {
					entry.flight = this.#dispatch(call, this.signal)
						.then((result) => {
							outcome = result;
						})
						.catch((error: unknown) => {
							outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
						})
						.finally(() => {
							entry.settled = true;
							this.#wakeup();
						});
				},
				commit: () => {
					resolve(outcome ?? { ok: false, error: "run_code dispatch settled without a result" });
				},
			};
			this.#pendingQueue.push(entry);
			this.#wakeup();
			void this.#drive();
		});
	}

	async drain(): Promise<void> {
		await this.#drive();
	}

	#wakeup(): void {
		const wake = this.#wake;
		this.#wake = undefined;
		wake?.();
	}

	#drive(): Promise<void> {
		if (this.#driving) return this.#driverRun;
		this.#driving = true;
		this.#driverRun = (async () => {
			try {
				for (;;) {
					const signal = new Promise<void>((resolve) => {
						this.#wake = resolve;
					});
					const commitHead = this.#commitQueue[0];
					if (commitHead?.settled) {
						this.#commitQueue.shift();
						commitHead.commit();
						if (commitHead.mode === "exclusive") this.#exclusiveActive = false;
						continue;
					}
					const head = this.#pendingQueue[0];
					if (head !== undefined) {
						if (this.signal.aborted) {
							this.#pendingQueue.shift();
							head.abandon();
							continue;
						}
						const mode = head.classify();
						const capacity =
							!this.#exclusiveActive &&
							(mode === "exclusive" ? this.#inFlight.size === 0 : this.#inFlight.size < MAX_PARALLEL_DISPATCHES);
						if (capacity) {
							if (mode === "exclusive") this.#exclusiveActive = true;
							head.mode = mode;
							this.#pendingQueue.shift();
							this.#commitQueue.push(head);
							head.start();
							const flight = head.flight.finally(() => {
								this.#inFlight.delete(flight);
								this.#wakeup();
							});
							this.#inFlight.add(flight);
							continue;
						}
					}
					if (this.#pendingQueue.length === 0 && this.#commitQueue.length === 0 && this.#inFlight.size === 0)
						return;
					await signal;
				}
			} finally {
				this.#driving = false;
				this.#wake = undefined;
			}
		})();
		return this.#driverRun;
	}
}

function jsonObject(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("tool arguments must be a JSON object");
	return structuredClone(value) as Record<string, unknown>;
}

function renderOutput(logs: readonly string[], value: DshCodeJsonValue | undefined): string {
	const rendered = value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value, null, 2);
	return [...logs, rendered].filter((entry) => entry.length > 0).join("\n") || "(run_code completed with no output)";
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
	});
}

async function terminateAndWait(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = waitForExit(child);
	if (child.connected) child.send({ type: "shutdown" });
	const graceful = await Promise.race([
		exited.then(() => true),
		new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_000)),
	]);
	if (graceful) return;
	terminateCodexProcess(child);
	await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
}

export async function runDshCompatibleCode(input: DshCompatibleCodeInput): Promise<ProgrammaticToolRunResult> {
	if (input.code.trim().length === 0) throw new Error("run_code code must be non-empty");
	const wrapped = `${PROGRAM_PREFIX}${input.code}${PROGRAM_SUFFIX}`;
	const stripped = stripTypeScriptTypes(wrapped);
	const code = stripped.slice(PROGRAM_PREFIX.length, -PROGRAM_SUFFIX.length);
	const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
	const scheduler = new DshSubdispatchScheduler(input);
	const child = spawn(process.execPath, ["--input-type=commonjs", "-e", WORKSPACE_HOST_BOOTSTRAP], {
		cwd: input.workspace,
		env: {},
		shell: false,
		stdio: ["ignore", "pipe", "pipe", "ipc"],
		windowsHide: true,
	});
	const logs: string[] = [];
	let outputBytes = 0;
	let dispatches = 0;
	let terminal: WorkerTerminal | undefined;
	let settleTerminal: ((terminal: WorkerTerminal) => void) | undefined;
	const terminalPromise = new Promise<WorkerTerminal>((resolve) => {
		settleTerminal = resolve;
	});
	const settle = (value: WorkerTerminal): void => {
		if (terminal !== undefined) return;
		terminal = value;
		settleTerminal?.(value);
	};
	const appendLog = (text: string): void => {
		if (terminal !== undefined) return;
		outputBytes += Buffer.byteLength(JSON.stringify(text), "utf8");
		if (outputBytes > maxOutputBytes) {
			settle({ type: "done", error: { kind: "output-limit", message: "run_code output limit exceeded" } });
			return;
		}
		logs.push(text);
	};
	child.stdout?.on("data", (chunk: Buffer | string) => appendLog(String(chunk)));
	child.stderr?.on("data", (chunk: Buffer | string) => appendLog(String(chunk)));
	child.on("message", (message: unknown) => {
		if (typeof message !== "object" || message === null) return;
		const record = message as ChildMessage;
		if (record.type === "log") {
			appendLog(record.text);
			return;
		}
		if (record.type === "output-limit") {
			settle({ type: "done", error: { kind: "output-limit", message: "run_code output limit exceeded" } });
			return;
		}
		if (record.type === "done") {
			settle(record);
			return;
		}
		if (record.type !== "call" || typeof record.id !== "number" || typeof record.name !== "string") return;
		dispatches += 1;
		let args: Record<string, unknown>;
		try {
			if (!input.tools.includes(record.name)) throw new Error(`Unknown tool: ${record.name}`);
			args = jsonObject(record.args);
		} catch (error) {
			child.send({ type: "reply", id: record.id, ok: false, message: messageOf(error) });
			return;
		}
		void scheduler.schedule({ tool: record.name, arguments: args }).then((result) => {
			if (!child.connected) return;
			if (result.ok) child.send({ type: "reply", id: record.id, ok: true, value: result.value });
			else child.send({ type: "reply", id: record.id, ok: false, message: result.error });
		});
	});
	child.once("error", (error) => settle({ type: "done", error: { kind: "worker-exit", message: error.message } }));
	child.once("exit", (exitCode, signal) => {
		settle({
			type: "done",
			error: {
				kind: "worker-exit",
				message: `workspace host exited before completion (${exitCode ?? signal ?? "unknown"})`,
			},
		});
	});
	child.send({
		type: "boot",
		bootstrap: WORKER_BOOTSTRAP,
		workerData: { code, tools: input.tools, maxOutputBytes },
	});

	const timeoutMs = input.maxWallMs ?? DEFAULT_WALL_MS;
	let timeout: NodeJS.Timeout | undefined;
	const timeoutPromise = new Promise<WorkerTerminal>((resolve) => {
		timeout = setTimeout(
			() =>
				resolve({
					type: "done",
					error: { kind: "timeout", message: `wall-clock ceiling reached (${timeoutMs}ms)` },
				}),
			timeoutMs,
		);
	});
	let resolveAbort: ((value: WorkerTerminal) => void) | undefined;
	const onAbort = (): void =>
		resolveAbort?.({
			type: "done",
			error: { kind: "abort", message: String(input.signal?.reason) },
		});
	const abortPromise = new Promise<WorkerTerminal>((resolve) => {
		resolveAbort = resolve;
		if (input.signal?.aborted) onAbort();
		else input.signal?.addEventListener("abort", onAbort, { once: true });
	});

	const result = await Promise.race([terminalPromise, timeoutPromise, abortPromise]);
	if (timeout !== undefined) clearTimeout(timeout);
	input.signal?.removeEventListener("abort", onAbort);
	scheduler.abort(result.error?.message ?? "run_code settled");
	await scheduler.drain();
	await terminateAndWait(child);
	if (result.error !== undefined) {
		const logsText = logs.length > 0 ? `\nCaptured output:\n${logs.join("\n")}` : "";
		throw new Error(`code run failed (${result.error.kind}): ${result.error.message}${logsText}`);
	}
	return { observation: renderOutput(logs, result.value), dispatches };
}
