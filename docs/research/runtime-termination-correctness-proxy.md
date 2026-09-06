# Auditing Runtime Termination as a Resolution Proxy: A Frozen Coding-Agent Case Study

## Abstract

Runtime termination records how a coding-agent execution stopped; it does not
directly establish whether its terminal patch passes an external evaluator.
We audit a termination-only proxy in 50 canonical AgentPatchCheck runs under
one frozen configuration. The normalized grading statuses are 35 `resolved`,
10 `unresolved`, and 5 `not_run`. Among the 45 runs with binary outcomes from
the official SWE-bench evaluator, mapping `finished` to resolved and every
other termination to unresolved disagrees with the evaluator on 12/45 runs
(approximately 26.7%): three finished runs are unresolved, and nine
non-finished runs are resolved. Thus, `finished` is neither sufficient nor
necessary for evaluator-derived resolution in this sample. Terminal mutation,
observed effort, and non-resolved endpoints provide supporting context.
The contribution is a configuration-specific measurement audit, not a new
discovery of termination–outcome mismatch, a population error estimate, or
evidence of a runtime's causal advantage.

## 1. Introduction

Coding agents execute under limits on iterations, tool calls, retries, and
wall-clock duration. Their runtimes publish terminal states to record normal
completion, exhausted limits, or failures. Evaluation asks a different
question: does the terminal patch satisfy the benchmark's test oracle?
A finished run can leave an unresolved patch, while a run stopped at a limit
can already contain a patch that passes evaluation.

Prior work already reports operational endings alongside independent
resolution outcomes [3, 10]. This note studies a narrower measurement object:
the disagreements introduced by mechanically converting one runtime's typed
termination into a binary resolution prediction.

> **RQ1:** In one frozen coding-agent configuration, which and how many
> disagreements in each direction arise when `finished` predicts resolved and
> every other runtime termination predicts unresolved, relative to the binary
> outcomes of the official SWE-bench evaluator?

We study one canonical run per task in APC's frozen `HAL-Verified-Mini-v1`
manifest. The 50 runs use `deepseek-v4-flash`, the APC runtime and tooling,
and a fixed execution policy. The primary evidence is a confusion matrix over
the 45 runs with binary evaluator outcomes. The five `not_run` observations
remain visible in the full population but do not enter that matrix.

The proxy is a specified analysis rule, not a claim that APC or another
system deploys this classifier. Its 12/45 mismatch quantifies the consequence
of substituting that rule for evaluation in this sample. The contribution is
the explicit join of typed termination and evaluator-derived resolution under
a frozen configuration. Supporting observations characterize the recorded
endpoints; they do not test agent design, model capability, benchmark
difficulty, or the effect of additional resources.

## 2. Study Design and Measurement

### 2.1 Frozen configuration and canonical population

`HAL-Verified-Mini-v1` is APC's frozen 50-instance manifest derived from
`MariusHobbhahn/swe-bench-verified-mini`, as specified in the
[benchmark reproduction contract](../benchmark-reproduction.md). It is not
an official SWE-bench subset release, and the reported result is not a full
SWE-bench Verified score. The manifest contains 25 Django and 25 Sphinx
instances and records selection in source-dataset order; this is not a random
sample of repositories or coding tasks.

One canonical formal run is selected per manifest instance. Batches 1–6 and
8–10 use `hal-final-batch-*` artifacts; Batch 7 uses only
`hal-scored-batch-7-20260902-*`. The archived Batch 7 invalidation record
records an operator-reported network incident and
marks it invalidated before scoring, with `outcomeBasedRerun=NO`.
Those older artifacts remain preserved but excluded, as do mini, pilot,
probe, validation, preparation, and other non-scored artifacts. This is a
recorded operational exclusion, not selection of the better evaluator outcome.

A canonical run is the unit of analysis and can contain up to two attempts
under the frozen policy. These attempts are not independent task replications.

**Table 1. Frozen configuration and analysis populations**

| Item | Frozen value |
| --- | --- |
| Selected instances | 50 |
| Repositories | Django 25; Sphinx 25 |
| Model | `deepseek-v4-flash` |
| Iteration budget | 24 per attempt |
| Maximum attempts | 2 |
| Normal tool-call cap | 48 per attempt |
| Whole-agent timeout | 1,200,000 ms |
| Provider retry allowance | 2 |
| Concurrency | 1 |
| Valid executions | 50/50 |
| Harness-invalid | 0 |
| Grading-invalid | 0 |
| Normalized grading-status population | 35 `resolved`; 10 `unresolved`; 5 `not_run` |
| Binary resolution population | 45; excludes all 5 `not_run` |

