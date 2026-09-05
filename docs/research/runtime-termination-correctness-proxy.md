# Auditing Runtime Termination as a Correctness Proxy for Coding Agents: A Frozen SWE-bench Verified Mini Case Study

## Abstract

Coding-agent runtimes record how bounded executions end—for example, through
normal completion, iteration or tool limits, timeouts, and model failures.
These operational states do not directly establish whether the terminal patch
is correct. We audit typed runtime termination as a correctness proxy using 50
canonical AgentPatchCheck runs from a frozen HAL SWE-bench Verified Mini
configuration. The full normalized grading-status population contains 35
`resolved`, 10 `unresolved`, and 5 `not_run` instances. Binary correctness
analysis is restricted to the 45 instances for which the official evaluator
produced `resolved` or `unresolved`.

We evaluate the mechanical proxy `finished → resolved` and
`non-finished → unresolved`. The resulting confusion matrix contains 26
finished-and-resolved, 3 finished-but-unresolved, 9 non-finished-but-resolved,
and 7 non-finished-and-unresolved runs. The proxy therefore misclassifies 12
of 45 graded instances, or 26.7%, with errors in both directions. Supporting
analyses show that terminal mutation has no discriminating variation within
the binary subset because all 45 graded runs end with a non-empty diff.
Unresolved runs also exhibit higher observed medians for iterations, tool
calls, and model calls, although these variables are bounded and confounded by
the frozen termination policy. Among the 15 non-resolved observations, 11 end
at a budget boundary; this is an operational classification, not evidence that
insufficient budget caused the outcome.

The contribution is an artifact-grounded audit of typed operational
termination as a correctness proxy under one frozen configuration. It is
neither a claim of first discovery nor an estimate of termination–correctness
mismatch across coding agents generally.

## 1. Introduction

Coding agents operate under finite execution contracts. A runtime may bound
iterations, tool calls, retries, or wall-clock duration and must eventually
publish a terminal state. Such states are useful operational telemetry: they
indicate whether the agent completed normally, exhausted a limit, timed out, or
encountered a model failure. They do not, by themselves, establish whether the
terminal repository state satisfies an external correctness criterion.

This distinction matters in evaluation. A run recorded as `finished` can
contain an incomplete or regressive patch. Conversely, a run stopped by an
iteration or tool boundary can already contain a patch that passes an
independent evaluator. Reducing these states to a binary success label can
therefore produce two errors: accepting a finished but incorrect patch and
rejecting a non-finished but correct patch.

These phenomena are not new. SWE-agent reports episode endings such as
submission and cost exits alongside independent SWE-bench outcomes, including
both submitted-but-unresolved and cost-ended-but-resolved episodes [3].
SHEPHERD identifies false termination as a coding-agent trajectory pattern
[4], while other work distinguishes trajectory quality or self-validated
completion from external outcomes. The present study asks a narrower
measurement question: when one frozen runtime exposes several typed
termination reasons, what errors result from mechanically using those reasons
as a binary correctness proxy?

We study 50 canonical AgentPatchCheck runs on HAL SWE-bench Verified Mini. The
frozen end-to-end configuration consists of `deepseek-v4-flash`, the APC Agent
Runtime and tooling, a fixed execution policy, and an independent official
SWE-bench evaluator. All 50 runs are execution-valid; none is Harness-invalid
or grading-invalid. Their normalized grading statuses are 35 `resolved`, 10
`unresolved`, and 5 `not_run`. The first two are official evaluator-derived
binary outcomes; `not_run` records an empty-patch evaluation for which no
binary official correctness verdict was produced.

Our primary research question is:

> **RQ1:** In one frozen bounded coding-agent configuration, what mismatch is
> observed when typed runtime termination is reduced to a binary correctness
> proxy and compared with independent official correctness?

We preserve the six observed runtime termination states and the full
three-class normalized grading status. We then audit a deliberately simple
binary mapping: `finished` predicts `resolved`, while every other termination
predicts `unresolved`. Only the 45 runs with binary official outcomes enter
this confusion matrix; all five `not_run` observations remain outside binary
correctness.

