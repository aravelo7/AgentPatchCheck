# Formal Runtime Contract

> Historical formal-pilot frozen runtime contract. This document applies to the
> APC-Pilot-10 formal pilot, not to the current HAL SWE-bench Verified Mini
> fixed-50 benchmark freeze.

Status: normative specification for the formal-frozen canonical execution only.

Frozen source HEAD: `b52f0cd150218a30efdb76094a270f5500c5b302`.

This document records behavior that is present in the current implementation and
supported by the existing regression tests, closure review, or canonical lifecycle
qualification. It is the source of truth for formal runtime semantics. It does not
define a new architecture, prompt, benchmark, evaluator, retry policy, or
provenance subsystem.

When implementation, tests, or review expectations disagree with this document,
the disagreement is classified before any change is made:

- implementation differs from this contract: `IMPLEMENTATION BUG`;
- a test or review expectation differs from this contract: `TEST/REVIEW SPEC BUG`;
- the desired behavior is different from this contract: `CONTRACT CHANGE PROPOSAL`.

No reviewer may resolve such a disagreement by inventing a replacement runtime
semantic.

## 1. Scope and authority

The scope is the formal-frozen canonical execution. The formal runtime path is
normative; benchmark-specific metadata and SWE-bench artifact handling are
specified separately below.

The contract is frozen at the source HEAD above. A contract change requires a new
Git SHA, lifecycle qualification for the affected scope, and benchmark refreeze.

## 2. Canonical execution

The formal path is:

`runSWEbenchCli -> runSWEbenchInstance -> executeAgentAdapterUnderDeadline -> Harness-native Runtime`.

Formal runtime behavior paths remain exactly `1 -> 1`. The formal path does not
select a second runtime or alternate launcher. The Docker task environment is an
engineering-validation facility and is not a second formal runtime path.

The formal bootstrap uses the canonical manifest identity
`.agentpatchcheck/swebench/datasets/APC-Pilot-10-v1-formal.manifest.json`, version
`v1`. The manifest content hash is not recorded here because it was not part of the
evidence inspected for this document: `UNRESOLVED — NOT NORMATIVE`.

## 3. Agent and tool semantics

The following runtime-level facts are normative:

- formal native execution uses the formal native tool presentation;
- `dsh-shell` is an available native tool in that presentation;
- development-only public-verification profiles are not exposed on the formal path;
- repository-public commands may be used by the Agent through the available
  repository/tool boundary for autonomous validation.

The concrete Prompt text is not runtime semantics. Prompt and instruction
revisions belong to Benchmark Freeze metadata.

## 4. Cancellation lifecycle

The common cancellation contract is:

`deadline -> cancellation -> stop new work -> settle/terminate started work -> quiescence acknowledgement -> terminal`.

An already-started atomic mutation may settle during cancellation. Once the
terminal boundary is reached, no new Provider, Planner, Tool, or mutation work may
start, and the workspace must not be modified by background work.

The prohibited sequence is:

`deadline -> terminal -> background mutation continues`.

If cancellation cleanup acknowledgement cannot confirm termination/quiescence, the
execution fails closed as `ProcessTreeTerminationError`; it is not converted into
an acknowledged timeout terminal.

## 5. Terminal-state matrix

Only the cells marked with a verified behavior are normative. An `UNRESOLVED`
cell is deliberately not a default or implied policy.

