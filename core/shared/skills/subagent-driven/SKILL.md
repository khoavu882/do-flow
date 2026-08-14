---
name: subagent-driven
description: "Execute a plan's tasks by grouping implementer dispatches by (phase, owner), then batching the spec/quality review one phase at a time and running a bounded fix loop before the phase counts as done. Use when executing plan.md's task checklist with review, either through /do-execute-plan or standalone against an existing plan."
argument-hint: "[--task=<id>|--phase=<X>|--all] [--review|--no-review] [--sync] [--group|--no-group]"
disable-model-invocation: true
effort: high
---

# subagent-driven

The task-execution engine for `plan.md`'s checklist: implementer dispatches grouped by `(phase, owner)`,
then a two-verdict review of the whole phase once every task in it reports done, and a bounded fix loop
before the phase counts as done. `/do-execute-plan` delegates its task loop here; it can also run standalone
against an existing plan.

**Why phase-owner grouping, not per-task dispatch:** multiple tasks sharing an owner within a phase are
executed sequentially by a single implementer subagent. This eliminates agent startup and repeated prompt/system
loading costs, serializes same-owner edits safely without false conflict warnings, and preserves clean
context boundaries between distinct phases and owners. Cross-owner groups still dispatch concurrently.

**Why phase-batched review, not per-task:** a phase's tasks are parallel precisely because they touch
disjoint files serving related requirements. Reviewing the phase as a unit lets the reviewer judge whether
the pieces are consistent with each other, not just individually correct, and costs one dispatch instead
of N.

**Why fresh subagents:** a dispatched agent inherits none of this conversation, so you construct exactly
what it needs — which also leaves your own context free to coordinate. Everything you paste into a dispatch
and everything an agent prints back stays resident for the rest of your run and is re-read on every later
turn. **Hand artifacts over as file paths, never as prompt bodies.**

## Invocation
```text
/subagent-driven [--task=<id>|--phase=<X>|--all] [--review|--no-review] [--sync] [--group|--no-group]
```

Run from a top-level context, not from inside a dispatched agent: at least one harness blocks a
subagent from dispatching further subagents outright, and this skill's whole job is dispatching.

## Behavioral Flow

**Cross-client clarification:** every `AskUserQuestion` below means the mechanism in
`RULE_04_QUESTIONS.md` — that tool in Claude Code; in Codex or Gemini, a stage question file whose
`[Answer]:` tags you wait for.

1. **Resolve paths.** In group mode (default), run `do-exec-paths.sh --group=<phase>:<owner> --tasks=<csv>`
   for each group you will touch and use the `workspace`, `group_brief` and `reports[]` values it emits.
   In single-task mode or with `--no-group`, run `do-exec-paths.sh --task=<id>` and use `workspace`,
   `brief` and `report`. Never construct one of those paths yourself. When invoked by `/do-execute-plan`,
   take the feature slug it passes and forward it as `--slug=`.

2. **Pre-flight scan, once, before the first dispatch.** Read the plan once and look for tasks that
   contradict each other or the constraints they inherit, and for anything the plan mandates that
   the review rubric in `task-reviewer-prompt.md` would call a defect. Present everything you find
   as **one batched `AskUserQuestion`** — each finding beside the plan text that mandates it, asking
   which governs — before execution begins. Not one interruption per discovery mid-run. A clean
   scan proceeds without comment. The review loop remains the net for conflicts that only surface
   once code exists.

3. **Check write-set disjointness and form groups before any fan-out.** Run
   `do-parallel-check.sh --phase=<X>`.
   - **Group mode (default):** Read `groups[]`, `group_overlaps[]`, `group_serialize[]`, and `unowned_tasks[]`.
     Dispatch concurrently only the groups whose union files are disjoint (`group_overlaps[]` is empty);
     **serialize whatever groups appear in `group_serialize[]` and say so**.
     Report the task-to-dispatch mapping at run start (e.g. `Phase A: 5 tasks → 2 dispatches (A.1–A.4 as A:backend-architect, A.5 as A:devops-architect)`).
     Where grouping serializes same-owner tasks marked `[P]`, explicitly state the wall-clock trade
     (FR-009, NFR-002, NFR-003).
   - **`--no-group` mode:** Disregard `groups[]`; dispatch concurrently only the `[P]` tasks `parallel_tasks[]`
     reports safe, and serialize `serialize[]`.
   - **With `--sync`:** Skip fan-out entirely and run every group/task in dependency order — and report
     that fan-out was suppressed, so a serial run is never mistaken for a plan with no parallel-safe work.
   Never dispatch two implementers concurrently onto overlapping files.

4. **Record `PHASE_BASE` once, before that phase's first dispatch.** `git rev-parse HEAD`. Every
   task in the phase, and the phase's own review package, diffs against this one SHA — never a
   per-task snapshot, or the phase's review would miss whatever landed between two of its tasks.

