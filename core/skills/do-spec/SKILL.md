---
name: do-spec
description: "Create a feature specification (WHAT/WHY) from brainstorm/design output; seeds spec.md in a branch-coupled feature dir"
argument-hint: "[feature description] [--slug NNN-name]"
disable-model-invocation: true
effort: high
---

# do-spec

Phase 1 of the doflow chain (`constitution → spec → plan → tasks → implement → review`).
Produces a **specification document only** — WHAT and WHY, never HOW.

## Invocation
```text
/do-spec [feature description] [--slug NNN-name]
```

## Behavioral Flow
1. **Resolve** — run the deterministic resolver and parse its JSON (never compute paths yourself):
   ```bash
   RESOLVER="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/scripts/doflow/bash/do-paths.sh"
   [ -f "$RESOLVER" ] || RESOLVER="core/scripts/doflow/bash/do-paths.sh"   # dev tree
   bash "$RESOLVER" --json
   ```
2. **Pick the feature** — if `feature_slug` is non-null, use it. If null (trunk branch), ask the user
   for a slug using the RULE_04 question format, default `<next_number>-<kebab-of-description>`, then
   create the branch and dir: `git checkout -b feat/<slug>` and `mkdir -p agent-docs/specs/<slug>`.
3. **Consume prior discovery** — if `/do-brainstorm` and/or `/do-design` output exists in this session
   or under `agent-docs/`, fold it into the spec. Do **not** re-run discovery; this skill records, not explores.
4. **Write `spec.md`** — copy `templates/doflow/spec-template.md` into the feature dir, fill the tokens.
   WHAT/WHY only: user stories (P1/P2/P3 → US#), `FR-###`, NFRs, out-of-scope, acceptance criteria.
   Cap unresolved `[NEEDS CLARIFICATION]` markers at 3.
5. **Stop** — report the spec path and the open `[NEEDS CLARIFICATION]` items.

## Boundaries
**Will:** create the feature branch+dir (if needed), seed and fill `spec.md`, fold in prior discovery.
**Will Not:** include tech/implementation, design architecture, write code, or run `/do-plan`'s job.

## CRITICAL BOUNDARIES
**STOP AFTER SPEC CREATION.** Output: `agent-docs/specs/<slug>/spec.md` (WHAT/WHY).

**Next Step:** `/do-plan` to turn the spec into an implementation plan (HOW).
