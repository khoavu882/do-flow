---
name: do-execute-plan
description: "Execute plan.md's task checklist: subagent-driven orchestration over the agent specs named as plan owners, with prerequisite gates, readiness contracts, and parallel execution. Use whenever requirement.md, design.md, and plan.md exist and the next step is building the plan's tasks through subagents, or when the user says 'execute the plan', 'run the plan', 'start building', or 'implement phase N'. Always activate this skill to orchestrate multi-task implementation plans with write-set isolation."
argument-hint: "[--scope next|phase:N|all|resume] [--review] [--scaffold]"
effort: high
---

# do-execute-plan

Phase 4 of the DoFlow chain. Executes the task checklist in `plan.md` using specialist subagent archetypes with readiness validation and progressive disclosure.

## Invocation
```text
/do-execute-plan [--scope next|phase:N|all|resume] [--review] [--scaffold]
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
[ -x "$DOFLOW" ] || { echo "doflow: no runtime found in any .doflow/ above $PWD, nor at $HOME/.doflow. Run: npx @khoavu882/doflow install -t <harness>" >&2; exit 2; }
```

Run every command below from the project root — the walk-up starts at `$PWD`. On exit 2, print the message verbatim and stop; it names every path searched.

```bash
"$DOFLOW" paths --json
```

   - Enforce hard prerequisite gate: `"$DOFLOW" prereqs --require-plan` (requires
     `requirement.md`, `design.md`, `plan.md`).
   - Read `<feature_dir>/state.md` if it exists — the cross-session execution record, per
     `MODE_Task_Management.md`'s "Session Start" sequence. A `complete` row in its Task Ledger means
     that task is done: never re-dispatch it, resume at the first task without one. No `state.md`
     yet is the normal first-run case, not a gap.

2. **Propose the Task Class; the Runtime Validates It**:
   - Name exactly one class id for the work this run executes. `/do-flow` passes one when it
     invoked this skill; a user who named one settles it; otherwise derive it from `plan.md`.
     ```bash
     "$DOFLOW" classify --task-class "<proposed>" --calling-skill do-execute-plan --json
     ```
Branch on the returned `outcome` field, not the exit code.
- **`ACCEPTED`** — the returned `workflow` is this run's plan of record; read `stages`, `gates` and `handoff` off it rather than from memory.
- **`REJECTED`** — **stop.** Print `message` verbatim (it already names `validClasses` and any `suggestions`), ask the user to choose from `validClasses`, then re-validate. Never substitute `feature`.
  A rejection may be about **you** rather than the class (`reason: caller-not-a-stage`). Then the fix is to propose one of the classes in `fit.hostingClasses`, or to hand the work to the skill this class names for the stage you meant — not to re-propose the same class.
- **Exit 2** — surface the message verbatim and stop.

   - Take the readiness template from the returned workflow's implementation stage: the entry in
     `stages[]` with `mutatesSource: true`, whose `readinessTemplate` names the contract step 4
     grades against. Do not pick a template by hand.
   - If the accepted workflow has no stage with `mutatesSource: true` — read
     `hasImplementationStage` off the returned object rather than recalling which classes those are
     — this skill is the wrong tool for that class. Say so and stop rather than executing tasks the
     workflow never declared.
   - Also derive `<expected gate id>`, the gate standing directly before this stage, as
     `references/run_position.md` says; step 3 needs it.

