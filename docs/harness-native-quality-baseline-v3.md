# Harness-native Quality Baseline v3

This is a historical, reproducible quality sample for the versioned
`harness-native-public-repair` v3 suite. It is not a general capability claim
and does not replace per-change benchmark comparison.

## Experiment identity

- Date: 2026-08-14
- Suite: `harness-native-public-repair` v3 (eight fixed tasks)
- Model: `deepseek-v4-pro`
- Provider profile: `deepseek-chat`
- Experiment fingerprint:
  `090b4a59de113728d6a2e13532d04cd2e29cf327fda911e80815eb2797afe372`
- Repetitions: one three-run experiment; three suite runs and twenty-four task
  executions total.

The repetition report was marked `comparable`: suite/configuration,
fixture/base, Hidden Oracle, Provider/Agent, and Harness environment identity
matched across all three runs. It is retained outside the repository because it
contains disposable fixtures and task Evidence:

- `D:\Benchmarks\agentpatchcheck-native-v3-baseline-20260814\repetitions-report.json`

## Aggregate results

| Measure | Result | Definition |
| --- | ---: | --- |
| Suite pass rate | 3/3 (100.00%) | A suite run passes only when all eight tasks pass. |
| Task pass rate | 24/24 (100.00%) | Final Benchmark task status is `passed`. |
| Final public verification pass rate | 24/24 (100.00%) | The public command verifier passed after the bounded repair cycle. |
| Hidden Oracle pass rate | 24/24 (100.00%) | The independent post-patch Oracle passed. |
| Public-verification false-positive rate | 0/24 (0.00%) | Public verification passed but the Hidden Oracle rejected the final patch. |
| Public repair recovery rate | 9/9 (100.00%) | A deliberately failed initial public verification triggered the one permitted repair and the final public verification passed. |
| Provider failure tasks | 0 | Provider errors are excluded from semantic patch failures. |
| Agent execution failures | 0 | Agent execution completed successfully under the configured runtime budget. |

## V3-specific evidence

`recursive-feedback-invariant-repair` passed in all three runs. It begins with
one retained initial cross-directory change, then receives one Harness-owned
targeted repair instruction after public verification fails. Its Hidden Oracle
requires both intended source repairs and verifies that the unrelated
`src/shared/constants.ts` remains unchanged.

`nested-configuration-invariant-repair` also passed in all three runs. Public
verification checks only the requested nested retry fields; its Hidden Oracle
requires the complete JSON document, including untouched defaults and
formatting.

These results show that the v3 invariants were exercised by this sample. The
three-run denominator is too small to support a general 100% success claim.

## Use

Use this baseline only with a repetition report whose `experimentIdentity` is
`comparable` and whose fingerprint matches the value above. A different
fingerprint is a different experiment: compare it descriptively, but do not
label rate differences as a model regression without an intentional baseline
update.
