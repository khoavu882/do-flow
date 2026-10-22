---
description: Operating modes, task states, control boundaries, and transition rules between assisted and autonomous work.
---
# Spec: operating modes and task states

Contract document for feature 074 (P0). It states the two operating modes DoFlow aims at, who owns
what in each, the task states, and the rules that stop a run from reporting more than it did. It
changes no runtime behaviour. Source: the DoFlow hybrid RAG and context-budgeted orchestration ADR, sections 3.0 to 3.0.4.
The ADR calls these target capabilities, not a claim that the baseline implements them fully, so
every state and control below is marked `implemented` or `target` against the source read for
this document.

## Modes

| Mode | Control owner | DoFlow responsibilities |
|---|---|---|
| Manual / assisted | The user selects workflows, invokes steps, and reviews or redirects results | Routing, retrieval, context, state, and verification under shared contracts |
| Autonomous agent workflow | The main session receives an objective and coordinates subagents within its authorized scope | Task lifecycle, dependencies, dispatch policy, budgets, handoffs, and completion gates |

Both modes share task state and evidence contracts; their control policies differ. Autonomous means
end-to-end execution within the assigned scope without the user operating every stage. Missing
mandatory information, insufficient authorization or an exhausted budget produces a BLOCKED or
incomplete outcome; the system does not expand scope to report success.

The attempt ledger already records which way a task was run: its `MODES` are `manual`,
`sequential` and `subagent` (`src/runtime/task-attempts.ts#MODES`). The dispatch loop
(`src/runtime/dispatch/loop.ts`, feature 082) launches and coordinates one-shot workers for the
tasks of an existing plan; no code yet takes a bare objective and decomposes it, so the autonomous
workflow of the table above stays `target` as a whole.

## Ownership

| Owner | Owns |
|---|---|
| Main session | The objective, acceptance criteria, task graph and final outcome; decomposition, integration and replanning |
| DoFlow runtime | State transitions, policy and budget checks, capability resolution, sourced context preparation, result recording and completion gates |
| Harness adapters | Spawn, wait, status, cancel and resume where the harness supports them; a missing capability is declared, not hidden |
| Subagents | A scoped task with owner, dependencies, acceptance criteria, budget and context references; they return a concise summary, artifact or change references, evidence, verification outcomes and blockers |

The local advisor proposes bounded retrieval and dispatch choices; it is not a supervisor and cannot
certify completion. No orchestration framework or daemon is required by default, and small tasks may
stay sequential.

## Task states

The runtime derives a task's state on every `status` call from the attempt ledger and plan.md
(`src/runtime/task-attempts.ts#status`, which reads `src/runtime/task-graph.ts#deriveTasks`);
`src/runtime/task-state.ts` is the locked, versioned store both ledgers persist through and holds
no state names.

| State | Meaning | Implemented | Locator |
|---|---|---|---|
| PLANNED | The task exists in the plan and is not yet startable | implemented | derived `pending`, `src/runtime/task-graph.ts#deriveTasks`, with the unmet or held dependencies named |
| READY | Every dependency is satisfied, so the task may be dispatched | implemented | derived `ready`, `src/runtime/task-graph.ts#deriveTasks` |
| RUNNING | One active attempt holds the task | implemented | derived `running`, `src/runtime/task-graph.ts#deriveTasks` |
| SUCCEEDED | A COMPLETED attempt backed by a passing, fresh, task-bound test result | implemented | derived `done`, `src/runtime/task-graph.ts#deriveTasks`; the evidence check in `src/runtime/task-attempts.ts#finish` |
| FAILED | An attempt ended in failure and the parent must replan or retry | implemented | derived `failed`, `src/runtime/task-graph.ts#deriveTasks`, from a FAILED result, which `src/runtime/task-attempts.ts#finish` accepts only with a reason |
| BLOCKED | Mandatory input, authorization or budget is missing | implemented | derived `blocked`, `src/runtime/task-graph.ts#deriveTasks`, from a BLOCKED result or an exhausted task attempt budget |
| CANCELLED | The attempt was revoked and its result must not be accepted | implemented | derived `cancelled`, `src/runtime/task-graph.ts#deriveTasks`, from an attempt `src/runtime/task-run.ts#cancelRun` or `src/runtime/task-run.ts#cancelAttempt` cancelled and no resume has cleared |

