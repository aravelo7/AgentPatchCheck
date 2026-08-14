import { readFileSync } from "node:fs";
import { join } from "node:path";

const worktree = process.env.AGENTPATCHCHECK_ORACLE_WORKTREE;
const filePath = typeof worktree === "string" ? join(worktree, "settings.json") : "";
const expected = '{\n  "featureEnabled": true,\n  "retryLimit": 3\n}\n';
process.exit(filePath && readFileSync(filePath, "utf8") === expected ? 0 : 1);
