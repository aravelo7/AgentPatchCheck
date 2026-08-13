import { readFileSync } from "node:fs";
import { join } from "node:path";

const worktree = process.env.AGENTPATCHCHECK_ORACLE_WORKTREE;
if (typeof worktree !== "string") process.exit(1);
const first = readFileSync(join(worktree, "first.txt"), "utf8");
const second = readFileSync(join(worktree, "second.txt"), "utf8");
process.exit(first === "first-after\n" && second === "second-after\n" ? 0 : 1);