The archived execution contract identifies APC harness revision
`49bf69fe4549c7c493dff94e98f7f4bd15c37ff8` and official evaluator revision
`7d92bde324b9b96d41fb3e5e1023c8476f17b0bf`. Results belong to this complete
configuration, not to the model alone.

### 2.2 Per-run measurements and analysis set

Let $`i`$ index the $`N=50`$ canonical runs. $`T_i`$ is run $`i`$'s final
runtime termination, with $`\mathcal{T}`$ denoting the six observed states
listed in Table 2. $`G_i`$ is its normalized grading status. We abbreviate
`resolved`, `unresolved`, and `not_run` as $`R`$, $`U`$, and $`\mathrm{NR}`$:

```math
T_i \in \mathcal{T}, \qquad
G_i \in \{R,U,\mathrm{NR}\}, \qquad i=1,\ldots,N.
```

The `finished` state records an accepted APC completion transition, not an
independent correctness certificate. We use `non-finished` to group the other
five states; it is not a native termination category.

For `resolved` and `unresolved`, the APC grading bridge normalizes the official
SWE-bench evaluator's binary result. For all five canonical `not_run` cases,
the evaluator aggregate lists the instance in `empty_patch_ids` and the bridge
records `normalizedStatus=not_run`. This denotes no binary evaluator verdict;
it is not a third official correctness class.

Define the binary analysis set and its size as:

```math
B=\{i\in\{1,\ldots,N\}:G_i\in\{R,U\}\}, \qquad n_B=|B|.
```

For $`i\in B`$, encode evaluator-derived resolution as:

```math
O_i=
\begin{cases}
1, & G_i=R,\\
0, & G_i=U.
\end{cases}
```

Here $`O_i`$ represents resolution under the SWE-bench test oracle. It is not
an absolute semantic-correctness truth label. It is undefined for `not_run`
observations. In this study, $`n_B=45`$.

### 2.3 Proxy and mismatch metric

The termination-only proxy predicts resolution exactly when the runtime
finishes:

```math
g(T_i)=
\begin{cases}
1, & T_i=\mathrm{finished},\\
0, & T_i\neq\mathrm{finished}.
\end{cases}
```

Its empirical mismatch rate on the binary analysis set is:

```math
\mathrm{Err}_B(g)=
\frac{1}{n_B}\sum_{i\in B}\mathbf{1}\{g(T_i)\neq O_i\}.
```

The indicator equals one for a disagreement and zero otherwise. We report the
two directions separately: finished but unresolved, and non-finished but
resolved. All 50 runs enter the termination-by-grading-status table; only
$`B`$ enters the confusion matrix. No hypothesis test is needed to enumerate
these disagreements in the frozen population.

Supporting observations summarize terminal mutation, observed execution
effort, and the archived taxonomy of non-resolved endpoints to contextualize
the primary result.

### 2.4 Evidence provenance and public availability

The analysis uses retained per-run terminal artifacts, evaluator outputs, and
the fixed-50 aggregate and taxonomy records. The archived manifest identifies
source revision `b316c349947c29963fce3f4a65967c9807a4b673` and the selected
`HAL-Verified-Mini-v1.full.jsonl` SHA-256:
`8095237e52344cebede1e03c10c93d171c6f7749368a79e04814dede2076bac0`.
The exclusion described above is recorded in
`HAL-Verified-Mini-v1-batch-7-invalidation-20260902.json`.

The reproduction contract documents execution requirements. The public
repository does not include the frozen manifest, complete per-run records, or
the analysis materials needed to regenerate every table in this note.
The identifiers specify which retained evidence was used; they do not make
that evidence publicly inspectable. Consequently, readers can inspect the
reported cross-tabulations and measurement definitions, but cannot fully
reproduce the analysis from this repository alone.

No experiment, evaluator invocation, or outcome was added or changed for
this analysis.

## 3. Primary Analysis: Termination vs. Evaluator-Derived Resolution

Table 2 preserves the full population and all observed termination states.
Several states span multiple grading statuses; `not_run` remains distinct
from an unresolved evaluator outcome.

**Table 2. Typed runtime termination by normalized grading status**

| Runtime termination | Resolved | Unresolved | Not run | Total |
| --- | ---: | ---: | ---: | ---: |
| `finished` | 26 | 3 | 0 | 29 |
| `iteration-limit` | 7 | 4 | 2 | 13 |
| `tool-limit` | 1 | 1 | 1 | 3 |
| `timeout` | 0 | 2 | 0 | 2 |
| `model-failed` | 1 | 0 | 1 | 2 |
| `rejected-tool-limit` | 0 | 0 | 1 | 1 |
| **Total** | **35** | **10** | **5** | **50** |

