---
name: do-design
description: "Design system architecture, APIs, and component interfaces (HOW at the system-shape level); writes design.md as Phase 2 of the doflow chain, turning requirement.md into concrete architecture and interface decisions. Use when requirement.md already exists and the next need is system-shape decisions — diagrams, API contracts, data models — or the user says 'design the architecture for this' rather than asking for an implementation plan or task list."
argument-hint: "[target] [--type architecture|api|component|database] [--format diagram|spec|code]"
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
**Cross-client clarification:** Every `AskUserQuestion` reference below means the mechanism in
`RULE_04_QUESTIONS.md`: use that tool in Claude Code; in Codex or Gemini, write the stage question
file and wait for its answered `[Answer]:` tags. Include `Other` explicitly in a question file.

1. **Resolve** — run the resolver, parse JSON:
   ```bash
   RESOLVER="${DOFLOW_CONFIG_DIR:+$DOFLOW_CONFIG_DIR/scripts/doflow/bash/do-paths.sh}"
   if [ -z "$RESOLVER" ] || [ ! -f "$RESOLVER" ]; then
     d="$PWD"
     while [ "$d" != / ]; do
       [ -f "$d/.doflow/scripts/doflow/bash/do-paths.sh" ] && RESOLVER="$d/.doflow/scripts/doflow/bash/do-paths.sh" && break
       d="$(dirname "$d")"
     done
   fi
   DOFLOW_CONFIG_DIR="$(dirname "$(dirname "$(dirname "$(dirname "$RESOLVER")")")")"
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
5. **Write `design.md`** — copy `$DOFLOW_CONFIG_DIR/templates/doflow/design-template.md` into the
   feature dir, fill
   it from step 4. `design-template.md`'s §8 "Assumptions" section must read "None" unless a
   design-level clarification question was resolved via the defer escape hatch in Step 4, in
   which case record it there with a one-line rationale.
   Structure the artifact per `references/ARTIFACT_FORMAT.md` — read it before filling the
   template: index-then-detail for §3/§7/§8, the closed `Live` / `Superseded → <ref>` status
   vocabulary, and §9 History. Its §4 also governs the C4 diagrams — keep C4 as the conceptual
   zoom model but render every level with Mermaid `flowchart` plus `subgraph` boundaries; the
   experimental `C4Context` / `C4Container` types must not be used.
6. **Validate** — run the advisory consistency check and surface any findings verbatim:
   ```bash
   bash "$DOFLOW_CONFIG_DIR/scripts/doflow/bash/validate-artifacts.sh" "<design path>"
   ```
   Findings are reported to the user, never repaired automatically. A non-zero exit is advisory
   and does not halt the chain.
7. **Stop** — report the design path.

## Boundaries
**Will:** read `requirement.md`, produce system-shape design decisions, write `design.md`.
**Will Not:** write `plan.md` (implementation approach/task decomposition — that's `/do-plan`),
write code, or execute anything.

## CRITICAL BOUNDARIES
**STOP AFTER DESIGN CREATION.** Output: `agent-docs/doflow/<slug>/design.md`.

**Next Step:** `/do-plan` to turn the design into an implementation plan (HOW to build it).
