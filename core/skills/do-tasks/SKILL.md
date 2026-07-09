---
name: do-tasks
description: "Generate a dependency-ordered tasks.md with [P] parallel and [US#] traceability markers from plan.md"
argument-hint: "[--parallel]"
disable-model-invocation: true
effort: high
---

# do-tasks

Phase 3 of the doflow chain. Decomposes `plan.md` into an executable `tasks.md`.

## Invocation
```text
/do-tasks [--parallel]
```

## Behavioral Flow
1. **Resolve** — run the resolver, parse JSON:
   ```bash
   RESOLVER="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/scripts/doflow/bash/do-paths.sh"
   [ -f "$RESOLVER" ] || RESOLVER="core/scripts/doflow/bash/do-paths.sh"
   bash "$RESOLVER" --json
   ```
2. **Precondition (advisory)** — if `has_plan` is false, warn and offer `/do-plan` first. Advisory, not hard.
3. **Read** `plan.md` (and `spec.md` for user-story IDs).
4. **Write `tasks.md`** — copy `templates/doflow/tasks-template.md` into the feature dir, fill it:
   - dependency-ordered `- [ ]` tasks grouped by phase (the checkboxes are the execution contract).
   - mark parallel-safe tasks `[P]`; trace each to a user story with `[US#]`.
   - name the owning specialist agent and target files per task; add checkpoints + completion criteria.
5. **Stop** — report the tasks path and the count of `[P]` / sequential tasks.

## Boundaries
**Will:** read plan/spec, write a dependency-ordered `tasks.md` with `[P]`/`[US#]` markers.
**Will Not:** execute tasks, write code, or skip the marker contract that `/do-execute-plan` parses.

## CRITICAL BOUNDARIES
**STOP AFTER TASK GENERATION.** Output: `agent-docs/specs/<slug>/tasks.md`.

**Next Step:** `/do-execute-plan` to execute the tasks. The implement phase is gated: it requires
both `plan.md` and `tasks.md` to exist.
