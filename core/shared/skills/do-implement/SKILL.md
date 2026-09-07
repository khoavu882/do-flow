---
name: do-implement
description: "Direct, standalone code implementation from a description, /do-code-review findings, or an existing task — no DoFlow chain artifacts required. Use whenever the user asks to implement, build, add, or fix something directly without a formal brainstorm-design-plan sequence, or says 'now implement that', 'fix what the review found', 'let's just build this', or 'address these comments'. Always activate this skill for one-off coding tasks, direct bugfixes, and immediate code changes even if the user never mentions DoFlow by name."
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

2. **Resolve the task id, then evaluate readiness — skip only when standalone**:
   - `<task id>` is the same unit every recording stage keys on: the plan task id when one exists,
     otherwise the feature slug that step 1's `"$DOFLOW" paths --json` resolved, or the issue id you
     were given. When none of those exist, there is nothing to look up — treat this run as standalone
     and go straight to the exemption below.
   - Check what is recorded against that id before touching anything:
     ```bash
     "$DOFLOW" evidence --task-id "<task id>" --json
     ```
   - **`evidenceCount` is 0 — standalone.** Nothing is recorded for this id, which is exactly the
     no-chain-artifacts case this skill exists to serve (FR-002). Proceed to step 3 without
     evaluating readiness and without compiling a context pack. State the exemption in step 6's
     report as prominently as a block would be stated — a skipped gate the report never mentions
     reads as a passed gate, and that silence is the failure this exemption must not become
     (NFR-004).
   - **`evidenceCount` is nonzero — not standalone.** An earlier stage already recorded work against
     this task, so resolve its class the same way every classifying stage does — proposing whichever
     of `bug`, `refactor`, `dependency-change` or `trivial-edit` the recorded work already fits.
     `do-implement` never serves `feature`; that class's implementation stage is `/do-execute-plan`.
     ```bash
     "$DOFLOW" classify --task-class "<proposed>" --calling-skill do-implement --json
     ```
     Branch on the returned `outcome`, not the exit code. `ACCEPTED` — the returned `workflow` names
     the validated class to evaluate readiness against. `REJECTED` — stop, print `message` verbatim
     (it names `validClasses`), ask the user to choose from that set, then re-validate; never
     substitute `feature` for the class that was rejected.
   - Evaluate readiness before modifying anything. `do-implement` is the declared one-off path, so
     it states that mode explicitly — the exemption is a flag, never an inference:
     ```bash
     "$DOFLOW" readiness --task-class "<validated class>" --task-id "<task id>" --mode standalone --json
     ```
     Both `--task-class` and `--task-id` are required — omitting either exits 2 and names the valid
     set. Branch on the returned `stageEntry.decision`, never the exit code or your own reading of
     `state`: the entry policy is owned by the runtime, and this verb exits 0 for every state it
     computes, so a zero exit is not a green light.
     - **`STOP`** — refuse to modify source. Report which claim is conflicted and what evidence
       disagrees, then stop. Do not edit anyway.
     - **`ASK_USER`** — a decision is owed by the user. Ask it through the `RULE_04_QUESTIONS.md`
       mechanism and wait; editing first would decide it silently on their behalf.
     - **`ENTER`** — proceed to the context-pack call below. In standalone mode this includes
       `NEEDS_EVIDENCE`: the unmet contract is reported, not enforced — relay the missing
       requirements in step 6's report rather than presenting the edit as fully evidenced.
     (`GATHER_FIRST` is the workflow-mode answer and does not arise under `--mode standalone`.)
   - Once readiness has cleared (or been confirmed non-blocking), compile the prior context:
     ```bash
     "$DOFLOW" context-pack --task-id "<task id>" --json
     ```
     This verb exits 1 on an empty pack by design — nothing recorded is not the same as nothing
     needed — and that non-zero exit is never read as success. Because this call only runs after the
     evidence check above already found something recorded for this task id, an exit 1 here means
     the compiled pack still held nothing usable (evidence with no linked claims, most likely):
     treat that as a mismatch worth naming in step 6's report, not as license to proceed as though
     there were no prior context to look for. On a normal, non-empty pack, carry its evidence and
     claims into step 4's change set instead of re-deriving what an earlier stage already
     established.
   - This step is independent of the repository's `pre-implement-gate` hook, and stays that way:
     the hook checks file existence (`requirement.md` / `design.md` / `plan.md`) on every
     `Edit`/`Write` call regardless of which skill is editing, while this step evaluates the
     readiness *contract* recorded for the task's own class. Neither may be made to depend on the
     other (FR-012) — this step is a second, independent layer sitting alongside the hook, not a
     replacement for it and not a way around it.

3. **Understand before writing**:
   - Read the files the change touches and their immediate neighbors — naming conventions, error
     handling style, test structure — before writing anything. Evidence over assumption applies
     here exactly as everywhere else in DoFlow: match what the codebase already does rather than
     importing an unrelated house style.

