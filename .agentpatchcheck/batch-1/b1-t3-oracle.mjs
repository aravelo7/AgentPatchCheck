import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const worktree = process.env.AGENTPATCHCHECK_ORACLE_WORKTREE;
if (!worktree) process.exit(2);

const result = spawnSync(
	"python",
	[
		"-c",
		"from django.conf import settings; settings.configure(USE_I18N=False); from django.template.defaultfilters import floatformat; print(floatformat('0.00', 0))",
	],
	{ cwd: worktree, encoding: "utf8", timeout: 25000, windowsHide: true },
);
if (result.error) throw result.error;
assert.equal(result.status, 0, result.stderr);
assert.deepEqual(result.stdout.trim().split(/\r?\n/u), ["0"]);
