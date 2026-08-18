---
name: do-execute-plan
description: "Execute plan.md's task checklist: subagent-driven orchestration over named specialist archetypes (system-architect, core-implementer, quality-guardian) with prerequisite gates, readiness contracts, and parallel execution. Use when requirement.md, design.md, and plan.md already exist and the next step is running the plan's tasks through those subagents, or the user says 'let's start building the plan' rather than describing a one-off fix outside any plan."
argument-hint: "[--next|--phase N|--all|--resume|--scaffold] [--sync] [--review|--no-review]"
effort: high
---

# do-execute-plan

Phase 4 of the DoFlow chain. Executes the task checklist in `plan.md` using specialist subagent archetypes with readiness validation and progressive disclosure.

## Invocation
```text
/do-execute-plan [--next|--phase N|--all|--resume|--scaffold] [--sync] [--review|--no-review]
```

## Behavioral Flow

1. **Resolve State & Prerequisite Gate**:
   - Every DoFlow runtime call in this skill — `paths`, `prereqs`, `parallel-check`, `task-brief` —
     goes through the runtime seam. Resolve it **once** here and reuse `$DOFLOW` for all four:
     ```bash
     # Resolve the DoFlow runtime: nearest project install wins, then the global one.
     D=$PWD; while [ "$D" != / ] && [ ! -x "$D/.doflow/scripts/doflow/bin/doflow-run" ]; do D=$(dirname "$D"); done
     DOFLOW="$D/.doflow/scripts/doflow/bin/doflow-run"
     [ -x "$DOFLOW" ] || DOFLOW="$HOME/.doflow/scripts/doflow/bin/doflow-run"
     [ -x "$DOFLOW" ] || { echo "doflow: no runtime found in any .doflow/ above $PWD, nor at $HOME/.doflow. Run: npx @khoavu882/doflow install" >&2; exit 2; }
     "$DOFLOW" paths --json
     ```
     The walk-up starts at the working directory, so run every command in this skill from the
     project root. Exit 2 means no DoFlow runtime was found; the message names every place searched
     — surface it verbatim and stop, do not search for the runtime yourself.
   - Enforce hard prerequisite gate: `"$DOFLOW" prereqs --require-plan` (requires
     `requirement.md`, `design.md`, `plan.md`).

2. **Readiness Evaluation (Confidence Check)**:
   - Evaluate the task's contract with `doflow readiness --task-class <bug|feature|refactor|trivial-edit|dependency-change> --task-id <id>`,
     run from the project the task belongs to. It reports which prerequisites are unmet and, for
     each, the capability that would satisfy it. `doflow evidence --task-id <id>` shows what has been
     recorded. Do not recall the contract from memory — the templates are versioned and the command
     reads them. Consult `references/readiness_gate.md` for the class keys, how to read each state,
     and the current evidence-capture limitation.

3. **Scaffold Generation (`--scaffold`)**:
   - When invoked with `--scaffold`, emit a reviewable code scaffold under `<feature_dir>/scaffold/`
     instead of executing tasks: the source layout, signatures and test stubs that `requirement.md`,
     `design.md` and `plan.md` imply, plus a contract frame per external `depends-on:` service.
     Signatures only, never implementation logic, and never a write into the project's source tree.
   - The in-scope half is deterministic and is **run**, not reasoned through; the
     external-dependency half is an algorithm you execute. Both, with the exact command, live in
     `references/scaffold.md` (or `scaffold.md`). Report its `status` and, specifically, whatever it
     lists as skipped or not evaluated — a partial scaffold read as complete is worse than none.

4. **Task Selection & Parallel Dispatch**:
   - Select next pending task(s) (`--next`, `--phase N`, `--all`, `--resume`).
   - Compute dispatch groups with `"$DOFLOW" parallel-check --phase=<N> --json` — it
     groups by phase and `owner:`, and returns the cross-group write-set collisions
     (`group_overlaps[]`, `group_serialize[]`) that decide what may run concurrently. Do not derive
     write-set isolation by inspection; it is computed.
     **Branch on the `parallel_safe` field, never on the exit code.** With `jq` unavailable this
     verb exits 0 and reports `"parallel_safe": null` — a zero exit is not a grant of concurrency.
     `null`, or a missing field, means unknown: fall back to `--sync` and say why.
     Build each group's brief with
     `"$DOFLOW" task-brief --group=<phase>:<owner> --tasks=<csv>`. Full protocol, field
     meanings, and the `--sync` / `--no-group` fallbacks: `references/parallel_dispatch.md`.
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
