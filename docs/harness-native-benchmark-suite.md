# Harness-native Agent Benchmark Suite v1

`harness-native-public-repair` is an explicit, model-backed benchmark suite. It is separate from the deterministic
Headless Core corpus and is not part of ordinary CI.

The suite materializes a disposable Git fixture, pins its fixture/base, TaskSpec, verification profile, risk profile,
and Hidden Oracle source in the resulting Evidence and BenchmarkReport. Its fixed v1 corpus contains a public-repair
task, a new-file task, a multi-file local-repair task, a recursive cross-directory repair task, and a recursive
feedback-repair task. The public-repair and recursive feedback-repair tasks deliberately produce a public verification
failure first, then measure the bounded single repair attempt before the Hidden Oracle runs.

The separately versioned v2 corpus preserves all five v1 tasks and adds `configuration-semantic-repair`: public
verification checks the requested settings values, while the Hidden Oracle checks the exact intended JSON document.
The separately versioned v3 corpus preserves v2 and adds `recursive-feedback-invariant-repair` (a bounded feedback
repair whose Oracle also protects an unrelated source file) and `nested-configuration-invariant-repair` (publicly
checks two nested settings while the Oracle protects the complete configuration document). The corpus is selected
explicitly; no existing suite identity is mutated.

## Run

Select the model explicitly; the selected model is recorded in each task execution identity and is treated as agent
drift by comparison. Provider selection is limited to versioned suite profiles: it cannot supply arbitrary endpoints,
credential names, or Provider configuration.

```powershell
$env:OPENAI_API_KEY = "..."
npm.cmd run benchmark:harness-native-suite -- `
  --output-root <benchmark-output-root> `
  --model <model-id> `
  --suite-version v1
```

The default `openai-responses` profile requires `OPENAI_API_KEY`. The verified DeepSeek profile uses Chat
Completions and requires `DEEPSEEK_API_KEY` in the same PowerShell session:

```powershell
npm.cmd run benchmark:harness-native-suite -- `
  --output-root <benchmark-output-root> `
  --model deepseek-v4-pro `
  --provider-profile deepseek-chat `
  --suite-version v2
```

The current profiles are intentionally fixed:

- `openai-responses` — OpenAI Responses, credential reference `openai-primary`.
- `deepseek-chat` — OpenAI-compatible Chat Completions at `https://api.deepseek.com`, disabled thinking mode, credential reference `deepseek-primary`.

The output root must not exist. It contains only a disposable fixture repository, managed worktrees, Evidence, and the
BenchmarkReport. The command prints a machine-readable JSON summary. It exits `0` when the task passes and `1` when
the task is evaluated but does not pass; in both cases the printed `benchmarkReportPath` preserves the result for
`agentpatchcheck benchmark-compare`.

## Repeated reliability runs

Use an explicit repetition count to evaluate the same pinned corpus more than once. Each repetition gets a separate
fixture, Evidence set, and BenchmarkReport; the parent output adds `repetitions-report.json` with per-task pass counts
and summed Native Agent quality counters. It also records `publicVerificationFalsePositives`: executions where public
verification passed but the Hidden Oracle explicitly rejected the patch. Oracle infrastructure errors are not included.
It does not retry a failed task or hide provider failures.

The parent report now additionally contains `experimentIdentity`. It is `comparable` only if every child
BenchmarkReport has the same suite/configuration, fixture/base, Hidden Oracle, Provider/Agent, and Harness environment
identity; in that case it exposes a SHA-256 fingerprint. `identity-drift` or `incomplete` means its aggregate rates
must not be compared as a model-quality regression signal.

When the identity is comparable, `qualityBaseline` records rate objects with an explicit `numerator`, `denominator`,
and decimal `rate`: whole-suite pass rate, task pass rate, final public verification pass rate, Hidden Oracle pass rate,
public-verification false-positive rate, and bounded public-repair recovery rate. It also classifies failures by task
status and separately records Provider failures versus Agent execution failures. If identity is not comparable, these
rates are `null`; consumers must not manufacture a cross-experiment success rate from the raw task counts.

