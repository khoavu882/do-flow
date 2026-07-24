---
name: do-brainstorm
description: "Interactive requirements discovery through Socratic dialogue; seeds requirement.md in a branch-coupled feature dir"
argument-hint: "[topic/idea] [--strategy systematic|agile|enterprise] [--depth shallow|normal|deep] [--parallel]"
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
**Cross-client clarification:** Every `AskUserQuestion` reference below means the mechanism in
`RULE_04_QUESTIONS.md`: use that tool in Claude Code; in Codex or Gemini, write the stage question
file and wait for its answered `[Answer]:` tags. Include `Other` explicitly in a question file.

1. **Resolve** — run the deterministic resolver and parse its JSON (never compute paths yourself):
   ```bash
   RESOLVER="${DOFLOW_CONFIG_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}/scripts/doflow/bash/do-paths.sh"
   [ -f "$RESOLVER" ] || RESOLVER="$HOME/.codex/scripts/doflow/bash/do-paths.sh"
   if [ ! -f "$RESOLVER" ]; then                                          # project-scoped install
     d="$PWD"
     while [ "$d" != / ]; do
       for config_dir in .claude .codex .agents; do
         [ -f "$d/$config_dir/scripts/doflow/bash/do-paths.sh" ] && RESOLVER="$d/$config_dir/scripts/doflow/bash/do-paths.sh" && break 2
       done
       d="$(dirname "$d")"
     done
   fi
   DOFLOW_CONFIG_DIR="$(dirname "$(dirname "$(dirname "$(dirname "$RESOLVER")")")")"
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
   here. After each dialogue round, before moving to the next round, partition any ambiguities
   surfaced that round into: *independent* ones (answerable without knowing another's answer) —
   up to 4 — batched into one `AskUserQuestion` call (the tool's 4-question max); *dependent*
   ones (whose options depend on a prior answer) — asked as their own individual `AskUserQuestion`
   call, in dependency order, after the dependency resolves; never batched with something it
   depends on. Every question built for this loop MUST include an explicit "Decide for me" choice
   among its listed options (on top of the tool's automatic "Other" free-text escape), so the
   defer path below is actually selectable. Any question where the user picks that "Decide for
   me" option (distinct from the general "Other" free-text escape) resolves via a recorded
   assumption rather than by re-prompting — see Step 4 for where that assumption is recorded.
3. **Pick the feature** — if `feature_slug` is non-null (branch-derived, auto-selected from a
   single non-git candidate, or resolved via step 1's disambiguation), use it. If still null
   (genuinely no active feature: trunk branch, or a non-git root with zero existing feature dirs),
   ask the user for a slug using the RULE_04 question format, default
   `<next_number>-<kebab-of-description>`, then create the dir: `mkdir -p
   agent-docs/doflow/<slug>`, plus `git checkout -b feat/<slug>` when `is_git_repo` is `true`
   (skip the branch step entirely at a non-git root — there's no repo to branch).
4. **Write `requirement.md`** — copy
   `$DOFLOW_CONFIG_DIR/templates/doflow/requirement-template.md` into the feature
   dir, fill the tokens from the dialogue. WHAT/WHY only: user stories (P1/P2/P3 → US#), `FR-###`,
   NFRs, out-of-scope, acceptance criteria. Zero `[NEEDS CLARIFICATION]` markers remain in §7 at
   hand-off — every ambiguity from Step 2 is either a resolved answer folded into the relevant
   US/FR/NFR, or an assumption recorded in `requirement-template.md`'s §8 "Assumptions" section
   with a one-line rationale.
   The `[NEEDS CLARIFICATION]` marker syntax remains only as a fallback for a session aborted
   mid-loop, not for a completed artifact. Populate the `**Ticket:**` header field only if the user
   referenced a PBI/epic/ticket ID during the dialogue (confirm the exact ID via `AskUserQuestion`
   if it was ambiguous) — otherwise write `none`; do not add a new forced question to every
   brainstorm session just to fill this field.
5. **Stop** — report the requirement path and confirmation that §7 has zero remaining
   `[NEEDS CLARIFICATION]` markers (or, in the rare aborted-session case, whatever markers remain).

## Boundaries
**Will:** run Socratic discovery, create the feature branch+dir (if needed), seed and fill
`requirement.md`.
**Will Not:** include tech/implementation detail, design architecture (`/do-design`'s job), write
code, or run `/do-plan`'s job.

## CRITICAL BOUNDARIES
**STOP AFTER REQUIREMENT CREATION.** Output: `agent-docs/doflow/<slug>/requirement.md` (WHAT/WHY).

**Next Step:** `/do-design` for architecture, then `/do-plan` for the implementation plan (HOW).
