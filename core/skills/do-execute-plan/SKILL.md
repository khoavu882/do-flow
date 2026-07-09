---
name: do-execute-plan
description: "Execute tasks.md: pm-agent orchestration over named specialists with the implement-phase prerequisite gate."
argument-hint: "[--next|--phase N|--all|--resume|--dry-run] [--safe]"
disable-model-invocation: true
effort: high
---

# do-execute-plan

Phase 4 of the doflow chain. Executes the `tasks.md` of the active feature.

## Invocation
```text
/do-execute-plan [--next|--phase N|--all|--resume|--dry-run] [--safe]
```

## Behavioral Flow
1. **Prerequisite gate (HARD)** — run, and STOP on a non-zero exit:
   ```bash
   PREREQ="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/scripts/doflow/bash/do-prereqs.sh"
   [ -f "$PREREQ" ] || PREREQ="core/scripts/doflow/bash/do-prereqs.sh"
   bash "$PREREQ" --require-tasks   # exit 2 -> no plan.md/tasks.md: tell user to run /do-plan, /do-tasks
   ```
   This is the primary, prompt-level half of the one hard gate; the `pre-implement-gate.sh` hook is the
   backstop. Do not proceed past a `--require-tasks` failure.
2. **Resolve & load** — `do-paths.sh --json` for paths; read `tasks.md` (and `plan.md`/`spec.md` for context).
   Parse the `- [ ]` tasks, `[P]` parallel markers, `[US#]` traceability, dependencies, and per-task owner.
3. **Select work** — `--next` (default): one dependency-ready task. `--phase N`: one phase. `--all`: to
   completion/blocker. `--resume`: continue from `state.md`.
4. **Orchestrate (pm-agent)** — dispatch each task to its owning specialist (backend-architect,
   security-engineer, quality-engineer, …) via the Agent tool:
   - **`[P]`, dependency-ready** tasks → fan out concurrently with `/parallel-agents`; subagents return
     **summaries only** (protects the main context).
   - **sequential / dependent** tasks → run in dependency order.
5. **Validate then record** — run the task/phase validation; check the `- [ ]` box; update `state.md`
   (Completed / In Progress / Blocked / Next Action). With `--safe`, validate + checkpoint more often.
6. **Stop on risk** — ambiguity, blocker, or failed validation → report and wait (route failures to
   `root-cause-analyst` / `/do-troubleshoot`).

## Boundaries
**Will:** enforce the prereq gate, orchestrate named specialists over `tasks.md`, fan out `[P]` work,
validate, and keep `state.md` resumable.
**Will Not:** generate the plan/tasks (use `/do-plan`,`/do-tasks`), skip the gate or validation, or
commit unless explicitly asked (`/do-git`).

## CRITICAL BOUNDARIES
Implement phase. Requires `plan.md` **and** `tasks.md` (hard gate). Output: code + updated `state.md`.

**Next Step:** `/do-review` to review the change against `spec.md`/`tasks.md`.
