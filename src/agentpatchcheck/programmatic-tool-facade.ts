/**
 * Code Mode model-facing tool facade adapted from DeepSeek Harness tool-fs
 * (`read`, `write`, `edit`) and its generated TypeScript tools SDK.
 * DeepSeek Harness is MIT licensed, Copyright (c) 2026 DeepSeek.
 *
 * This module owns presentation only. Runtime execution is translated back to
 * APC's canonical Tool Executor calls so safety, facts, budgets, and replay stay
 * under the existing Harness boundary.
 */
import type { HarnessNativeToolName } from "./types";

export interface ProgrammaticToolFacadeDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	/** DSH canonical JSON value resolved to model-written code. */
	outputSchema: Record<string, unknown>;
}

export interface ProgrammaticToolFacadeCall {
	tool: string;
	arguments: Record<string, unknown>;
}

export type ProgrammaticToolFacadeMapping = {
	kind: "canonical";
	tool: HarnessNativeToolName;
	arguments: Record<string, unknown>;
};

const objectSchema = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
	type: "object",
	properties,
	required,
	additionalProperties: false,
});

const textOutputSchema = objectSchema({ output: { type: "string" } }, ["output"]);

const baseDefinitions: readonly ProgrammaticToolFacadeDefinition[] = [
	{
		name: "read",
		description: "Read a UTF-8 text file and return bounded line-numbered content.",
		inputSchema: objectSchema(
			{
				file_path: { type: "string", description: "Workspace-relative path to read." },
				offset: { type: "number", minimum: 1, description: "Optional 1-based first line. Defaults to 1." },
				limit: { type: "number", minimum: 1, maximum: 2000, description: "Optional line limit, at most 2000." },
			},
			["file_path"],
		),
		outputSchema: objectSchema(
			{
				path: { type: "string" },
				offset: { type: "integer" },
				lines: {
					type: "array",
					items: objectSchema({ number: { type: "integer" }, text: { type: "string" } }, ["number", "text"]),
				},
				totalLines: { type: "integer" },
			},
			["path", "offset", "lines", "totalLines"],
		),
	},
	{
		name: "write",
		description: "Create or fully replace one UTF-8 text file. Prefer edit for a targeted change.",
		inputSchema: objectSchema(
			{
				file_path: { type: "string", description: "Workspace-relative file path." },
				content: { type: "string", description: "Complete UTF-8 file content, at most 32768 characters." },
			},
			["file_path", "content"],
		),
		outputSchema: objectSchema(
			{
				path: { type: "string" },
				operation: { type: "string", enum: ["create", "update"] },
				before: { oneOf: [{ type: "string" }, { type: "null" }] },
				after: { type: "string" },
			},
			["path", "operation", "before", "after"],
		),
	},
	{
		name: "edit",
		description: "Edit an existing UTF-8 text file by replacing one unique literal text region.",
		inputSchema: objectSchema(
			{
				file_path: { type: "string", description: "Workspace-relative path to an existing file." },
				old_string: {
					type: "string",
					description: "Exact non-empty text to replace; include enough context to be unique.",
				},
				new_string: { type: "string", description: "Literal replacement text; an empty string deletes the match." },
				replace_all: { type: "boolean", description: "Replace every literal match. Defaults to false." },
			},
			["file_path", "old_string", "new_string"],
		),
		outputSchema: objectSchema({ path: { type: "string" }, before: { type: "string" }, after: { type: "string" } }, [
			"path",
			"before",
			"after",
		]),
	},
	{
		name: "todo_write",
		description:
			"Replace the complete structured task list. Use it for multi-step coding work and update statuses as progress changes.",
		inputSchema: objectSchema(
			{
				todos: {
					type: "array",
					items: objectSchema(
						{
							content: { type: "string", description: "Short imperative task step." },
							status: { type: "string", enum: ["pending", "in_progress", "completed"] },
						},
						["content", "status"],
					),
				},
			},
			["todos"],
		),
		outputSchema: objectSchema(
			{
				todos: {
					type: "array",
					items: objectSchema(
						{
							content: { type: "string" },
							status: { type: "string", enum: ["pending", "in_progress", "completed"] },
						},
						["content", "status"],
					),
				},
			},
			["todos"],
		),
	},
	{
		name: "list_directory",
		description: "List the entries directly inside one workspace directory.",
		inputSchema: objectSchema({ path: { type: "string", description: "Workspace-relative directory path." } }, [
			"path",
		]),
		outputSchema: objectSchema(
			{
				path: { type: "string" },
				entries: {
					type: "array",
					items: objectSchema(
						{ name: { type: "string" }, kind: { type: "string", enum: ["file", "directory", "other"] } },
						["name", "kind"],
					),
				},
			},
			["path", "entries"],
		),
	},
	{
		name: "search_text",
		description: "Search literal text in one file or directly inside one directory.",
		inputSchema: objectSchema(
			{ path: { type: "string" }, query: { type: "string", description: "Literal text to find." } },
			["path", "query"],
		),
		outputSchema: textOutputSchema,
	},
	{
		name: "search_text_recursive",
		description: "Search literal text recursively below one workspace directory.",
		inputSchema: objectSchema(
			{ path: { type: "string" }, query: { type: "string", description: "Literal text to find." } },
			["path", "query"],
		),
		outputSchema: textOutputSchema,
	},
	{
		name: "git_status",
		description: "Read the current workspace Git status.",
		inputSchema: objectSchema({}, []),
		outputSchema: textOutputSchema,
	},
	{
		name: "git_diff",
		description: "Read the current workspace Git diff.",
		inputSchema: objectSchema({}, []),
		outputSchema: textOutputSchema,
	},
];

