---
name: do-execute-plan
description: "Execute plan.md's embedded task checklist: pm-agent orchestration over named specialists with the implement-phase prerequisite gate."
argument-hint: "[--next|--phase N|--all|--resume|--dry-run] [--safe]"
disable-model-invocation: true
effort: high
---

# do-execute-plan

Phase 4 of the doflow chain. Executes the task checklist embedded in `plan.md` (section 8) for
the active feature.

## Invocation
```text
/do-execute-plan [--next|--phase N|--all|--resume|--dry-run] [--safe]
```

## Behavioral Flow
1. **Prerequisite gate (HARD)** — run, and STOP on a non-zero exit:
   ```bash
   PREREQ="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/scripts/doflow/bash/do-prereqs.sh"
   [ -f "$PREREQ" ] || PREREQ="core/scripts/doflow/bash/do-prereqs.sh"
   bash "$PREREQ" --require-plan   # exit 2 -> missing requirement/design/plan: tell user what to run
   ```
   This is the primary, prompt-level half of the one hard gate; the `pre-implement-gate.sh` hook is
   the backstop. Do not proceed past a `--require-plan` failure.
2. **Resolve & load** — `do-paths.sh --json` for paths; read `plan.md` (its section 8 Tasks
   subsection) and `requirement.md`/`design.md` for context. Parse the `- [ ]` tasks, `[P]`
   parallel markers, `[US#]` traceability, dependencies, and per-task owner.
3. **Select work** — `--next` (default): one dependency-ready task. `--phase N`: one phase
   (matches `plan.md`'s Phase A/B/... groupings). `--all`: to completion/blocker. `--resume`:
   continue from `state.md`.
4. **Orchestrate (pm-agent)** — dispatch each task to its owning specialist (backend-architect,
   security-engineer, quality-engineer, …) via the Agent tool:
   - **`[P]`, dependency-ready** tasks → fan out concurrently with `/parallel-agents`; subagents
     return **summaries only** (protects the main context).
   - **sequential / dependent** tasks → run in dependency order.
5. **Validate then record** — run the task/phase validation; check the `- [ ]` box in `plan.md`;
   update `state.md` (seed from `templates/doflow/state-template.md` on first write if absent;
   sections: Completed / In Progress / Blocked / Next Action). With `--safe`, validate + checkpoint
   more often.
6. **Stop on risk** — ambiguity, blocker, or failed validation → report and wait (route failures
   to `root-cause-analyst` / `/do-troubleshoot`).

## Boundaries
**Will:** enforce the prereq gate, orchestrate named specialists over `plan.md`'s task checklist,
fan out `[P]` work, validate, and keep `state.md` resumable.
**Will Not:** generate the requirement/design/plan (use `/do-brainstorm`, `/do-design`,
`/do-plan`), skip the gate or validation, or commit unless explicitly asked (`/do-git`).

## CRITICAL BOUNDARIES
Implement phase. Requires `requirement.md`, `design.md`, **and** `plan.md` (hard gate). Output:
code + updated `state.md` + checked-off tasks in `plan.md`.

**Next Step:** `/do-code-review` to review the change for code quality.
