---
name: do-execute-plan
description: "Execute plan.md's task checklist: subagent-driven orchestration over named specialist archetypes (system-architect, core-implementer, quality-guardian) with prerequisite gates, readiness contracts, and parallel execution. Use when requirement.md, design.md, and plan.md already exist and the next step is running the plan's tasks through those subagents, or the user says 'let's start building the plan' rather than describing a one-off fix outside any plan."
argument-hint: "[--scope next|phase:N|all|resume] [--review[=false]] [--scaffold]"
effort: high
---

# do-execute-plan

Phase 4 of the DoFlow chain. Executes the task checklist in `plan.md` using specialist subagent archetypes with readiness validation and progressive disclosure.

## Invocation
```text
/do-execute-plan [--scope next|phase:N|all|resume] [--review[=false]] [--scaffold]
```

## Behavioral Flow

1. **Resolve State & Prerequisite Gate**:
   - Every DoFlow runtime call in this skill — `paths`, `prereqs`, `parallel-check`, `task-brief` —
     goes through the runtime seam. Resolve it **once** here and reuse `$DOFLOW` for all four:

```bash
# Resolve the DoFlow runtime: nearest project install wins, then the global one.
D=$PWD; while [ "$D" != / ] && [ ! -x "$D/.doflow/scripts/doflow/bin/doflow-run" ]; do D=$(dirname "$D"); done
DOFLOW="$D/.doflow/scripts/doflow/bin/doflow-run"
[ -x "$DOFLOW" ] || DOFLOW="$HOME/.doflow/scripts/doflow/bin/doflow-run"
[ -x "$DOFLOW" ] || { echo "doflow: no runtime found in any .doflow/ above $PWD, nor at $HOME/.doflow. Run: npx @khoavu882/doflow install" >&2; exit 2; }
```

Run every command below from the project root — the walk-up starts at `$PWD`. On exit 2, print the message verbatim and stop; it names every path searched.

```bash
"$DOFLOW" paths --json
```

   - Enforce hard prerequisite gate: `"$DOFLOW" prereqs --require-plan` (requires
     `requirement.md`, `design.md`, `plan.md`).

2. **Propose the Task Class; the Runtime Validates It**:
   - Name exactly one class id for the work this run executes. `/do-flow` passes one when it
     invoked this skill; a user who named one settles it; otherwise derive it from `plan.md`.
     ```bash
     "$DOFLOW" classify --task-class "<proposed>" --json
     ```
Branch on the returned `outcome` field, not the exit code.
- **`ACCEPTED`** — the returned `workflow` is this run's plan of record; read `stages`, `gates` and `handoff` off it rather than from memory.
- **`REJECTED`** — **stop.** Print `message` verbatim (it already names `validClasses` and any `suggestions`), ask the user to choose from `validClasses`, then re-validate. Never substitute `feature`.
- **Exit 2** — surface the message verbatim and stop.

   - Take the readiness template from the returned workflow's implementation stage: the entry in
     `stages[]` with `mutatesSource: true`, whose `readinessTemplate` names the contract step 3
     grades against. Do not pick a template by hand.
   - If the accepted workflow has no stage with `mutatesSource: true` — `review`, `research` and
     `operations` have none — this skill is the wrong tool for that class. Say so and stop rather
     than executing tasks the workflow never declared.

3. **Readiness Evaluation (Contract State)**:
   - Evaluate a task's contract before dispatching it, run from the project the task belongs to:
     ```bash
     "$DOFLOW" readiness --task-class "<template from step 2>" --task-id "<task id>" --json
     "$DOFLOW" evidence --task-id "<task id>" --json
     ```
   - **Both `--task-class` and `--task-id` are required.** Omitting either exits 2 and names the
     valid set. Pass them explicitly rather than letting anything default: a verdict computed for
     another task, or against another class's contract, is worse than no verdict.
   - **Branch on the `state` field, not the exit code.** This verb exits 0 for every state it can
     compute, so a zero exit is not a grant of readiness. The four states are the entire
     vocabulary — `READY`, `NEEDS_EVIDENCE`, `NEEDS_USER_DECISION`, `BLOCKED` — and none of them is
     ever reported as a number, a percentage, or a confidence.
   - Only `bug`, `feature`, `refactor`, `trivial-edit` and `dependency-change` have templates. On
     any other class the verb exits 1 and lists the valid keys; that is the correct answer, not a
     gap to route around.
   - All four states are reachable, so a verdict is about this task rather than about the runtime:
     `NEEDS_EVIDENCE` until step 6's batch is recorded, `READY` once the recorded evidence and the
     inputs you state cover the contract, `BLOCKED` on a claim whose evidence contradicts itself,
     and `NEEDS_USER_DECISION` when you pass `--user-decision-pending`. A first call on a task with
     nothing recorded grades an empty ledger — that is a checklist, not a defect.
   - `readiness` also accepts `--verification-plan`, `--scope` and `--invariants` — the verb's own
     arguments, unrelated to this skill's `--scope`. Those are inputs
     you **state**, not evidence the gate measured: the report lists them back as `callerAsserted`
     in JSON and `Caller-stated:` in the human report, and a requirement satisfied that way links
     no evidence. Pass them when they are true, and when you report the verdict say which part of
     it rests on a statement rather than on a record. Never pass one to move a state.
   - Do not recall the contract from memory — the templates are versioned and the command reads
     them. This skill's own `references/readiness_gate.md` carries the per-class requirements, what each state
     means, and exactly which input produces it. Read it before acting on a verdict, and never
     write `READY` yourself: the gate did not say it.

