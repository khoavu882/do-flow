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

1. **Resolve** — run the resolver, parse JSON. Every DoFlow runtime call in this skill goes through
   the runtime seam. Resolve it **once** here and reuse `$DOFLOW` for every later call in this skill:
   ```bash
   # Resolve the DoFlow runtime: nearest project install wins, then the global one.
   D=$PWD; while [ "$D" != / ] && [ ! -x "$D/.doflow/scripts/doflow/bin/doflow-run" ]; do D=$(dirname "$D"); done
   DOFLOW="$D/.doflow/scripts/doflow/bin/doflow-run"
   [ -x "$DOFLOW" ] || DOFLOW="$HOME/.doflow/scripts/doflow/bin/doflow-run"
   [ -x "$DOFLOW" ] || { echo "doflow: no runtime found in any .doflow/ above $PWD, nor at $HOME/.doflow. Run: npx @khoavu882/doflow install" >&2; exit 2; }
   "$DOFLOW" paths --json
   ```
   The walk-up starts at the working directory, so run every command in this skill from the project
   root. Exit 2 means no DoFlow runtime was found; the message names every place searched — surface
   it verbatim and stop, do not search for the runtime yourself.
   If `feature_slug` is `null` **and** `candidate_slugs` is non-empty (a non-git root with 2+
   `agent-docs/doflow/` feature dirs and no branch to disambiguate), ask via `AskUserQuestion`, one
   option per `candidate_slugs` entry, before continuing. Re-resolve with
   `"$DOFLOW" paths --json --slug="<chosen>"` and use that slug for the rest of this flow. If `/do-flow` already
   disambiguated and is invoking this skill directly, it passes `--slug="<chosen>"` itself — skip
   the prompt in that case (resolver output already has a non-null `feature_slug`).
2. **Propose one task class; the runtime validates it** — name exactly one class id for the work
   being designed. `/do-flow` passes one when it invoked this skill; a user who named one settles
   it; otherwise derive it from `requirement.md`'s scope, not from the fact that a `requirement.md`
   exists.
   ```bash
   "$DOFLOW" classify --task-class "<proposed>" --json
   ```
   Branch on the returned `outcome` field, not on the exit code.
   - **`ACCEPTED`** — the returned `workflow` is this run's plan of record; this skill is its
     `design` stage. State the class and the signal it rests on in one line.
   - **`REJECTED`** — **stop.** Print `message` verbatim; it names `validClasses` and any
     `suggestions`. Ask the user to choose from `validClasses` via `AskUserQuestion`, then
     re-validate. Never substitute `feature` and never design under a class the runtime refused.
   - **Exit 2** — the runtime could not answer. Surface its message verbatim and stop.
   If the accepted `stageIds` contain no `design` stage, say so and hand off to the first stage
   they do name. A `bug` or `trivial-edit` run has no design stage by construction, and producing
   a `design.md` for it invents an artifact its workflow never reads.
3. **Precondition (advisory)** — if `has_requirement` is false, warn that there's no
   `requirement.md` and offer to run `/do-brainstorm` first. This gate is **advisory**
   (skippable), not the hard hook gate.
4. **Read inputs** — `requirement.md` for the user stories, FRs, and NFRs the design must serve.
5. **Design** — per `--type` (architecture/api/component/database), produce the system-shape
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
   see Step 6 below for where that's recorded.
6. **Write `design.md`** — copy the design template into the feature dir and fill it from step 5.
   The template is `templates/doflow/design-template.md` inside the same install step 1 resolved:
   take `constitution_base` from that JSON and replace its trailing
   `guidance/references/CONSTITUTION_BASE.md` with that path. `design-template.md`'s §8 "Assumptions" section must read "None" unless a
   design-level clarification question was resolved via the defer escape hatch in Step 5, in
   which case record it there with a one-line rationale.
   Structure the artifact per `references/ARTIFACT_FORMAT.md` — read it before filling the
   template: index-then-detail for §3/§7/§8, the closed `Live` / `Superseded → <ref>` status
   vocabulary, and §9 History. Its §4 also governs the C4 diagrams — keep C4 as the conceptual
   zoom model but render every level with Mermaid `flowchart` plus `subgraph` boundaries; the
   experimental `C4Context` / `C4Container` types must not be used.
7. **Validate** — run the advisory consistency check and surface any findings verbatim:
   ```bash
   "$DOFLOW" validate "<design path>"
   ```
   Findings are reported to the user, never repaired automatically. A non-zero exit is advisory
   and does not halt the chain.
8. **Batch this stage's evidence** — one pass here at the stage boundary, never one call per fact.
   `<task id>` is the unit these stores key on: the plan task id once `plan.md` exists, otherwise
   the feature slug. Use the same id for every `evidence`, `claim` and `readiness` call in the run —
   a different id reads a different task's record.
   ```bash
   "$DOFLOW" evidence --task-id "<task id>" --json
   "$DOFLOW" claim --task-id "<task id>" --action add --statement "<one conclusion>"
   ```
   `evidence` only reads. It has no append form and silently ignores flags that look like one, so
   the batch itself is the block you just wrote into `design.md`: per item, what was found, where it
   came from (a provider + capability, an existing artifact, or the user), its locator, and whether
   it is **extracted** (read verbatim out of the repository or the user's words) or **inferred**
   (your analysis). Never merge those two provenances into one line — a design that cannot be told
   apart from the code it describes is what makes a wrong assumption unfalsifiable later.
   Add every system-shape conclusion as a claim in this same pass. Each is stored as a `hypothesis`
   and becomes supported only through linked evidence; the previous stage having asserted it is not
   support.
   Relevance is not confidence. A match count, a ranking, a "best hit" is a property of the query,
   not of the fact — record the locator, never a score, a percentage, or a confidence.
   The `design` stage declares `readinessTemplate: null`. Do **not** call `readiness` here and do
   not report one as skipped: readiness belongs to the stage that edits source.
9. **Stop** — report the design path.

## Boundaries
**Will:** propose a task class and have the runtime validate it, read `requirement.md`, produce
system-shape design decisions, write `design.md`, and batch the stage's evidence and claims at the
boundary.
**Will Not:** write `plan.md` (implementation approach/task decomposition — that's `/do-plan`),
write code, execute anything, design under a class the runtime rejected or replaced with `feature`,
call `readiness` for a stage that declares no template, or express evidence or readiness as a
number, a percentage or a confidence.

## CRITICAL BOUNDARIES
**STOP AFTER DESIGN CREATION.** Output: `agent-docs/doflow/<slug>/design.md`.

**Next Step:** `/do-plan` to turn the design into an implementation plan (HOW to build it).
