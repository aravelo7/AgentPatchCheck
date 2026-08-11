# Harness-native Agent Benchmark Suite v1

`harness-native-public-repair` is an explicit, model-backed benchmark suite. It is separate from the deterministic
Headless Core corpus and is not part of ordinary CI.

The suite materializes a disposable Git fixture, pins its fixture/base, TaskSpec, verification profile, risk profile,
and Hidden Oracle source in the resulting Evidence and BenchmarkReport. The task deliberately produces a public
verification failure first, then measures the bounded single repair attempt before the Hidden Oracle runs.

## Run

The suite requires an API key because the Harness-native adapter calls the OpenAI Responses API. Select the model
explicitly; the selected model is recorded in each task execution identity and is treated as agent drift by comparison.

```powershell
$env:OPENAI_API_KEY = "..."
npm.cmd run benchmark:harness-native-suite -- `
  --output-root D:\Benchmarks\agentpatchcheck-native-v1 `
  --model <model-id>
```

The output root must not exist. It contains only a disposable fixture repository, managed worktrees, Evidence, and the
BenchmarkReport. The command prints a machine-readable JSON summary. It exits `0` when the task passes and `1` when
the task is evaluated but does not pass; in both cases the printed `benchmarkReportPath` preserves the result for
`agentpatchcheck benchmark-compare`.

## Setup-only validation

Use `--dry-run` to validate the versioned fixture/base identity, materialize the selected model into the disposable
TaskSpec, and inspect the fixed budgets without making an API request:

```powershell
npm.cmd run benchmark:harness-native-suite -- `
  --output-root D:\Benchmarks\agentpatchcheck-native-v1-dry-run `
  --model <model-id> `
  --dry-run
```

## Limits and boundaries

- The v1 task uses one managed workspace and requires a patch.
- The Native Agent is bounded to six model iterations and six tool calls, with a 120-second task timeout and 4 KiB
  observations.
- The public verifier only checks the expected README prefix. The Hidden Oracle checks exact final content after the
  public repair cycle and is not exposed to the agent.
- The suite records token usage reported by the provider, but v1 does not enforce a monetary token-cost ceiling.
- It does not apply, stage, commit, or push the resulting patch.

OpenAI documents the Responses API as the API for multi-turn and tool-calling workflows; choose and compare models on
representative tasks rather than treating a single result as a general capability claim.
