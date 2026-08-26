import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const worktree = process.env.AGENTPATCHCHECK_ORACLE_WORKTREE;
if (!worktree) process.exit(2);

const result = spawnSync(
	"python",
	["-c", "from sympy.parsing.sympy_parser import parse_expr; x=parse_expr('1 < 2', evaluate=False); print(x); print(type(x).__name__)"],
	{ cwd: worktree, encoding: "utf8", timeout: 25000, windowsHide: true },
);
if (result.error) throw result.error;
assert.equal(result.status, 0, result.stderr);
assert.deepEqual(result.stdout.trim().split(/\r?\n/u), ["1 < 2", "StrictLessThan"]);
