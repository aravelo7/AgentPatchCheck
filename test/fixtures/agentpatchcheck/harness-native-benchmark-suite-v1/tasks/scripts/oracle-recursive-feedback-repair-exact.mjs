import { readFileSync } from "node:fs";
import { join } from "node:path";

const worktree = process.env.AGENTPATCHCHECK_ORACLE_WORKTREE;
if (typeof worktree !== "string") process.exit(1);
const alpha = readFileSync(join(worktree, "src", "feature", "alpha.ts"), "utf8");
const beta = readFileSync(join(worktree, "src", "config", "beta.ts"), "utf8");
process.exit(
	alpha === 'export const alphaMessage = "cross-after-a";\n' && beta === 'export const betaMessage = "cross-after-b";\n'
		? 0
		: 1,
);
