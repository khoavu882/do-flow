---
name: do-brainstorm
description: "Interactive requirements discovery through Socratic dialogue; seeds requirement.md in a branch-coupled feature dir"
argument-hint: "[topic/idea] [--strategy systematic|agile|enterprise] [--depth shallow|normal|deep] [--parallel]"
disable-model-invocation: true
effort: high
---

# do-brainstorm

Phase 1 of the doflow chain (`do-brainstorm → do-design → do-plan → do-execute-plan → do-test →
do-code-review`). Transforms an ambiguous idea into a concrete requirement through Socratic dialogue,
then **always** persists the result as `requirement.md` — this is what closes the cross-session
continuity gap: brainstorm output survives a compact/session-end without a separate save step.

## Invocation
```text
/do-brainstorm [topic/idea] [--strategy systematic|agile|enterprise] [--depth shallow|normal|deep] [--parallel]
```

## Behavioral Flow
1. **Resolve** — run the deterministic resolver and parse its JSON (never compute paths yourself):
   ```bash
   RESOLVER="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/scripts/doflow/bash/do-paths.sh"
   [ -f "$RESOLVER" ] || RESOLVER="core/scripts/doflow/bash/do-paths.sh"   # dev tree
   bash "$RESOLVER" --json
   ```
2. **Explore** — Socratic dialogue: transform the idea through systematic questioning.
   `--depth shallow|normal|deep` and `--strategy systematic|agile|enterprise` shape how many
   rounds and how wide the exploration goes. Coordinate architecture/analysis/frontend/backend/
   security domain framing as needed, but stay in discovery mode — no implementation decisions
   here.
3. **Pick the feature** — if `feature_slug` is non-null, use it. If null (trunk branch), ask the
   user for a slug using the RULE_04 question format, default
   `<next_number>-<kebab-of-description>`, then create the branch and dir:
   `git checkout -b feat/<slug>` and `mkdir -p agent-docs/doflow/<slug>`.
4. **Write `requirement.md`** — copy `templates/doflow/requirement-template.md` into the feature
   dir, fill the tokens from the dialogue. WHAT/WHY only: user stories (P1/P2/P3 → US#), `FR-###`,
   NFRs, out-of-scope, acceptance criteria. Cap unresolved `[NEEDS CLARIFICATION]` markers at 3.
5. **Stop** — report the requirement path and the open `[NEEDS CLARIFICATION]` items.

## Boundaries
**Will:** run Socratic discovery, create the feature branch+dir (if needed), seed and fill
`requirement.md`.
**Will Not:** include tech/implementation detail, design architecture (`/do-design`'s job), write
code, or run `/do-plan`'s job.

## CRITICAL BOUNDARIES
**STOP AFTER REQUIREMENT CREATION.** Output: `agent-docs/doflow/<slug>/requirement.md` (WHAT/WHY).

**Next Step:** `/do-design` for architecture, then `/do-plan` for the implementation plan (HOW).
