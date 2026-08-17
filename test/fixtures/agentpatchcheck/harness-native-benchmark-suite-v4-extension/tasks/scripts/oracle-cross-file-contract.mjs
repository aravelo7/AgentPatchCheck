import { readFileSync } from "node:fs";
import { join } from "node:path";
const worktree = process.env.AGENTPATCHCHECK_ORACLE_WORKTREE;
if (typeof worktree !== "string") process.exit(1);
const request = readFileSync(join(worktree, "src/api/request.ts"), "utf8");
const response = readFileSync(join(worktree, "src/api/response.ts"), "utf8");
process.exit(request === 'export const requestStatus = "ready";\n' && response === 'export function acceptsStatus(value: string): boolean {\n\treturn value === "ready";\n}\n' ? 0 : 1);
