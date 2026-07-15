---
name: do-execute-plan
description: "Execute plan.md's embedded task checklist: pm-agent orchestration over named specialists with the implement-phase prerequisite gate."
argument-hint: "[--next|--phase N|--all|--resume|--dry-run|--contracts] [--safe]"
disable-model-invocation: true
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
1. **Resolve the active feature** — run the resolver first, before the gate:
   ```bash
   RESOLVER="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/scripts/doflow/bash/do-paths.sh"
   [ -f "$RESOLVER" ] || RESOLVER="core/scripts/doflow/bash/do-paths.sh"
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
   PREREQ="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/scripts/doflow/bash/do-prereqs.sh"
   [ -f "$PREREQ" ] || PREREQ="core/scripts/doflow/bash/do-prereqs.sh"
   bash "$PREREQ" --require-plan   # add --slug="<chosen>" if step 1 disambiguated
   ```
   This is the primary, prompt-level half of the one hard gate; the `pre-implement-gate.sh` hook is
   the backstop. Do not proceed past a `--require-plan` failure. An `ambiguous-feature` error here
   means step 1's disambiguation didn't happen or wasn't carried through — do not retry blindly;
   go back to step 1.
3. **Load** — read `plan.md` (its section 8 Tasks subsection) and `requirement.md`/`design.md` for
   context, using the paths from step 1's resolved JSON. Parse the `- [ ]` tasks, `[P]` parallel
   markers, `[US#]` traceability, dependencies, and per-task owner.
4. **Contracts scaffold (`--contracts`, alternative path)** — only when `--contracts` is passed:
   read `contracts.md` (co-located with this file) and follow its algorithm exactly. Reads
   `plan.md`'s task list already loaded in step 3; produces a distinct deliverable from the
   task-execution loop in steps 5-8 below; runs standalone (no task-selection mode required), to
   completion, then stops. Idempotent — safe to re-run. Skip reading `contracts.md` entirely for
   every other flag mode — its content is irrelevant to `--next`/`--phase`/`--all`/`--resume`/
   `--dry-run`.
5. **Select work** — `--next` (default): one dependency-ready task. `--phase N`: one phase
   (matches `plan.md`'s Phase A/B/... groupings). `--all`: to completion/blocker. `--resume`:
   continue from `state.md`. If the selected task's `depends-on:` names a service with no
   `contracts/<service>/` scaffolded yet, surface a non-blocking advisory notice (e.g. "this task
   depends on `<service>`, no contract scaffolded yet — run `--contracts` first, or proceed
   anyway") — not a gate; the one hard gate stays step 2, unchanged.
6. **Orchestrate (pm-agent)** — dispatch each task to its owning specialist (backend-architect,
   security-engineer, quality-engineer, …) via the Agent tool:
   - **`[P]`, dependency-ready** tasks → fan out concurrently with `/parallel-agents`; subagents
     return **summaries only** (protects the main context).
   - **sequential / dependent** tasks → run in dependency order.
7. **Validate then record** — run the task/phase validation; check the `- [ ]` box in `plan.md`;
   update `state.md` (seed from `templates/doflow/state-template.md` on first write if absent;
   sections: Completed / In Progress / Blocked / Next Action). With `--safe`, validate + checkpoint
   more often.
8. **Stop on risk** — ambiguity, blocker, or failed validation → report and wait (route failures
   to `root-cause-analyst` / `/do-troubleshoot`).

## Boundaries
**Will:** enforce the prereq gate, orchestrate named specialists over `plan.md`'s task checklist,
fan out `[P]` work, validate, keep `state.md` resumable, and scaffold dependency-service contracts
(`--contracts`).
**Will Not:** generate the requirement/design/plan (use `/do-brainstorm`, `/do-design`,
`/do-plan`), skip the gate or validation, generate contract content beyond the scaffold (folders +
manifest), or commit unless explicitly asked (`/do-git`).

## CRITICAL BOUNDARIES
Implement phase. Requires `requirement.md`, `design.md`, **and** `plan.md` (hard gate). Output:
code + updated `state.md` + checked-off tasks in `plan.md`; with `--contracts`, also
`contracts/<service>/` scaffolds + `manifest.yaml`.

**Next Step:** `/do-code-review` to review the change for code quality.
