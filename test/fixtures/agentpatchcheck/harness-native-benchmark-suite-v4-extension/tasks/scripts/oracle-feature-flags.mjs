import { readFileSync } from "node:fs";
import { join } from "node:path";
const worktree = process.env.AGENTPATCHCHECK_ORACLE_WORKTREE;
process.exit(typeof worktree === "string" && readFileSync(join(worktree, "feature-flags.json"), "utf8") === '{\n  "beta": {\n    "enabled": false,\n    "rollout": 25\n  },\n  "stable": {\n    "enabled": true\n  }\n}\n' ? 0 : 1);
