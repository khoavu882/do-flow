---
name: do-plan
description: "Generate the implementation plan (HOW) from spec.md, with a Constitution Check gate."
argument-hint: "[--strategy systematic|agile] [--depth normal|deep]"
disable-model-invocation: true
effort: high
---

# do-plan

Phase 2 of the doflow chain. Turns `spec.md` (WHAT/WHY) into `plan.md` (HOW).

## Invocation
```text
/do-plan [--strategy systematic|agile] [--depth normal|deep]
```

## Behavioral Flow
1. **Resolve** — run the resolver, parse JSON:
   ```bash
   RESOLVER="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/scripts/doflow/bash/do-paths.sh"
   [ -f "$RESOLVER" ] || RESOLVER="core/scripts/doflow/bash/do-paths.sh"
   bash "$RESOLVER" --json
   ```
2. **Precondition (advisory)** — if `has_spec` is false, warn that there's no `spec.md` and offer to run
   `/do-spec` first. This gate is **advisory** (skippable), not the hard hook gate.
3. **Read inputs** — `spec.md` and the resolved constitution (`constitution_base` overlaid by
   `constitution_local`; local wins).
4. **Write `plan.md`** — copy `templates/doflow/plan-template.md` into the feature dir, fill it:
   approach, research/decisions that resolve every `[NEEDS CLARIFICATION]` from the spec, components,
   data/contracts, risks, validation strategy.
5. **Constitution Check (gate)** — evaluate the plan against the resolved constitution. On a violation,
   STOP and revise the approach before continuing. Record PASS/FAIL in the plan.
6. **Stop** — report the plan path and Constitution Check result.

## Boundaries
**Will:** read spec + constitution, write `plan.md`, run the Constitution Check, resolve clarifications.
**Will Not:** write `tasks.md` (that's `/do-tasks`), write code, or execute the plan.

## CRITICAL BOUNDARIES
**STOP AFTER PLAN CREATION.** Output: `agent-docs/specs/<slug>/plan.md` (HOW).

**Next Step:** `/do-tasks` to decompose the plan into dependency-ordered tasks.
