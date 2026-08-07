# AgentPatchCheck Headless Core

The Headless Core is independent from Kanban Runtime, Web UI, Electron, terminal sessions, and PTY. Its first executable flow is:

```text
local Git repository
  -> .agentpatchcheck/worktrees/<runId>
  -> codex exec --json
  -> Git diff and changed-file collection
  -> structured execution result
```

Run it with:

```powershell
npm.cmd run agentpatchcheck:run -- --repo <path-to-target-repository> --prompt "Describe the requested change"
```

If the installed Codex CLI is older than the configured default model, pass an explicit compatible model, for example `--model gpt-5.4`.

The runner defaults to `workspace-write` and accepts only `workspace-write` or `read-only`; it never adds an approval- or sandbox-bypass flag. On Unix it launches `codex` directly. On Windows it uses `cmd.exe` only when the resolved command is a `.cmd`/`.bat` shim, reusing the existing escaped-argv launch utility. It does not use a PTY or an interactive shell.

Each run owns a worktree below the target repository. The first phase intentionally retains that worktree after execution so patch, verifier, and evidence stages can inspect it. Automatic cleanup, task policy, verifiers, verdicts, and UI/API adapters are later phases.
