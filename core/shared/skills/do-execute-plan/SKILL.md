---
name: do-execute-plan
description: "Execute plan.md's embedded task checklist: pm-agent orchestration over named specialists with the implement-phase prerequisite gate."
argument-hint: "[--next|--phase N|--all|--resume|--dry-run|--contracts] [--safe]"
effort: high
---

# do-execute-plan

Phase 4 of the doflow chain. Executes the task checklist embedded in `plan.md` (section 8) for
the active feature.

## Invocation
```text
/do-execute-plan [--next|--phase N|--all|--resume|--dry-run|--contracts] [--safe]
```

## Behavioral Flow
**Cross-client clarification:** Every `AskUserQuestion` reference below means the mechanism in
`RULE_04_QUESTIONS.md`: use that tool in Claude Code; in Codex or Gemini, write the stage question
file and wait for its answered `[Answer]:` tags. Include `Other` explicitly in a question file.

1. **Resolve the active feature** — run the resolver first, before the gate:
   ```bash
   RESOLVER="${DOFLOW_CONFIG_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}/scripts/doflow/bash/do-paths.sh"
   [ -f "$RESOLVER" ] || RESOLVER="$HOME/.codex/scripts/doflow/bash/do-paths.sh"
   if [ ! -f "$RESOLVER" ]; then                                          # project-scoped install
     d="$PWD"
     while [ "$d" != / ]; do
       for config_dir in .claude .codex .agents; do
         [ -f "$d/$config_dir/scripts/doflow/bash/do-paths.sh" ] && RESOLVER="$d/$config_dir/scripts/doflow/bash/do-paths.sh" && break 2
       done
       d="$(dirname "$d")"
     done
   fi
   DOFLOW_CONFIG_DIR="$(dirname "$(dirname "$(dirname "$(dirname "$RESOLVER")")")")"
   bash "$RESOLVER" --json
   ```
   In a git repo this always resolves deterministically (branch-derived) — proceed to the next
   step. Outside a git repo (e.g. doflow installed at a multi-service container root, above the
   actual git sub-repos — no branch to key off), `do-paths.sh` falls back to scanning
   `agent-docs/doflow/` itself: `feature_slug` is already auto-set when exactly one candidate dir
   exists (nothing to ask — proceed to the next step). If `feature_slug` is `null` **and**
   `candidate_slugs` is non-empty, this is a genuine ambiguity only the user can resolve: ask via
   `AskUserQuestion`, one option per `candidate_slugs` entry, no invented filler, header naming
   the feature slug. Carry the chosen slug through every remaining step by appending
   `--slug="<chosen>"` to both the resolver and prereq-gate calls below.
2. **Prerequisite gate (HARD)** — run, and STOP on a non-zero exit:
   ```bash
   PREREQ="${DOFLOW_CONFIG_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}/scripts/doflow/bash/do-prereqs.sh"
   [ -f "$PREREQ" ] || PREREQ="$HOME/.codex/scripts/doflow/bash/do-prereqs.sh"
   if [ ! -f "$PREREQ" ]; then                                          # project-scoped install
     d="$PWD"
     while [ "$d" != / ]; do
       for config_dir in .claude .codex .agents; do
         [ -f "$d/$config_dir/scripts/doflow/bash/do-prereqs.sh" ] && PREREQ="$d/$config_dir/scripts/doflow/bash/do-prereqs.sh" && break 2
       done
       d="$(dirname "$d")"
     done
   fi
   bash "$PREREQ" --require-plan   # add --slug="<chosen>" if step 1 disambiguated
   ```
   This is the primary, prompt-level half of the one hard gate; the `pre-implement-gate.sh` hook is
   the backstop. Do not proceed past a `--require-plan` failure. An `ambiguous-feature` error here
   means step 1's disambiguation didn't happen or wasn't carried through — do not retry blindly;
   go back to step 1.
3. **Load** — read `plan.md` (its section 8 Tasks subsection) and `requirement.md`/`design.md` for
   context, using the paths from step 1's resolved JSON. Parse the `- [ ]` tasks, `[P]` parallel
   markers, `[US#]` traceability, dependencies, and per-task owner.
