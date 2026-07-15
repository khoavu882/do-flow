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
3. **Contracts scaffold (`--contracts`, alternative path)** — reads `plan.md`'s task list already
   loaded in step 2, but produces a distinct deliverable from the task-execution loop in steps 4-6
   below; runs standalone (no task-selection mode required), to completion, then stops. Idempotent
   — safe to re-run.
   - Derive each task's service identity from its `files:` path against known roots
     (`sources/<name>`, `sources-rf/<name>`, `clients/<name>`); paths outside these roots are
     excluded, not misfired into a fake service.
   - Partition touched services into **dependency** (named in some task's `depends-on:`, owns no
     task of its own in this plan) vs. **in-scope** (owns a task — being built for real, no
     contract needed).
   - Classify each dependency service's integration style: `network` for a `sources/` or
     `sources-rf/` root (microservice-style), `in-process` for a known legacy monolith (e.g.
     `cops-backend`) or a module in the same repo as the consuming task.
   - Per dependency service: if `contracts/<service>/manifest.yaml` exists and its
     `generation_hash` matches the current source tasks' full text, skip (never clobbers manual
     edits). Otherwise write `contracts/<service>/{code,data,mock}/` (empty scaffold, content
     freeform — loosely guided by `integration_style`, not generated here) plus `manifest.yaml`
     (`service`, `integration_style`, `generated_from_plan`, `source_task_ids`, `generation_hash`
     — sha256 of the source tasks' full text, `generated_at`).
   - Report N services scaffolded, M skipped (already current), and the in-scope services with no
     contract generated (expected outcome, not an error).
4. **Select work** — `--next` (default): one dependency-ready task. `--phase N`: one phase
   (matches `plan.md`'s Phase A/B/... groupings). `--all`: to completion/blocker. `--resume`:
   continue from `state.md`. If the selected task's `depends-on:` names a service with no
   `contracts/<service>/` scaffolded yet, surface a non-blocking advisory notice (e.g. "this task
   depends on `<service>`, no contract scaffolded yet — run `--contracts` first, or proceed
   anyway") — not a gate; the one hard gate stays step 1, unchanged.
5. **Orchestrate (pm-agent)** — dispatch each task to its owning specialist (backend-architect,
   security-engineer, quality-engineer, …) via the Agent tool:
   - **`[P]`, dependency-ready** tasks → fan out concurrently with `/parallel-agents`; subagents
     return **summaries only** (protects the main context).
   - **sequential / dependent** tasks → run in dependency order.
6. **Validate then record** — run the task/phase validation; check the `- [ ]` box in `plan.md`;
   update `state.md` (seed from `templates/doflow/state-template.md` on first write if absent;
   sections: Completed / In Progress / Blocked / Next Action). With `--safe`, validate + checkpoint
   more often.
7. **Stop on risk** — ambiguity, blocker, or failed validation → report and wait (route failures
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
