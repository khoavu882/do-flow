---
name: do-plan
description: "Generate the implementation plan (HOW) and dependency-ordered task checklist from requirement.md + design.md, with a Constitution Check gate."
argument-hint: "[--strategy systematic|agile] [--depth normal|deep] [--parallel]"
disable-model-invocation: true
effort: high
---

# do-plan

Phase 3 of the doflow chain. Turns `requirement.md` (WHAT/WHY) + `design.md` (system shape) into
`plan.md` (HOW to implement, plus the dependency-ordered task checklist).

## Invocation
```text
/do-plan [--strategy systematic|agile] [--depth normal|deep] [--parallel]
```

## Behavioral Flow
1. **Resolve** — run the resolver, parse JSON:
   ```bash
   RESOLVER="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/scripts/doflow/bash/do-paths.sh"
   [ -f "$RESOLVER" ] || RESOLVER="core/scripts/doflow/bash/do-paths.sh"
   bash "$RESOLVER" --json
   ```
2. **Precondition (advisory)** — if `has_requirement` or `has_design` is false, warn and offer to
   run `/do-brainstorm` / `/do-design` first. This gate is **advisory** (skippable), not the hard
   hook gate.
3. **Read inputs** — `requirement.md`, `design.md`, and the resolved constitution
   (`constitution_base` overlaid by `constitution_local`; local wins).
4. **Write `plan.md`, sections 1–7** — copy `templates/doflow/plan-template.md` into the feature
   dir, fill it: approach, research/decisions that resolve every `[NEEDS CLARIFICATION]` from the
   requirement, components, data/contracts, risks, validation strategy.
5. **Constitution Check (gate)** — evaluate the plan against the resolved constitution. On a
   violation, STOP and revise the approach before continuing. Record PASS/FAIL in the plan.
6. **Decompose into Tasks (section 8)** — dependency-ordered, `[P]`-marked where parallel-safe,
   `[US#]`-traced to the requirement's user stories, owner+files named per task, with checkpoints
   and completion criteria. Set `depends-on:` on a task when it references a service (via its
   `files:` or description) that has no owning task in this plan and is external to what the plan
   builds. The `- [ ]` checkboxes are the execution contract `/do-execute-plan`
   parses — keep the marker syntax intact, don't reflow it into prose.
7. **Stop** — report the plan path, Constitution Check result, and the task count
   (`[P]`/sequential).

## Boundaries
**Will:** read requirement + design + constitution, write `plan.md` including its embedded task
checklist, run the Constitution Check, resolve clarifications.
**Will Not:** write `design.md` (that's `/do-design`), write code, or execute the plan.

## CRITICAL BOUNDARIES
**STOP AFTER PLAN CREATION.** Output: `agent-docs/doflow/<slug>/plan.md` (HOW + tasks).

**Next Step:** `/do-execute-plan` to execute the tasks. The implement phase is gated: it requires
`requirement.md`, `design.md`, and `plan.md` to all exist.
