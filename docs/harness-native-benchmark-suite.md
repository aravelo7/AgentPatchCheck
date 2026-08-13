# Harness-native Agent Benchmark Suite v1

`harness-native-public-repair` is an explicit, model-backed benchmark suite. It is separate from the deterministic
Headless Core corpus and is not part of ordinary CI.

The suite materializes a disposable Git fixture, pins its fixture/base, TaskSpec, verification profile, risk profile,
and Hidden Oracle source in the resulting Evidence and BenchmarkReport. Its fixed corpus contains a public-repair
task, a new-file task, a multi-file local-repair task, a recursive cross-directory repair task, and a recursive
feedback-repair task. The public-repair and recursive feedback-repair tasks deliberately produce a public verification
failure first, then measure the bounded single repair attempt before the Hidden Oracle runs.

## Run

Select the model explicitly; the selected model is recorded in each task execution identity and is treated as agent
drift by comparison. Provider selection is limited to versioned suite profiles: it cannot supply arbitrary endpoints,
credential names, or Provider configuration.

```powershell
$env:OPENAI_API_KEY = "..."
npm.cmd run benchmark:harness-native-suite -- `
  --output-root D:\Benchmarks\agentpatchcheck-native-v1 `
  --model <model-id>
```

The default `openai-responses` profile requires `OPENAI_API_KEY`. The verified DeepSeek profile uses Chat
Completions and requires `DEEPSEEK_API_KEY` in the same PowerShell session:

```powershell
npm.cmd run benchmark:harness-native-suite -- `
  --output-root D:\Benchmarks\agentpatchcheck-native-v1-deepseek `
  --model deepseek-v4-pro `
  --provider-profile deepseek-chat
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

```powershell
npm.cmd run benchmark:harness-native-repetitions -- `
  --output-root D:\Benchmarks\agentpatchcheck-native-v1-deepseek-repetitions `
  --runs 3 `
  --model deepseek-v4-pro `
  --provider-profile deepseek-chat
```

This is an explicitly model-backed experiment and consumes one complete suite execution per run. Compare individual
`benchmarkReportPath` values with `agentpatchcheck benchmark-compare`; use the aggregate only for repeated-run rates.

## Recorded baseline: Hidden Oracle discrimination

On 2026-08-13, three explicit DeepSeek `deepseek-v4-pro` runs of the pinned v1 corpus produced 15 task executions:
all 15 passed final public verification, while 14 passed the Hidden Oracle. The remaining `public-repair` execution
changed `README.md` to `after\n\n`; it passed the public prefix check but failed the exact-content Hidden Oracle.
There were no Provider or Agent execution failures in that sample. This is evidence that the Oracle detects a
public-verification false positive, not evidence of a stable 100% task-success rate. The retained result is
`D:\Benchmarks\agentpatchcheck-native-v1-deepseek-repetitions-20260813\repetitions-report.json`; it is local
experiment evidence, not a versioned repository fixture.

On a second three-run experiment on the same date, 12 of 15 tasks reached final public verification and the Hidden
Oracle; `publicVerificationFalsePositives` was zero. The three remaining tasks failed before any tool call: two had
Provider transport failures (`ECONNRESET`) and one had a malformed Provider response. These are recorded as Provider
failures, not Agent execution failures or semantic patch failures. The result is
`D:\Benchmarks\agentpatchcheck-native-v1-deepseek-repetitions-false-positive-20260813\repetitions-report.json`.
That historical run predates the bounded transport retry below, so it remains useful as an unmasked reliability
observation.

The `deepseek-chat` suite profile explicitly permits one retry only when its first model request fails with
`ECONNRESET`, before any tool call or tool result exists. The default remains zero retries. Malformed responses,
HTTP failures, authentication failures, rate limits, and requests after the session has begun are never retried.
Recovered retries are recorded as `runtime.transportRetries` in Evidence and aggregated as
`summary.nativeQuality.transportRetries`; they are not counted as Agent repair attempts.

## Setup-only validation

Use `--dry-run` to validate the versioned fixture/base identity, materialize the selected model into the disposable
TaskSpec, and inspect the fixed budgets without making an API request:

```powershell
npm.cmd run benchmark:harness-native-suite -- `
  --output-root D:\Benchmarks\agentpatchcheck-native-v1-dry-run `
  --model <model-id> `
  --provider-profile <openai-responses|deepseek-chat> `
  --dry-run
```

## Limits and boundaries

- The v1 corpus uses five independent managed workspaces and requires a patch from each task.
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
- `providerFailureTasks` is separate from `agentExecutionFailureTasks`; neither should be silently counted as a semantic
  patch failure.

The v1 suite contains five tasks and is an integration fixture, not a statistically meaningful quality score. Future
versioned corpora must grow the task denominator before publishing rates.

OpenAI documents the Responses API as the API for multi-turn and tool-calling workflows; choose and compare models on
representative tasks rather than treating a single result as a general capability claim.
