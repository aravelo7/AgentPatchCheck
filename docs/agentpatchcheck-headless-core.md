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
# Installed package / CI entrypoint
agentpatchcheck run --task-spec D:\Projects\task-spec.json

# Repository development convenience wrapper
npm.cmd run agentpatchcheck:run -- --task-spec D:\Projects\task-spec.json
```

## CI and script contract

Every Headless CLI command writes one versioned JSON response. Scripts should branch on `ok` and `error.code`, not on human-readable messages:

```json
{
  "contractVersion": 1,
  "command": "apply-plan",
  "ok": true,
  "data": {},
  "error": null
}
```

`run`, `assess`, `cleanup`, `list`, `evidence-audit`, `evidence-retention`, `show`, `apply-plan`, `approve`, `reject`, `apply`, `benchmark`, and `benchmark-compare` all use this envelope. A successful command exits `0`; a business or runtime failure exits `1`; malformed or missing command arguments exit `2`. Failure responses retain `data` when an operation produced a structured result, such as a blocked apply plan, and otherwise use `data: null`. Stable error codes are `invalid-arguments`, `operation-failed`, `execution-failed`, `assessment-not-pass`, `apply-plan-blocked`, `apply-blocked`, and `benchmark-failed`.

The published package exposes `agentpatchcheck` as a standalone Node CLI at `dist/agentpatchcheck.js`; it does not require `tsx` at runtime. When a repository development script needs stdout to contain only the JSON response, invoke that built entry directly rather than an `npm run` convenience wrapper, which may print npm's own preamble.

### Version and compatibility policy

`agentpatchcheck --version` prints the installed package version. `agentpatchcheck --help` is the human-facing command reference; automation must use the JSON response envelope rather than parsing help text.

The Headless CLI contract is independently versioned by `contractVersion`. Within a contract version, the envelope keys `contractVersion`, `command`, `ok`, `data`, and `error` are stable. Existing command names and their documented error codes are stable; fields may be added inside `data`, but existing field names, value types, error codes, and exit-code meanings are not changed. A breaking envelope, command, error-code, or exit-code change requires a new contract version and a documented migration path.

| Exit code | Stable meaning | Error codes |
| --- | --- | --- |
| `0` | Command completed successfully. | `null` |
| `1` | Valid command could not complete, or a recorded result was not acceptable. | `operation-failed`, `execution-failed`, `assessment-not-pass`, `apply-plan-blocked`, `apply-blocked`, `benchmark-failed` |
| `2` | Command arguments are malformed or incomplete. | `invalid-arguments` |

For CI that consumes only Headless Core, run `node scripts/build.mjs`, then invoke `node dist/agentpatchcheck.js ...` (or the installed `agentpatchcheck` bin). The repository provides `npm.cmd run check:headless` and `npm.cmd run smoke:headless-cli`; neither installs or starts the Web UI, desktop package, or Kanban Runtime. `npm.cmd run test:kanban` remains the broader project/UI test entrypoint.

## Evidence lifecycle operations

Evidence is retained by default, including after `cleanup` removes its managed worktree. This preserves auditability. Use `list` for deterministic operational filtering without writing any state:

```powershell
agentpatchcheck list --repository D:\Projects\target --status failed --assessment-status valid --created-after 2026-01-01T00:00:00.000Z
```

Supported filters are exact `--run-id`, `--status succeeded|failed`, `--assessment-status missing|valid|invalid`, and strict ISO-8601 `--created-after` / `--created-before` bounds.

`evidence-audit` is read-only. It identifies missing or invalid assessments, Evidence whose managed worktree no longer exists, bundles older than a conservative 30-day default (or `--older-than-days`), invalid bundle files, and approval records without a matching Evidence bundle:

```powershell
agentpatchcheck evidence-audit --repository D:\Projects\target --older-than-days 90
```

`evidence-retention` never deletes by default. It only considers Evidence that is older than the explicit threshold, has a valid matching assessment, and whose managed worktree has already been removed. Every retention invocation requires one or more directories containing BenchmarkReport JSON files; an Evidence referenced by any scanned report remains protected. Review the dry-run output first, then repeat with `--apply`:

```powershell
agentpatchcheck evidence-retention --repository D:\Projects\target --older-than-days 90 --benchmark-report-root D:\Projects\benchmarks
agentpatchcheck evidence-retention --repository D:\Projects\target --older-than-days 90 --benchmark-report-root D:\Projects\benchmarks --apply
```

The report roots are an explicit operational boundary: supply every location that stores Benchmark reports for the repository. Retention removes only the exact managed Evidence JSON and its matching assessment/approval sidecars (including approval history); it never removes worktrees, Git data, benchmark reports, invalid Evidence, or entries with missing/invalid assessments.

## Recommended operating flow

1. Create a strict TaskSpec and run `run`; retain the evidence path returned in `data.evidence.path`.
2. Use `show` or `list` to inspect persisted, redacted metadata without re-running Codex.
3. Run `assess` to re-check the retained worktree and write a matching assessment.
4. Run `apply-plan`; proceed only when `data.decision` is `ready`. A `requires-approval` decision needs an explicit `approve` record; `prohibited` cannot be approved or applied.
5. Run `apply` without `--apply` for a final no-write preview, then repeat it with the exact repository root and `--apply` only after review.
6. Run `cleanup` without `--apply` to preview removal, then add `--apply` to remove only the registered managed worktree. Evidence and assessment files remain.

This separates agent execution, read-only assessment, explicit patch application, and cleanup. No command stages, commits, pushes, stashes, merges, or resolves conflicts for the user.

## Agent adapters

`codex` remains the default adapter. The execution boundary now also supports a controlled `script` adapter for deterministic local fixtures and Benchmark development. A Script Adapter is a Node script supplied from the Harness/TaskSpec side; its resolved path must be outside the target repository, and it receives the managed worktree path only through `AGENTPATCHCHECK_AGENT_WORKTREE`. It is not an external hosted agent, does not add network access, and does not weaken TaskPolicy, verification, Hidden Oracle, Risk Policy, Approval, or Safe Apply.

```json
{
  "version": 1,
  "repositoryRoot": "../target-repo",
  "prompt": "Apply the fixture change.",
  "agentAdapter": "script",
  "agentScript": "../harness-fixtures/update-readme.mjs",
  "patchExpectation": "changes-required"
}
```

The validated adapter id is persisted in Evidence and Benchmark configuration. The Script Adapter is intentionally limited to local Harness-owned scripts; arbitrary command adapters, network adapters, parallel scheduling, and retry are outside this phase.

## Approval history

Approval remains a local, single-operator safety gate; it is not an identity or RBAC system. Every `approve` and `reject` appends an immutable decision record beside the Evidence. Each record contains the Evidence reference, risk fingerprint, decision, optional reason, timestamp, and the Headless CLI version that made the decision. `show --evidence <path>` returns both the current approval state and the full `approvalHistory`.

Safe Apply reads the latest history decision for the matching Evidence and risk fingerprint. A later rejection therefore blocks apply even if an earlier decision approved it; a manually altered legacy latest-state sidecar cannot override an existing append-only history. Critical/prohibited risk remains non-approvable.

## Benchmark Runner

`benchmark` is an orchestration layer over existing Headless Core execution. It does not introduce another workspace, agent, verifier, or evidence implementation. A BenchmarkSpec references one or more strict TaskSpec files; each referenced TaskSpec continues to define the repository root, base ref, prompt, sandbox, model, timeout, and inline or catalog verification profile.

```json
{
  "version": 1,
  "name": "local-smoke",
  "suite": { "id": "local-smoke", "fixtureVersion": "fixture-v1" },
  "tasks": [
    { "id": "modify-readme", "taskSpec": "tasks/modify-readme.json", "expectedStatus": "passed" },
    { "id": "add-file", "taskSpec": "tasks/add-file.json" }
  ]
}
```

Task ids are unique and paths must be relative descendants of the BenchmarkSpec directory. `suite` is optional for compatibility, but a reusable benchmark suite should set both its stable id and fixture version. `expectedStatus` records the intended classification without changing the actual result classification. Run the benchmark with:

```powershell
npm.cmd run agentpatchcheck:benchmark -- --spec D:\Projects\benchmarks\local-smoke.json
```

Each task runs sequentially through `validateTaskPolicy` and `executeAgentPatchCheck`, retaining its ordinary EvidenceBundle and AssessmentReport in the task repository. The benchmark report is atomically written beside the spec at `.agentpatchcheck/benchmarks/<benchmark-runId>.json`. It contains the BenchmarkSpec and TaskSpec SHA-256 values, Suite/fixture identity, verification and risk-profile references and hashes, configured model, actual agent executable/args, Node/platform/architecture metadata, task evidence and assessment references, real task classification, and a deterministic `summaryText` for terminal logs.

Classifications are `passed`, `timed-out`, `agent-failed`, `verification-failed`, `hidden-oracle-failed`, `hidden-oracle-error`, `assessment-failed`, and `setup-failed`. A failed task is recorded and does not stop later independent tasks. The aggregate CLI response is `ok: false` with `benchmark-failed` when any task is not `passed`; the report and completed task evidence remain available for inspection. Non-Codex adapters, parallel scheduling, retries, and CI-specific policy selection are intentionally outside this minimal runner.

Compare two persisted reports without launching an agent, reading a worktree, or mutating either report:

```powershell
agentpatchcheck benchmark-compare --left D:\Projects\benchmarks\baseline.json --right D:\Projects\benchmarks\candidate.json
```

The result is a versioned JSON comparison keyed by task id. Each task is `unchanged`, `improved`, `regressed`, `changed`, `added`, or `removed`, and includes `configurationChanged` plus the compared reproducibility configuration so automation can distinguish a behavioral result change from a changed task/profile input.

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
  "verificationProfile": "node-version",
  "riskPolicyProfile": "policies/strict-local.json"
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

## Verifier Plugins and Hidden Oracle

Assessment exposes public command verification and Hidden Oracle outcomes through one structural verifier result shape: verifier id and kind, `passed` / `failed` / `timed-out` / `error` / `not-run` status, duration, exit code, signal, and a short safe diagnostic. The existing `VerificationPolicy` remains the public command verifier; its recorded command facts are summarized into this common result at assessment time. This is the extension boundary for future verifier kinds without replacing Headless Core execution, evidence, or workspace management.

`hiddenOracle` is an optional TaskSpec block whose `script` is relative to the TaskSpec directory and must resolve outside the target repository. The Harness executes that Node script only after the agent has exited and its patch has been collected. The script runs with its own external directory as cwd and receives only the retained worktree path through `AGENTPATCHCHECK_ORACLE_WORKTREE`; the Oracle path and contents are never supplied to the prompt or Codex arguments.

```json
{
  "hiddenOracle": {
    "script": "oracles/semantic-check.mjs",
    "timeoutMs": 10000
  }
}
```

Hidden Oracle exit `0` means pass, exit `1` means the patch did not satisfy the hidden semantic check, and any other exit code, missing script, or spawn failure is Oracle infrastructure error. A timeout is separately recorded. Evidence stores only the structural Oracle result and generic diagnostic, never the script path, script body, or Oracle stdout/stderr. Assessment maps rejection to `hidden-oracle-failed` and infrastructure/timeout to distinct verdict reason codes; Benchmark consumes those existing results as `hidden-oracle-failed` or `hidden-oracle-error` task classifications.

### Isolation capability contract

Hidden Oracle supports the TaskSpec isolation request `none`, `network`, `process`, or `strict`; omitted means `none` and preserves the existing local Harness execution. The requested level is included in the TaskPolicy/Evidence snapshot. The runtime probes an enforced OS isolation backend before launching the Oracle and persists the structural capability result with the Oracle verifier result.

This release intentionally configures no OS-level network/process/resource backend. Therefore `network`, `process`, and `strict` fail closed as a Hidden Oracle infrastructure error: the Oracle process is not spawned, the patch does not receive a false semantic pass, and Evidence records that no backend was available. This is a safety boundary, not a claim of sandboxing. A future platform backend must make the probe report an actual backend before any such request may run.

`assessEvidenceBundle({ evidencePath })` closes the first evaluation loop: it reads the immutable EvidenceBundle, runs GitPatchVerifier, applies PatchVerdict (including recorded CommandVerifier facts) using the recorded TaskPolicy patch expectation, and atomically writes `<runId>.assessment.json` alongside the source evidence. The assessment never launches Codex, creates a worktree, changes the worktree, or alters the original bundle.

`cleanupEvidenceWorktree({ evidencePath })` is dry-run by default. It requires a completed assessment matching that evidence, verifies the evidence and worktree paths are the exact managed paths recorded for the run, and checks that Git still registers the worktree. With explicit `--apply`, it removes only that registered worktree through `git worktree remove --force`. EvidenceBundle and AssessmentReport JSON files are always retained.

`listEvidenceBundles({ repositoryPath })` is read-only. It validates the target as a Git repository, lists only `.agentpatchcheck/evidence/*.json` files (excluding assessment reports), and reports each run's execution status, matching assessment verdict, worktree availability, and paths. Invalid EvidenceBundle files are returned separately without preventing valid history from being listed.

`showEvidenceBundle({ evidencePath })` is read-only and does not re-run verification. It returns the stored TaskPolicy and workspace, a redacted agent invocation summary with output byte counts, command-verification summaries, changed files and tracked-patch metadata, plus the matching recorded assessment when present.

`createApplyPlan({ evidencePath })` is read-only. It does not apply a patch; it requires a matching `pass` assessment, confirms the recorded repository remains at its recorded base commit, rejects changed files not materialized in the stored tracked diff, and runs `git apply --check --binary` through stdin. A future write-capable apply command must consume only a `ready` plan.

## Risk Policy and human approval

`apply-plan` also evaluates the immutable EvidenceBundle and matching AssessmentReport with a pure rule-based Risk Policy. It emits a structured `risk` object (level, findings, reason codes, affected paths, and fingerprint), an `approval` state, and a decision of `ready`, `requires-approval`, or `prohibited`. The current policy requires explicit human approval for CI/build files, dependency manifests and lockfiles, scripts, public test changes, and oversized changes. It prohibits apply for sensitive key-like or `.env` paths, an assessment that is not `pass`, or a Hidden Oracle result that is not `passed`.

For a `requires-approval` result, record a deliberate decision bound to the exact EvidenceBundle creation timestamp and risk fingerprint:

```powershell
npm.cmd run agentpatchcheck:approve -- --evidence D:\Projects\target-repo\.agentpatchcheck\evidence\<runId>.json --reason "reviewed dependency update"
# or explicitly prevent later application
npm.cmd run agentpatchcheck:reject -- --evidence D:\Projects\target-repo\.agentpatchcheck\evidence\<runId>.json --reason "not approved"
```

The approval is stored atomically beside Evidence as `<runId>.approval.json`; Evidence itself remains immutable. `show` reports the current computed risk and approval state. Approval never suppresses assessment, base-commit, patch-integrity, target-repository, exclusive-create, or explicit `--apply` checks. There is intentionally no user identity, RBAC, automatic approval, or wildcard policy in this local single-operator boundary.

### RiskPolicy Profile

`riskPolicyProfile` is an optional strict JSON file relative to the TaskSpec directory. It is a Harness input: validation rejects any profile path inside the target repository, so the Agent worktree cannot provide or replace it. The resolved profile path, name, SHA-256, and effective rules are retained in the EvidenceBundle; later assessment and apply planning use that stored snapshot rather than re-reading the source profile.

```json
{
  "version": 1,
  "name": "strict-local",
  "risk": {
    "protectedPaths": ["infra/", "scripts/release.mjs"],
    "sensitivePaths": ["deploy/secrets/"],
    "maxChangedFiles": 10,
    "maxTrackedPatchBytes": 65536
  }
}
```

Protected paths require approval; sensitive paths prohibit apply. Paths are repository-relative literals; a trailing slash means a descendant prefix. A profile can add paths and lower `maxChangedFiles` (default 25) or `maxTrackedPatchBytes` (default 131072), but cannot remove built-in findings, raise either limit, lower a finding severity, or disable approval. Omitting a profile uses the built-in default policy.

`applyRecordedPatch({ evidencePath, repositoryPath, apply })` re-runs that preflight, requires the explicit repository to resolve to the exact recorded Git root, and writes only when `apply` is true and the result is `ready`. It invokes `git apply --binary` through stdin with no shell, does not stage or commit, and strictly fails rather than stashing, merging, overwriting, or resolving conflicts.

Untracked snapshot writes are additionally guarded: all paths and SHA-256 values are validated before writing, duplicate targets are rejected, and any existing target path causes the operation to fail rather than overwrite it. Files are created with exclusive creation semantics, so a path created after preflight is also rejected. A blocked or failed apply must be investigated and re-run from a fresh assessed evidence bundle; Headless Core does not attempt recovery by overwriting or force-applying.

On Windows, Codex may be started through `cmd.exe` when it resolves to an npm `.cmd` shim. Timeout handling terminates that complete process tree rather than only the wrapper process, and the resulting `timedOut`, exit, signal, and bounded output fields remain in the EvidenceBundle. A timed-out run is assessed as a failed verdict and must not be applied.
