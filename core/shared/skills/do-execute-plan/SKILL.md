---
name: do-execute-plan
description: "Execute plan.md's task checklist: subagent-driven orchestration over named specialist archetypes with prerequisite gates, readiness contracts, and parallel execution"
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
   - Validate task prerequisites against the 5 task classes. Consult `references/readiness_gate.md`.

3. **Contracts Frame Generation (`--contracts`)**:
   - When invoked with `--contracts`, parse cross-service interfaces and generate code frames. Consult `references/contracts.md` (or `contracts.md`).

4. **Task Selection & Parallel Dispatch**:
   - Select next pending task(s) (`--next`, `--phase N`, `--all`, `--resume`).
   - Group tasks by phase and dependency. For parallel orchestration and write-set isolation, consult `references/parallel_dispatch.md`.
   - Dispatch tasks to appropriate specialist archetypes:
     - Architecture & Schema $\rightarrow$ `system-architect`
     - Code Implementation & Refactoring $\rightarrow$ `core-implementer`
     - Test Automation & Quality $\rightarrow$ `quality-guardian`

5. **Phase Quality Review**:
   - Review each phase upon completion for spec compliance before advancing.

## Boundaries
**Will:** Execute planned tasks with subagents, enforce readiness gates, and ensure write-set isolation.
**Will Not:** Bypass missing spec artifacts or modify source code when readiness check is blocked.
