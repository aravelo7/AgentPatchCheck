# AgentPatchCheck Headless Core

The Headless Core is independent from Kanban Runtime, Web UI, Electron, terminal sessions, and PTY. Its first executable flow is:

```text
local Git repository
  -> .agentpatchcheck/worktrees/<runId>
  -> codex exec --json
  -> Git diff and changed-file collection
  -> structured execution result
```

Run it with a strict local TaskSpec JSON file:

```powershell
npm.cmd run agentpatchcheck:run -- --task-spec D:\Projects\task-spec.json
```

Assess an existing EvidenceBundle without launching Codex or creating a worktree:

```powershell
npm.cmd run agentpatchcheck:assess -- --evidence D:\Projects\target-repo\.agentpatchcheck\evidence\<runId>.json
```

After assessment, preview cleanup of that run's managed worktree. Add `--apply` only after reviewing the printed target:

```powershell
npm.cmd run agentpatchcheck:cleanup -- --evidence D:\Projects\target-repo\.agentpatchcheck\evidence\<runId>.json
npm.cmd run agentpatchcheck:cleanup -- --evidence D:\Projects\target-repo\.agentpatchcheck\evidence\<runId>.json --apply
```

List the repository's persisted runs, including assessment availability and whether each retained worktree still exists:

```powershell
npm.cmd run agentpatchcheck:list -- --repository D:\Projects\target-repo
```

Show a concise read-only summary for one run. This reports metadata, execution and command-verification summaries, patch metadata, and the recorded assessment; it does not print full agent output or patch content:

```powershell
npm.cmd run agentpatchcheck:show -- --evidence D:\Projects\target-repo\.agentpatchcheck\evidence\<runId>.json
```

Before any future apply operation, run the read-only preflight. It requires a matching passing assessment, the recorded repository at its base commit, and a clean `git apply --check`:

```powershell
npm.cmd run agentpatchcheck:apply-plan -- --evidence D:\Projects\target-repo\.agentpatchcheck\evidence\<runId>.json
```

Apply is intentionally separate and requires both the exact target repository and explicit write consent. Without `--apply`, it performs the same guarded preview without writing:

```powershell
npm.cmd run agentpatchcheck:apply -- --evidence D:\Projects\target-repo\.agentpatchcheck\evidence\<runId>.json --repository D:\Projects\target-repo
npm.cmd run agentpatchcheck:apply -- --evidence D:\Projects\target-repo\.agentpatchcheck\evidence\<runId>.json --repository D:\Projects\target-repo --apply
```

```json
{
  "version": 1,
  "repositoryRoot": "D:\\Projects\\target-repo",
  "promptFile": "prompt.txt",
  "model": "gpt-5.4",
  "sandbox": "read-only",
  "patchExpectation": "changes-optional",
  "verificationProfile": "node-version"
}
```

`node-version` resolves only to `<repositoryRoot>/.agentpatchcheck/profiles/node-version.json`. The catalog file is strict JSON and can be referenced by multiple TaskSpecs:

```json
{
  "version": 1,
  "name": "node-version",
  "verification": {
    "commands": [{ "command": "node", "args": ["--version"] }]
  }
}
```

TaskSpec accepts exactly one of `prompt` or `promptFile`; the latter must be a file below the TaskSpec directory. It may define inline `verification` or a catalog `verificationProfile`, but not both. Profile names accept only letters, numbers, underscores, and hyphens; paths, `..`, and unknown entries are rejected. Unknown fields are rejected in both files. The resolved profile path, name, and SHA-256 are retained in the EvidenceBundle, so the exact reusable verification policy remains auditable.

If the installed Codex CLI is older than the configured default model, pass an explicit compatible model, for example `--model gpt-5.4`.

Before execution, CLI input is resolved into a validated TaskPolicy. The policy requires the repository root, resolves the base ref to a commit, restricts the worktree root to a descendant of that repository, caps prompt and timeout values, and accepts only `workspace-write` or `read-only`. Network access is disabled by default and can only be enabled with `--allow-network`. Dangerous Codex parameters are rejected; the CLI never exposes bypass flags. On Unix the runner launches `codex` directly. On Windows it uses `cmd.exe` only when the resolved command is a `.cmd`/`.bat` shim, reusing the existing escaped-argv launch utility. It does not use a PTY or an interactive shell.

