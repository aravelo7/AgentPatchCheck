import { readFile } from "node:fs/promises";
import { join } from "node:path";

const readme = await readFile(join(process.env.AGENTPATCHCHECK_ORACLE_WORKTREE, "README.md"), "utf8");
process.exit(readme === "after\n" ? 0 : 1);
