---
name: subagent-driven
description: "Execute a plan's tasks by dispatching a fresh subagent per task, reviewing each one for spec compliance and quality, and running a bounded fix loop before it counts as done. Use when executing plan.md's task checklist with review, either through /do-execute-plan or standalone against an existing plan."
argument-hint: "[--task=<id>|--phase=<X>|--all] [--review|--no-review] [--sync]"
effort: high
---

# subagent-driven

The task-execution engine for `plan.md`'s checklist: one fresh subagent per task, a two-verdict
review after each, and a bounded fix loop before the task counts as done. `/do-execute-plan`
delegates its task loop here; it can also run standalone against an existing plan.

**Why fresh subagents:** a dispatched agent inherits none of this conversation, so you construct
exactly what it needs — which also leaves your own context free to coordinate. Everything you paste
into a dispatch and everything an agent prints back stays resident for the rest of your run and is
re-read on every later turn. **Hand artifacts over as file paths, never as prompt bodies.**

## Invocation
```text
/subagent-driven [--task=<id>|--phase=<X>|--all] [--review|--no-review] [--sync]
```

Run from a top-level context, not from inside a dispatched agent: at least one harness blocks a
subagent from dispatching further subagents outright, and this skill's whole job is dispatching.

## Behavioral Flow

**Cross-client clarification:** every `AskUserQuestion` below means the mechanism in
`RULE_04_QUESTIONS.md` — that tool in Claude Code; in Codex or Gemini, a stage question file whose
`[Answer]:` tags you wait for.

1. **Resolve paths.** Run `do-exec-paths.sh --task=<id>` for each task you will touch and use the
   `workspace`, `brief` and `report` values it emits. Never construct one of those paths yourself.
   When invoked by `/do-execute-plan`, take the feature slug it passes and forward it as `--slug=`.

2. **Pre-flight scan, once, before the first dispatch.** Read the plan once and look for tasks that
   contradict each other or the constraints they inherit, and for anything the plan mandates that
   the review rubric in `task-reviewer-prompt.md` would call a defect. Present everything you find
   as **one batched `AskUserQuestion`** — each finding beside the plan text that mandates it, asking
   which governs — before execution begins. Not one interruption per discovery mid-run. A clean
   scan proceeds without comment. The review loop remains the net for conflicts that only surface
   once code exists.

3. **Check write-set disjointness before any fan-out.** Run
   `do-parallel-check.sh --phase=<X>`. Dispatch concurrently only the `[P]` tasks it reports safe;
   **serialize whatever it lists in `serialize[]` and say so**. With `--sync`, skip fan-out entirely
   and run every task in dependency order — and report that fan-out was suppressed, so a serial run
   is never mistaken for a plan with no parallel-safe work. Never dispatch two implementers
   concurrently onto overlapping files.

4. **Per task — dispatch the implementer.** Record `BASE` (`git rev-parse HEAD`) first; the review
   package and every fix diff need it. Run `do-task-brief.sh --task=<id>`, then dispatch
   [implementer-prompt.md](implementer-prompt.md) with the brief path, the report path, the task's
   `owner:` as the subagent type, and an explicit model tier. If the brief reported anything in
   `missing[]`, say so in the dispatch — a thin brief must be visible to its reader.
   Keep the dispatch to this task: no summaries of earlier tasks. Note the agent's identity, so a
   fix round can resume it where the harness allows.

5. **Handle the report.** Four statuses, four different responses:

   | Status | What you do |
   |---|---|
   | `DONE` | Build the review package and go to step 6 |
   | `DONE_WITH_CONCERNS` | Read the concerns first. Correctness or scope → resolve before review. An observation → note it and review |
   | `NEEDS_CONTEXT` | Supply what was missing and re-dispatch |
   | `BLOCKED` | Assess: context problem → add context; needs more reasoning → higher tier; too large → split it; plan is wrong → ask the user |

   Never re-dispatch the same tier against unchanged inputs after `BLOCKED`. If the implementer says
   it is stuck, something must change. If it asks a question, answer it properly rather than
   pushing it back into implementation.

6. **Review the task** — unless review is off for this run (see **Review mode**). Run
   `do-review-package.sh --task=<id> --base=<BASE> --head=<HEAD>` and dispatch
   [task-reviewer-prompt.md](task-reviewer-prompt.md) with the brief path, the report path, the diff
   path, and the brief's own **Global constraints** block copied verbatim as the reviewer's lens.
   Use the `BASE` you recorded, never `HEAD~1`.

   Both verdicts are required. An implementer's self-review never substitutes. A ⚠️ cannot-verify
   item does not block the review, but **you** must resolve each one before completing the task —
   you hold the cross-task context the reviewer lacks. A ⚠️ you confirm as a real gap becomes a
   finding and enters the loop.

