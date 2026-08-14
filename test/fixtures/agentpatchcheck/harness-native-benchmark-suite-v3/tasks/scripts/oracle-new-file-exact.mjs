import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const worktree = process.env.AGENTPATCHCHECK_ORACLE_WORKTREE;
const filePath = typeof worktree === "string" ? join(worktree, "created.txt") : "";
process.exit(filePath && existsSync(filePath) && readFileSync(filePath, "utf8") === "created\n" ? 0 : 1);