4. **Name the change set, then continue**:
   - Before touching anything, write the change set out file by file: each file to be edited, the
     change it takes, and what that change is for. Name what you are deliberately leaving alone.
     The pass that decides what to change is still not the pass that makes it — deciding and
     typing in one move is how the first plausible shape becomes the design — but the separation
     is an ORDERING inside this run, not a turn boundary.
   - The user asking to implement IS the authorization to implement: proceed to step 5 in the same
     run. Ending the turn here to await approval the user already gave costs a round-trip and
     duplicates the host's own edit-approval mechanisms.
   - Stop after the change set only when one of two things is true: the user asked for the plan
     rather than the change ("show me what you'd change first"), or naming the change set surfaced
     a genuine user-owned decision — then ask it per `RULE_04_QUESTIONS.md` and wait, because
     editing first would decide it silently.

5. **Implement**:
   - Make the complete change end-to-end. Never leave placeholder stubs (e.g. `// TODO: implement`),
     unimplemented mock functions, or `throw new Error('Not implemented')` placeholders in the
     produced change. Every changed component must be fully wired and functional.
   - Keep it scoped to what was asked — no bonus refactors, no speculative abstractions (the same
     scope-discipline rule the chain's own artifacts would otherwise remind you of; here, hold
     yourself to it directly).
   - Add or update tests when the codebase already has a test convention to extend; skip it when
     there is not one, rather than inventing a test harness the project doesn't otherwise use.

6. **Verify — name the check set before running it**:
   - First, list the build/test/lint commands you found and where each came from (`package.json`
     scripts, a `Makefile`, an obvious test runner config). That list is the contract for this
     step; state it before running anything.
   - Then run each one and report its result against that list. A command the list named and the
     run did not reach is reported as not run, and a command the project does not have is reported
     as absent — neither is dropped from the report. Never mark something done against a failing
     suite.

7. **Record the handoff — skip only when step 2 took the standalone exemption**:
   - Step 2's standalone exemption (`evidenceCount` 0) means there was never a task id to begin
     with — skip this step entirely; there is nothing to record against.
   - Otherwise, `<task id>` and the validated class are the same ones step 2 already resolved.
     Record this skill's completion of the implementation stage:
     ```bash
     "$DOFLOW" orchestrate --action handoff --task-id "<task id>" --calling-skill do-implement --note "<one line: what was implemented>" --result <passed|failed> --json
     ```
     Use step 6's verification outcome for `--result`: `passed` when every check in the named set
     passed, `failed` when one did not — never omit it to imply a pass step 6 did not establish.
     The runtime selects this class's implementation stage — the only mutating stage a caller may
     complete — and returns `disposition`. `deferred` means a gate, an unfinished mutating stage
     elsewhere, or a rejected run prevented it; report `reason` and stop, this skill resolves no
     gate. Render the trail after a recorded completion:
     ```bash
     "$DOFLOW" render-audit --slug="<task id>" --json
     ```
   - Without this call, the orchestrator's cursor never advances past `implementation` for any
     class that routes here — `bug`, `refactor`, `dependency-change`, `trivial-edit` all do — and
     every later stage's own handoff call is refused with `blocked-on-mutating-stage:implementation`
     until this one runs.

8. **Report and hand off**:
   - Summarize what changed, file by file, and why — not a restatement of the diff.
   - If step 2 took the standalone exemption, state that plainly here — as visible as a block would
     be, per NFR-004 — rather than only mentioning it in passing back in step 2. If step 2 evaluated
     readiness instead, name the state it returned, whether the context pack held usable prior
     context or came back mismatched-empty, and the handoff `disposition` step 7 recorded (or that
     step 7 was skipped as standalone).
   - Suggest `/do-code-review` as the natural next step, mirroring the pointer that skill's own
     "Next Step" section already sends back here. If a chain feature's `plan.md` task happened to
     get addressed along the way, say so explicitly rather than silently — `plan.md` bookkeeping
     itself stays `/do-execute-plan`'s responsibility, not this skill's.

## Boundaries

**Will:** Implement directly from a description, review findings, or a named task; read and match
existing repo conventions before writing; run whatever test/lint suite the project already has;
work in any repo, whether or not it uses the DoFlow chain at all; record the stage handoff through
`orchestrate`/`render-audit` when this run is not standalone, so the orchestrator's cursor can
advance past the mutating stage only this skill may complete.

**Will Not:** Require or generate `requirement.md` / `design.md` / `plan.md`; orchestrate a
multi-task checklist through specialist subagents — that is `/do-execute-plan`'s job once a real
plan exists; silently override the repository's own `pre-implement-gate` hook. That hook triggers
on any `Edit`/`Write` call, not on which skill made it — a branch mid-chain with a started feature
but no `design.md` still gets blocked here exactly as it would anywhere else, and that is by
design, not a gap this skill works around. Resolve a workflow gate, or start a workflow run for a
standalone implementation.
