---
name: do-flow
description: "Auto-chain the doflow spec-driven flow (brainstorm → design → plan → implement → test → review), pausing only at defined approval gates"
argument-hint: "[feature description] [--from brainstorm|design|plan|implement|test|review]"
effort: high
---

# do-flow

Runs the doflow spec-driven chain end-to-end without requiring a manual `/do-X` invocation for
every phase. It does not replace or modify `do-brainstorm`, `do-design`, `do-plan`,
`do-execute-plan`, `do-test`, or `do-code-review` — it runs their existing Behavioral Flows in
sequence rather than reimplementing them. `do-constitution` is a separate, standalone skill —
not part of this chain; invoke it directly when you need to set or amend repo-level rules.

## Invocation
```text
/do-flow [feature description] [--from brainstorm|design|plan|implement|test|review]
```

## Behavioral Flow
**Cross-client clarification:** Every `AskUserQuestion` reference below means the mechanism in
`RULE_04_QUESTIONS.md`: use that tool in Claude Code; in Codex or Gemini, write the stage question
file and wait for its answered `[Answer]:` tags. Include `Other` explicitly in a question file.

1. **Resolve state** — resolve and run `do-paths.sh --json` from the installed DoFlow config:
   ```bash
   RESOLVER="${DOFLOW_CONFIG_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}/scripts/doflow/bash/do-paths.sh"
   [ -f "$RESOLVER" ] || RESOLVER="$HOME/.codex/scripts/doflow/bash/do-paths.sh"
   if [ ! -f "$RESOLVER" ]; then
     d="$PWD"
     while [ "$d" != / ]; do
       for config_dir in .claude .codex .agents; do
         [ -f "$d/$config_dir/scripts/doflow/bash/do-paths.sh" ] && RESOLVER="$d/$config_dir/scripts/doflow/bash/do-paths.sh" && break 2
       done
       d="$(dirname "$d")"
     done
   fi
   bash "$RESOLVER" --json
   ```
   Determine the starting phase:
   - `feature_slug` is `null` **and** `candidate_slugs` is empty (trunk branch, or a non-git root
     with zero `agent-docs/doflow/` dirs): no active feature — start at `do-brainstorm`.
   - `feature_slug` is `null` **and** `candidate_slugs` is non-empty (a non-git root — e.g. doflow
     installed at a multi-service container root — with 2+ feature dirs and no branch to
     disambiguate): this is NOT "no active feature," it's an unresolved choice. Ask via
     `AskUserQuestion`, one option per `candidate_slugs` entry, before doing anything else — never
     default to `do-brainstorm` here, that would create a duplicate feature dir alongside an
     existing one. Re-resolve with `do-paths.sh --json --slug="<chosen>"` and carry that slug
     through every remaining phase invocation and gate.
   - `feature_slug` is set (branch-derived, or auto-selected/disambiguated above): resume from the
     first missing artifact — `!has_requirement` → `do-brainstorm`; `has_requirement &&
     !has_design` → `do-design`; `has_design && !has_plan` → `do-plan`; all three present →
     Gate A (step 4).
   - `--from <phase>` overrides auto-detection to deliberately re-run a specific phase.
2. **Run phases in sequence**, invoking each phase skill's own Behavioral Flow directly:
   `do-brainstorm` → [**Gate 0**] → `do-design` → `do-plan` → [**Gate A**] → `do-execute-plan` →
   `do-test` → `do-code-review` → [**Gate B**].
3. **Report progress after each auto-advanced phase** — one line: phase name + artifact path
   (e.g. `requirement.md written → agent-docs/doflow/003-foo/requirement.md`) — so the user can
   follow along without needing to intervene.
4. **Stop at exactly three points; auto-advance everywhere else:**

   - **Gate 0 — unresolved `[NEEDS CLARIFICATION]` markers** (after `do-brainstorm`):
     `do-brainstorm` now resolves every ambiguity to zero via its own clarification loop before
     writing `requirement.md`, so this gate is a safety net rather than the normal path — it only
     fires if a marker survives from a session aborted mid-loop. If any remain unresolved, stop
     and surface them via `AskUserQuestion` (one question per marker, or grouped if closely
     related) before continuing to `do-design`. Patch resolved answers into `requirement.md`
     directly; do not re-run `do-brainstorm`.
   - **Gate A — before implementation** (after `do-plan`, before `do-execute-plan`): this is the
     auto-chain's *conversational* checkpoint on top of the already-existing hard hook gate
     (`pre-implement-gate.sh`, which blocks source edits until `requirement.md` + `design.md` +
     `plan.md` exist and remains the real enforcement regardless of what happens here). Ask via
     `AskUserQuestion`: "`requirement.md`, `design.md`, and `plan.md` are ready. Proceed to
     implementation?" with options `Proceed` / `Let me review the artifacts first` / `Stop here`.
   - **Gate B — before commit/merge** (after `do-code-review`): no enforcement hook exists for this
     today — `/do-git` is a separate, always-manually-invoked skill. Ask via `AskUserQuestion`,
     framed by the review's own approval status (e.g. if `CHANGES REQUESTED`, foreground
     "address findings first" rather than offering a bare proceed option): "Review result:
     `<status>`. Proceed to `/do-git` for commit/merge?"

5. **Never skip a gate on an ambiguous answer** — an unanswered or unclear response to any
   `AskUserQuestion` means stop and ask again, per this repo's `RULE_04_QUESTIONS`.

## Boundaries
**Will:**
- Auto-advance through brainstorm/design/plan/implement/test/review without requiring a manual
  re-invocation at each phase boundary.
- Stop at exactly three points: unresolved requirement clarifications, before implementation,
  before commit/merge.
- Compose with the existing `pre-implement-gate.sh` hard gate rather than bypass or duplicate it.

**Will Not:**
- Modify `do-brainstorm`, `do-design`, `do-plan`, `do-execute-plan`, `do-test`, or `do-code-review`.
- Invoke or modify `do-constitution` — it is a standalone skill outside this chain; run it
  separately when you need to set or amend repo-level rules.
- Add a new hook-level enforcement gate for commit/merge — Gate B is conversational only. A
  hook-level version would be a separate, future proposal.
- Silently proceed past a gate on an ambiguous or missing answer.

**Next Step:** after `do-flow` completes (or pauses at a gate), `/do-git` to commit/merge once
Gate B is cleared.
