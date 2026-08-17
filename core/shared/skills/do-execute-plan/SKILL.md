---
name: do-execute-plan
description: "Execute plan.md's task checklist: subagent-driven orchestration over named specialist archetypes (system-architect, core-implementer, quality-guardian) with prerequisite gates, readiness contracts, and parallel execution. Use when requirement.md, design.md, and plan.md already exist and the next step is running the plan's tasks through those subagents, or the user says 'let's start building the plan' rather than describing a one-off fix outside any plan."
argument-hint: "[--next|--phase N|--all|--resume|--contracts] [--sync] [--review|--no-review]"
effort: high
---

# do-execute-plan

Phase 4 of the DoFlow chain. Executes the task checklist in `plan.md` using specialist subagent archetypes with readiness validation and progressive disclosure.

## Invocation
```text
/do-execute-plan [--next|--phase N|--all|--resume|--contracts] [--sync] [--review|--no-review]
```

## Behavioral Flow

1. **Resolve State & Prerequisite Gate**:
   - Resolve and run `do-paths.sh --json`:
     ```bash
     RESOLVER="${DOFLOW_CONFIG_DIR:+$DOFLOW_CONFIG_DIR/scripts/doflow/bash/do-paths.sh}"
     if [ -z "$RESOLVER" ] || [ ! -f "$RESOLVER" ]; then
       d="$PWD"
       while [ "$d" != / ]; do
         [ -f "$d/.doflow/scripts/doflow/bash/do-paths.sh" ] && RESOLVER="$d/.doflow/scripts/doflow/bash/do-paths.sh" && break
         d="$(dirname "$d")"
       done
     fi
     bash "$RESOLVER" --json
     ```
   - Enforce hard prerequisite gate: `bash "$(dirname "$RESOLVER")/do-prereqs.sh" --require-plan` (requires `requirement.md`, `design.md`, `plan.md`).

2. **Readiness Evaluation (Confidence Check)**:
   - Evaluate the task's contract with `doflow readiness --task-class <bug|feature|refactor|trivial-edit|dependency-change> --task-id <id>`,
     run from the project the task belongs to. It reports which prerequisites are unmet and, for
     each, the capability that would satisfy it. `doflow evidence --task-id <id>` shows what has been
     recorded. Do not recall the contract from memory — the templates are versioned and the command
     reads them. Consult `references/readiness_gate.md` for the class keys, how to read each state,
     and the current evidence-capture limitation.

3. **Contracts Frame Generation (`--contracts`)**:
   - When invoked with `--contracts`, parse cross-service interfaces and generate code frames. Consult `references/contracts.md` (or `contracts.md`).

4. **Task Selection & Parallel Dispatch**:
   - Select next pending task(s) (`--next`, `--phase N`, `--all`, `--resume`).
   - Compute dispatch groups with `do-parallel-check.sh --phase=<N> --json` — it groups by phase and
     `owner:`, and returns the cross-group write-set collisions (`group_overlaps[]`,
     `group_serialize[]`) that decide what may run concurrently. Do not derive write-set isolation
     by inspection; it is computed. Build each group's brief with
     `do-task-brief.sh --group=<phase>:<owner> --tasks=<csv>`. Full protocol, field meanings, and
     the `--sync` / `--no-group` fallbacks: `references/parallel_dispatch.md`.
   - Dispatch tasks to appropriate specialist archetypes:
     - Architecture & Schema $\rightarrow$ `system-architect`
     - Code Implementation & Refactoring $\rightarrow$ `core-implementer`
     - Test Automation & Quality $\rightarrow$ `quality-guardian`
   - Name a model tier explicitly on every dispatch — an omitted tier silently inherits the
     session's model rather than "using the default." Consult `references/MODEL_SELECTION.md` for
     how to pick the tier per task and per review pass.

5. **Phase Quality Review**:
   - Review each phase upon completion for spec compliance before advancing.

## Boundaries
**Will:** Execute planned tasks with subagents, enforce readiness gates, and ensure write-set isolation.
**Will Not:** Bypass missing spec artifacts or modify source code when readiness check is blocked.
