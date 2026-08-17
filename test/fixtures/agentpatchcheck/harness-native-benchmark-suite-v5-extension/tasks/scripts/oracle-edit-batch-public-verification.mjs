import { readFileSync } from "node:fs";
import { join } from "node:path";

const worktree = process.env.AGENTPATCHCHECK_ORACLE_WORKTREE;
if (typeof worktree !== "string") process.exit(1);

const status = readFileSync(join(worktree, "src", "edition", "status.ts"), "utf8");
const summary = readFileSync(join(worktree, "src", "edition", "summary.ts"), "utf8");
process.exit(
	status === 'export const editionStatus = "published";\n' &&
		summary.includes('import { editionStatus } from "./status";') &&
		summary.includes('export const editionSummary = `${editionStatus}: managed`;')
		? 0
		: 1,
);
