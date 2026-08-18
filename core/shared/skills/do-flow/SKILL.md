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
**Cross-client clarification:** Every `AskUserQuestion` reference below means the mechanism in
`RULE_04_QUESTIONS.md`: use that tool in Claude Code; in Codex or Gemini, write the stage question
file and wait for its answered `[Answer]:` tags. Include `Other` explicitly in a question file.

1. **Resolve state** — run the resolver. Every DoFlow runtime call in this skill goes through the
   runtime seam. Resolve it **once** here and reuse `$DOFLOW` for every later call in this skill:
   ```bash
   # Resolve the DoFlow runtime: nearest project install wins, then the global one.
   D=$PWD; while [ "$D" != / ] && [ ! -x "$D/.doflow/scripts/doflow/bin/doflow-run" ]; do D=$(dirname "$D"); done
   DOFLOW="$D/.doflow/scripts/doflow/bin/doflow-run"
   [ -x "$DOFLOW" ] || DOFLOW="$HOME/.doflow/scripts/doflow/bin/doflow-run"
   [ -x "$DOFLOW" ] || { echo "doflow: no runtime found in any .doflow/ above $PWD, nor at $HOME/.doflow. Run: npx @khoavu882/doflow install" >&2; exit 2; }
   "$DOFLOW" paths --json
   ```
   The walk-up starts at the working directory, so run every command in this skill from the project
   root. Exit 2 means no DoFlow runtime was found; the message names every place searched — surface
   it verbatim and stop, do not search for the runtime yourself.
   If `feature_slug` is `null` **and** `candidate_slugs` is non-empty (a non-git root — e.g. doflow
   installed at a multi-service container root — with 2+ feature dirs and no branch to
   disambiguate), this is NOT "no active feature," it's an unresolved choice. Ask via
   `AskUserQuestion`, one option per `candidate_slugs` entry, before doing anything else — never
   default past it, that would create a duplicate feature dir alongside an existing one. Re-resolve
   with `"$DOFLOW" paths --json --slug="<chosen>"` and carry that slug through every later stage
   invocation and gate.

2. **Propose one class** — read the request and name exactly one class id, using the cues and the
   confusable pairs in `references/task_classes.md`. State the class and the signal it rests on in
   one line. If two classes fit equally, do **not** take the longer one: show what each would run —
   `"$DOFLOW" workflow --task-class "<candidate>" --json`, quote its `stageIds` — and ask via
   `AskUserQuestion`, one option per candidate.

3. **Validate the class through the runtime** — a proposal is not a selection until this returns:
   ```bash
   "$DOFLOW" classify --task-class "<proposed>" --json
   ```
   Branch on the returned `outcome` field, not on the exit code.
   - **`ACCEPTED`** — the returned `workflow` is this run's plan of record. Its `stages`, `gates`
     and `handoff` are the only source for what happens next; do not supplement them from memory.
   - **`REJECTED`** — **stop.** Print `message` verbatim: it already names `validClasses` and any
     near-match `suggestions`. Ask the user to choose from `validClasses` via `AskUserQuestion`,
     then re-validate that choice. Never substitute `feature`, never retry with a guess, and never
     run a stage on a class the runtime did not accept.
   - **Exit 2** — the runtime could not answer at all. Surface its message verbatim and stop.

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
     `"$DOFLOW" readiness --task-class "<taskClass>" --task-id "<task id>" --json`. Pass
     `--task-class` explicitly every time: the verb defaults to `feature`, and a readiness verdict
     computed for the wrong class is worse than none. Not ready → report the missing items and
     stop; do not enter the stage.
   - `readinessTemplate` is `null` — enter the stage. Do not consult readiness "to be safe": a
     `review` or `research` workflow has no implementation to be ready for, and `operations` has no
     template by design (`references/task_classes.md`). Calling it anyway invents a gate the
     registry does not declare.
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

**Next Step:** whatever the resolved `workflow.handoff` names — for every class that ends in a
change, `/do-git` to commit/merge once the last gate is cleared.