Mapping from today's derived states: `pending` to PLANNED, `ready` to READY, `running` to RUNNING,
`done` to SUCCEEDED, `failed` to FAILED, `blocked` to BLOCKED, `cancelled` to CANCELLED.

## Rules

- READY requires satisfied dependencies. No dispatch while a required dependency is blocked.
- A child's done report never completes a parent. Completion needs satisfied acceptance criteria,
  valid verification evidence, accepted required tasks and no unresolved blocking gap.
- A sequential main-session run is never reported as a subagent run.
- BLOCKED means missing mandatory input, missing authorization or exhausted budget. It is never a
  reason to widen scope.
- A stale or cancelled attempt cannot overwrite current work. `src/runtime/task-attempts.ts#finish`
  refuses a cancelled token first (`attempt-cancelled`, through
  `src/runtime/task-attempts.ts#cancelledAttempt`), then a stale token and a changed plan line;
  `src/runtime/task-attempts.ts#release` refuses a cancelled token the same way.

## User controls

A user can pause, inspect, redirect, cancel, take over and resume an autonomous run, and resume
must use current state and versions rather than restart blindly.

| Control | Manual / assisted | Autonomous | Locator |
|---|---|---|---|
| Pause | implemented | implemented | `src/runtime/task-run.ts#pauseRun`, `src/runtime/dispatch/controls.ts#pause` |
| Inspect | implemented | implemented | `src/runtime/task-run.ts#inspectRun`, `src/runtime/dispatch/controls.ts#inspect` |
| Redirect | target | target | none |
| Cancel | implemented | implemented | `src/runtime/task-run.ts#cancelRun`, `src/runtime/task-run.ts#cancelAttempt`, `src/runtime/dispatch/controls.ts#cancel` |
| Take over | target | implemented | `src/runtime/dispatch/controls.ts#takeOver` |
| Resume | implemented | implemented | `src/runtime/task-run.ts#resumeRun`, `src/runtime/dispatch/controls.ts#resume` |

Basis for the `implemented` cells: a user starts a run with `src/runtime/task-run.ts#startRun`,
pauses it with `src/runtime/task-run.ts#pauseRun`, cancels the run or one attempt with
`src/runtime/task-run.ts#cancelRun` and `src/runtime/task-run.ts#cancelAttempt`, resumes it from
current state with the digest-acknowledged `src/runtime/task-run.ts#resumeRun`, and inspects the
graph, task states and run totals read-only with `src/runtime/task-run.ts#inspectRun`. A done task
is reopened with `src/runtime/task-attempts.ts#reopen`. No Manual / assisted redirect or take-over
operation exists, so both Manual / assisted cells stay `target`. The Autonomous controls act on a
dispatch run through `src/runtime/dispatch/controls.ts#pause`, `#inspect`, `#cancel`, `#takeOver`
and `#resume`; take over exists only there, and redirect stays `target` because no worker steering
exists (DEC-009).

A linked worktree on a pre-080 runtime ignores pause, cancel, budgets, the epoch and done-stale,
and still refuses a cancelled token (DEC-013).

## Harness primitives

Whether a harness can spawn, wait for, report the status of, cancel or resume a subagent is
declared per harness in the `orchestration` block of `core/registry/harnesses.json`, defined by
IC-026 of feature 074 and validated by
`src/registry/index.ts`. This document restates no value from that block. A value is never inferred
from another harness or a model name, and an unsupported primitive falls back to sequential or
manual execution that is reported as such.

External worker capabilities, meaning which harness can run a one-shot worker for a claimed task and
how, are declared per harness in the `worker` block of `core/registry/harnesses.json`, defined by
IC-001 of feature 081. This document restates no value from that block either.

## Refresh

- Trigger: a change to the task states derived in `src/runtime/task-graph.ts#deriveTasks`, to the
  run controls in `src/runtime/task-run.ts`, to the `MODES` of the attempt ledger, or to the ADR sections 3.0 to 3.0.4 this document follows.
- Owner: the author of the feature that changes the lifecycle (features 080 to 082 for the
  autonomous workflow), reviewed at that feature's design gate.