3. **Position the Run, and Resolve the Approval Gate Standing Before This Stage**:
   - This stage is the one the accepted workflow anchors an `approval`-kind gate directly *before*
     (`gate-a`, "Before implementation", in the `feature` workflow — the gate whose `afterStage` is
     the stage preceding this skill's own). `/do-plan` deliberately leaves it open: an approval gate
     is answered by the human who is asked, and this skill is where that question lands when nothing
     else has already asked it. Until it is decided, the state machine refuses this stage's own
     completion, so resolve it here rather than at step 10.
   - One `orchestrate --action catch-up` call positions the run, stopping either on this stage or
     on any gate in the way; **branch on its `caughtUpTo` / `reason`, not on the exit code.** That
     call and every branch off it — the expected gate, an earlier stage's gate, a blocking mutating
     stage, an already-recorded stage, a finished run — are in this skill's own
     `references/run_position.md`. Read it before running this step; carry the `caughtUpTo` it
     lands on to step 10.

4. **Readiness Evaluation (Contract State)**:
   - Evaluate a task's contract before dispatching it, run from the project the task belongs to.
     This skill is an orchestrated run, and says so:
     ```bash
     "$DOFLOW" readiness --task-class "<template from step 2>" --task-id "<task id>" --mode workflow --json
     "$DOFLOW" evidence --task-id "<task id>" --json
     ```
   - **Both `--task-class` and `--task-id` are required; act on `stageEntry.decision`, never on the exit
     code or your own reading of `state`.** The rest of acting on a verdict, the four states, and which
     classes have templates: `references/readiness_gate.md`. Dispatch no task until the run's record,
     below, is `READY`.
   - **The run's record comes first.** The handoff, `verify` and the edit hook read the record
     keyed on the feature slug (the run's task id), so before the first dispatch record the
     `affected_components` evidence, then evaluate with the plan's stated inputs:
     ```bash
     "$DOFLOW" evidence --task-id "<slug>" --action add --batch <batch>.json --json
     "$DOFLOW" readiness --task-class "<template from step 2>" --task-id "<slug>" --mode workflow \
       --verification-plan "<plan.md §7 Validation Strategy>" --scope "<comma-separated paths from plan.md §4>" --json
     ```
     The batch holds one item: `kind` `structural` or `semantic-retrieval`, `provenance`
     `extracted`, `locator` a file in this repository (`plan.md`), `establishes`
     `["affected_components"]`, and `content` summarizing the components and files `plan.md` §4
     lists (schema: the guidance tree's `references/EVIDENCE_LEDGER.md`). `scope_clear` and
     `verification_plan` come from the two stated inputs; `--scope` as a path list is also what
     `verify` bounds the change by. A refusal names the command to run again.
   - Do not recall the contract from memory — the templates are versioned and the command reads
     them. This skill's own `references/readiness_gate.md` carries the per-class requirements, what each state
     means, and exactly which input produces it. Read it before acting on a verdict, and never
     write `READY` yourself: the gate did not say it.

5. **Scaffold Generation (`--scaffold`)**:
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

6. **Task Selection & Parallel Dispatch**:
   - Read the guidance tree's `references/ORCHESTRATION.md` before dispatching agents;
     it governs briefs, tools, running work, verification, and questions.
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
   - Before dispatching each task, compile its prior context — the same plan task id step 4 graded:
     ```bash
     "$DOFLOW" context-pack --task-id "<task id>" --json
     ```
     **Exit 1 means the pack came back empty; exit 3 means overflow: the pack is complete, act on
     `overflowAction.message` and report the gap.**
     An empty pack does not withhold dispatch; what the brief must then say: `references/parallel_dispatch.md`.
   - Claim each task before dispatch and finish it with evidence: `references/task_attempts.md`
     (the evidence item schema: the guidance tree's `references/EVIDENCE_LEDGER.md`).
   - Dispatch each task to its plan `owner` (an agent spec).
   - Name a model tier on every dispatch — an omitted tier inherits the session's model. Pass the
     tier from task-brief's `record.tier` as the dispatch model; for review passes and the limit
     where a harness honors only `model: inherit`, see `references/MODEL_SELECTION.md`.

7. **Batch the Phase's Evidence**:
   - One pass at each phase boundary, never one call per fact. Use the plan task id — the same id
     step 4 graded — for every `evidence`, `claim` and `readiness` call about that task; a
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
     contradiction becomes `conflicted`, which is what makes step 4 report `BLOCKED`.

8. **Update `state.md`**:
   - One checkpoint per phase (or per task, on a `--scope next` run), immediately after step 7's
     evidence/claim batch for that phase — same boundary, not a separate pass to remember later.
   - No `<feature_dir>/state.md` yet: create it from the template. The template is
     `templates/doflow/state-template.md` in the install step 1 resolved: take `constitution_base`
     from that JSON and swap its trailing `guidance/references/CONSTITUTION_BASE.md` for that path.
     Fill `[PLAN_PATH]` from that same resolution's `plan` field, verbatim (repo-root-relative,
     exactly as the resolver returns it) — `state.md` and `plan.md` both sit at the feature dir's
     own root under both layouts, the same single shared location, and the resolver's own field is
     what confirms it rather than a hand-computed guess.
   - Every checkpoint updates the Task Ledger and rewrites the status sections in place, per
     `references/state_checkpoint.md`; a write failure there is reported, never a task failure.

9. **Phase Quality Review** (`--review`, opt-in):
   - Off by default. With `--review`, review each phase on completion for spec compliance before
     advancing. Without it no per-phase review runs: the completion summary says "per-phase review:
     not requested"; review at `/do-code-review` after the test stage (or the caller's final review).

10. **Record the Handoff**:
    - Before recording it, follow the decision step in the guidance tree's
      `references/WORKFLOW_HANDOFF.md`.
    - Once per invocation, at the last `state.md` checkpoint, on step 3's `caughtUpTo` (`references/handoff_record.md`).
    - **First: is this run a completion or a checkpoint?** Count `plan.md`'s still-unchecked task
      lines with `grep -cE '^- \[ \] [A-Z]+\.[0-9]+'`. The task-id prefix is load-bearing: a bare
      `^- \[ \]` also matches the plan's own `- [ ] All tasks checked` completion-criteria line, so
      it reports a remaining task on a finished plan and records a checkpoint where a completion
      was owed. Any genuinely remaining task makes this handoff a checkpoint (`annotate`, never
      `complete-stage`); zero remaining is the completion flow. Both branches, their exact
      commands, the readiness record the handoff reads, and how to report the
      resulting `disposition`: this skill's own `references/handoff_record.md`. Read it before
      running this step.

**Stop when** every review finding the contract names has an answer or a stated gap, **and** the last round produced no new review finding. A round that only restates what you already have is the last round. Report the remaining gaps rather than continuing.

## Embedded feature research

For an external fact gap or explicit request, follow the conditional protocol in `../do-document/references/embedded-research.md` before stage completion.

## Boundaries
**Will:** Propose a task class and have the runtime validate it, put the approval gate standing
before this stage to the user — but only when the run still reports it open — and record their
answer, execute planned tasks with subagents, consult the readiness contract per task, batch each
phase's evidence and claims, ensure write-set isolation, and record the stage handoff through
`orchestrate`/`render-audit` — as a completion when every plan task is checked, as a checkpoint
annotation when this run finished only part of the plan.
**Will Not:** Bypass missing spec artifacts, modify source code while readiness reports `BLOCKED`,
hand this stage off while any plan task is still unchecked, re-ask a gate the run no longer reports
as open, execute under a class the runtime rejected or replaced with `feature`,
call `readiness` for a stage that declares no template; or express evidence, an estimate or readiness as a number, a percentage or a confidence.
