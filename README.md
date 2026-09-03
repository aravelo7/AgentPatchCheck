# AgentPatchCheck

AgentPatchCheck (APC) is an evidence-oriented runtime and evaluation toolkit
for bounded software-repair agents. It separates agent execution, public
verification, hidden evaluation, risk review, patch application, and official
benchmark grading so that a completed agent turn is not mistaken for a correct
repair.

The project is a research preview. It is intended for controlled local and CI
experiments, not unattended modification of production repositories.

## Overview

APC runs a repair task in an isolated Git worktree, exposes a bounded tool
surface to the selected agent, records structured execution evidence, verifies
the resulting patch, and keeps application to the target repository behind a
separate approval step. Benchmark results preserve execution validity and
grading validity independently from termination status.

## Key Capabilities

- Isolated, per-run Git worktrees and deterministic run identities.
- Bounded agent iterations, tool calls, output, deadlines, and cancellation.
- Harness-native, Codex, Cline, and script adapter boundaries already present
  in the repository.
- Structured trajectories, evidence bundles, assessment reports, and risk
  policy checks with credential and sensitive-text redaction.
- Public verification, hidden Oracle evaluation, patch capture, guarded apply,
  and evidence retention workflows.
- Sequential benchmark orchestration, report comparison, SWE-bench prediction
  generation, and official evaluator integration.

## Architecture

The ordinary headless repair path is:

```text
TaskSpec
  -> policy validation
  -> isolated Git worktree
  -> selected agent adapter and bounded runtime
  -> public verification
  -> hidden Oracle / assessment
  -> EvidenceBundle and patch
  -> explicit approval and guarded apply
```

The frozen SWE-bench path is:

```text
tracked manifest + operator environment
  -> src/agentpatchcheck/swebench-cli.ts
  -> APC Harness-native runtime and tooling
  -> prediction JSONL
  -> external official SWE-bench evaluator
  -> resolved / unresolved grading evidence
```

APC does not introduce a second evaluator or alternate runtime for published
benchmark results.

## What APC Implements

APC implements the bounded repair lifecycle, tool brokerage, execution and
cancellation controls, evidence model, verification and assessment gates,
risk-aware apply workflow, benchmark runner, SWE-bench adapter, dataset
preparation boundary, prediction generation, and evaluator bridge contained
under `src/agentpatchcheck/`, `scripts/`, and their tests.

## What APC Reuses

- Cline Kanban's Apache-2.0 CLI, desktop, web UI, worktree, and task-management
  foundations. The original copyright and license are retained.
- Selected DeepSeek Harness Code Mode mechanisms adapted under the MIT License.
  Details and the required notice are in `THIRD_PARTY_NOTICES.md`.
- Installed provider SDKs and CLIs through explicit adapter boundaries.
- The external official SWE-bench evaluator and upstream benchmark datasets.
  APC does not claim authorship of the evaluator and does not redistribute the
  complete benchmark datasets.

## Quick Start

### Prerequisites

- Node.js 22 or newer.
- npm 10 or newer.
- Git.
- An installed agent/provider required by the TaskSpec you choose to run.

Install the repository dependencies and build the existing CLIs:

```bash
npm run install:all
npm run build
node dist/agentpatchcheck.js --help
```

Run the smallest headless flow with a TaskSpec whose paths refer to your own
checkout and target repository:

```bash
node dist/agentpatchcheck.js run --task-spec ./path/to/task-spec.json
```

See `docs/agentpatchcheck-headless-core.md` for the TaskSpec, evidence,
assessment, approval, cleanup-preview, and guarded-apply contracts.

### Provider environment variables

Credentials are resolved at execution time from fixed logical references. Do
not store credential values in TaskSpecs, manifests, evidence, or source files.

