import { writeFile } from "node:fs/promises";
import { join } from "node:path";

await writeFile(join(process.env.AGENTPATCHCHECK_AGENT_WORKTREE, "README.md"), "invalid\n", "utf8");
