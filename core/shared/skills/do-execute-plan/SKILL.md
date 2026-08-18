---
name: do-execute-plan
description: "Execute plan.md's task checklist: subagent-driven orchestration over named specialist archetypes (system-architect, core-implementer, quality-guardian) with prerequisite gates, readiness contracts, and parallel execution. Use when requirement.md, design.md, and plan.md already exist and the next step is running the plan's tasks through those subagents, or the user says 'let's start building the plan' rather than describing a one-off fix outside any plan."
argument-hint: "[--next|--phase N|--all|--resume|--scaffold] [--sync] [--review|--no-review]"
effort: high
---

# do-execute-plan

Phase 4 of the DoFlow chain. Executes the task checklist in `plan.md` using specialist subagent archetypes with readiness validation and progressive disclosure.

## Invocation
```text
/do-execute-plan [--next|--phase N|--all|--resume|--scaffold] [--sync] [--review|--no-review]
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
     "$DOFLOW" paths --json
     ```
     The walk-up starts at the working directory, so run every command in this skill from the
     project root. Exit 2 means no DoFlow runtime was found; the message names every place searched
     — surface it verbatim and stop, do not search for the runtime yourself.
   - Enforce hard prerequisite gate: `"$DOFLOW" prereqs --require-plan` (requires
     `requirement.md`, `design.md`, `plan.md`).

2. **Propose the Task Class; the Runtime Validates It**:
   - Name exactly one class id for the work this run executes. `/do-flow` passes one when it
     invoked this skill; a user who named one settles it; otherwise derive it from `plan.md`.
     ```bash
     "$DOFLOW" classify --task-class "<proposed>" --json
     ```
   - Branch on the returned `outcome` field, not on the exit code.
     - **`ACCEPTED`** — take the readiness template from the returned workflow's implementation
       stage: the entry in `stages[]` with `mutatesSource: true`, whose `readinessTemplate` names
       the contract step 3 grades against. Do not pick a template by hand.
     - **`REJECTED`** — **stop.** Print `message` verbatim; it already names `validClasses` and any
       `suggestions`. Ask the user to choose from `validClasses`, then re-validate that choice.
       Never substitute `feature`, and never execute a task under a class the runtime refused.
     - **Exit 2** — the runtime could not answer at all. Surface its message verbatim and stop.
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
   - `readiness` also accepts `--verification-plan`, `--scope` and `--invariants`. Those are inputs
     you **state**, not evidence the gate measured: the report lists them back as `callerAsserted`
     in JSON and `Caller-stated:` in the human report, and a requirement satisfied that way links
     no evidence. Pass them when they are true, and when you report the verdict say which part of
     it rests on a statement rather than on a record. Never pass one to move a state.
   - Do not recall the contract from memory — the templates are versioned and the command reads
     them. `references/readiness_gate.md` carries the per-class requirements, what each state
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
     commands, live in `references/scaffold.md` (or `scaffold.md`). Report its `status` and,
     specifically, whatever it lists as skipped or not evaluated — a partial scaffold read as
     complete is worse than none.

5. **Task Selection & Parallel Dispatch**:
   - Select next pending task(s) (`--next`, `--phase N`, `--all`, `--resume`).
   - Compute dispatch groups with `"$DOFLOW" parallel-check --phase=<N> --json` — it
     groups by phase and `owner:`, and returns the cross-group write-set collisions
     (`group_overlaps[]`, `group_serialize[]`) that decide what may run concurrently. Do not derive
     write-set isolation by inspection; it is computed.
     **Branch on the `parallel_safe` field, never on the exit code.** With `jq` unavailable this
     verb exits 0 and reports `"parallel_safe": null` — a zero exit is not a grant of concurrency.
     `null`, or a missing field, means unknown: fall back to `--sync` and say why.
     Build each group's brief with
     `"$DOFLOW" task-brief --group=<phase>:<owner> --tasks=<csv>`. Full protocol, field
     meanings, and the `--sync` / `--no-group` fallbacks: `references/parallel_dispatch.md`.
   - Dispatch tasks to appropriate specialist archetypes:
     - Architecture & Schema $\rightarrow$ `system-architect`
     - Code Implementation & Refactoring $\rightarrow$ `core-implementer`
     - Test Automation & Quality $\rightarrow$ `quality-guardian`
   - Name a model tier explicitly on every dispatch — an omitted tier silently inherits the
     session's model rather than "using the default." Consult `references/MODEL_SELECTION.md` for
     how to pick the tier per task and per review pass.

6. **Batch the Phase's Evidence**:
   - One pass at each phase boundary, never one call per fact. Use the plan task id — the same id
     step 3 graded — for every `evidence`, `claim` and `readiness` call about that task; a
     different id reads a different task's record.
     ```bash
     "$DOFLOW" evidence --task-id "<task id>" --action add --batch <batch>.json --json
     "$DOFLOW" claim --task-id "<task id>" --action add --statement "<one conclusion>"
     ```
   - The batch file is a JSON array, one object per item (scratch input — delete it after the
     write). It is validated whole: one rejected item writes nothing, so a half-written phase never
     reads as complete. Per item: `kind` (`exact-search`, `semantic-retrieval`, `structural`,
     `historical`, `documentation`, `test-result`, `runtime-observation`, `user-statement`, `diff`,
     `generated-analysis`), `provenance` (`extracted` | `inferred` | `asserted`, with **no
     default** — an unstated one is refused rather than filed as repository fact), and `source`
     (`provider` + `capability`, no `unknown` stand-in). `extracted` needs a `locator`; `inferred`
     and `asserted` need `content`; `generated-analysis` and `user-statement` can never be
     `extracted`. `id`, `freshness`, `supports`/`contradicts`, `stage` and any score field are
     refused by name — freshness is measured at the write, and evidence is attached to a claim by
     linking, below.
   - The same items are the phase's completion report: per item, what was found, its source (a
     provider + capability, a command and its output, or a subagent's analysis), its locator, and
     whether it is **extracted** (read verbatim from the repository or a command) or **inferred**
     (analysis). Never merge those two provenances into one line, and never promote a subagent's
     assertion to fact because a subagent made it.
   - Add each conclusion as a claim in this same pass. Each is stored as a `hypothesis` and becomes
     supported only through linked evidence:
     `"$DOFLOW" claim --task-id "<task id>" --action link --claim-id <claim id> --evidence-id <evidence id> --relation supports|contradicts`.
     An evidence id the ledger does not hold is **refused** — exit 2, naming the id — not graded,
     so record the batch first and link afterwards. A claim carrying both fresh support and fresh
     contradiction becomes `conflicted`, which is what makes step 3 report `BLOCKED`.
   - Relevance is not confidence. A match count, a ranking, a "best hit" is a property of the query,
     not of the fact — record the locator, never a score, a percentage, or a confidence.

7. **Phase Quality Review**:
   - Review each phase upon completion for spec compliance before advancing.

## Boundaries
**Will:** Propose a task class and have the runtime validate it, execute planned tasks with
subagents, consult the readiness contract per task, batch each phase's evidence and claims, and
ensure write-set isolation.
**Will Not:** Bypass missing spec artifacts, modify source code while readiness reports `BLOCKED`,
execute under a class the runtime rejected or replaced with `feature`, invoke `readiness` for a
class that has no template, or report readiness or evidence as a number, a percentage or a
confidence.
