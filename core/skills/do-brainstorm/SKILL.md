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
   if [ ! -f "$RESOLVER" ]; then                                          # project-scoped install
     d="$PWD"
     while [ "$d" != / ]; do
       [ -f "$d/.claude/scripts/doflow/bash/do-paths.sh" ] && RESOLVER="$d/.claude/scripts/doflow/bash/do-paths.sh" && break
       d="$(dirname "$d")"
     done
   fi
   bash "$RESOLVER" --json
   ```
   If `feature_slug` is `null` **and** `candidate_slugs` is non-empty (a non-git root — e.g.
   doflow installed at a multi-service container root — with 2+ `agent-docs/doflow/` feature dirs
   and no branch to disambiguate), this is NOT "no active feature" — it's an unresolved choice.
   Ask via `AskUserQuestion`, one option per `candidate_slugs` entry, before continuing to step 2;
   never fall through to step 3's fresh-feature path on an ambiguous result, that would create a
   duplicate feature dir. Re-resolve with `bash "$RESOLVER" --json --slug="<chosen>"` and use that
   slug for the rest of this flow. If `/do-flow` already disambiguated and is invoking this skill
   directly, it passes `--slug="<chosen>"` itself — the resolver output already has a non-null
   `feature_slug` in that case, so no prompt is needed here.
2. **Explore** — Socratic dialogue: transform the idea through systematic questioning.
   `--depth shallow|normal|deep` and `--strategy systematic|agile|enterprise` shape how many
   rounds and how wide the exploration goes. Coordinate architecture/analysis/frontend/backend/
   security domain framing as needed, but stay in discovery mode — no implementation decisions
   here.
3. **Pick the feature** — if `feature_slug` is non-null (branch-derived, auto-selected from a
   single non-git candidate, or resolved via step 1's disambiguation), use it. If still null
   (genuinely no active feature: trunk branch, or a non-git root with zero existing feature dirs),
   ask the user for a slug using the RULE_04 question format, default
   `<next_number>-<kebab-of-description>`, then create the dir: `mkdir -p
   agent-docs/doflow/<slug>`, plus `git checkout -b feat/<slug>` when `is_git_repo` is `true`
   (skip the branch step entirely at a non-git root — there's no repo to branch).
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