const verificationDefinition: ProgrammaticToolFacadeDefinition = {
	name: "run_public_verification",
	description: "Run one TaskSpec-declared public verification command by zero-based index.",
	inputSchema: objectSchema({ index: { type: "integer", minimum: 0 } }, ["index"]),
	outputSchema: objectSchema(
		{
			index: { type: "integer" },
			outcome: { type: "string", enum: ["passed", "failed"] },
			exitCode: { oneOf: [{ type: "integer" }, { type: "null" }] },
			timedOut: { type: "boolean" },
			durationMs: { type: "number" },
		},
		["index", "outcome", "exitCode", "timedOut", "durationMs"],
	),
};

const shellDefinition: ProgrammaticToolFacadeDefinition = {
	name: process.platform === "win32" ? "pwsh" : "bash",
	description:
		process.platform === "win32"
			? "Execute one foreground PowerShell command in the managed workspace and return bounded stdout/stderr plus its exit marker."
			: "Execute one foreground Bash command in the managed workspace and return bounded stdout/stderr plus its exit marker.",
	inputSchema: objectSchema(
		{
			command: { type: "string", description: "Non-empty shell command." },
			description: { type: "string", description: "Short active-voice description of the command." },
			timeoutMs: { type: "number", minimum: 1, maximum: 600000 },
		},
		["command", "description"],
	),
	outputSchema: objectSchema(
		{
			stdout: { type: "string" },
			stderr: { type: "string" },
			exitCode: { oneOf: [{ type: "integer" }, { type: "null" }] },
			signal: { oneOf: [{ type: "string" }, { type: "null" }] },
			timedOut: { type: "boolean" },
			durationMs: { type: "number" },
		},
		["stdout", "stderr", "exitCode", "signal", "timedOut", "durationMs"],
	),
};

export function getProgrammaticToolFacade(hasVerification: boolean): ProgrammaticToolFacadeDefinition[] {
	return [...baseDefinitions, shellDefinition, ...(hasVerification ? [verificationDefinition] : [])];
}

function nonEmptyString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
	return value;
}