| Logical credential reference | Environment variable |
| --- | --- |
| `openai-primary` | `OPENAI_API_KEY` |
| `openai-secondary` | `OPENAI_API_KEY_SECONDARY` |
| `deepseek-primary` | `DEEPSEEK_API_KEY` |
| `gemini-primary` | `GEMINI_API_KEY` |
| `provider-a-primary` | `AGENTPATCHCHECK_KEY_PROVIDER_A` |
| `provider-b-primary` | `AGENTPATCHCHECK_KEY_PROVIDER_B` |

Only configure the credential required by the selected TaskSpec or frozen
provider profile.

## Benchmark

HAL SWE-bench Verified Mini fixed-50:

- 35/50 official resolved (70.0%).
- 50/50 valid executions.
- 0 Harness-invalid.
- 0 grading-invalid.

This is the end-to-end result of `deepseek-v4-flash + APC Runtime/tooling +
frozen execution policy`, as judged by the official SWE-bench evaluator. It is
not a full SWE-bench Verified score, a DeepSeek model-only score, or evidence of
an independently quantified APC uplift.

### Reproducing the frozen SWE-bench path

The repository tracks portable manifests, task identities, source revisions,
and expected SHA-256 values. It intentionally does not track complete benchmark
JSONL data, evaluator source, evaluator environments, repositories, images,
predictions, logs, or scored artifacts.

1. Obtain the HAL fixed-50 source data from the upstream
   `MariusHobbhahn/swe-bench-verified-mini` test split at revision
   `b316c349947c29963fce3f4a65967c9807a4b673`. Materialize the exact 50-row
   JSONL selected by the tracked manifest at
   `.agentpatchcheck/swebench/datasets/HAL-Verified-Mini-v1.full.jsonl` and
   verify its SHA-256 against the manifest before running.
2. Clone or otherwise prepare the official SWE-bench evaluator outside this
   repository and check out frozen revision
   `7d92bde324b9b96d41fb3e5e1023c8476f17b0bf`. Use a Python environment that
   can import its Docker dependency and provide the evaluator's required Docker
   images separately.
3. In the same shell, configure the existing bootstrap variables using paths
   on your machine:

   ```powershell
   $env:DEEPSEEK_API_KEY = "<secret>"
   $env:AGENTPATCHCHECK_SWEBENCH_MANIFEST = ".agentpatchcheck/swebench/datasets/HAL-Verified-Mini-v1.manifest.json"
   $env:AGENTPATCHCHECK_SWEBENCH_EVALUATOR_ROOT = "<path-to-swe-bench-checkout>"
   $env:AGENTPATCHCHECK_SWEBENCH_EVALUATOR_PYTHON = "<path-to-evaluator-python>"
   ```

4. From the AgentPatchCheck repository root, invoke the existing source
   entrypoint for exactly one instance and a fresh run identity:

   ```powershell
   node_modules/.bin/tsx src/agentpatchcheck/swebench-cli.ts `
     --instance <instance-id-from-the-manifest> `
     --run-id <fresh-run-id>
   ```

The manifest owns the dataset, evaluator revision, model, timeout, and frozen
classification. Operator arguments cannot override those fields. Formal runs
must follow the predeclared ordering and retry policy; the command above is not
an instruction to rerun the published fixed-50 result.

## Limitations

- APC does not prove a patch correct merely because an agent finishes or emits
  a diff; correctness depends on verification and, for SWE-bench, official
  grading.
- Provider access, evaluator setup, Docker images, upstream repositories, and
  benchmark data are external prerequisites.
- The fixed-50 result measures one frozen end-to-end configuration and does not
  establish general performance, causal uplift, or state of the art.
- The desktop and web UI foundations remain inherited from Cline Kanban while
  APC's release-facing workflow is centered on the headless repair runtime.

## Project Status

AgentPatchCheck is an open-source research preview. The current release target
focuses on auditable, bounded software-repair execution and truthful benchmark
reporting. Interfaces and operational requirements may change before a stable
release.

AgentPatchCheck is distributed under the Apache License 2.0. See `LICENSE` and
`THIRD_PARTY_NOTICES.md` for retained upstream copyright and attribution.