4. **Contracts frame generation (`--contracts`, alternative path)** — only when `--contracts` is
   passed:
   read `contracts.md` (co-located with this file) and follow its algorithm exactly. Reads
   `plan.md`'s task list already loaded in step 3; produces a distinct deliverable from the
   task-execution loop in steps 5-9 below; runs standalone (no task-selection mode required), to
   completion, then stops. Idempotent — safe to re-run. Skip reading `contracts.md` entirely for
   every other flag mode — its content is irrelevant to `--next`/`--phase`/`--all`/`--resume`/
   `--dry-run`.
5. **Select work** — `--next` (default): one dependency-ready task. `--phase N`: one phase
   (matches `plan.md`'s Phase A/B/... groupings). `--all`: to completion/blocker. `--resume`:
   continue from `state.md`. If the selected task's `depends-on:` names a service with no
   `agent-docs/doflow/<slug>/contracts/<service>/` generated yet, surface a non-blocking advisory
   notice (e.g. "this task depends on `<service>`, no contract frame generated yet — run
   `--contracts` first, or proceed anyway") — not a gate; the one hard gate stays step 2, unchanged.
6. **Repo branch check (per task)** — runs for every task, regardless of what `plan.md`'s Repo
   Branch Plan said at plan-time (its `N/A` is a documentation convenience, not a runtime flag —
   a plan that started single-repo can still grow a second repo mid-execution, per FR-004, and
   this check must catch that live rather than trust a stale snapshot). Resolve the task's repo
   (nearest `.git` from its `files:` path); if that repo has no `state.md` row yet, **or its row's
   `Status` is `blocked`** (never skip re-checking a blocked repo), `cd` into it and run `git
   status --short` first — **dirty tree → do not switch or discard anything, record `blocked`
   immediately in `state.md`'s Repo Branch Status table, route to step 9, regardless of whether
   the planned branch already exists** (a resumed run's own uncommitted work is indistinguishable
   from unrelated foreign work by `git status` alone, so treat both the same per NFR-002 and let
   the user confirm). Tree clean → run `git branch --list <planned-branch>` (from `plan.md`'s Repo
   Branch Plan, or derived inline via `do-plan/SKILL.md` step 7's formula — `feat/<TICKET>-<slug-
   description>` or `feat/<slug>` — if this repo has no row there): exists → checkout, record
   `existing`; absent → `git checkout -b <planned-branch>`, record `created`. A `created`/`existing`
   row is trusted as-is on later visits — no re-check.
7. **Orchestrate (pm-agent)** — dispatch each task to its owning specialist (backend-architect,
   security-engineer, quality-engineer, …) via the Agent tool:
   - **`[P]`, dependency-ready** tasks → fan out concurrently with `/parallel-agents`; subagents
     return **summaries only** (protects the main context).
   - **sequential / dependent** tasks → run in dependency order.
8. **Validate then record** — run the task/phase validation; check the `- [ ]` box in `plan.md`;
   update `state.md` (seed from `$DOFLOW_CONFIG_DIR/templates/doflow/state-template.md` on first
   write if absent;
   sections: Completed / In Progress / Blocked / Next Action), folding in any Repo Branch Status row
   from step 6. With `--safe`, validate + checkpoint more often.
9. **Stop on risk** — ambiguity, blocker, failed validation, or a step 6 `blocked` repo → report and
   wait (route failures to `root-cause-analyst` / `/do-troubleshoot`).

## Boundaries
**Will:** enforce the prereq gate, orchestrate named specialists over `plan.md`'s task checklist,
fan out `[P]` work, validate, keep `state.md` resumable, generate a per-dependency-service code
frame — signatures, type/data shapes, and a pinned safe-default implementation, in the inferred
language (`--contracts`) — and lazily create/check out each repo's branch (step 6).
**Will Not:** generate the requirement/design/plan (use `/do-brainstorm`, `/do-design`,
`/do-plan`), skip the gate or validation, generate real behavior/implementation logic inside a
contract frame (signatures, type shapes, and a pinned "not implemented" default only — see
`contracts.md`), commit unless explicitly asked (`/do-git`), or force-switch/discard uncommitted
work when checking out a repo's branch.

## CRITICAL BOUNDARIES
Implement phase. Requires `requirement.md`, `design.md`, **and** `plan.md` (hard gate). Output:
code + updated `state.md` + checked-off tasks in `plan.md`; with `--contracts`, also
`agent-docs/doflow/<slug>/contracts/<service>/` code frames + `manifest.yaml`.

**Next Step:** `/do-code-review` to review the change for code quality.
