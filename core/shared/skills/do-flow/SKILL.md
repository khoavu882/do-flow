---
name: do-flow
description: "Auto-chain the doflow spec-driven flow (brainstorm → design → plan → implement → test → review), pausing only at defined approval gates. Use when the user wants the entire spec-driven lifecycle to run end-to-end without manually invoking each /do-* phase, or says 'just build this feature end to end' or 'run the whole doflow chain for me' rather than asking for one specific phase."
argument-hint: "[feature description] [--from brainstorm|design|plan|implement|test|review]"
effort: high
---

# do-flow

Runs a DoFlow workflow end-to-end without a manual `/do-X` at every stage. The task's **class**
selects the workflow; the resolved workflow's stages name which existing skills run, in what order,
and where the run stops. `do-flow` does not replace or modify those skills — it invokes their own
Behavioral Flows in sequence. `do-constitution` belongs to no class; invoke it directly when you
need to set or amend repo-level rules.

**You propose the class; the runtime validates it.** Never the reverse. A class you assumed, or one
the runtime rejected and you replaced with the familiar default, runs a confident workflow for the
wrong task.

## Invocation
```text
/do-flow [feature description] [--from brainstorm|design|plan|implement|test|review]
```

## Behavioral Flow

1. **Resolve state** — run the resolver. Every DoFlow runtime call in this skill goes through the
   runtime seam. Resolve it **once** here and reuse `$DOFLOW` for every later call in this skill:

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
`feature_slug` `null` with a non-empty `candidate_slugs` is an unresolved choice, not "no active feature": ask one option per entry, re-resolve with `"$DOFLOW" paths --json --slug="<chosen>"`, and use that slug for the rest of this flow. `/do-flow` passing `--slug` already resolves it — no prompt then.

2. **Propose one class** — read the request and name exactly one class id, using the cues and the
   confusable pairs in this skill's own `references/task_classes.md`. State the class and the
   signal it rests on in one line. If two classes fit equally, do **not** take the longer one: show
   what each would run —
   `"$DOFLOW" workflow --task-class "<candidate>" --json`, quote its `stageIds` — and ask via
   `AskUserQuestion`, one option per candidate.

3. **Validate the class through the runtime** — a proposal is not a selection until this returns:

```bash
"$DOFLOW" classify --task-class "<proposed>" --calling-skill do-flow --json
```
Branch on the returned `outcome` field, not the exit code.
- **`ACCEPTED`** — the returned `workflow` is this run's plan of record; read `stages`, `gates` and `handoff` off it rather than from memory.
- **`REJECTED`** — **stop.** Print `message` verbatim (it already names `validClasses` and any `suggestions`), ask the user to choose from `validClasses`, then re-validate. Never substitute `feature`.
  A rejection may be about **you** rather than the class (`reason: caller-not-a-stage`). Then the fix is to propose one of the classes in `fit.hostingClasses`, or to hand the work to the skill this class names for the stage you meant — not to re-propose the same class.
- **Exit 2** — surface the message verbatim and stop.

Every stage this run enters comes from the accepted `workflow`'s `stages`; a phase the workflow does
not declare is not run here, however familiar it is from the `feature` chain.

4. **Announce the selection** — one line before anything runs:
   `<taskClass> → <workflow.name>: <stageIds joined by →>`, plus the gate ids if `gates` is
   non-empty. This is the user's chance to correct a misclassification cheaply.

5. **Pick the starting stage.**
   - `feature`: resume from the first missing chain artifact — `!has_requirement` → the discovery
     stage; `has_requirement && !has_design` → design; `has_design && !has_plan` → planning; all
     three present → go straight to the pre-implementation gate in step 7.
   - Every other class: start at the first entry in `stages`.
   - `--from <phase>` overrides the above to deliberately re-run a stage. Match the phase to the
     stage whose `skill` is that phase's skill (`brainstorm` → `do-brainstorm`, `design` →
     `do-design`, `plan` → `do-plan`, `implement` → the stage with `mutatesSource: true`, `test` →
     `do-test`, `review` → `do-code-review`). No stage matches in this workflow → stop and list the
     stage ids it does have. Two stages match — `bug` and `refactor` each run `do-test` twice — →
     ask which one.

6. **Run the stages in order**, invoking each stage's `skill` Behavioral Flow directly.
   - `optional: true` — decide from that stage's own `purpose`, then say which way you went and
     why. Never drop an optional stage silently.
   - `readinessTemplate` is non-null — consult readiness before entering the stage:
     `"$DOFLOW" readiness --task-class "<taskClass>" --task-id "<task id>" --json`. Both
     `--task-class` and `--task-id` are required; omitting either exits 2 and names the valid set.
     Not ready → report the missing items and stop; do not enter the stage.
   - `readinessTemplate` is `null` — enter the stage. Do not consult readiness "to be safe": a
     workflow whose `requiresImplementationReadiness` is `false` has no implementation to be ready
     for and declares no template by design (`references/task_classes.md`). Calling it anyway
     invents a gate the registry does not declare.
   - After each stage, report one line: stage id, skill, and the artifact path or result it
     produced — so the user can follow without intervening.

