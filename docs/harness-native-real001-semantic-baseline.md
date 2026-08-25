# Harness-native real001 semantic baseline

This document fixes `run-7f4d2597-af3` as the trusted semantic baseline for
the `real-001` task. It records one reproducible frozen result, not a reliability
rate or a general model capability claim. A later run is comparable only when
its task and runtime identity are intentionally matched.

## Baseline verdict

`REAL001 SEMANTIC PASS`

- Frozen run: `run-7f4d2597-af3`
- Date: 2026-08-25
- Result: retrieval, mutation, public verification, and finish completed.
- Corrected formal Hidden Oracle: 15/15 semantic assertions passed; exit code
  `0`.
- Changed file: `src/lib/isURL.js`
- Tracked patch SHA-256:
  `7fb548e4ba19560e9b4cb1910bfed5e48a52676495e98e479a4ae48d1ef9933e`

## Experiment identity

- Repository: `validator.js`
- Base commit: `4af61243ba0ae93f29e7689040e188b5849ff1b0`
- Task-definition SHA-256:
  `6c744f425e95f558549b02fac60231068b8f52316a2fb3ff5088861b0ea3edd9`
- Agent adapter: `harness-native`
- Provider route: `deepseek` / `chat-completions`
- Provider implementation: `deepseek-official-chat-v1`
- Model: `deepseek-v4-pro`
- Thinking mode: `enabled`
- Reasoning effort: `high`
- Planner: disabled
- Maximum iterations: 12
- Maximum tool calls: 48
- Maximum observation bytes: 16,384
- Runtime outcome: `succeeded` / `finished`
- Runtime usage: 12 iterations, 16 tool calls, 0 transport retries

The credential value and endpoint URL are deliberately not recorded here. The
task-definition snapshot retains the non-secret provider identity needed to
audit the run.

## Evidence and Oracle provenance

The frozen Evidence is retained at:

`<validator.js checkout>\.agentpatchcheck\evidence\run-7f4d2597-af3.json`

Its SHA-256 is:

`4d1cd229a5909480f9cf7182b676a8f8001b99a3fcb703eb331434691b6fcdc8`

The frozen worktree is retained at:

`<validator.js checkout>\.agentpatchcheck\worktrees\run-7f4d2597-af3`

The run's captured Oracle SHA-256 was
`6148f6710a59c2ec887c676b53b602edc6b9e8de1aadb2caafc19247801baaf6`.
That Oracle passed a Windows absolute filesystem path directly to ESM
`import()`, so it exited before executing an assertion. The portability-only
repair converts the path with Node.js `pathToFileURL()` and leaves all 15
assertions, their order, and expected values unchanged.

The corrected Oracle is:

`.agentpatchcheck/local/deepseek-real-001-single-owner-once/oracle.mjs`

Its SHA-256 is:

`53bdf7715ffc3e4914110b0eb3b19ea9c7d3ffc59e1e381d79edee315bc0c447`

The same corrected content is retained in the repository real001 fixture at
`test/fixtures/agentpatchcheck/real-repo-benchmark-v1/real-001/oracle.mjs`.
Executing the corrected formal Oracle against the frozen worktree produced no
assertion failure and exited `0`.

## Interpretation and use

The persisted `run-7f4d2597-af3.assessment.json` still reports
`hidden-oracle-failed`. That assessment is not authoritative for semantic
acceptance because it records the pre-assertion Windows ESM bootstrap failure;
it has intentionally not been rewritten.

Use this baseline to establish that this exact frozen run satisfies the
real001 semantic contract. Do not use this single sample to claim a success
rate, retrieval-to-mutation reliability, or equivalence with a run whose base
commit, TaskSpec, Provider identity, thinking configuration, budgets, patch, or
Oracle semantics differ.