5. **Per group — dispatch the implementer.** In group mode, run
   `do-task-brief.sh --group=<phase>:<owner> --tasks=<csv>`. In `--no-group` mode, run
   `do-task-brief.sh --task=<id>`.
   - Derive the group's model tier as the **highest tier any task in the group requires** (FR-006;
     see `references/MODEL_SELECTION.md`).
   - Dispatch [implementer-prompt.md](implementer-prompt.md) with the group brief path, the ordered
     per-task report paths, the group's `owner:` as the subagent type, and the derived tier.
   - If the brief reported anything in `missing[]`, say so in the dispatch — a thin brief must be visible
     to its reader.
   Keep the dispatch to this group: no summaries of earlier phases. Note the agent's identity, so a
   fix round can resume it where the harness allows.

6. **Handle reports and grouped replies as they land.**
   The implementer executes each task in order, committing and writing that task's report before
   beginning the next task. If an implementer encounters a `BLOCKED` task, it stops remaining tasks
   in that group (stop-at-blocker).
   
   Handle the reply status for each task:

   | Status | What you do |
   |---|---|
   | `DONE` | Mark the task ready. Once every task in the phase is ready, go to step 7 |
   | `DONE_WITH_CONCERNS` | Read the concerns first. Correctness or scope → resolve before marking ready. An observation → note it and mark ready |
   | `NEEDS_CONTEXT` | Supply what was missing and re-dispatch |
   | `BLOCKED` | Assess: context problem → add context; needs more reasoning → higher tier; too large → split it; plan is wrong → ask the user. Remaining unattempted tasks in the group remain pending. |

   Never re-dispatch the same tier against unchanged inputs after `BLOCKED`. If the implementer says
   it is stuck, something must change. If it asks a question, answer it properly rather than pushing
   it back into implementation. A phase does not move to review until every one of its tasks — the
   parallel-dispatched groups and any serialized groups alike — has reported `DONE` or a resolved
   `DONE_WITH_CONCERNS`.

7. **Review the phase** — unless review is off for this run (see **Review mode**). Run
   `do-review-package.sh --task=<any task id in this phase> --base=<PHASE_BASE> --head=<HEAD>` —
   the `--task` value only resolves the shared workspace path (every task in a feature shares one
   `exec/` workspace), and the output file is named by SHA range, not by task, so which one you pass
   is immaterial. Dispatch [task-reviewer-prompt.md](task-reviewer-prompt.md) with **every group's**
   brief path in the phase (or per-task brief paths under `--no-group`), **every task's** report path,
   the one diff path, and the union of every task's **Global constraints** block copied verbatim as
   the reviewer's lens. Use the `PHASE_BASE` you recorded, never `HEAD~1`.

   Both verdicts are required, and both cover the phase as a unit — one spec verdict, one quality
   verdict, with each finding attributed to the specific task/file it belongs to. An implementer's
   self-review never substitutes. A ⚠️ cannot-verify item does not block the review, but **you**
   must resolve each one before completing the phase — you hold the cross-task context the reviewer
   lacks. A ⚠️ you confirm as a real gap becomes a finding and enters the loop.

