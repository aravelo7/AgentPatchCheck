import { readFileSync } from "node:fs";
import { join } from "node:path";
const worktree = process.env.AGENTPATCHCHECK_ORACLE_WORKTREE;
process.exit(typeof worktree === "string" && readFileSync(join(worktree, "src/validation/range.ts"), "utf8") === "export function isPort(value: number): boolean {\n\treturn value >= 1 && value <= 65535;\n}\n" ? 0 : 1);