Table 3 is the primary result. It applies the specified proxy to the 45 runs
with binary evaluator outcomes.

**Table 3. Confusion matrix for the termination-only proxy**

| Proxy prediction (termination group) | Evaluator resolved | Evaluator unresolved | Total |
| --- | ---: | ---: | ---: |
| Resolved (`finished`) | 26 | 3 | 29 |
| Unresolved (`non-finished`) | 9 | 7 | 16 |
| **Total** | **35** | **10** | **45** |

The proxy agrees with the evaluator on 33/45 observations and disagrees on
12/45:

```math
\mathrm{Err}_B(g)=\frac{3+9}{45}=\frac{12}{45}\approx26.7\%.
```

- **Finished but unresolved:** three observations, comprising 3/29 finished
  runs and 3/10 unresolved runs.
- **Non-finished but resolved:** nine observations, comprising 9/16
  non-finished graded runs and 9/35 resolved runs.

**RQ1 answer.** The specified proxy produces errors in both directions.
The `finished` state is neither sufficient nor necessary for evaluator-derived
resolution in this sample. The larger error count in the non-finished
direction describes this configuration and outcome distribution; it is not a
population estimate or evidence that termination causes resolution.

Table 4 includes all three finished-but-unresolved observations and one
resolved example for each non-finished termination type represented among
resolved runs. This selection illustrates the observed combinations, not their
prevalence beyond Table 3.

**Table 4. Instances illustrating both disagreement directions**

| Instance | Termination | Evaluator outcome | Recorded evidence |
| --- | --- | --- | --- |
| `django__django-11848` | `finished` | `unresolved` | Both official HTTP-date FAIL_TO_PASS tests failed |
| `django__django-12325` | `finished` | `unresolved` | A narrow reproduction passed, but two official parent-link cases failed |
| `django__django-12774` | `finished` | `unresolved` | A targeted test passed, but two PASS_TO_PASS tests regressed |
| `django__django-11815` | `iteration-limit` | `resolved` | An iteration-bound endpoint co-occurred with an evaluator-resolved terminal patch |
| `sphinx-doc__sphinx-8035` | `tool-limit` | `resolved` | A tool-bound endpoint co-occurred with an evaluator-resolved terminal patch |
| `sphinx-doc__sphinx-9320` | `model-failed` | `resolved` | A model-failure endpoint co-occurred with an evaluator-resolved terminal patch |

The last three records establish co-occurrence only. They do not establish
when the patch became resolvable or whether the terminal event affected it.

## 4. Supporting Observations

### 4.1 Terminal mutation

`mutationOccurred` records a non-empty terminal repository diff, not patch
relevance, intermediate edits, or edits later reverted. Across all 50 runs,
45 have `mutationOccurred=true`: 35 are resolved and 10 unresolved. The
remaining five have `mutationOccurred=false` and are all `not_run`.

All resolved observations have terminal mutation, but mutation is constant
throughout the binary subset. Its alignment with binary-outcome availability
also reflects the empty-patch handling of the grading bridge. This supporting
observation provides no within-subset discrimination and is not evidence of
an independently discovered necessary mechanism for resolution.

### 4.2 Observed execution effort

Table 5 retains descriptive summaries for the binary subset. Each entry is
the median followed by $`[Q_1,Q_3]`$, where $`Q_1`$ and $`Q_3`$ are the first
and third quartiles. Iterations and calls are summed across attempts; agent
runtime is recorded execution wall time, excluding environment preparation
and official grading.

**Table 5. Observed effort in the 45-run binary subset**

| Measure | Resolved, n=35 | Unresolved, n=10 |
| --- | ---: | ---: |
| Iterations | 41 [36, 47] | 46.5 [42.5, 48] |
| Normal tool calls | 60 [48, 69] | 71 [62.25, 75] |
| Model calls | 42 [37, 48.5] | 48.5 [43.25, 50.5] |
| Agent runtime, ms | 491,627 [359,059, 631,032] | 553,445 [429,823, 1,032,668] |

Unresolved runs have higher observed medians on these measures. Actual
consumption up to termination is observed and bounded by policy; any further
trajectory under a larger budget is unobserved. Task characteristics and
progress can affect both effort and resolution, and some counts directly
determine termination. These summaries contextualize execution endpoints
without estimating whether additional resources would improve outcomes.

### 4.3 Non-resolved endpoint profile

