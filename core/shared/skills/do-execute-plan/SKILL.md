---
name: do-execute-plan
description: "Execute plan.md's task checklist: subagent-driven orchestration over named specialist archetypes (system-architect, core-implementer, quality-guardian) with prerequisite gates, readiness contracts, and parallel execution. Use whenever requirement.md, design.md, and plan.md exist and the next step is building the plan's tasks through subagents, or when the user says 'execute the plan', 'run the plan', 'start building', or 'implement phase N'. Always activate this skill to orchestrate multi-task implementation plans with write-set isolation."
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
   - Also derive `<expected gate id>`: among `gates[]`, the one entry whose `afterStage` equals the
     stage immediately preceding this skill's own stage in `stageIds[]` (`gate-a` in `feature`, since
     `gate-a`'s `afterStage` is `planning`, the stage right before `implementation`) — `null` if no
     gate is anchored there. No shipped workflow anchors two gates to the same stage, so this is
     always at most one entry; do not hardcode `gate-a`, derive it this way so a differently-shaped
     workflow's own gate is found the same way. Step 3 needs this to tell "the gate that belongs to
     this stage" apart from any other gate `catch-up` might stop on.

3. **Position the Run, and Resolve the Approval Gate Standing Before This Stage**:
   - This stage is the one the accepted workflow anchors an `approval`-kind gate directly *before*
     (`gate-a`, "Before implementation", in the `feature` workflow — the gate whose `afterStage` is
     the stage preceding this skill's own). `/do-plan` deliberately leaves it open: an approval gate
     is answered by the human who is asked, and this skill is where that question lands when nothing
     else has already asked it. Until it is decided, the state machine refuses this stage's own
     completion, so resolve it here rather than at step 10.
   - `<slug>` is step 1's `feature_slug`; `<class>` is the class step 2's `classify` call accepted;
     `<stage id>` is the id of the entry in that call's `workflow.stages[]` whose `skill` is
     `do-execute-plan` (`implementation` in the `feature` workflow) — read it off that response,
     never hardcode a guess. One call positions the run: it starts one when none exists yet (an
     old-layout feature, or a chain that skipped straight here), backfills any earlier non-mutating
     stage as a routine handoff (marked `backfilled` in the trail, distinct from a stage its own
     skill actually completed), and stops on the node this skill must act on — or on any gate in the
     way, `clarification`-kind included, since only a human or that gate's own owning skill may
     decide it.
     ```bash
     "$DOFLOW" orchestrate --action catch-up --task-id "<slug>" --task-class "<class>" --stage "<stage id>" --note "entering implementation" --json
     ```
   - Branch on the response's `caughtUpTo` / `reason`, not on the exit code:
   - **`reason` is `awaiting-gate:<gate id>`** — **first check `<gate id>` against step 2's
     `<expected gate id>`.** They match in the ordinary case (`gate-a`, standing immediately before
     this stage) — present `awaitingGate.prompt` to the user through `AskUserQuestion` as a plain
     go/no-go, the same way step 1's prerequisite gate stops and asks rather than assuming. On yes:
     ```bash
     "$DOFLOW" orchestrate --action decide-gate --task-id "<slug>" --gate "<awaitingGate.gateId>" --decision approve --note "<the user's own answer, one line>" --json
     ```
     Then re-run the same `catch-up` call to land on this stage. If that re-run itself stops on
     *another* `awaiting-gate:`, re-apply this same check from the top — do not assume one approval
     clears the path; walk it exactly as far as it goes. On no: **stop the whole run here.** The gate
     is terminal in the same sense step 1's prerequisite gate is — report that the gate was not
     approved and dispatch nothing.
     **They do not match** — this is a gate belonging to an earlier stage, not this one. `gate-0`,
     left open by an aborted `/do-brainstorm` session, is exactly this case: it now surfaces here
     (catch-up stops on every gate, `clarification`-kind included) instead of being silently
     resolved on the way past. Report the gate id plainly and stop, the same way `do-design`,
     `do-plan`, `do-test` and `do-brainstorm` already handle a gate that isn't theirs. Never approve
     a gate this stage did not expect regardless of what the user answers — a "yes" given in an
     implementation context is not an answer to a different stage's clarification prompt, and
     `reject`'s "terminate the run outright" semantics are the wrong shape for a gate this stage has
     no standing to decide either way.
   - **`caughtUpTo` is this stage id** (`reason: reached-candidate`) — the run is positioned exactly
     here and there is no gate to ask. That covers three cases at once and needs no special-casing
     between them: `/do-flow` already recorded the user's answer to that gate while driving the
     chain, this skill just recorded it in the branch above, or the accepted class declares no gate
     at all — `feature` is the only shipped class that declares any. Never ask a gate the run does
     not report as open; that is exactly the double-prompt this branch exists to prevent. Carry this
     `caughtUpTo` value to step 10; it is the stage id that call completes.
   - **`reason` is `blocked-on-mutating-stage:<id>`** — a *different* source-mutating stage sits
     ahead of this one and its own skill has not executed it. Name `<id>`, report the block plainly,
     and dispatch nothing.
   - **`reason` starts with `already-completed:`** — this stage was already recorded on an earlier
     run of this skill (a `--scope resume` after an interrupted run, say). Use `annotate` instead of
     `complete-stage`:
     ```bash
     "$DOFLOW" orchestrate --action annotate --task-id "<slug>" --node "<stage id>" --note "<what changed on this re-run>" --json
     ```
   - **`reason` is `run-completed` or `run-rejected`** — the run is finished and takes no further
     stage. Report it and stop.
   - Positioning the run is advisory to the trail, not to the work: if the `catch-up` call itself
     fails for a reason outside this flow's control (an unwritable local state directory, say),
     report the failure plainly and continue — the hard prerequisite gate step 1 already enforced is
     what governs whether this run may proceed. A user's explicit "no" above is not that case; it
     stops the run.

4. **Readiness Evaluation (Contract State)**:
   - Evaluate a task's contract before dispatching it, run from the project the task belongs to.
     This skill is an orchestrated run, and says so:
     ```bash
     "$DOFLOW" readiness --task-class "<template from step 2>" --task-id "<task id>" --mode workflow --json
     "$DOFLOW" evidence --task-id "<task id>" --json
     ```
   - **Both `--task-class` and `--task-id` are required.** Omitting either exits 2 and names the
     valid set. Pass them explicitly rather than letting anything default: a verdict computed for
     another task, or against another class's contract, is worse than no verdict.
   - **Act on `stageEntry.decision`, not the exit code and not your own reading of `state`.** The
     entry policy is the runtime's: `ENTER` → dispatch the task; `GATHER_FIRST` → gather the named
     requirements before dispatching; `ASK_USER` → ask the owed decision and wait; `STOP` → stop
     and surface the conflicted claim. The four underlying states remain the entire state
     vocabulary — `READY`, `NEEDS_EVIDENCE`, `NEEDS_USER_DECISION`, `BLOCKED` — and none of them is
     ever reported as a number, a percentage, or a confidence.
   - Only `bug`, `feature`, `refactor`, `trivial-edit` and `dependency-change` have templates. On
     any other class the verb exits 1 and lists the valid keys; that is the correct answer, not a
     gap to route around.
   - All four states are reachable, so a verdict is about this task rather than about the runtime:
     `NEEDS_EVIDENCE` until step 7's batch is recorded, `READY` once the recorded evidence and the
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
     **Exit 1 means the pack came back empty.** Unlike design and plan, this call sits right at the
     point a subagent is about to be handed the task and told to act — so proceeding as though
     nothing happened is exactly the failure this feature exists to remove. An empty pack here can
     still be legitimate: step 4 lets a task reach `READY` on `callerAsserted` inputs alone, which
     link no evidence. Do not withhold dispatch on this alone — readiness already governs whether the
     task may be worked. Instead, carry the empty result into the group's brief itself: state in the
     dispatch, next to the task-brief output, that no prior evidence or claims were compiled for this
     task, so the subagent works from the plan/design text `task-brief` already supplies without
     assuming a grounding evidence base that isn't there. A non-empty pack is included in the brief
     as the subagent's prior context, same handoff.
   - Dispatch tasks to appropriate specialist archetypes:
     - Architecture & Schema $\rightarrow$ `system-architect`
     - Code Implementation & Refactoring $\rightarrow$ `core-implementer`
     - Test Automation & Quality $\rightarrow$ `quality-guardian`
   - Name a model tier explicitly on every dispatch — an omitted tier silently inherits the
     session's model rather than "using the default." Consult
     the guidance tree's `references/MODEL_SELECTION.md` for how to pick the tier per task and per
     review pass.

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
     exactly as the resolver returns it) — `state.md` sits at the feature dir's own root under both
     layouts, but `plan.md` does not: `<feature_dir>/plan.md` under the legacy layout,
     `<feature_dir>/plan/plan.md` under the structured one, and the resolver's own field is what
     tells you which.
   - Every checkpoint: append the finished task(s) to the Task Ledger (`Commits` as the actual
     `[base7]..[head7]` range once committed, or `uncommitted (working tree)` when this run doesn't
     commit on its own), move them from **In Progress** to **Completed**, and rewrite **Next
     Action** to name the next pending task — so a resumed session (or a different one) can pick up
     from this file and `git log` alone, per `state-template.md`'s own header note, never from
     conversation memory. A `Findings` entry records a review finding deliberately left unfixed
     (rare); write "None." otherwise rather than omitting the section.
   - This is bookkeeping, not a gate: a write failure here degrades resumability, not correctness —
     report it and continue rather than treating it as a task failure.

