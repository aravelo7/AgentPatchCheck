/**
 * Programmatic tool composition adapted from DeepSeek Harness Code Mode
 * (`packages/core/tools/src/code-mode.ts` and the worker-thread code runtime).
 * DeepSeek Harness is MIT licensed, Copyright (c) 2026 DeepSeek.
 *
 * APC keeps the same core semantics—a fresh worker, a `tools` binding, bounded
 * output, and all nested operations delegated back to the owning Tool Executor—
 * while using APC's existing schemas, safety checks, facts, and event spine.
 */
import { stripTypeScriptTypes } from "node:module";
import { Worker } from "node:worker_threads";

export interface ProgrammaticToolDispatch {
	tool: string;
	arguments: Record<string, unknown>;
}

export interface ProgrammaticToolDispatchResult {
	ok: boolean;
	observation: string;
}

export interface ProgrammaticToolRunResult {
	observation: string;
	dispatches: number;
}

const PROGRAM_PREFIX = "async () => {\n";
const PROGRAM_SUFFIX = "\n}";
const DEFAULT_WALL_MS = 600_000;
const DEFAULT_OUTPUT_BYTES = 64 * 1024;

// The worker bootstrap is fixed Harness code. Model code executes in a fresh,
// null-prototype vm context that exposes only tools, console, and ToolCallError.
const WORKER_BOOTSTRAP = `
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
if (!parentPort) throw new Error("programmatic tool worker requires a parent port");
let nextId = 1;
const pending = new Map();
class ToolCallError extends Error {
  constructor(toolName, message) { super(message); this.name = "ToolCallError"; this.toolName = toolName; }
}
const tools = Object.create(null);
for (const name of workerData.tools) {
  Object.defineProperty(tools, name, { enumerable: true, value: (args) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, name });
    parentPort.postMessage({ type: "call", id, name, args });
  }) });
}
const logs = [];
const consoleBinding = Object.freeze({ log: (...values) => logs.push(values.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" ")) });
parentPort.on("message", (message) => {
  if (!message || message.type !== "result" || typeof message.id !== "number") return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.ok) entry.resolve(message.value);
  else entry.reject(new ToolCallError(entry.name, message.error));
});
const context = vm.createContext(Object.assign(Object.create(null), {
  tools: Object.freeze(tools), console: consoleBinding, ToolCallError,
}), { codeGeneration: { strings: false, wasm: false } });
(async () => {
  try {
    const fn = new vm.Script("(" + workerData.code + ")", { filename: "agentpatchcheck-run-code.js" }).runInContext(context);
    const value = await fn();
    parentPort.postMessage({ type: "done", logs, value });
  } catch (error) {
    parentPort.postMessage({ type: "error", logs, message: error instanceof Error ? error.message : String(error) });
  }
})();
`;

function jsonObject(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("tool arguments must be a JSON object");
	return structuredClone(value) as Record<string, unknown>;
}

function renderOutput(logs: unknown, value: unknown, maxBytes: number): string {
	const safeLogs = Array.isArray(logs) ? logs.filter((entry): entry is string => typeof entry === "string") : [];
	let renderedValue = "";
	if (value !== undefined) {
		try {
			renderedValue = typeof value === "string" ? value : JSON.stringify(value, null, 2);
		} catch {
			throw new Error("run-code returned a non-JSON value");
		}
	}
	const output = [...safeLogs, renderedValue].filter((entry) => entry.length > 0).join("\n");
	if (Buffer.byteLength(output, "utf8") > maxBytes) throw new Error(`run-code output exceeded ${maxBytes} bytes`);
	return output.length > 0 ? output : "(run-code completed with no output)";
}

export async function runProgrammaticToolComposition(input: {
	code: string;
	tools: readonly string[];
	dispatch: (call: ProgrammaticToolDispatch) => Promise<ProgrammaticToolDispatchResult>;
	maxWallMs?: number;
	maxOutputBytes?: number;
}): Promise<ProgrammaticToolRunResult> {
	if (typeof input.code !== "string" || input.code.trim().length === 0)
		throw new Error("run-code code must be non-empty");
	const wrapped = `${PROGRAM_PREFIX}${input.code}${PROGRAM_SUFFIX}`;
	const code = stripTypeScriptTypes(wrapped);
	const worker = new Worker(WORKER_BOOTSTRAP, {
		eval: true,
		workerData: { code, tools: input.tools.filter((tool) => tool !== "run-code") },
		resourceLimits: { maxOldGenerationSizeMb: 128 },
	});
	let dispatches = 0;
	return await new Promise<ProgrammaticToolRunResult>((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			void worker.terminate();
			callback();
		};
		const timeout = setTimeout(
			() => finish(() => reject(new Error("run-code exceeded its wall-clock budget"))),
			input.maxWallMs ?? DEFAULT_WALL_MS,
		);
		worker.on("message", (message: unknown) => {
			if (typeof message !== "object" || message === null) return;
			const record = message as Record<string, unknown>;
			if (record.type === "call" && typeof record.id === "number" && typeof record.name === "string") {
				const tool = record.name;
				if (!input.tools.includes(tool)) {
					worker.postMessage({ type: "result", id: record.id, ok: false, error: `Unknown tool: ${record.name}` });
					return;
				}
				dispatches += 1;
				let argumentsValue: Record<string, unknown>;
				try {
					argumentsValue = jsonObject(record.args);
				} catch (error) {
					worker.postMessage({
						type: "result",
						id: record.id,
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					});
					return;
				}
				void input
					.dispatch({ tool, arguments: argumentsValue })
					.then((result) =>
						worker.postMessage({
							type: "result",
							id: record.id,
							ok: result.ok,
							...(result.ok ? { value: result.observation } : { error: result.observation }),
						}),
					)
					.catch((error: unknown) =>
						worker.postMessage({
							type: "result",
							id: record.id,
							ok: false,
							error: error instanceof Error ? error.message : String(error),
						}),
					);
				return;
			}
			if (record.type === "done")
				finish(() => {
					try {
						resolve({
							observation: renderOutput(record.logs, record.value, input.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES),
							dispatches,
						});
					} catch (error) {
						reject(error);
					}
				});
			else if (record.type === "error")
				finish(() => reject(new Error(typeof record.message === "string" ? record.message : "run-code failed")));
		});
		worker.once("error", (error) => finish(() => reject(error)));
		worker.once("exit", (codeValue) => {
			if (!settled && codeValue !== 0)
				finish(() => reject(new Error(`run-code worker exited with code ${codeValue}`)));
		});
	});
}