The archived primary taxonomy covers 15 non-resolved observations: 10
`unresolved` and 5 `not_run`. Eleven are labeled `budget-limited`, three
`incorrect / incomplete fix`, and one `provider / network failure`
(73.3%, 20.0%, and 6.7%, respectively). This outcome-conditioned profile is
not a symmetric comparison with resolved runs.

Here `budget-limited` means a **budget-bound terminal observation**. Of those
11 runs, seven end with mutation and a non-empty patch; four end without
mutation and with an empty patch. The concentration is operationally
meaningful: 11 of the 15 non-resolved observations terminate at recorded
resource boundaries, making execution-budget pressure the dominant endpoint
pattern in this subset under the frozen execution policy. The two `timeout`
cases, both `unresolved`, are direct wall-clock budget-exhaustion observations.
Termination reasons such as `iteration-limit`, `tool-limit`, and `timeout`
therefore provide diagnostic signals of resource pressure. These observations
motivate budget-sensitivity analysis, but the frozen runs do not identify the
counterfactual outcome under a larger budget or establish that insufficient
budget caused the non-resolved outcomes.

The three incorrect or incomplete fixes are the finished-but-unresolved
cases in Table 4. The remaining umbrella-labeled `provider / network failure`
case records exhaustion of recovery from a malformed provider response,
followed by no terminal mutation and `not_run`. Its direct evidence supports
a **provider malformed-response case**, not a network transport diagnosis.

## 5. Discussion

The reporting implication is to retain operational termination and
evaluator-derived resolution as separate variables. A termination-only report
using the audited mapping would accept three unresolved patches and reject
nine evaluator-resolved patches. When a binary outcome is unavailable, that
absence should remain explicit rather than be filled from termination.

This does not make termination uninformative: 26/29 finished runs are resolved.
The claim is about substituting a particular proxy for an evaluator verdict,
not about the absence of association or the best achievable predictor.
Termination reasons can therefore remain diagnostically useful even when
they cannot substitute for evaluator-derived resolution.

Three levels of interpretation should remain distinct. Termination describes
the operational endpoint. Resolution records satisfaction of the evaluator's
test oracle. A causal explanation of an outcome would require evidence beyond
their co-occurrence. The case records and supporting observations illuminate
the first two levels but cannot establish that a limit caused failure, that a
model failure changed patch quality, or that APC improved resolution relative
to another runtime.

## 6. Related Work

SWE-bench establishes test-based repository-level issue evaluation [1], and
SWE-bench Verified adds expert validation [2]. This note uses an APC-frozen
manifest and the official evaluator; it proposes neither a new benchmark nor
a new correctness oracle.

The closest overlap is operational endings cross-tabulated with outcomes.
SWE-agent reports submission and cost exits alongside resolution, including
mismatches in both directions [3, Table 13]. SWE-bench Multimodal also analyzes
success together with exit status [10, Figures 3 and 8]. Thus, the basic
termination–outcome distinction and its bidirectionality are established
prior art.

SHEPHERD's false termination is a trajectory diagnosis, distinct from APC's
typed lifecycle state [4]. SWE-EVAL studies trajectory efficiency, logical
consistency, and tool utilization [5]. The cited versions of both are
anonymous ICLR 2026 OpenReview manuscripts. Failure as a Process [6] and APR
traceability [7] analyze execution processes; trajectory-aware evaluation [8]
uses trajectory evidence for efficient benchmarking. Outside issue repair,
AnalysisBench distinguishes self-validated completion from manually verified
success [9]. We cite the July 2026 v1 of [6], September 2026 v1 of [8], and
July 2026 v3 of [9].

The incremental contribution is the explicit audit of a specified
termination-only rule across six APC endpoint types, retaining missing binary
verdicts separately and enumerating both error directions in one frozen
configuration. It neither discovers mismatch as a phenomenon nor establishes
a general theory of coding-agent completion.

## 7. Scope and Threats to Validity

**Measurement.** Evaluator-derived resolution is bounded by the SWE-bench
test oracle and does not prove full semantic correctness. APC's `finished`
state is runtime-specific, and terminal mutation omits intermediate activity.
Empty-patch handling makes the binary analysis conditional on verdict
availability; its 45-run denominator does not describe all 50 outcomes.
Complete token usage exists for only 15/50 runs, and structured agent-side
verification is unavailable for all 50, limiting investigation of what agents
checked before terminating.

**Selection and reproducibility.** The sample contains only Django and
Sphinx tasks under one runtime, model, and frozen policy. The canonical rule
excludes the operator-invalidated Batch 7 executions; the stated operational
rationale does not establish that such exclusions are statistically neutral.
One canonical run per task cannot measure run-to-run stochasticity. There are
no repeated-run comparisons, runtime comparators, or ablations. The public
evidence gap in §2.4 also limits independent verification of run selection,
case interpretations, and descriptive summaries.