| Terminal class | Terminal identity | Workspace trust / quiescence | Verification | Repair | Hidden Oracle | Patch recovery |
|---|---|---|---|---|---|---|
| Normal finished | `status=succeeded`, `exitCode=0`, `timedOut=false`, `terminationReason=finished` | Verified stable managed workspace | Eligible | Eligible only through the existing non-timeout public-verification repair flow | Eligible after the existing non-timeout path | Eligible |
| Agent failed | Runtime terminal such as `stuck`, `invalid-decision`, or other non-timeout Agent failure | `UNRESOLVED — NOT NORMATIVE` as a single class | `UNRESOLVED — NOT NORMATIVE` | `UNRESOLVED — NOT NORMATIVE` | `UNRESOLVED — NOT NORMATIVE` | `UNRESOLVED — NOT NORMATIVE` |
| Model/provider failed | `model-failed` or a recorded provider failure | Runtime terminal identity is verified; adapter-level workspace/post-agent eligibility is `UNRESOLVED — NOT NORMATIVE` | `UNRESOLVED — NOT NORMATIVE` | `UNRESOLVED — NOT NORMATIVE` | `UNRESOLVED — NOT NORMATIVE` | `UNRESOLVED — NOT NORMATIVE` |
| Attempt exhaustion | Final `iteration-limit`, `tool-limit`, or `rejected-tool-limit` after the bounded attempt controller stops | Final terminal identity is verified; post-agent eligibility is `UNRESOLVED — NOT NORMATIVE` | `UNRESOLVED — NOT NORMATIVE` | `UNRESOLVED — NOT NORMATIVE` | `UNRESOLVED — NOT NORMATIVE` | `UNRESOLVED — NOT NORMATIVE` |
| Acknowledged timeout | `status=failed`, `timedOut=true`, `terminationReason=timeout`, `exitCode=1`, final `attempt-ended=timeout` | Quiescence is acknowledged before terminal handling | Not eligible | Not eligible | Not eligible | Read-only partial patch recovery is allowed |
| Cancellation cleanup acknowledgement failure | `ProcessTreeTerminationError`; no timeout terminal is emitted | Quiescence is unconfirmed; fail closed | Not eligible | Not eligible | Not eligible | Not eligible |
| Runtime/infrastructure failure | Runtime/infrastructure failure not covered by the acknowledged-timeout or cleanup-failure cases | `UNRESOLVED — NOT NORMATIVE` by this contract | `UNRESOLVED — NOT NORMATIVE` | `UNRESOLVED — NOT NORMATIVE` | `UNRESOLVED — NOT NORMATIVE` | `UNRESOLVED — NOT NORMATIVE` |

Attempt exhaustion is not a new retry heuristic: an iteration-limited attempt may
continue only under the already-implemented bounded attempt-controller rules. A
timeout is terminal and does not create a continuation.

## 6. SWE-bench adapter artifact semantics

Runtime lifecycle and SWE-bench artifact protocol are separate layers.

For an acknowledged timeout, the SWE-bench adapter has the following verified
behavior:

- the workspace is quiescent before artifact handling;
- public verification, repair, and Hidden Oracle do not start;
- patch collection is read-only partial patch recovery from the stable workspace;
- a timeout-labelled prediction may be emitted;
- official grading may run against that stable partial patch;
- the run summary preserves the Agent timeout identity (`timeout`, `timedOut=true`);
- `resolved` or `unresolved` describes patch correctness and does not replace or
  rewrite the Agent timeout taxonomy.

For cancellation cleanup acknowledgement failure:

- the adapter fails closed with `ProcessTreeTerminationError`;
- patch collection does not run;
- no prediction is emitted;
- no official grading runs.

These rules apply only to the SWE-bench adapter. They do not redefine generic
runtime terminal behavior.

## 7. Attempt semantics

The shared wall budget belongs to the whole Agent execution and is consumed across
bounded attempts. A timeout is terminal at the attempt where it occurs; it does not
continue into another attempt. The same terminal identity is preserved whether the
timeout occurs at Attempt 1 or Attempt 2.

Iteration-limit continuation remains limited to the existing attempt-controller
decision and available shared-time/attempt boundaries. No additional retry or
continuation heuristic is normative here.

## 8. Artifact and provenance boundary

The formal source identity requires the exact frozen source HEAD above and a clean
tracked source worktree for standard formal SWE-bench execution. Untracked runtime
outputs are artifacts and are not source identity.

Prediction provenance is the canonical SWE-bench schema generated by the adapter:
`instance_id`, `model_patch`, and `model_name_or_path`. For acknowledged timeout,
the prediction may contain the read-only partial patch, while the run summary and
execution record retain the timeout terminal identity.

The formal manifest identity is the path and version recorded in Section 2. The
manifest's full dataset, evaluator revision, and fixed denominator are Benchmark
Freeze metadata, not runtime semantics.

## 9. Formal Runtime Contract vs Benchmark Freeze metadata

Formal Runtime Contract covers:

- lifecycle ordering and cancellation;
- terminal identities;
- native tool and repository boundary semantics;
- acknowledged-timeout artifact behavior;
- cleanup-failure behavior;
- bounded attempt terminal behavior.

Benchmark Freeze metadata covers:

- Harness exact SHA: `b52f0cd150218a30efdb76094a270f5500c5b302`;
- formal manifest and dataset identity;
- model and provider configuration;
- Prompt/instruction revision;
- budgets and timeout values;
- evaluator revision;
- fixed task denominator.