```powershell
npm.cmd run benchmark:harness-native-repetitions -- `
  --output-root <benchmark-output-root> `
  --runs 3 `
  --model deepseek-v4-pro `
  --provider-profile deepseek-chat `
  --suite-version v2
```

This is an explicitly model-backed experiment and consumes one complete suite execution per run. Compare individual
`benchmarkReportPath` values with `agentpatchcheck benchmark-compare`; use the aggregate only for repeated-run rates.

## Recorded baseline: Hidden Oracle discrimination

On 2026-08-13, three explicit DeepSeek `deepseek-v4-pro` runs of the pinned v1 corpus produced 15 task executions:
all 15 passed final public verification, while 14 passed the Hidden Oracle. The remaining `public-repair` execution
changed `README.md` to `after\n\n`; it passed the public prefix check but failed the exact-content Hidden Oracle.
There were no Provider or Agent execution failures in that sample. This is evidence that the Oracle detects a
public-verification false positive, not evidence of a stable 100% task-success rate. The retained result is
retained in operator-local experiment artifacts as `repetitions-report.json`; it is local experiment evidence,
not a versioned repository fixture.

On a second three-run experiment on the same date, 12 of 15 tasks reached final public verification and the Hidden
Oracle; `publicVerificationFalsePositives` was zero. The three remaining tasks failed before any tool call: two had
Provider transport failures (`ECONNRESET`) and one had a malformed Provider response. These are recorded as Provider
failures, not Agent execution failures or semantic patch failures. The result is
retained in operator-local experiment artifacts as `repetitions-report.json`. That historical run predates the
bounded transport retry below, so it remains useful as an unmasked reliability observation.

The `deepseek-chat` suite profile explicitly permits one retry only when its first model request fails with
`ECONNRESET`, before any tool call or tool result exists. The default remains zero retries. Malformed responses,
HTTP failures, authentication failures, rate limits, and requests after the session has begun are never retried.
Recovered retries are recorded as `runtime.transportRetries` in Evidence and aggregated as
`summary.nativeQuality.transportRetries`; they are not counted as Agent repair attempts.

## Controlled public-verification repair

Harness-native execution permits at most one separate repair attempt after the initial Agent execution. The decision
is Harness-owned: it is eligible only when the initial Agent finished normally, the declared public verification
failed, and shared task time remains. Provider failures, Agent timeouts, tool or iteration limits, successful or
unavailable public verification, and exhausted shared time do not trigger a repair execution.

The repair phase receives only the sanitized public-verification feedback, an optional TaskSpec-owned targeted repair
instruction, and the initial changed-file paths. It does not receive raw verifier output, an initial patch body, or
Hidden Oracle data. `Evidence.agent.publicVerificationRepair` and each Harness-native benchmark task's
`repairCycle.decision` record whether repair was eligible, the stable reason, and the initial changed-file paths.

## Setup-only validation

Use `--dry-run` to validate the versioned fixture/base identity, materialize the selected model into the disposable
TaskSpec, and inspect the fixed budgets without making an API request:

```powershell
npm.cmd run benchmark:harness-native-suite -- `
  --output-root <benchmark-output-root> `
  --model <model-id> `
  --provider-profile <openai-responses|deepseek-chat> `
  --suite-version <v1|v2|v3|v4> `
  --dry-run
```

## Limits and boundaries

- The v1/v2/v3/v4 corpora use five/six/eight/twelve independent managed workspaces respectively and require a patch from each task.
- The multi-file task allows only exact replacements in two existing files; it verifies both public prefixes and exact
  final content through a Hidden Oracle.
- The recursive task requires bounded cross-directory discovery before two nested source-file replacements; its Hidden
  Oracle verifies the exact final content of both targets.
- The recursive feedback task deliberately changes only one nested target on its initial attempt. A failed public
  verification can trigger one Harness-owned repair run, which must inspect the same worktree and complete the named
  remaining target before the Hidden Oracle checks both exact files.
- The Native Agent is bounded to six model iterations and eight tool calls, with a 120-second task timeout and 4 KiB
  observations.
