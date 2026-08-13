# Harness-native Quality Baseline v2

This is a historical, reproducible quality sample for the versioned
`harness-native-public-repair` v2 suite. It is not a general capability claim
and does not replace per-change benchmark comparison.

## Experiment identity

- Date: 2026-08-13
- Suite: `harness-native-public-repair` v2 (six fixed tasks)
- Model: `deepseek-v4-pro`
- Provider profile: `deepseek-chat`
- Experiment fingerprint:
  `fabb23c6e97fa39b4d622181a5cd1587172d23284acc5657a9c25ca8b0406599`
- Repetitions: two independent five-run experiments; ten suite runs and sixty
  task executions total.

The repetition reports were marked `comparable`: suite/configuration,
fixture/base, Hidden Oracle, Provider/Agent, and Harness environment identity
matched. The reports are retained outside the repository because they contain
disposable fixtures and task Evidence:

- `D:\Benchmarks\agentpatchcheck-native-v2-baseline-20260813\repetitions-report.json`
- `D:\Benchmarks\agentpatchcheck-native-v2-baseline-round2-20260813\repetitions-report.json`

## Aggregate results

| Measure | Result | Definition |
| --- | ---: | --- |
| Suite pass rate | 7/10 (70.00%) | A suite run passes only when all six tasks pass. |
| Task pass rate | 57/60 (95.00%) | Final Benchmark task status is `passed`. |
| Final public verification pass rate | 59/60 (98.33%) | The public command verifier passed after the bounded repair cycle. |
| Hidden Oracle pass rate | 58/60 (96.67%) | The independent post-patch Oracle passed. |
| Public-verification false-positive rate | 1/59 (1.69%) | Public verification passed but the Hidden Oracle rejected the final patch. |
| Public repair recovery rate | 19/19 (100.00%) | A deliberately failed initial public verification triggered the one permitted repair and the final public verification passed. |
| Provider failure tasks | 0 | Provider errors are excluded from semantic patch failures. |
| Agent execution failures | 2 | Agent did not complete successfully under the configured runtime budget. |

## Retained failure evidence

The sample deliberately preserves failures rather than weakening validation:

- One `public-repair` execution reached `iteration-limit`, left
  `README.md` as `invalid`, and failed both public verification and the Hidden
  Oracle.
- One `public-repair` execution finished normally and passed the public prefix
  check, but wrote `after\n\n` instead of the Oracle-required exact content
  `after\n`. The Hidden Oracle rejected this public-verification false
  positive.

The first is an Agent completion-stability observation; the second demonstrates
that the independent Oracle detects a semantic mismatch not covered by public
verification. Neither result should be erased by relaxing the public verifier
or the Oracle.

## Use

Use this baseline only with a repetition report whose `experimentIdentity` is
`comparable` and whose fingerprint matches the value above. A different
fingerprint is a different experiment: compare it descriptively, but do not
label rate differences as a model regression without an intentional baseline
update.