7. **Stop at the gates the resolved workflow declares** — read them from `workflow.gates`, each
   attached to a stage by `afterStage`. `trigger: always` stops every time; any other trigger stops
   only when that named condition actually holds. Ask with the gate's own `prompt` via
   `AskUserQuestion`. For the `feature` workflow's three, which behave as they always have:
   - **`gate-0`** (after discovery, trigger `unresolved-clarifications`) — a safety net, not the
     normal path: `do-brainstorm` resolves ambiguities to zero via its own loop, so this fires only
     if a `[NEEDS CLARIFICATION]` marker survived an aborted session. Ask one question per marker
     (grouped if closely related), patch the answers into `requirement.md` directly, and do not
     re-run `do-brainstorm`.
   - **`gate-a`** (after planning) — the conversational checkpoint on top of the already-existing
     hard hook (`pre-implement-gate.sh`, which blocks source edits until `requirement.md`,
     `design.md` and `plan.md` exist and remains the real enforcement regardless of what happens
     here). Options: `Proceed` / `Let me review the artifacts first` / `Stop here`.
   - **`gate-b`** (after review) — no enforcement hook exists for this today; `/do-git` is a
     separate, always-manually-invoked skill. Frame the question by the review's own approval
     status: on `CHANGES REQUESTED`, foreground addressing the findings rather than offering a bare
     proceed.
   A workflow with an empty `gates` array stops at none of these. It still stops on a readiness
   block, on an ambiguous answer, and on any stage skill's own stopping rule.

   **Record every answer that is a decision.** Asking is not recording: a gate this skill asked but
   never wrote back stays open in the run, so the stage skill that owns it asks the same question
   again — the user answers twice for one decision. Immediately after the user answers, write it:
   ```bash
   "$DOFLOW" orchestrate --action decide-gate --task-id "<slug>" --gate "<gate id>" --decision approve|reject --note "<the user's own answer, one line>" --json
   ```
   Map each gate's own option set onto the two decisions the runtime accepts, and never onto a third:
   - **`gate-a`** — `Proceed` is `approve`; `Stop here` is `reject`. `Let me review the artifacts
     first` is **neither**: it is a pause, not a decision, so call nothing and actually pause — hold
     the run at this gate and re-ask once the user comes back, exactly as step 8's ambiguous-answer
     rule already requires.
   - **`gate-b`** — an actual "proceed to commit/merge" answer is `approve`; an explicit stop is
     `reject`. Anything that is not a real decision — "let me address the findings first" on a
     `CHANGES REQUESTED` review, most often — is neither, and gets no `decide-gate` call. `reject`
     terminates the run outright, which is a different answer from "not now".
   - **`gate-0`** — only in the aborted-session branch above, where this skill patched
     `requirement.md` itself: once every surviving marker is resolved, `approve`. If any marker is
     still open, leave the gate alone.
   This call is advisory to the trail, not to the chain: if it fails for a reason outside this flow's
   control (an unwritable local state directory, say), report the failure plainly and carry the
   user's answer forward anyway — the answer is what governs whether the next stage runs, and the
   record of it is what keeps the next stage from asking again.

8. **Never skip a gate on an ambiguous answer** — an unanswered or unclear response to any
   `AskUserQuestion` means stop and ask again, per this repo's `RULE_04_QUESTIONS`. When the
   terminal stage completes, state `workflow.handoff` as the next step rather than continuing into
   it.

## Boundaries
**Will:**
- Propose a task class, validate it through the runtime, and run the resolved workflow's stages in
  order without a manual re-invocation at each boundary.
- Stop only where the resolved workflow says to: its declared gates, a readiness block, or an
  ambiguous answer.
- Record each gate answer it collects through `orchestrate --action decide-gate`, so the stage skill
  that owns that gate finds it already resolved instead of asking the user the same question twice.
- Compose with the existing `pre-implement-gate.sh` hard gate rather than bypass or duplicate it.
  That hook keys on branch and artifact state, not on class, so it can deny a `bug` or
  `trivial-edit` workflow's edits on a branch that already holds an incomplete feature dir —
  surface its message as written.

**Will Not:**
- Run any workflow for a class the runtime rejected, or replace a rejected class with `feature`.
- Infer a class silently when two fit, or read a class the user stated as a suggestion.
- Consult implementation readiness for a stage that declares no readiness template, or invent a
  readiness template for a class that has none.
- Modify any stage skill, or invoke `do-constitution` — it is standalone and in no class.
- Add a hook-level enforcement gate for commit/merge — `gate-b` is conversational only. A
  hook-level version would be a separate, future proposal.
- Silently proceed past a gate on an ambiguous or missing answer.
- Record a pause or a deferral as a gate decision — `Let me review the artifacts first` and "let me
  address the findings first" are neither `approve` nor `reject`, and forcing them into one writes a
  decision the user did not make.

**Next Step:** whatever the resolved `workflow.handoff` names — for every class that ends in a
change, `/do-git` to commit/merge once the last gate is cleared.