The concrete Prompt must not be copied into this runtime contract.

## 10. Traceability mapping

This is an evidence map, not a new audit or test plan.

| Contract clause | Existing evidence |
|---|---|
| Canonical formal bootstrap, manifest identity, formal classification, clean tracked source | `test/agentpatchcheck/swebench-cli.test.ts`: canonical manifest/bootstrap and clean-source tests |
| Single canonical adapter invocation and native adapter registration | `test/agentpatchcheck/agent-adapter.test.ts`; `test/agentpatchcheck/swebench-adapter.test.ts` |
| Native tool presentation and `dsh-shell` availability | `test/agentpatchcheck/harness-native-runtime.test.ts`: native tool and DSH-shell execution tests |
| Development verifier excluded from formal Agent inputs | `test/agentpatchcheck/swebench-adapter.test.ts`: safe-instance/formal-boundary test |
| Normal finished runtime and artifact path | `test/agentpatchcheck/harness-native-runtime.test.ts`; `test/agentpatchcheck/swebench-adapter.test.ts`; `test/agentpatchcheck/swebench-cli.test.ts` |
| Provider, Planner, and native Tool cancellation | `test/agentpatchcheck/harness-native-runtime.test.ts`: `cancels blocking Provider, Planner, and native Tool awaits before persisting timeout` |
| Docker command cancellation, stop/restart, and acknowledgement | `test/agentpatchcheck/swebench-docker-task-environment.test.ts`: Docker cancellation test |
| Atomic mutation settlement, no next mutation, terminal workspace stability | `test/agentpatchcheck/harness-native-runtime.test.ts`: `settles an in-flight mutation before timeout and never starts the next mutation` |
| Timeout terminal fields and `attempt-ended=timeout` | `test/agentpatchcheck/harness-native-runtime.test.ts`: caller-owned wall deadline test and timeout attempt-event test |
| No verification/repair/Hidden Oracle after timeout | `test/agentpatchcheck/execute.test.ts`: `does not start post-agent workspace work after a canonical timeout`; timeout lifecycle qualification |
| Timeout partial patch, timeout-labelled prediction, and official grading | `test/agentpatchcheck/swebench-cli.test.ts`: `executes Agent, writes a standard prediction, then evaluates a timeout with a valid patch` |
| Cleanup failure fail-closed with no patch/prediction/grading | `test/agentpatchcheck/agent-adapter.test.ts`, `test/agentpatchcheck/execute.test.ts`, `test/agentpatchcheck/swebench-adapter.test.ts` |
| Attempt 1 and Attempt 2 timeout terminal consistency | `test/agentpatchcheck/attempt-controller.test.ts`: `does not continue a timeout from attempt 1/2` |
| Shared wall budget and bounded continuation | `test/agentpatchcheck/attempt-controller.test.ts`: attempt and shared-time boundary tests |
| Read-only SWE-bench patch export and mutation attribution | `src/agentpatchcheck/swebench-adapter.ts` implementation, `test/agentpatchcheck/swebench-adapter.test.ts`, and Docker patch-export tests |

## 11. Change governance

The governing classification is:

`Implementation != frozen contract -> IMPLEMENTATION BUG`

`Test/reviewer expectation != frozen contract -> TEST/REVIEW SPEC BUG`

`Requested change to frozen semantics -> CONTRACT CHANGE PROPOSAL`

An implementation bug or test/review-spec bug must not be silently resolved by
rewriting this document. A contract change proposal does not automatically permit
production modification. Once a contract change is approved, it requires a new Git
SHA, lifecycle qualification for the affected scope, and benchmark refreeze.

## 12. Unresolved — not normative

- Formal manifest content hash: not established by the inspected evidence.
- A single generic post-agent eligibility policy for non-timeout Agent failures.
- A single generic post-agent eligibility policy for model/provider failures.
- A single generic post-agent eligibility policy for final attempt exhaustion.
- A single generic policy for runtime/infrastructure failures other than the
  acknowledged timeout and cancellation cleanup acknowledgement failure cases.

These entries are intentionally unresolved. They are not permission to infer
behavior from convenience, safety preference, or external project conventions.

## 13. Conflict status

Current contract/test/implementation conflict: **none identified for the clauses
recorded as normative**.

Production files modified for this specification: **0**.

Runtime paths: **1 -> 1**.