The primary result is a 12/45, or 26.7%, proxy error. Three runs are finished
but unresolved, while nine are non-finished but resolved. Within this sample,
`finished` is therefore neither sufficient nor necessary for official
correctness.

Three supporting analyses provide context without serving as independent
headline contributions. We examine terminal mutation as another operational
signal, compare execution-effort distributions descriptively, and summarize
the canonical taxonomy of the 15 non-resolved observations. None identifies a
causal mechanism.

The contribution of this note is an artifact-grounded measurement audit that
joins typed operational termination telemetry with independent evaluator
evidence and makes the resulting proxy errors explicit. It does not claim that
AgentPatchCheck first revealed termination–outcome mismatch, that 26.7% is a
population rate, or that APC improves correctness relative to another runtime.

## 2. Background and Measurement Model

We distinguish five measurement components.

### Runtime termination

Runtime termination (T) records how the bounded APC lifecycle ended:

\[
T \in \{\texttt{finished},\texttt{iteration-limit},\texttt{tool-limit},
\texttt{timeout},\texttt{model-failed},\texttt{rejected-tool-limit}\}.
\]

These are operational states. In particular, `finished` records an accepted
runtime completion transition. It is not an independent correctness
certificate.

We use `non-finished` only as an analytical grouping comprising the other five
terminal states. It is not an additional native APC termination category.

### Normalized grading status and official correctness

The APC grading bridge records a three-class normalized grading status:

\[
G_3 \in \{\texttt{resolved},\texttt{unresolved},\texttt{not\_run}\}.
\]

For `resolved` and `unresolved`, the bridge normalizes the binary result
produced by the official SWE-bench evaluator. For the five canonical
`not_run` cases, the official evaluator aggregate places the instance in
`empty_patch_ids`, and the bridge records `normalizedStatus=not_run`.
Therefore, `not_run` denotes the absence of a binary official correctness
verdict; it is not a third official correctness class.

Binary official correctness (O_2) is defined only for the 45 runs whose
normalized grading status is `resolved` or `unresolved`.

### Termination-based correctness proxy

We audit the mapping:

\[
g(T)=
\begin{cases}
\texttt{resolved}, & T=\texttt{finished},\\
\texttt{unresolved}, & T\neq\texttt{finished}.
\end{cases}
\]

This mapping is an analysis construct. It is not an APC evaluator, an agent
confidence score, or a guarantee made by the runtime.

### Terminal mutation

`mutationOccurred` indicates whether the terminal artifact contains a non-empty
repository diff. It does not measure patch relevance, semantic correctness,
intermediate edits, or edits that were later reverted.

### Execution effort and non-resolved taxonomy

Execution effort comprises attempts, cross-attempt iterations, normal tool
calls, model calls, agent execution wall time, and terminal changed-file count.
These variables are bounded by the frozen policy. Some are consequently
right-censored when execution reaches a limit.

The canonical primary taxonomy is defined only for the 15 non-resolved
observations: the 10 `unresolved` and 5 `not_run` runs. The label
`budget-limited` is interpreted throughout this note as a **budget-bound
terminal observation**—a record that execution ended at a frozen boundary. It
is not a diagnosis that insufficient budget caused a run's grading status.

Termination and official correctness are thus modeled as separate axes: they
are produced by different mechanisms and admit discordant observed
combinations. This does not imply statistical independence.

## 3. Study Design

### 3.1 Frozen configuration and canonical population

The study population consists of 50 instances from the frozen
`HAL-Verified-Mini-v1` manifest: 25 Django and 25 Sphinx instances. One
canonical formal run is selected per instance. Batches 1–6 and 8–10 use their
`hal-final-batch-*` artifacts. Batch 7 uses only
`hal-scored-batch-7-20260902-*`; its older invalidated runs remain preserved
but are excluded. Mini, pilot, probe, validation, preparation, and other
non-scored artifacts are also excluded.

