# Fixed-50 Benchmark Reproduction Contract

The repository preserves the portable reproduction contract, not a one-command
replica of the published run. Complete datasets, evaluator checkout and Python
environment, repositories, Docker images, predictions, logs, and scored
artifacts are external to this repository.

## Frozen contract

| Contract item | Frozen value / requirement |
| --- | --- |
| Dataset source | `MariusHobbhahn/swe-bench-verified-mini`, `test` split, revision `b316c349947c29963fce3f4a65967c9807a4b673` |
| Selected subset | `HAL-Verified-Mini-v1.full.jsonl`, 50 rows, SHA-256 in the tracked manifest |
| Evaluator | official SWE-bench checkout at `7d92bde324b9b96d41fb3e5e1023c8476f17b0bf` |
| Model profile | `deepseek-v4-flash` |
| Entry point | `node_modules/.bin/tsx src/agentpatchcheck/swebench-cli.ts` |

## Bootstrap environment

Set these existing bootstrap variables in the operator environment; do not put
credential values in manifests, source, or evidence:

```text
DEEPSEEK_API_KEY
AGENTPATCHCHECK_SWEBENCH_MANIFEST
AGENTPATCHCHECK_SWEBENCH_EVALUATOR_ROOT
AGENTPATCHCHECK_SWEBENCH_EVALUATOR_PYTHON
```

## Example invocation

For one manifest-selected instance and a fresh run identity:

```powershell
node_modules/.bin/tsx src/agentpatchcheck/swebench-cli.ts `
  --instance <instance-id-from-the-manifest> `
  --run-id <fresh-run-id>
```

The manifest owns dataset identity, evaluator revision, model, timeout, and
classification. Operator arguments cannot override them; this is not an
instruction to rerun the published fixed-50 result.