7. **The fix loop — three rounds maximum.** It triggers on spec ❌, any Critical or Important
   finding, or a ⚠️ you confirmed. Two routes leave immediately: **Minor** findings never enter the
   loop (record them in the ledger as deferred and let the final review triage them), and a
   **plan-mandated** finding is the user's call — present it beside the plan text and ask which
   governs.

   One round is one fix dispatch plus one scoped re-review:

   - **Rounds 1–2** — resume the implementer that already holds the task's context, sending the open
     findings verbatim. Where the harness cannot continue a live subagent, dispatch a fresh one with
     the brief path, the report path and the findings; the report file is the persistent memory
     either way, so this costs a re-read rather than correctness.
   - **Round 3** — dispatch a fresh implementer one tier higher, framed plainly: prior attempts
     failed, the report file says what was tried. A loop that survives two resumes usually means the
     implementer cannot see its own problem, so change both context and capability at once.
   - **Every round** — the implementer re-runs the tests covering the amended code and appends its
     fix report to the same file. Confirm that report names the covering tests, the command and the
     output before you re-review. Then run
     `do-review-package.sh --task=<id> --base=<FIX_BASE> --head=<HEAD>` where `FIX_BASE` is the head
     the previous review saw, and dispatch [re-review-prompt.md](re-review-prompt.md).
   - Record each round in the ledger before starting the next.

   **Never fix findings yourself.** A controller fix pollutes the context you need for coordination
   and skips review entirely.

8. **The breaker.** When round 3's re-review still leaves findings open, stop dispatching and rule on
   each one yourself:
   - **Wrong or contestable** → park it with the ruling that says why the code stands
   - **Real, but nothing downstream depends on it** → park it, recorded as real and deferred
   - **Real and load-bearing** — a later task builds on it, or it exposes a plan defect → **stop**.
     Record `BLOCKED` and report to the user with the finding, the plan text it collides with, and
     the fix history. Parking a structural failure lets every dependent task build on it.

   Adjudicate **only** at the cap. Doing it earlier to end a loop is pre-judging under another name.
   Every ruling is a ledger entry; a silent discard is not available.

9. **Record, then move on.** Append the task's row to `state.md`'s Task Ledger — commit range, rounds
   used, review outcome, status — plus any parked ruling or deferred minor in its Findings section.
   Check the `- [ ]` box in `plan.md`. Then take the next task without pausing to ask whether to
   continue: the user asked for these tasks to be executed. Stop only for a blocker you cannot
   resolve, an ambiguity that genuinely prevents progress, or completion.

## Review mode

`--review` forces the loop on, `--no-review` forces it off. The default is **auto**: on for `--all`,
off for `--task` and `--phase`. Report the resolved mode at the start of every run — whether a task
was reviewed must never be ambiguous after the fact.

## Model selection

Read `references/MODEL_SELECTION.md` and name a tier on every dispatch — implementer, reviewer, and
re-reviewer alike. An omitted tier inherits the session's model, typically the most capable and most
expensive available, which defeats the policy silently. Where a harness cannot express a tier per
dispatch, fix it in the dispatched agent's own definition instead.

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
| "The reviewer will just find something else anyway" | A scoped re-review verifies fixes; it cannot wander. Findings outside the fix diff go to the ledger. |
| "Ledger bookkeeping is overhead" | The ledger is what survives a compact. Without it, completed tasks get re-dispatched. |
| "I'll paste the last three tasks' state so it has context" | A fresh subagent needs its brief, its interfaces, and its constraints. Pasted history is the largest avoidable context cost there is. |

## Boundaries

**Will:** scan the plan for conflicts once up front, check write-set disjointness before fan-out,
dispatch one implementer per task with a composed brief, review every task for spec compliance and
quality, run a bounded fix loop, adjudicate at the cap, and record every task and ruling in
`state.md`.

**Will Not:** write `requirement.md`/`design.md`/`plan.md` (that is `/do-brainstorm`, `/do-design`,
`/do-plan`), fix findings in the controller context, pre-judge findings for a reviewer, skip a
review because a diff looked small, dispatch concurrent implementers onto overlapping files, commit
on the user's behalf beyond each task's own commit, or run nested inside another dispatched agent.

## CRITICAL BOUNDARIES

Requires a `plan.md` with a task checklist. Output: code, checked-off tasks, and an updated
`state.md` Task Ledger.

**Next Step:** `/do-code-review` for the broad review of the whole change — point it at the ledger's
deferred and parked findings so it can triage them.
