---
name: do-implement
description: "Direct, standalone code implementation from a description, /do-code-review findings, or an existing task — no DoFlow chain artifacts required. Use whenever the user asks to implement, build, add, or fix something without a formal brainstorm-design-plan sequence, or says 'now implement that' / 'fix what the review found' / 'let's just build this' / 'address these comments'. Works in any repo, chain-instrumented or not — make sure to trigger this even if the user never mentions DoFlow by name."
argument-hint: "[description of the change] [--from-review]"
effort: medium
---

# do-implement

A standalone extension skill, not a numbered phase of the DoFlow chain (`do-brainstorm → do-design
→ do-plan → do-execute-plan → do-test → do-code-review`). Implements directly from whatever
context is fed to it — a plain-language description, `/do-code-review`'s findings, or a pointer to
an existing `requirement.md` / `design.md` / `plan.md` — without requiring any of those artifacts
to exist first. `/do-execute-plan` is the chain's own implementation phase, built for orchestrating
a full `plan.md` task checklist through specialist subagents with prerequisite gates; reach for
this skill instead when there is no task checklist to orchestrate — a one-off fix, a described
feature, or a batch of review comments to work through right now.

## Invocation
```text
/do-implement [description of the change] [--from-review]
```

- With no arguments, and a `/do-code-review` (or `/code-review`) run earlier in the conversation:
  `--from-review` is implied — work through that review's findings.
- With a description: implement exactly what is described.
- Either form may also name an existing artifact (`requirement.md`, `design.md`, a linked issue, a
  specific `plan.md` task) as extra context. Reading it is welcome; it is never required.

## Behavioral Flow

Every DoFlow runtime call in this skill goes through the runtime seam. Resolve it **once** here and
reuse `$DOFLOW` for every later call in this skill:

```bash
# Resolve the DoFlow runtime: nearest project install wins, then the global one.
D=$PWD; while [ "$D" != / ] && [ ! -x "$D/.doflow/scripts/doflow/bin/doflow-run" ]; do D=$(dirname "$D"); done
DOFLOW="$D/.doflow/scripts/doflow/bin/doflow-run"
[ -x "$DOFLOW" ] || DOFLOW="$HOME/.doflow/scripts/doflow/bin/doflow-run"
[ -x "$DOFLOW" ] || { echo "doflow: no runtime found in any .doflow/ above $PWD, nor at $HOME/.doflow. Run: npx @khoavu882/doflow install" >&2; exit 2; }
```
Run every command below from the project root — the walk-up starts at `$PWD`. On exit 2, print the message verbatim and stop; it names every path searched.

1. **Gather context — don't demand it**:
   - Invoked after `/do-code-review` or `/code-review` in this conversation, or with
     `--from-review`: treat that review's findings as the work list, most-severe first, in the
     order the review itself ranked them.
   - Invoked with a description: treat that as the work list directly.
   - If the current branch has an active DoFlow feature (`"$DOFLOW" paths --json` resolves a
     `feature_dir`) and its `plan.md` already has a task matching the request, say so and offer
     `/do-execute-plan` instead — that machinery exists for exactly this case, and duplicating it
     here would just be a second, worse orchestrator. Proceed directly only if the user confirms
     the lighter path, or if no such plan or matching task exists.
   - Never block on a missing `requirement.md` / `design.md` / `plan.md`. Those artifacts are the
     chain's business, not a precondition of this skill.

**Stop when** every work-list finding the contract names has an answer or a stated gap, **and** the last round produced no new work-list finding. A round that only restates what you already have is the last round. Report the remaining gaps rather than continuing.

2. **Understand before writing**:
   - Read the files the change touches and their immediate neighbors — naming conventions, error
     handling style, test structure — before writing anything. Evidence over assumption applies
     here exactly as everywhere else in DoFlow: match what the codebase already does rather than
     importing an unrelated house style.

3. **Name the change set, then stop**:
   - Before touching anything, write the change set out file by file: each file to be edited, the
     change it takes, and what that change is for. Name what you are deliberately leaving alone.
   - Stops after producing the change set; never begins edits here. The pass that decides what to
     change is not the pass that makes it — deciding and typing in one move is how the first
     plausible shape becomes the design.

4. **Implement**:
   - Make the change. Keep it scoped to what was asked — no bonus refactors, no speculative
     abstractions (the same scope-discipline rule the chain's own artifacts would otherwise remind
     you of; here, hold yourself to it directly).
   - Add or update tests when the codebase already has a test convention to extend; skip it when
     there is not one, rather than inventing a test harness the project doesn't otherwise use.

5. **Verify — name the check set before running it**:
   - First, list the build/test/lint commands you found and where each came from (`package.json`
     scripts, a `Makefile`, an obvious test runner config). That list is the contract for this
     step; state it before running anything.
   - Then run each one and report its result against that list. A command the list named and the
     run did not reach is reported as not run, and a command the project does not have is reported
     as absent — neither is dropped from the report. Never mark something done against a failing
     suite.

6. **Report and hand off**:
   - Summarize what changed, file by file, and why — not a restatement of the diff.
   - Suggest `/do-code-review` as the natural next step, mirroring the pointer that skill's own
     "Next Step" section already sends back here. If a chain feature's `plan.md` task happened to
     get addressed along the way, say so explicitly rather than silently — `plan.md` bookkeeping
     itself stays `/do-execute-plan`'s responsibility, not this skill's.

## Boundaries

**Will:** Implement directly from a description, review findings, or a named task; read and match
existing repo conventions before writing; run whatever test/lint suite the project already has;
work in any repo, whether or not it uses the DoFlow chain at all.

**Will Not:** Require or generate `requirement.md` / `design.md` / `plan.md`; orchestrate a
multi-task checklist through specialist subagents — that is `/do-execute-plan`'s job once a real
plan exists; silently override the repository's own `pre-implement-gate` hook. That hook triggers
on any `Edit`/`Write` call, not on which skill made it — a branch mid-chain with a started feature
but no `design.md` still gets blocked here exactly as it would anywhere else, and that is by
design, not a gap this skill works around.
