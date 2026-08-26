import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const worktree = process.env.AGENTPATCHCHECK_ORACLE_WORKTREE;
if (!worktree) process.exit(2);

const result = spawnSync(
	"python",
	[
		"-c",
		"from sympy import symbols; from sympy.polys.domains import ZZ; from sympy.polys.rings import ring; R,x,y,z=ring('x,y,z',ZZ); f=3*x**2*y-x*y*z+7*z**3+1; U,V,W=symbols('u,v,w'); result=f.as_expr(U,V,W); print(','.join(sorted(str(symbol) for symbol in result.free_symbols))); print(result.free_symbols == {U,V,W})",
	],
	{ cwd: worktree, encoding: "utf8", timeout: 25000, windowsHide: true },
);
if (result.error) throw result.error;
assert.equal(result.status, 0, result.stderr);
assert.deepEqual(result.stdout.trim().split(/\r?\n/u), ["u,v,w", "True"]);