export function mapProgrammaticToolFacadeCall(call: ProgrammaticToolFacadeCall): ProgrammaticToolFacadeMapping {
	const args = call.arguments;
	if (call.tool === "read") {
		return {
			kind: "canonical",
			tool: "read-file",
			arguments: {
				path: nonEmptyString(args.file_path, "file_path"),
				...(args.offset === undefined ? {} : { offset: args.offset }),
				...(args.limit === undefined ? {} : { limit: args.limit }),
			},
		};
	}
	if (call.tool === "edit") {
		const oldString = args.old_string;
		const newString = args.new_string;
		if (typeof oldString !== "string" || oldString.length === 0)
			throw new Error("old_string must be a non-empty string");
		if (typeof newString !== "string") throw new Error("new_string must be a string");
		if (oldString === newString) throw new Error("old_string and new_string must differ");
		return {
			kind: "canonical",
			tool: "apply-edit",
			arguments: {
				path: nonEmptyString(args.file_path, "file_path"),
				expectedText: oldString,
				replacementText: newString,
				...(args.replace_all === undefined ? {} : { replaceAll: args.replace_all }),
			},
		};
	}
	if (call.tool === "todo_write") return { kind: "canonical", tool: "todo-write", arguments: args };
	if (call.tool === "pwsh" || call.tool === "bash")
		return { kind: "canonical", tool: "dsh-shell", arguments: { ...args, dialect: call.tool } };
	if (call.tool === "write") {
		const content = args.content;
		if (typeof content !== "string" || content.length > 32_768 || content.includes("\0"))
			throw new Error("content must be UTF-8 text of at most 32768 characters");
		return {
			kind: "canonical",
			tool: "write-file",
			arguments: { path: nonEmptyString(args.file_path, "file_path"), content },
		};
	}
	const aliases: Record<string, HarnessNativeToolName> = {
		list_directory: "list-directory",
		search_text: "search-text",
		search_text_recursive: "search-text-recursive",
		git_status: "git-status",
		git_diff: "git-diff",
		run_public_verification: "run-public-verification",
	};
	const tool = aliases[call.tool];
	if (tool === undefined) throw new Error(`Unknown programmatic tool: ${call.tool}`);
	return { kind: "canonical", tool, arguments: args };
}

function schemaType(schema: unknown, indent = 0): string {
	if (typeof schema !== "object" || schema === null || Array.isArray(schema)) return "unknown";
	const node = schema as Record<string, unknown>;
	if (Array.isArray(node.oneOf)) return node.oneOf.map((entry) => schemaType(entry, indent)).join(" | ");
	if (node.type === "null") return "null";
	if (Array.isArray(node.enum)) return node.enum.map((entry) => JSON.stringify(entry)).join(" | ");
	if (node.type === "string") return "string";
	if (node.type === "number" || node.type === "integer") return "number";
	if (node.type === "boolean") return "boolean";
	if (node.type === "array") return `${schemaType(node.items, indent)}[]`;
	if (node.type !== "object") return "unknown";
	const properties =
		typeof node.properties === "object" && node.properties !== null && !Array.isArray(node.properties)
			? (node.properties as Record<string, unknown>)
			: {};
	const required = new Set(
		Array.isArray(node.required) ? node.required.filter((item): item is string => typeof item === "string") : [],
	);
	const padding = "  ".repeat(indent + 1);
	const fields = Object.entries(properties).map(([name, property]) => {
		const description =
			typeof property === "object" && property !== null && !Array.isArray(property)
				? (property as Record<string, unknown>).description
				: undefined;
		return `${typeof description === "string" ? `\n${padding}/** ${description.replaceAll("*/", "*\\/")} */` : ""}\n${padding}${JSON.stringify(name)}${required.has(name) ? "" : "?"}: ${schemaType(property, indent + 1)};`;
	});
	return `{${fields.join("")}\n${"  ".repeat(indent)}}`;
}

export function renderProgrammaticToolSdk(definitions: readonly ProgrammaticToolFacadeDefinition[]): string {
	const sorted = [...definitions].sort((left, right) => left.name.localeCompare(right.name));
	const argumentTypes = sorted
		.map((definition) => `  ${JSON.stringify(definition.name)}: ${schemaType(definition.inputSchema, 1)};`)
		.join("\n");
	const outputTypes = sorted
		.map((definition) => `  ${JSON.stringify(definition.name)}: ${schemaType(definition.outputSchema, 1)};`)
		.join("\n");
	return `## Writing code for run_code

- Call tools as \`await tools.name(args)\`. Every successful call resolves to that tool's typed canonical JSON value. Tool arguments must be lossless JSON objects.
- Failed calls reject with \`ToolCallError\`; catch only when the program can recover meaningfully.
- Independent read-only calls may use \`Promise.all\`. Mutations and verification run exclusively in submission order; sequence dependent operations with \`await\`.
- Only returned or logged values enter the next model decision, so return a concise task-relevant result.
- Use \`read\` before changing an existing file. Prefer \`edit\` for a targeted literal replacement; use \`write\` to create or completely replace a file.
- For non-trivial work, call \`todo_write\` with the complete list, keep active work \`in_progress\`, and mark completed work promptly.

\`\`\`ts
declare class ToolCallError extends Error {
  readonly name: "ToolCallError";
  readonly toolName: ToolName;
}

interface ToolArgsMap {
${argumentTypes}
}

interface ToolOutputMap {
${outputTypes}
}

type ToolName = keyof ToolOutputMap;

declare const tools: {
  [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>;
};
\`\`\``;
}
