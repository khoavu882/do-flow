---
name: do-brainstorm
description: "Interactive requirements discovery through Socratic dialogue; seeds requirement.md in a branch-coupled feature dir as Phase 1 of the doflow chain. Use when an idea is still vague and needs discovery questions before any design or planning work starts, or when the user says something like 'I have an idea for a new feature' or 'help me figure out what we actually need to build' rather than describing a concrete, already-scoped task."
argument-hint: "[topic/idea] [--depth shallow|normal|deep]"
effort: high
---

# do-brainstorm

Phase 1 of the doflow chain (`do-brainstorm → do-design → do-plan → do-execute-plan → do-test →
do-code-review`). Transforms an ambiguous idea into a concrete requirement through Socratic dialogue,
then persists the result as `requirement.md` whenever the accepted workflow has a discovery stage —
this is what closes the cross-session continuity gap: brainstorm output survives a compact or
session-end without a separate save step.

## Invocation
```text
/do-brainstorm [topic/idea] [--depth shallow|normal|deep]
```

## Behavioral Flow

1. **Resolve** — run the deterministic resolver and parse its JSON (never compute paths yourself).
   Every DoFlow runtime call in this skill goes through the runtime seam. Resolve it **once** here
   and reuse `$DOFLOW` for every later call in this skill:

```bash
# Resolve the DoFlow runtime: nearest project install wins, then the global one.
D=$PWD; while [ "$D" != / ] && [ ! -x "$D/.doflow/scripts/doflow/bin/doflow-run" ]; do D=$(dirname "$D"); done
DOFLOW="$D/.doflow/scripts/doflow/bin/doflow-run"
[ -x "$DOFLOW" ] || DOFLOW="$HOME/.doflow/scripts/doflow/bin/doflow-run"
[ -x "$DOFLOW" ] || { echo "doflow: no runtime found in any .doflow/ above $PWD, nor at $HOME/.doflow. Run: npx @khoavu882/doflow install" >&2; exit 2; }
```

Run every command below from the project root — the walk-up starts at `$PWD`. On exit 2, print the message verbatim and stop; it names every path searched.

```bash
"$DOFLOW" paths --json
```

   If `feature_slug` is `null` **and** `candidate_slugs` is non-empty (a non-git root — e.g.
   doflow installed at a multi-service container root — with 2+ `agent-docs/doflow/` feature dirs
   and no branch to disambiguate), this is NOT "no active feature" — it's an unresolved choice.
   Ask via `AskUserQuestion`, one option per `candidate_slugs` entry, before continuing to step 3;
   never fall through to step 4's fresh-feature path on an ambiguous result, that would create a
   duplicate feature dir. Re-resolve with `"$DOFLOW" paths --json --slug="<chosen>"` and
   use that slug for the rest of this flow. If `/do-flow` already disambiguated and is invoking this skill
   directly, it passes `--slug="<chosen>"` itself — the resolver output already has a non-null
   `feature_slug` in that case, so no prompt is needed here.
2. **Propose one task class; the runtime validates it** — name exactly one class id for what is
   being asked. `/do-flow` passes one when it invoked this skill; a user who named one settles it.
   Validate before eliciting anything:
   ```bash
   "$DOFLOW" classify --task-class "<proposed>" --json
   ```
Branch on the returned `outcome` field, not the exit code.
- **`ACCEPTED`** — the returned `workflow` is this run's plan of record; read `stages`, `gates` and `handoff` off it rather than from memory.
- **`REJECTED`** — **stop.** Print `message` verbatim (it already names `validClasses` and any `suggestions`), ask the user to choose from `validClasses`, then re-validate. Never substitute `feature`.
- **Exit 2** — surface the message verbatim and stop.

This skill is the accepted workflow's `discovery` stage: state the class and the one signal it rests
on in a single line. `feature` is not the safe default; it is the longest workflow and the only one
that demands three artifacts before an edit. If the accepted `stageIds` contain no `discovery` stage,
say so and hand off to the first stage they do name rather than writing a `requirement.md` that
workflow never reads.

3. **Explore** — Socratic dialogue: transform the idea through systematic questioning.
   `--depth shallow|normal|deep` is the single breadth knob: it sets both how many dialogue
   rounds run and how wide each one reaches. Coordinate architecture/analysis/frontend/backend/
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
   assumption rather than by re-prompting — see Step 5 for where that assumption is recorded.
**Stop when** every ambiguity the contract names has an answer or a stated gap, **and** the last round produced no new ambiguity. A round that only restates what you already have is the last round. Report the remaining gaps rather than continuing.
   The loop's posture — how deep to question, what a round is for — is the Behavioral Posture read
   below, not a second rule stated here.
