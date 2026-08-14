import { readFileSync } from "node:fs";
import { join } from "node:path";

const worktree = process.env.AGENTPATCHCHECK_ORACLE_WORKTREE;
const expected = '{\n  "retry": {\n    "enabled": true,\n    "limit": 3,\n    "backoffMs": 200\n  },\n  "telemetry": {\n    "enabled": true\n  },\n  "labels": [\n    "stable"\n  ]\n}\n';
const filePath = typeof worktree === "string" ? join(worktree, "service-settings.json") : "";
process.exit(filePath && readFileSync(filePath, "utf8") === expected ? 0 : 1);
