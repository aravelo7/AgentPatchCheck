import { readFileSync } from "node:fs";

const readmePath = `${process.env.AGENTPATCHCHECK_ORACLE_WORKTREE}/README.md`;
process.exit(readFileSync(readmePath, "utf8") === "after\n" ? 0 : 1);