8. **The fix loop — three rounds maximum, per phase.** It triggers on spec ❌, any Critical or
   Important finding, or a ⚠️ you confirmed. Two routes leave immediately: **Minor** findings never
   enter the loop (record them in the ledger as deferred and let the final review triage them), and
   a **plan-mandated** finding is the user's call — present it beside the plan text and ask which
   governs.

   One round is one fix dispatch per affected group/task, plus one scoped re-review of the whole phase:

   - **Rounds 1–2** — route each finding to the implementer/group that owns the file it names, and resume
     that implementer with its open findings verbatim. (A finding naming a file no task in this
     phase owns is a plan or brief defect — stop and ask, don't guess an owner.) Where the harness
     cannot continue a live subagent, dispatch a fresh one with that group's brief path, report path(s),
     and the findings; the report file is the persistent memory either way, so this costs a re-read
     rather than correctness. Findings against different groups fix concurrently, under the same
     write-set-disjointness rule as the initial dispatch.
   - **Round 3** — for each task/group still carrying open findings, dispatch a fresh implementer one tier
     higher, framed plainly: prior attempts failed, the report file says what was tried. A loop that
     survives two resumes usually means the implementer cannot see its own problem, so change both
     context and capability at once.
   - **Every round** — each implementer re-runs the tests covering its own amended code and appends
     a fix report to its own report file. Confirm every touched task's report names the covering
     tests, the command, and the output before you re-review. Then run
     `do-review-package.sh --task=<any task id in this phase> --base=<FIX_BASE> --head=<HEAD>`,
     where `FIX_BASE` is the head the previous phase review saw, and dispatch
     [re-review-prompt.md](re-review-prompt.md) scoped to the whole phase's fix diff.
   - Record each round in the ledger before starting the next.

   **Never fix findings yourself.** A controller fix pollutes the context you need for coordination
   and skips review entirely.

9. **The breaker.** When round 3's re-review still leaves findings open, stop dispatching and rule
   on each one yourself:
   - **Wrong or contestable** → park it with the ruling that says why the code stands
   - **Real, but nothing downstream depends on it** → park it, recorded as real and deferred
   - **Real and load-bearing** — a later phase builds on it, or it exposes a plan defect → **stop**.
     Record `BLOCKED` and report to the user with the finding, the plan text it collides with, and
     the fix history. Parking a structural failure lets every dependent phase build on it.

   Adjudicate **only** at the cap. Doing it earlier to end a loop is pre-judging under another name.
   Every ruling is a ledger entry; a silent discard is not available.

10. **Record, then move on.** Once the phase's review is clean — or every open finding is parked or
    adjudicated — append every task in the phase to `state.md`'s Task Ledger: commit range, rounds
    used, review outcome, status, plus any parked ruling or deferred minor in its Findings section.
    Check every task's `- [ ]` box in `plan.md`. Then take the next phase without pausing to ask
    whether to continue: the user asked for these tasks to be executed. Stop only for a blocker you
    cannot resolve, an ambiguity that genuinely prevents progress, or completion.

## Grouping mode

`--group` (the default) groups tasks by `(phase, owner)` into single dispatches. `--no-group` restores
per-task fan-out. Report the resolved grouping mode and the task-to-dispatch count mapping at the start
of every run (FR-007, FR-009, NFR-002).

## Review mode

`--review` forces the loop on, `--no-review` forces it off. The default is **auto**: on for `--all`,
off for `--task` and `--phase`. Batching is always by phase regardless of how much of the run this
flag covers — selecting a single `--task` reviews that task alone (a phase of one), selecting
`--phase` or `--all` reviews each phase together as its tasks finish. Report the resolved mode at
the start of every run — whether a phase was reviewed must never be ambiguous after the fact.

## Model selection

Read `references/MODEL_SELECTION.md` and name a tier on every dispatch — implementer, reviewer, and
re-reviewer alike. An omitted tier inherits the session's model, typically the most capable and most
expensive available, which defeats the policy silently. Where a harness cannot express a tier per
dispatch, fix it in the dispatched agent's own definition instead. For grouped dispatches, the tier is
the highest tier required by any task in the group (FR-006).

## Behavioral Posture

Before starting, read `modes/MODE_Task_Management.md` in the shared guidance tree for the
task-hierarchy and delegation posture it sets. That file is loaded on demand through this skill — it
has no other trigger, so skipping the read silently drops the posture it defines.

Narrate at most one short line between tool calls. The ledger and the tool results carry the record.

## Common rationalizations

| Excuse | Reality |
|---|---|
| "Close enough on spec compliance" | A spec gap means not done. Fix it, or reach the cap and adjudicate — those are the only exits. |
| "I'll just fix it myself, dispatching is overhead" | A controller fix skips review and spends the context you need to coordinate. Resume the implementer. |
| "One more round will converge" | Past the cap, rounds do not converge — the failure is structural. Adjudicate and route. |
| "This finding is obviously wrong, I'll drop it" | You adjudicate at the cap, and every ruling is a ledger entry. Silent discards are not available. |
| "The fix was tiny, skip the re-review" | Unreviewed fixes are how regressions land. Every round ends with a scoped re-review. |
| "The reviewer will just find something else anyway" | A scoped re-review verifies the phase's fixes; it cannot wander. Findings outside the fix diff go to the ledger. |
| "Ledger bookkeeping is overhead" | The ledger is what survives a compact. Without it, completed tasks get re-dispatched. |
| "I'll paste the last three tasks' state so it has context" | A fresh subagent needs its brief, its interfaces, and its constraints. Pasted history is the largest avoidable context cost there is. |
| "This one task is ready, review it now" | Review waits for the whole phase — reviewing early defeats the reason phases batch: judging the pieces together, once. |

## Boundaries

**Will:** scan the plan for conflicts once up front, form dispatch groups by (phase, owner) and check union-overlap
disjointness before fan-out, dispatch implementers with composed briefs, review each phase together for spec
compliance and quality once every task in it is done, run a bounded fix loop per phase, adjudicate
at the cap, and record every task and ruling in `state.md`.

**Will Not:** write `requirement.md`/`design.md`/`plan.md` (that is `/do-brainstorm`, `/do-design`,
`/do-plan`), fix findings in the controller context, pre-judge findings for a reviewer, skip a
review because a diff looked small, review a task before every other task in its phase has reported,
dispatch concurrent implementers onto overlapping files, commit on the user's behalf beyond each
task's own commit, or run nested inside another dispatched agent.

## CRITICAL BOUNDARIES

Requires a `plan.md` with a task checklist. Output: code, checked-off tasks, and an updated
`state.md` Task Ledger.

**Next Step:** `/do-code-review` for the broad review of the whole change — point it at the ledger's
deferred and parked findings so it can triage them.