Each run owns a worktree below the target repository. The first phase intentionally retains that worktree after execution so patch, verifier, and evidence stages can inspect it. Automatic cleanup, task policy, verifiers, verdicts, and UI/API adapters are later phases.

Every completed run also writes an atomic JSON EvidenceBundle to `.agentpatchcheck/evidence/<runId>.json`, adjacent to the managed worktrees. It records the validated policy snapshot, workspace and base commit, agent invocation/result, patch snapshot and SHA-256, duration, and final status. Prompt text is represented by length and SHA-256; prompt and common credential values are redacted from persisted agent output and arguments.

For untracked files, a new run records an applyable snapshot only when the path is repository-relative, the file is a regular UTF-8 text file, it is within the per-file and total size limits, and it contains no detected credential pattern. The snapshot carries content, byte length, and SHA-256. Binary, oversized, symlinked, suspicious, or unsnapshotted files remain visible as changed files but block `apply-plan` rather than being applied incompletely.

`verifyGitPatchEvidence(evidencePath)` is the first read-only verifier. It confirms the retained worktree exists, its `HEAD` still equals the recorded base commit, its changed-file snapshot and tracked diff SHA-256 still match, and reports any unrecorded untracked files. It returns a structured verification result without changing the repository or worktree.

`decidePatchVerdict(...)` is a pure verdict stage modelled after evaluation harness grading: it consumes the persisted execution facts and Git verification result, but performs no I/O. Git verification failure, agent failure, and timeout produce `fail`; an empty patch where changes were required produces `inconclusive`; otherwise it produces `pass`. Task-specific commands and richer acceptance rules remain a later verifier stage.

`VerificationPolicy` provides that first task-specific command stage. It is constructed programmatically as an explicit list of argv commands; the CLI deliberately does not accept arbitrary verification-command text. Each command runs directly in the retained worktree with `shell: false`, a bounded timeout and captured output. Shell launchers and Codex bypass parameters are rejected. Commands run before the final Git snapshot, their structured results are written to the EvidenceBundle, and a failed command makes the PatchVerdict fail. The policy does not grant network access; OS-level network isolation is a future sandbox integration concern.

`assessEvidenceBundle({ evidencePath })` closes the first evaluation loop: it reads the immutable EvidenceBundle, runs GitPatchVerifier, applies PatchVerdict (including recorded CommandVerifier facts) using the recorded TaskPolicy patch expectation, and atomically writes `<runId>.assessment.json` alongside the source evidence. The assessment never launches Codex, creates a worktree, changes the worktree, or alters the original bundle.

`cleanupEvidenceWorktree({ evidencePath })` is dry-run by default. It requires a completed assessment matching that evidence, verifies the evidence and worktree paths are the exact managed paths recorded for the run, and checks that Git still registers the worktree. With explicit `--apply`, it removes only that registered worktree through `git worktree remove --force`. EvidenceBundle and AssessmentReport JSON files are always retained.

`listEvidenceBundles({ repositoryPath })` is read-only. It validates the target as a Git repository, lists only `.agentpatchcheck/evidence/*.json` files (excluding assessment reports), and reports each run's execution status, matching assessment verdict, worktree availability, and paths. Invalid EvidenceBundle files are returned separately without preventing valid history from being listed.

`showEvidenceBundle({ evidencePath })` is read-only and does not re-run verification. It returns the stored TaskPolicy and workspace, a redacted agent invocation summary with output byte counts, command-verification summaries, changed files and tracked-patch metadata, plus the matching recorded assessment when present.

`createApplyPlan({ evidencePath })` is read-only. It does not apply a patch; it requires a matching `pass` assessment, confirms the recorded repository remains at its recorded base commit, rejects changed files not materialized in the stored tracked diff, and runs `git apply --check --binary` through stdin. A future write-capable apply command must consume only a `ready` plan.

`applyRecordedPatch({ evidencePath, repositoryPath, apply })` re-runs that preflight, requires the explicit repository to resolve to the exact recorded Git root, and writes only when `apply` is true and the result is `ready`. It invokes `git apply --binary` through stdin with no shell, does not stage or commit, and strictly fails rather than stashing, merging, overwriting, or resolving conflicts.