4. **Scaffold Generation (`--scaffold`)**:
   - When invoked with `--scaffold`, emit a reviewable code scaffold under `<feature_dir>/scaffold/`
     instead of executing tasks: the source layout, signatures and test stubs that `requirement.md`,
     `design.md` and `plan.md` imply, plus a contract frame per external `depends-on:` service.
     Signatures only, never implementation logic, and never a write into the project's source tree.
   - The in-scope half is deterministic and is **run**, not reasoned through — one verb through the
     same seam as every other runtime call, `"$DOFLOW" scaffold --json`, which resolves the active
     feature itself. The external-dependency half is an algorithm you execute. Both, with the exact
     commands, live in this skill's own `references/scaffold.md`. Report its `status` and,
     specifically, whatever it lists as skipped or not evaluated — a partial scaffold read as
     complete is worse than none.

5. **Task Selection & Parallel Dispatch**:
   - `--scope` selects what this run executes, and takes exactly one value: `next` (the next
     pending task, the default), `phase:N` (one phase), `all` (every pending task), or `resume`
     (pick up where an interrupted run stopped). Where an interrupted run stopped is read from the
     recorded state, never reconstructed from the transcript.
   - Compute dispatch groups with `"$DOFLOW" parallel-check --phase=<N> --json` — it
     groups by phase and `owner:`, and returns the cross-group write-set collisions
     (`group_overlaps[]`, `group_serialize[]`) that decide what may run concurrently. Do not derive
     write-set isolation by inspection; it is computed.
     **Branch on the `parallel_safe` field, never on the exit code.** With `jq` unavailable this
     verb exits 0 and reports `"parallel_safe": null` — a zero exit is not a grant of concurrency.
     `null`, or a missing field, means unknown: run the tasks serially and say why.
     Build each group's brief with
     `"$DOFLOW" task-brief --group=<phase>:<owner> --tasks=<csv>`. Full protocol, field
     meanings, and the serial and per-task fallbacks: this skill's own `references/parallel_dispatch.md`.
   - Dispatch tasks to appropriate specialist archetypes:
     - Architecture & Schema $\rightarrow$ `system-architect`
     - Code Implementation & Refactoring $\rightarrow$ `core-implementer`
     - Test Automation & Quality $\rightarrow$ `quality-guardian`
   - Name a model tier explicitly on every dispatch — an omitted tier silently inherits the
     session's model rather than "using the default." Consult
     the guidance tree's `references/MODEL_SELECTION.md` for how to pick the tier per task and per
     review pass.

6. **Batch the Phase's Evidence**:
   - One pass at each phase boundary, never one call per fact. Use the plan task id — the same id
     step 3 graded — for every `evidence`, `claim` and `readiness` call about that task; a
     different id reads a different task's record.
     ```bash
     "$DOFLOW" evidence --task-id "<task id>" --action add --batch <batch>.json --json
     "$DOFLOW" claim --task-id "<task id>" --action add --statement "<one conclusion>"
     ```
Item schema, provenance rules, and the refused-field list: the guidance tree's `references/EVIDENCE_LEDGER.md`. Read it before writing the batch.
   - This phase's items are its completion report, and a subagent's assertion never becomes fact by
     a subagent having made it.
   - Add each conclusion as a claim in this same pass. Each is stored as a `hypothesis` and becomes
     supported only through linked evidence:
     `"$DOFLOW" claim --task-id "<task id>" --action link --claim-id <claim id> --evidence-id <evidence id> --relation supports|contradicts`.
     An evidence id the ledger does not hold is **refused** — exit 2, naming the id — not graded,
     so record the batch first and link afterwards. A claim carrying both fresh support and fresh
     contradiction becomes `conflicted`, which is what makes step 3 report `BLOCKED`.

7. **Phase Quality Review** (`--review`):
   - Review each phase upon completion for spec compliance before advancing. This runs by default;
     `--review=false` is the only way to skip it, and skipping it is reported in the phase's
     completion summary rather than passing silently.

**Stop when** every review finding the contract names has an answer or a stated gap, **and** the last round produced no new review finding. A round that only restates what you already have is the last round. Report the remaining gaps rather than continuing.

## Boundaries
**Will:** Propose a task class and have the runtime validate it, execute planned tasks with
subagents, consult the readiness contract per task, batch each phase's evidence and claims, and
ensure write-set isolation.
**Will Not:** Bypass missing spec artifacts, modify source code while readiness reports `BLOCKED`,
execute under a class the runtime rejected or replaced with `feature`,
call `readiness` for a stage that declares no template; or express evidence, an estimate or readiness as a number, a percentage or a confidence.
