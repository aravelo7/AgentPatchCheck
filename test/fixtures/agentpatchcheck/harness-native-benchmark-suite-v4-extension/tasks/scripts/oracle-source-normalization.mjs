import { readFileSync } from "node:fs";
import { join } from "node:path";
const worktree = process.env.AGENTPATCHCHECK_ORACLE_WORKTREE;
process.exit(typeof worktree === "string" && readFileSync(join(worktree, "src/domain/normalize.ts"), "utf8") === "export function normalizeName(value: string): string {\n\treturn value.trim().toLowerCase();\n}\n" ? 0 : 1);
