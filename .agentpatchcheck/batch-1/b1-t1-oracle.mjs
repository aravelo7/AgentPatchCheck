import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const worktree = process.env.AGENTPATCHCHECK_ORACLE_WORKTREE;
if (!worktree) process.exit(2);

const result = spawnSync(
	"python",
	["-c", "from sympy import Rational; x=Rational('0.5','100'); print(x); print(x == Rational(1,200))"],
	{ cwd: worktree, encoding: "utf8", timeout: 25000, windowsHide: true },
);
if (result.error) throw result.error;
assert.equal(result.status, 0, result.stderr);
assert.deepEqual(result.stdout.trim().split(/\r?\n/u), ["1/200", "True"]);