9. **Phase Quality Review** (`--review`):
   - Review each phase upon completion for spec compliance before advancing. This runs by default;
     `--review=false` is the only way to skip it, and skipping it is reported in the phase's
     completion summary rather than passing silently.

10. **Record the Handoff**:
    - Once per `/do-execute-plan` invocation, at the last `state.md` checkpoint this run writes —
      not once per phase, since the stage hands off once however many phases it executed. The stage
      id is step 3's `caughtUpTo`, which the run is already positioned on; there is no second
      `catch-up` call and no `status` call to make here.
    - **First: is this run a completion or a checkpoint?** Re-read `plan.md`'s task checklist and
      count the task lines still unchecked. A real task line matches `^- \[ \] [A-Z]+\.[0-9]+` (a
      phase letter, a dot, a number — `- [ ] B.2`); the pattern deliberately excludes the generic
      `- [ ] All tasks checked` line in the plan's own "Completion criteria" section, which carries
      no phase-letter id and is not a task.
      ```bash
      grep -cE '^- \[ \] [A-Z]+\.[0-9]+' "<plan path>"
      ```
      **Any such line remaining means this run's handoff is a checkpoint, not a completion** — the
      normal outcome of a `--scope next` or `--scope phase:N` run, which finishes some of the plan by
      design. Record the checkpoint and stop; do **not** attempt `complete-stage`, which would hand
      the stage off while tasks nobody executed are still open:
      ```bash
      "$DOFLOW" orchestrate --action annotate --task-id "<slug>" --node "<stage id>" --note "<checkpoint: N of M tasks done, scope was --scope next|phase:X>" --json
      ```
      Only when zero such lines remain does the completion flow below run.
    - **Then: give the readiness cascade its real inputs before completing.** This stage is the
      workflow's `mutatesSource` stage, so `complete-stage` runs the cascade against the `feature`
      contract, whose three requirements are `affected_components`, `verification_plan` and
      `scope_clear` (`references/readiness_gate.md`). Two of them are satisfiable by a caller-stated
      input; the third is not, and attempting the call without it returns `NEEDS_EVIDENCE`.
      1. Batch **one** evidence item under the **feature slug** — deliberately different from every
         other evidence call this skill makes, which key on a plan task id, because the cascade
         grades the ledger under the slug. `kind` is `structural` or `semantic-retrieval`,
         `provenance` is `extracted`, the `locator` points at `plan.md`,
         `establishes` is `["affected_components"]` — the gate counts an item toward a requirement
         only when the item names it — and `content` summarizes the
         components and files this implementation actually touched, taken from `plan.md` §4
         "Components & Changes" — which this run already read. That is what satisfies
         `affected_components`; per `readiness_gate.md`'s own rule it cannot be satisfied by a
         caller-stated flag, and asserting it as one would misrepresent what backs it.
         ```bash
         "$DOFLOW" evidence --task-id "<slug>" --action add --batch <batch>.json --json
         ```
         An `extracted` locator must resolve in this repository — the ledger refuses a batch whose
         locator points at nothing, and refuses the batch whole rather than the item.
      2. Then complete the stage, stating the other two:
         ```bash
         "$DOFLOW" orchestrate --action complete-stage --task-id "<slug>" --task-class "<class>" --stage "<stage id>" \
           --verification-plan "<one line: how this was verified — plan.md §7 Validation Strategy, or the final phase's own results>" \
           --scope "<one line: plan.md §1 Approach>" \
           --note "<one line, e.g. tasks A.1–E.5 complete>" --json
         ```
         `--task-class` is not optional on this one call: without the class there is no contract to
         compile the cascade against. `--verification-plan` and `--scope` are inputs you **state**,
         not evidence the gate measured — the same `callerAsserted` rule step 4 sets out. Pass them
         when they are true, and say in the report which part of the verdict rests on a statement.
    - **Report the resulting state plainly.** With the evidence item recorded and both inputs stated,
      the cascade returns `READY` and the call succeeds, advancing the cursor to the verification
      stage. If it refuses anyway, that refusal stands: report the verdict and exactly what the
      message says is unmet, and fix that — do not re-run the call with a class that grades looser,
      never assert `READY`, and do not swallow the failure into an `annotate`. The `annotate` path
      above belongs to the unfinished-tasks case alone; it is not a catch-all for an unexpected
      readiness failure here.
    - No gate is anchored to this stage: the `complete-stage` response comes back with
      `awaitingGate` `null` and the cursor on the verification stage. Read that field rather than
      re-deriving it from `workflow.gates[]`, and decide no gate when it is null. Finish by rendering
      the trail — the `--slug` value attaches with an `=`; a space-separated one is rejected with an
      error rather than silently rendering the wrong feature's trail:
      ```bash
      "$DOFLOW" render-audit --slug="<slug>" --json
      ```
    - Same standing as step 8's `state.md` write: bookkeeping, not a gate. A failure here degrades
      the trail, not the correctness of the work already done — report it and continue.

**Stop when** every review finding the contract names has an answer or a stated gap, **and** the last round produced no new review finding. A round that only restates what you already have is the last round. Report the remaining gaps rather than continuing.

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