4. **Pick the feature** — if `feature_slug` is non-null (branch-derived, auto-selected from a
   single non-git candidate, or resolved via step 1's disambiguation), use it. If still null
   (genuinely no active feature: trunk branch, or a non-git root with zero existing feature dirs),
   ask the user for a slug using the RULE_04 question format, default
   `<next_number>-<kebab-of-description>`, then create the dir: `mkdir -p
   agent-docs/doflow/<slug>`. **Branch creation delegated to `/do-git`:** if `is_git_repo` is true,
   call `"$DOFLOW" git-state --branch-name --class=feature --slug=<slug>` and use the
   returned branch name with `git checkout -b`; if false (non-git root), skip branch creation
   entirely.
5. **Write `requirement.md`** — copy the requirement template into the feature dir and fill the
   tokens from the dialogue.
The template is `templates/doflow/requirement-template.md` in the install step 1 resolved: take `constitution_base` from that JSON and swap its trailing `guidance/references/CONSTITUTION_BASE.md` for that path.
   WHAT/WHY only: user stories (P1/P2/P3 → US#), `FR-###`, NFRs, out-of-scope, acceptance criteria. Zero `[NEEDS CLARIFICATION]` markers remain in §7 at
   hand-off — every ambiguity from Step 2 is either a resolved answer folded into the relevant
   US/FR/NFR, or an assumption recorded in `requirement-template.md`'s §8 "Assumptions" section
   with a one-line rationale.
   The `[NEEDS CLARIFICATION]` marker syntax remains only as a fallback for a session aborted
   mid-loop, not for a completed artifact. Populate the `**Ticket:**` header field only if the user
   referenced a PBI/epic/ticket ID during the dialogue (confirm the exact ID via `AskUserQuestion`
   if it was ambiguous) — otherwise write `none`; do not add a new forced question to every
   brainstorm session just to fill this field.
Structure the artifact per the guidance tree's `references/ARTIFACT_FORMAT.md` — read it before filling the template; it names which of this artifact's sections take an index-then-detail table.

6. **Validate** — run the advisory consistency check and surface any findings verbatim:
   ```bash
   "$DOFLOW" validate "<requirement path>"
   ```
   Surface findings verbatim; a non-zero exit is advisory and does not halt the chain.
7. **Batch this stage's evidence** — one pass here at the stage boundary, never one call per fact.
   `<task id>` is the unit these stores key on: the plan task id once `plan.md` exists, otherwise
   the feature slug. Use the same id for every `evidence`, `claim` and `readiness` call in the run —
   a different id reads a different task's record.
   ```bash
   "$DOFLOW" evidence --task-id "<task id>" --action add --batch <batch>.json --json
   "$DOFLOW" claim --task-id "<task id>" --action add --statement "<one conclusion>"
   ```
Item schema, provenance rules, and the refused-field list: the guidance tree's `references/EVIDENCE_LEDGER.md`. Read it before writing the batch.
   This stage's items are the block you just wrote into `requirement.md` — mostly `user-statement`
   and `generated-analysis`, neither of which may ever be `extracted`, because that pairing is
   exactly how the user's words and your reading of them stop being distinguishable. Add every
   conclusion this stage reached as a claim in the same pass.
8. **Stop** — report the requirement path and confirmation that §7 has zero remaining
   `[NEEDS CLARIFICATION]` markers (or, in the rare aborted-session case, whatever markers remain).

## Behavioral Posture

Before starting, read `modes/MODE_Brainstorming.md` in the shared guidance tree for
the discovery posture it sets (question depth, when to stop eliciting). That file is loaded on demand through this skill — it has no other trigger,
so skipping the read silently drops the posture it defines.

## Boundaries
**Will:** propose a task class and have the runtime validate it, run Socratic discovery, create the
feature branch+dir (if needed), seed and fill `requirement.md`, and batch the stage's evidence and
claims at the boundary.
**Will Not:** include tech/implementation detail, design architecture (`/do-design`'s job), write
code, run `/do-plan`'s job, elicit under a class the runtime rejected or replaced with `feature`,
call `readiness` for a stage that declares no template; or express evidence, an estimate or readiness as a number, a percentage or a confidence.

## CRITICAL BOUNDARIES
**STOP AFTER REQUIREMENT CREATION.** Output: `agent-docs/doflow/<slug>/requirement.md` (WHAT/WHY).

**Next Step:** `/do-design` for architecture, then `/do-plan` for the implementation plan (HOW).
