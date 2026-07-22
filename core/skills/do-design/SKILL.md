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
   if [ ! -f "$RESOLVER" ]; then                                          # project-scoped install
     d="$PWD"
     while [ "$d" != / ]; do
       [ -f "$d/.claude/scripts/doflow/bash/do-paths.sh" ] && RESOLVER="$d/.claude/scripts/doflow/bash/do-paths.sh" && break
       d="$(dirname "$d")"
     done
   fi
   bash "$RESOLVER" --json
   ```
   If `feature_slug` is `null` **and** `candidate_slugs` is non-empty (a non-git root with 2+
   `agent-docs/doflow/` feature dirs and no branch to disambiguate), ask via `AskUserQuestion`, one
   option per `candidate_slugs` entry, before continuing. Re-resolve with `bash "$RESOLVER" --json
   --slug="<chosen>"` and use that slug for the rest of this flow. If `/do-flow` already
   disambiguated and is invoking this skill directly, it passes `--slug="<chosen>"` itself — skip
   the prompt in that case (resolver output already has a non-null `feature_slug`).
2. **Precondition (advisory)** — if `has_requirement` is false, warn that there's no
   `requirement.md` and offer to run `/do-brainstorm` first. This gate is **advisory**
   (skippable), not the hard hook gate.
3. **Read inputs** — `requirement.md` for the user stories, FRs, and NFRs the design must serve.
4. **Design** — per `--type` (architecture/api/component/database), produce the system-shape
   decisions: a C4 System Context diagram (actors + external systems this feature touches) and,
   when the feature spans more than one deployable unit, a C4 Container diagram; component
   boundaries, API/interface contracts, data model, sequence/data-flow where useful. `--format`
   controls output shape (diagram/spec/code-sketch) within `design.md`, not whether it gets
   written. For a trivial, single-file change with no new external interaction, write
   "N/A: [why]" in the System Overview section instead of forcing a diagram. Before finalizing
   system-shape decisions, run the same clarification loop `do-brainstorm` uses for any
   design-level ambiguity encountered while shaping architecture/API/data-model choices (e.g.
   "extend an existing endpoint vs. add a new one", "single container vs. split service").
   Concretely: partition ambiguities surfaced while designing into independent ones (up to 4,
   batched into one `AskUserQuestion` call) and dependent ones (asked individually, in dependency
   order, after their dependency resolves, never batched with what they depend on). Every question
   built for this loop MUST include an explicit "Decide for me" choice among its listed options
   (on top of the tool's automatic "Other" free-text escape), so this defer path is actually
   selectable. A question where the user picks that "Decide for me" option (distinct from the
   general "Other" free-text escape) resolves via a recorded assumption, not by re-prompting —
   see Step 5 below for where that's recorded.
5. **Write `design.md`** — copy `templates/doflow/design-template.md` into the feature dir, fill
   it from step 4. `design-template.md`'s §8 "Assumptions" section must read "None" unless a
   design-level clarification question was resolved via the defer escape hatch in Step 4, in
   which case record it there with a one-line rationale.
6. **Stop** — report the design path.

## Boundaries
**Will:** read `requirement.md`, produce system-shape design decisions, write `design.md`.
**Will Not:** write `plan.md` (implementation approach/task decomposition — that's `/do-plan`),
write code, or execute anything.

## CRITICAL BOUNDARIES
**STOP AFTER DESIGN CREATION.** Output: `agent-docs/doflow/<slug>/design.md`.

**Next Step:** `/do-plan` to turn the design into an implementation plan (HOW to build it).
