---
name: do-design
description: "Design system architecture, APIs, and component interfaces (HOW at the system-shape level); writes design.md"
argument-hint: "[target] [--type architecture|api|component|database] [--format diagram|spec|code]"
disable-model-invocation: true
effort: high
---

# do-design

Phase 2 of the doflow chain. Turns `requirement.md` (WHAT/WHY) into `design.md` — the system
shape: architecture, APIs, data/interface contracts. Distinct from `/do-plan`'s HOW, which covers
implementation approach and task decomposition, not system-shape decisions.

## Invocation
```text
/do-design [target] [--type architecture|api|component|database] [--format diagram|spec|code]
```

## Behavioral Flow
1. **Resolve** — run the resolver, parse JSON:
   ```bash
   RESOLVER="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/scripts/doflow/bash/do-paths.sh"
   [ -f "$RESOLVER" ] || RESOLVER="core/scripts/doflow/bash/do-paths.sh"
   bash "$RESOLVER" --json
   ```
2. **Precondition (advisory)** — if `has_requirement` is false, warn that there's no
   `requirement.md` and offer to run `/do-brainstorm` first. This gate is **advisory**
   (skippable), not the hard hook gate.
3. **Read inputs** — `requirement.md` for the user stories, FRs, and NFRs the design must serve.
4. **Design** — per `--type` (architecture/api/component/database), produce the system-shape
   decisions: component boundaries, API/interface contracts, data model, sequence/data-flow where
   useful. `--format` controls output shape (diagram/spec/code-sketch) within `design.md`, not
   whether it gets written.
5. **Write `design.md`** — copy `templates/doflow/design-template.md` into the feature dir, fill
   it from step 4.
6. **Stop** — report the design path.

## Boundaries
**Will:** read `requirement.md`, produce system-shape design decisions, write `design.md`.
**Will Not:** write `plan.md` (implementation approach/task decomposition — that's `/do-plan`),
write code, or execute anything.

## CRITICAL BOUNDARIES
**STOP AFTER DESIGN CREATION.** Output: `agent-docs/doflow/<slug>/design.md`.

**Next Step:** `/do-plan` to turn the design into an implementation plan (HOW to build it).