**Interpretation and statistical scope.** The binary set is imbalanced
(35 resolved, 10 unresolved), and several typed-termination cells contain only
one or two observations. The 26.7% mismatch is an empirical proportion for
this set and rule, not a generalization to coding agents. Policy-bounded effort
is observed up to termination; unobserved continuations cannot establish an
effect of additional resources. Outcome-conditioned endpoint labels and
constant mutation within the binary subset likewise do not identify causal
mechanisms or general predictive relationships.

## 8. Conclusion

For one frozen 50-run configuration, the termination-only proxy disagrees
with the official SWE-bench evaluator on 12/45 binary outcomes
(approximately 26.7%): three finished runs are unresolved and nine
non-finished runs are resolved. This supports a specific reporting practice:
preserve termination and evaluator-derived resolution separately, including
explicit absence of a binary verdict. Supporting observations describe the
recorded endpoints; they do not establish causal failure mechanisms, a runtime
advantage, or a mismatch rate beyond this configuration.

## References

[1] C. E. Jimenez, J. Yang, A. Wettig, S. Yao, K. Pei, O. Press, and K. Narasimhan. “SWE-bench: Can Language Models Resolve Real-World GitHub Issues?” In *Proceedings of the Twelfth International Conference on Learning Representations (ICLR)*, 2024. https://proceedings.iclr.cc/paper_files/paper/2024/hash/edac78c3e300629acfe6cbe9ca88fb84-Abstract-Conference.html

[2] OpenAI. “Introducing SWE-bench Verified.” Official benchmark report and release announcement, 2024. https://openai.com/index/introducing-swe-bench-verified/

[3] J. Yang, C. E. Jimenez, A. Wettig, K. Lieret, S. Yao, K. Narasimhan, and O. Press. “SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering.” In *Advances in Neural Information Processing Systems 37 (NeurIPS 2024)*, pp. 50528–50652, 2024. https://proceedings.neurips.cc/paper_files/paper/2024/hash/5a7c947568c1b1328ccc5230172e1e7c-Abstract-Conference.html

[4] Anonymous. “SHEPHERD: Pattern-Guided Trajectory Selection for Coding Agents on SWE-bench.” Anonymous manuscript submitted to ICLR 2026, OpenReview ID `ZBOFr4ryBk`, 2026. https://openreview.net/pdf?id=ZBOFr4ryBk

[5] Anonymous. “SWE-EVAL: Trajectory-Enhanced Evaluation for Agentic Issue Resolution.” Anonymous manuscript submitted to ICLR 2026, OpenReview ID `aPeeUApKtW`, 2026. https://openreview.net/pdf?id=aPeeUApKtW

[6] X. Zhao, H. Li, S. Li, T. Zhao, E. T. Barr, F. Sarro, and H. Ye. “Failure as a Process: An Anatomy of CLI Coding Agent Trajectories.” *arXiv preprint arXiv:2607.09510v1*, July 2026. https://arxiv.org/abs/2607.09510v1

[7] I. Ceka, H. Mitchell, S. Pujar, L. Buratti, S. Ramji, J. Yang, G. Kaiser, and B. Ray. “Understanding Automated Program Repair Agents Through the Lens of Traceability: An Empirical Study.” Accepted for publication at the *International Symposium on Software Testing and Analysis (ISSTA 2026)*, 2026; originally posted as arXiv:2506.08311 in 2025. https://arxiv.org/abs/2506.08311

[8] K. Duan, D. Zheng, Y. Wang, X. Wang, E. Shi, X. Liu, Y. Ma, J. Chen, M. Liu, and Z. Zheng. “Efficient SWE Agent Benchmarking via Trajectory-Aware Evaluation.” *arXiv preprint arXiv:2609.01603v1*, September 2026. https://arxiv.org/abs/2609.01603v1

[9] I. Bouzenia, C. Cadar, and M. Pradel. “Evaluating LLM Agents on Automated Software Analysis Tasks.” *arXiv preprint arXiv:2604.11270v3*, July 2026. https://arxiv.org/abs/2604.11270v3

[10] J. Yang, C. E. Jimenez, A. L. Zhang, K. Lieret, J. Yang, X. Wu, O. Press, N. Muennighoff, G. Synnaeve, K. R. Narasimhan, D. Yang, S. I. Wang, and O. Press. “SWE-bench Multimodal: Do AI Systems Generalize to Visual Software Domains?” Cited version: *arXiv manuscript arXiv:2410.03859v1*, October 2024. https://arxiv.org/abs/2410.03859v1