**Table 1. Frozen configuration and analysis populations**

| Item | Frozen value |
| --- | ---: |
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
| Binary correctness population | 45; excludes all 5 `not_run` |

The score is attributed only to this frozen end-to-end configuration. It is not
a model-only score or an estimate of APC’s causal contribution.

### 3.2 Analysis

RQ1 reports exact termination-by-normalized-status counts over all 50 runs. The
binary confusion matrix includes only the 45 `resolved` or `unresolved` runs.
Proxy error is defined as:

\[
\operatorname{Error}(g)=
\frac{\#(\texttt{finished},\texttt{unresolved})+
\#(\texttt{non\mbox{-}finished},\texttt{resolved})}{45}.
\]

Cramér’s (V) is retained as a descriptive association measure. Sparse
typed-termination cells make exact counts more informative than asymptotic
significance tests.

RQ2 cross-tabulates terminal mutation with the three-class normalized grading
status. No association statistic is estimated for the binary subset because
mutation is constant across all 45 runs.

RQ3 reports medians, interquartile ranges, Cliff’s delta, and exploratory
two-sided Mann–Whitney comparisons. Positive Cliff’s delta denotes larger
values among unresolved runs. These comparisons are not interpreted causally.

RQ4 summarizes the canonical primary taxonomy for all 15 non-resolved
observations. Because that taxonomy is outcome-dependent, it is not compared
symmetrically with the resolved population.

No run, evaluator invocation, artifact, policy, denominator, or outcome was
added or changed for this study.

## 4. Results

### 4.1 RQ1: Termination vs. Official Correctness

Table 2 retains all typed runtime terminal states and all normalized
grading-status classes.

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

Several terminal states span multiple normalized grading statuses. `finished`
contains both resolved and unresolved runs. `iteration-limit` and
`tool-limit` span all three classes, while `model-failed` contains one resolved
and one `not_run` observation. The single `rejected-tool-limit` case is
`not_run`; one observation cannot support a category-level correctness claim.

Table 3 audits the binary proxy after excluding all five `not_run` observations.

**Table 3. Confusion matrix for `finished → resolved`, `non-finished → unresolved`**

| Termination-based prediction | Officially resolved | Officially unresolved | Total |
| --- | ---: | ---: | ---: |
| `finished` | 26 | 3 | 29 |
| `non-finished` | 9 | 7 | 16 |
| **Total** | **35** | **10** | **45** |

The proxy correctly classifies 33/45 observations and misclassifies 12/45:

\[
\operatorname{Error}(g)=\frac{3+9}{45}=\frac{12}{45}=26.7\%.
\]

Both directions contribute:

- Three finished runs are officially unresolved. These constitute 3/29
  finished runs and 3/10 unresolved runs.
- Nine non-finished runs are officially resolved. These constitute 9/16
  non-finished graded runs and 9/35 resolved runs.

Accordingly, `finished` is neither a sufficient nor a necessary condition for
official correctness in this sample. Most observed proxy errors are in the
non-finished-but-resolved direction, but this asymmetry is configuration-
specific.

The collapsed binary table has Cramér’s (V=0.385). Retaining the five typed
terminal states present among the 45 graded runs yields (V=0.512). These
values describe association; they neither validate the proxy nor identify an
effect of termination on correctness.

**Table 4. Representative termination–correctness mismatches**

| Mismatch direction | Instance | Runtime termination | Official outcome | Terminal mutation | Evidence-bound interpretation |
| --- | --- | --- | --- | ---: | --- |
| Finished but unresolved | `django__django-11848` | `finished` | `unresolved` | true | Both official HTTP-date FAIL_TO_PASS tests failed |
| Finished but unresolved | `django__django-12325` | `finished` | `unresolved` | true | A narrow reproduction passed, but two official parent-link cases failed |
| Finished but unresolved | `django__django-12774` | `finished` | `unresolved` | true | A targeted test passed, but two PASS_TO_PASS tests regressed |
| Non-finished but resolved | `django__django-11815` | `iteration-limit` | `resolved` | true | This iteration-bound terminal state co-occurred with a resolved terminal patch |
| Non-finished but resolved | `sphinx-doc__sphinx-8035` | `tool-limit` | `resolved` | true | This tool-bound terminal state co-occurred with a resolved terminal patch |
| Non-finished but resolved | `sphinx-doc__sphinx-9320` | `model-failed` | `resolved` | true | A model-failure terminal state co-occurred with a resolved terminal patch |

The latter three cases establish only the observed terminal state and official
outcome. They do not establish why the patch was correct or whether the
terminal event affected it.

**RQ1 answer.** In this frozen configuration, runtime termination and official
correctness are not interchangeable. The specified termination-only proxy
misclassifies 12/45 graded instances, or 26.7%, with three finished-but-
unresolved and nine non-finished-but-resolved observations.

### 4.2 RQ2: Terminal Mutation

Across the full population, 45 runs have `mutationOccurred=true`: 35 are
`resolved` and 10 are `unresolved`. The remaining five runs have
`mutationOccurred=false`, and all five are `not_run`.

Terminal mutation is therefore an observed necessary condition for a resolved
outcome in this sample, but it is not sufficient: ten mutated runs remain
unresolved. Within the N=45 binary subset, mutation is constant across both
outcome groups. The data consequently contain no variation from which to
estimate mutation’s discriminating association with official correctness.

**RQ2 answer.** Terminal mutation separates patch-producing from empty-patch
observations in the full population but does not distinguish resolved from
unresolved runs within the graded subset. This is a sample-specific boundary
result, not a general claim about mutation in coding agents.

### 4.3 RQ3: Execution Effort

Table 5 reports execution-effort summaries for the binary population. Values
are median \([Q_1,Q_3]\); positive Cliff’s delta indicates larger values among
unresolved runs.

**Table 5. Execution effort in the 45-run binary subset**

| Measure | Resolved, n=35 | Unresolved, n=10 | Cliff’s δ | Exploratory MW p |
| --- | ---: | ---: | ---: | ---: |
| Attempts | 2 [2, 2] | 2 [2, 2] | 0.100 | 0.483 |
| Iterations | 41 [36, 47] | 46.5 [42.5, 48] | 0.366 | 0.080 |
| Normal tool calls | 60 [48, 69] | 71 [62.25, 75] | 0.369 | 0.080 |
| Model calls | 42 [37, 48.5] | 48.5 [43.25, 50.5] | 0.366 | 0.083 |
| Agent runtime, ms | 491,627 [359,059, 631,032] | 553,445 [429,823, 1,032,668] | 0.234 | 0.269 |
| Changed-file count | 2 [1, 3] | 2 [1.25, 2] | −0.077 | 0.710 |

Unresolved runs have higher observed medians for iterations, normal tool calls,
model calls, and agent runtime. The rank-based differences are largest for
iterations, tool calls, and model calls. Attempts and changed-file count do not
show corresponding median differences.

These measurements are bounded and confounded. Iterations and calls
accumulate until completion or termination, so observations near a limit are
right-censored. Task difficulty and trajectory progress may influence both
effort and official correctness. Termination is also mechanically related to
some accumulated counts. The Mann–Whitney comparisons are therefore
exploratory summaries rather than confirmatory evidence of an effort effect.

**RQ3 answer.** Unresolved runs exhibit higher descriptive execution effort on
several measures, but the data do not show that additional iterations, calls,
or runtime reduce correctness or cause failure.

### 4.4 RQ4: Non-resolved Failure Patterns

The canonical primary taxonomy covers 15 non-resolved observations: 10
`unresolved` and 5 `not_run`. Eleven are labeled `budget-limited`, three
`incorrect / incomplete fix`, and one `provider / network failure`, corresponding
to 73.3%, 20.0%, and 6.7%.

The 11 `budget-limited` cases are interpreted here as budget-bound terminal
observations. Seven end with terminal mutation and a non-empty patch; four end
without terminal mutation and with an empty patch. This heterogeneity prevents
treating the category as a single patch-quality mechanism. It also provides no
evidence that additional budget would have produced a resolved outcome.

The three incorrect or incomplete fixes are the three finished-but-unresolved
cases in Table 4. Their official evidence includes unmet target tests or
regressions despite narrower local checks. They demonstrate that normal runtime
completion did not guarantee official correctness, but three observations do
not establish a systemic completion-detection defect.

The remaining case carries the canonical umbrella label `provider / network
failure`. The direct record establishes exhaustion of recovery from a malformed
provider response, followed by no terminal mutation and a `not_run` normalized
grading status. It does not establish a network transport failure.
Accordingly, this note refers to it as a **provider malformed-response case**
and does not attribute it to network connectivity.

**RQ4 answer.** The non-resolved population is dominated by budget-bound
terminal observations, followed by three finished but incorrect or incomplete
patches and one provider malformed-response case. These categories describe
the observed endpoints and evidence; they do not identify causal failure
mechanisms.

## 5. Discussion

The main result is a measurement result rather than an agent-design result.
Runtime termination answers how execution stopped under a bounded lifecycle.
Official correctness answers whether the terminal patch satisfied an
independent evaluator. Collapsing these questions into one binary variable
loses information in both directions.

The three finished-but-unresolved cases show why `finished` cannot serve as a
correctness certificate. Nevertheless, 26/29 finished graded runs are
resolved, so the result does not imply that `finished` is uninformative. It
establishes that the state is insufficient on its own.

The nine non-finished-but-resolved cases expose the complementary error. A
resolved terminal patch can coexist with an iteration limit, tool limit, or
model failure. A termination-only report that treats every non-finished state
as incorrect would discard those verified successes. In this sample, the proxy
therefore both accepts three unresolved runs and rejects nine resolved runs.

The appropriate reporting implication is to preserve typed runtime termination
and external grading status as separate variables. Termination remains valuable
for lifecycle diagnosis, resource accounting, and trajectory analysis. When
binary correctness is unavailable, the grading status should remain `not_run`
or correctness should remain unknown instead of being inferred from
termination.

The supporting analyses reinforce this boundary. Terminal mutation
distinguishes terminal non-empty diffs from empty-patch observations, but it
cannot discriminate official correctness within the graded subset. Higher
observed effort among unresolved runs can guide qualitative inspection, but
censoring and confounding preclude causal interpretation. Similarly, a
budget-bound terminal observation identifies where the frozen execution
stopped, not why its outcome was non-resolved.

## 6. Related Work

### Coding-agent benchmarks and operational endings

SWE-bench introduced repository-level issue resolution evaluated through
executable tests [1]. SWE-bench Verified later refined the benchmark through
expert validation [2]. The present study uses a frozen 50-instance subset and
an official evaluator-derived binary outcome where available, but it does not
propose a new benchmark.

SWE-agent, published at NeurIPS 2024, reports operational episode endings—
including submission and cost exits—alongside SWE-bench resolution outcomes
[3]. Its results already include both submitted-but-unresolved and
cost-ended-but-resolved episodes. The bidirectional mismatch observed here is
therefore prior-art overlap, not a first discovery.

### False termination and trajectory failure analysis

SHEPHERD identifies false termination as a trajectory pattern in which an
agent finishes without adequate checking [4]. As of this artifact, it is an
anonymous ICLR 2026 OpenReview submission, not a formally published paper.
False termination is related to finished-but-unresolved observations but is
conceptually different from APC’s system-recorded terminal telemetry: the
former is a semantic trajectory diagnosis, while the latter is an operational
endpoint used in a specified proxy mapping.

Zhao et al.’s *Failure as a Process* studies the onset, evolution, observability,
and recovery of failures across CLI coding-agent trajectories [6]. It is
currently an arXiv preprint. Its process-oriented taxonomy complements the
present endpoint audit but does not make a typed termination-only confusion
matrix its central measurement object.

### Process evaluation versus outcome evaluation

The anonymous SWE-EVAL ICLR 2026 submission evaluates trajectory efficiency,
logical consistency, and tool utilization across issue-resolution agents [5].
It supplements outcome evaluation with process measures, but termination-reason
mismatch is not its primary target.

Ceka et al., accepted to ISSTA 2026, study automated program-repair agents
through execution traceability, test generation, workflow structure, and patch
behavior [7]. Duan et al. use trajectory information as privileged evidence
for efficient SWE-agent benchmarking [8]; that work is currently an
under-review arXiv preprint. Both reinforce the value of retaining process
information beyond final outcomes, while addressing different research
questions.

Outside issue repair, Bouzenia et al.’s AnalysisBench study distinguishes agent
self-validated completion from manually verified success and reports
substantial disagreement between them [9]. It is currently an arXiv preprint.
Its self-validation construct is related to, but not identical with, APC’s
typed runtime termination.

Against this literature, APC’s incremental contribution is narrow: it joins
six typed operational termination reasons with an APC-normalized grading status
derived from official evaluator artifacts and explicitly audits the errors of a
termination-only binary proxy on the 45 runs with official `resolved` or
`unresolved` outcomes. It does not introduce termination–outcome mismatch as a
phenomenon or establish a general theory of coding-agent completion.

## 7. Threats to Validity

### Construct validity

`Finished` is an APC runtime state, not a universal definition of agent
completion, calibrated confidence, or successful verification. Similarly,
`mutationOccurred` indicates only a terminal non-empty diff. It does not
measure semantic relevance, patch quality, or intermediate repository changes.

Agent runtime covers the execution wall duration recorded in the run artifact;
it does not include a uniformly comparable environment-setup or official-
grading duration. Complete token usage exists for only 15/50 observations and
is excluded. Structured agent-side verification is unavailable for all 50
observations and therefore cannot be analyzed.

The five `not_run` observations have no binary official correctness label.
Treating them as unresolved would change the outcome construct and the
denominator. The failure taxonomy is also outcome-dependent because it is
defined only for the 15 non-resolved runs.

### Internal validity

This is an observational analysis. Task characteristics, trajectory behavior,
accumulated effort, termination, and official correctness may be mutually
related. The data do not isolate termination or resource use as causal
variables.

Iterations, tool calls, and model calls are affected by the frozen policy.
Limit-terminated observations are right-censored because their unconstrained
trajectories are unobserved. Termination also directly depends on some
accumulated counts, confounding effort comparisons.

Each instance has one canonical formal run. Run-to-run stochasticity cannot be
estimated. No controlled runtime comparator or ablation is present, so the
study cannot attribute a correctness improvement to APC, its runtime, tooling,
or any component.

### External validity

The dataset contains 50 instances drawn only from Django and Sphinx and uses
one runtime, model, scaffolding configuration, and budget policy. It is not a
random sample of coding agents, repositories, or software-engineering tasks.

Termination vocabularies may differ across systems. APC’s typed states cannot
be assumed equivalent to similarly named states elsewhere without semantic
alignment. The 26.7% error is specific to this sample and proxy mapping and is
not a population mismatch estimate.

### Statistical conclusion validity

The binary population includes 35 resolved but only 10 unresolved runs.
Several typed-termination cells contain one or two observations. Exact counts
and the confusion matrix are therefore more reliable as primary evidence than
asymptotic significance claims.

The effort analysis covers six related variables and is exploratory.
Mann–Whitney tests and Cliff’s delta do not remove right censoring, ties,
outcome imbalance, or termination confounding. No causal or confirmatory
conclusion is drawn from their values.

Mutation has zero variance within the binary subset. This prevents estimation
of a mutation–correctness association; it does not establish a universal null
relationship. Repository results—17/25 resolved for Django and 18/25 for
Sphinx—are descriptive checks and do not establish relative difficulty or
capability.

## 8. Conclusion

We audited typed runtime termination as a binary correctness proxy in one
frozen 50-run AgentPatchCheck configuration. Among the 45 runs with binary
official outcomes, mapping `finished` to `resolved` and `non-finished` to
`unresolved` misclassifies 12 instances, or 26.7%. The errors occur in both
directions: three finished runs are unresolved, while nine non-finished runs
are resolved.

The evidence supports a bounded measurement conclusion: typed runtime
termination and independently evaluated official correctness should be retained
as separate variables. Terminal mutation, execution effort, and non-resolved
taxonomy provide supporting context but do not identify causal mechanisms. The
study does not estimate mismatch prevalence across coding agents or demonstrate
an APC correctness improvement. Its contribution is an artifact-grounded proxy
audit under a reproducible frozen configuration.

## References

[1] C. E. Jimenez, J. Yang, A. Wettig, S. Yao, K. Pei, O. Press, and K. Narasimhan. “SWE-bench: Can Language Models Resolve Real-World GitHub Issues?” In *Proceedings of the Twelfth International Conference on Learning Representations (ICLR)*, 2024. https://proceedings.iclr.cc/paper_files/paper/2024/hash/edac78c3e300629acfe6cbe9ca88fb84-Abstract-Conference.html

[2] OpenAI. “Introducing SWE-bench Verified.” Official benchmark report and release announcement, 2024. https://openai.com/index/introducing-swe-bench-verified/

[3] J. Yang, C. E. Jimenez, A. Wettig, K. Lieret, S. Yao, K. Narasimhan, and O. Press. “SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering.” In *Advances in Neural Information Processing Systems 37 (NeurIPS 2024)*, pp. 50528–50652, 2024. https://proceedings.neurips.cc/paper_files/paper/2024/hash/5a7c947568c1b1328ccc5230172e1e7c-Abstract-Conference.html

[4] Anonymous. “SHEPHERD: Pattern-Guided Trajectory Selection for Coding Agents on SWE-bench.” Anonymous manuscript submitted to ICLR 2026, OpenReview ID `ZBOFr4ryBk`, 2026. https://openreview.net/pdf?id=ZBOFr4ryBk

[5] Anonymous. “SWE-EVAL: Trajectory-Enhanced Evaluation for Agentic Issue Resolution.” Anonymous manuscript submitted to ICLR 2026, OpenReview ID `aPeeUApKtW`, 2026. https://openreview.net/pdf?id=aPeeUApKtW

[6] X. Zhao, H. Li, S. Li, T. Zhao, E. T. Barr, F. Sarro, and H. Ye. “Failure as a Process: An Anatomy of CLI Coding Agent Trajectories.” *arXiv preprint arXiv:2607.09510*, 2026. https://arxiv.org/abs/2607.09510

[7] I. Ceka, H. Mitchell, S. Pujar, L. Buratti, S. Ramji, J. Yang, G. Kaiser, and B. Ray. “Understanding Automated Program Repair Agents Through the Lens of Traceability: An Empirical Study.” Accepted for publication at the *International Symposium on Software Testing and Analysis (ISSTA 2026)*, 2026; originally posted as arXiv:2506.08311 in 2025. https://arxiv.org/abs/2506.08311

[8] K. Duan, D. Zheng, Y. Wang, X. Wang, E. Shi, X. Liu, Y. Ma, J. Chen, M. Liu, and Z. Zheng. “Efficient SWE Agent Benchmarking via Trajectory-Aware Evaluation.” *arXiv preprint arXiv:2609.01603*, under review, 2026. https://arxiv.org/abs/2609.01603

[9] I. Bouzenia, C. Cadar, and M. Pradel. “Evaluating LLM Agents on Automated Software Analysis Tasks.” *arXiv preprint arXiv:2604.11270*, 2026. https://arxiv.org/abs/2604.11270