- The public verifier only checks the expected README prefix. The Hidden Oracle checks exact final content after the
  public repair cycle and is not exposed to the agent.
- The suite records token usage reported by the provider, but v1 does not enforce a monetary token-cost ceiling.
- It does not apply, stage, commit, or push the resulting patch.

## Quality accounting

Each executed BenchmarkReport includes `summary.nativeQuality` for Harness-native tasks. It records counts rather than
precomputed percentages so a consumer cannot accidentally mix model transport failures with code-quality outcomes.

- `initialPublicVerificationPassed / nativeTasks` is the first-attempt public verification rate.
- `publicRepairRecovered / publicRepairAttempted` is the bounded one-repair recovery rate.
- `finalPublicVerificationPassed / nativeTasks` is the final public verification rate.
- `hiddenOraclePassed / nativeTasks` is the final Hidden Oracle pass rate.
- `transportRetries` is the number of successful, bounded pre-tool `ECONNRESET` transport recoveries.
- `rejectedToolCalls` is the number of policy-rejected, non-mutating calls; it is capped separately and does not reduce
  the accepted-tool budget.
- `providerFailureTasks` is separate from `agentExecutionFailureTasks`; neither should be silently counted as a semantic
  patch failure.

The v1/v2/v3/v4 suites contain five/six/eight/twelve tasks respectively and are integration fixtures, not statistically
meaningful quality scores. Future versioned corpora must grow the task denominator before publishing rates.

The first retained v2 quality sample is documented in
[`harness-native-quality-baseline-v2.md`](./harness-native-quality-baseline-v2.md). It records only comparable-run
results and explicitly retains the observed Agent failure and Hidden Oracle false positive.

The first retained v3 quality sample is documented in
[`harness-native-quality-baseline-v3.md`](./harness-native-quality-baseline-v3.md). Its three-run sample exercises
the new feedback-repair and nested-configuration invariants, but is explicitly not a general 100% capability claim.

The trusted single-run semantic baseline for the real-repository `real-001`
task is documented in
[`harness-native-real001-semantic-baseline.md`](./harness-native-real001-semantic-baseline.md).
It pins the frozen run, TaskSpec, patch, Evidence, and corrected Hidden Oracle
identities; it is a semantic acceptance record, not a repeated-run quality
rate.

OpenAI documents the Responses API as the API for multi-turn and tool-calling workflows; choose and compare models on
representative tasks rather than treating a single result as a general capability claim.

## Quality gates for repeated runs

`benchmark:harness-native-repetitions` can consume a strict Harness-owned JSON quality gate. A gate is evaluated only
after all repetitions complete and fails closed when the report is not comparable, its suite identity differs, or the
sample has fewer than the configured runs. It can set minimum rates and ceilings for public-verification false positives,
Provider failures, and Agent execution failures. It does not alter task execution, verification, or Evidence.

The versioned v3 example is
[`quality-gates/harness-native-v3.json`](../test/fixtures/agentpatchcheck/quality-gates/harness-native-v3.json):

```powershell
npm.cmd run benchmark:harness-native-repetitions -- `
  --output-root <benchmark-output-root> `
  --runs 3 `
  --model <model-id> `
  --provider-profile <openai-responses|deepseek-chat> `
  --suite-version v3 `
  --quality-gate test\fixtures\agentpatchcheck\quality-gates\harness-native-v3.json
```

The generated repetition report records `qualityGate` with `passed` or `failed` plus stable reasons. A failed gate
returns exit code 1 even if individual benchmark invocations completed. This makes the gate suitable for CI after a
project deliberately pins an experiment identity and acceptance policy.

## V4 corpus increment

V4 preserves all eight v3 tasks and adds four independently materialized workspaces: source normalization,
cross-file status-contract migration, feature-flag preservation, and an inclusive numeric boundary repair. Each new
task has a narrow public verifier and an exact Hidden Oracle. The cross-file and feature-flag tasks specifically retain
the distinction between a convenient public check and the complete final-state requirement.

V4 is a versioned corpus increment, not the final P0 corpus target. Twelve fixture tasks do not yet substitute for a
20–30 task corpus or for separately selected historical fixes from real repositories.
