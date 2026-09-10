---
name: do-brainstorm
description: "Interactive requirements discovery through Socratic dialogue; seeds requirement.md in a branch-coupled feature dir as Phase 1 of the doflow chain. Use whenever an idea is still vague or early, requirements need discovery questions before design or planning begins, or the user says 'I have an idea', 'help me scope this feature', 'brainstorm what we need', or 'explore building X'. Always activate this skill before designing or planning new features to ensure requirements are grounded in WHAT and WHY without premature implementation choices."
argument-hint: "[topic/idea] [--intent <path>] [--depth shallow|normal|deep]"
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
/do-brainstorm [topic/idea] [--intent <path>] [--depth shallow|normal|deep]
```

**`--intent <path>`** seeds this stage from a pre-branch intent. An intent lives at
`agent-docs/intent/<kebab-description>.md`, outside the branch-coupled tree, and is written before any
branch or feature exists — so it is the one input this skill may be given that did not come from the
conversation. When the flag is present:

- Read the file. Carry its Problem, Proposed outcome, Affected and Constraints into the requirement you
  write, in §1, §2 and §4 respectively. Treat its **Open questions** as ambiguities for step 3's
  clarification loop — they are the originator saying what they did not know, not answers to fold in.
- Fill `requirement.md`'s `**Intent:**` header field with the path you read, so a reader can see where
  the problem statement came from and judge whether it was reinterpreted.
- Never move, rename, delete or rewrite the intent. It records what was asked; `requirement.md` records
  what the project decided to do about it, and the two are allowed to diverge.
- A path that does not exist is a mistake, not an absence: say so and stop, rather than proceeding as
  though no intent had been named.

Without the flag, nothing below changes and no intent is owed — discovery starting from a conversation
alone is the ordinary case.

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
   "$DOFLOW" classify --task-class "<proposed>" --calling-skill do-brainstorm --json
   ```
Branch on the returned `outcome` field, not the exit code.
- **`ACCEPTED`** — the returned `workflow` is this run's plan of record; read `stages`, `gates` and `handoff` off it rather than from memory.
- **`REJECTED`** — **stop.** Print `message` verbatim (it already names `validClasses` and any `suggestions`), ask the user to choose from `validClasses`, then re-validate. Never substitute `feature`.
  A rejection may be about **you** rather than the class (`reason: caller-not-a-stage`). Then the fix is to propose one of the classes in `fit.hostingClasses`, or to hand the work to the skill this class names for the stage you meant — not to re-propose the same class.
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
   here. Discovery focuses strictly on WHAT and WHY: user problem, personas, business outcomes,
   and acceptance criteria. Keeping concrete technical stack decisions out of requirements prevents
   premature technical bias before `/do-design` evaluates architectural options.
   **MCP Integration**:
   - **Context7**: the idea names a specific library or framework → verify the claim, per
     `MCP_Context7.md`'s Tool IDs, before folding it into `requirement.md` — read-only
     fact-checking, never a tech choice.
   - **Sequential-thinking**: a round's ambiguity is genuinely multi-step or cross-domain → route
     it per `MCP_Sequential.md`'s Tool IDs.
   After each dialogue round, before moving to the next round, partition any ambiguities
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
   **Log each round.** One file per round, never appended to a prior round's file:
   `agent-docs/doflow/<slug>/intention/brainstorm-<NN>-question.md`, shaped by
   `templates/doflow/question-log-template.md` (same install path resolution as the requirement
   template in step 5) — every question as asked, the options offered, and the answer given, with a
   "Decide for me" pick recorded as the assumption it becomes rather than as an answer. `<NN>` is
   zero-padded to two digits and starts at step 1's `intention_next_round` — never hand-counted:
   the resolver already scanned the subdir, and this session's second round is that value plus one,
   its third plus two. Write the round's file as soon as its answers land, `mkdir -p` the
   `intention/` directory first. If `feature_slug` was still null at step 1 (a trunk branch with no
   feature picked yet), there is no directory to write into until step 4 resolves one — hold the
   rounds and write them all, in round order, immediately after step 4's `mkdir`.
4. **Pick the feature** — if `feature_slug` is non-null (branch-derived, auto-selected from a
   single non-git candidate, or resolved via step 1's disambiguation), use it. If still null
   (genuinely no active feature: trunk branch, or a non-git root with zero existing feature dirs),
   ask the user for a slug using the RULE_04 question format, default
   `<next_number>-<kebab-of-description>`. **Branch creation delegated to `/do-git`:** if `is_git_repo` is true,
   call `"$DOFLOW" git-state --branch-name --class=feature --slug=<slug>` and use the
   returned branch name with `git checkout -b`; if false (non-git root), skip branch creation
   entirely.
   Then, on **every** path: `mkdir -p agent-docs/doflow/<slug>/intention`. A branch-derived slug
   names a directory that usually does not exist yet, so this is not only the new-feature case, and
   the stage's own subdirectory holds both its dialogue logs and its output.
5. **Write `requirement.md`** — copy the requirement template into the feature dir and fill the
   tokens from the dialogue. It goes at `agent-docs/doflow/<slug>/intention/requirement.md`: a
   fresh feature dir holds nothing yet, so step 1's `layout` still reads `legacy` and its
   `requirement` field still points at the top level — create `intention/` and write there anyway
   rather than waiting for the resolver, which reports `structured` only once this file exists. The
   one exception is an existing old-layout feature dir (`layout` is `legacy` **and**
   `has_requirement` is true): that feature's `design.md`/`plan.md` already sit at the top level, so
   write to the resolved `requirement` path and leave the dir where it is — this feature performs no
   migration, and a dir must never resolve as a mix of both layouts.
The template is `templates/doflow/requirement-template.md` in the install step 1 resolved: take `constitution_base` from that JSON and swap its trailing `guidance/references/CONSTITUTION_BASE.md` for that path.
   WHAT/WHY only: user stories (P1/P2/P3 → US#), `FR-###`, NFRs, out-of-scope, acceptance criteria. Zero `[NEEDS CLARIFICATION]` markers remain in §7 at
   hand-off — every ambiguity from Step 2/3 is either a resolved answer folded into the relevant
   US/FR/NFR, or an assumption recorded in `requirement-template.md`'s §8 "Assumptions" section
   with a one-line rationale.
   The `[NEEDS CLARIFICATION]` marker syntax remains only as a fallback for a session aborted
   mid-loop, not for a completed artifact. Populate the `**Ticket:**` header field only if the user
   referenced a PBI/epic/ticket ID during the dialogue (confirm the exact ID via `AskUserQuestion`
   if it was ambiguous) — otherwise write `none`; do not add a new forced question to every
   brainstorm session just to fill this field.
Structure the artifact per the guidance tree's `references/ARTIFACT_FORMAT.md` — read it before filling the template; it names which of this artifact's sections take an index-then-detail table.
Read `references/ARTIFACT_VOICE.md` at the same point: it carries the prose rules the artifact's sentences follow, and the carve-outs where one of those rules meets a construct the checker parses.

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
8. **Record the handoff** — one call positions the run (starting one when none exists yet, so this
   stage never has to decide between `start` and completing it for itself), records this stage's
   completion or a rerun annotation, and returns the disposition:
   ```bash
   "$DOFLOW" orchestrate --action handoff --task-id "<slug>" --task-class "<class>" --calling-skill do-brainstorm --note "<requirement path written; §7 marker count>" --json
   ```
   `<slug>` is step 1's `feature_slug`; `<class>` is the class step 2's `classify` call accepted.
   Branch on the response's `disposition`, not the exit code:
   - **`completed`** — this stage was recorded normally; check `awaitingGate` below.
   - **`annotated`** — this stage was already recorded on an earlier run of this skill (a
     re-invocation to amend `requirement.md`, say); the rerun note was appended, no gate to recheck.
   - **`deferred`** — a gate ahead of this stage, an unfinished mutating stage, or a rejected run
     prevented the handoff. Discovery is the chain's first stage, so nothing before it can open a
     gate; report `reason` plainly and stop rather than resolving something that is not this
     stage's.
   - **`standalone`** — no workflow applies; there is nothing further to record here.

   Then the gate anchored to this stage, read directly off the same response rather than re-derived
   from `workflow.gates[]`. A non-null `awaitingGate` carries the `gateId`, `name` and `prompt`
   (`gate-0`, "Unresolved clarifications", in the `feature` workflow); a null one means no gate
   follows this stage in this workflow and there is nothing to decide. `gate-0` is
   `clarification`-kind and its `unresolved-clarifications` trigger is exactly what step 9 already
   checks — so this stage resolves it rather than leaving a mechanically-answerable gate for a
   human. When §7 genuinely carries zero markers, approve it plainly — this is the routine path,
   never a forced one:
   ```bash
   "$DOFLOW" orchestrate --action decide-gate --task-id "<slug>" --gate "<awaitingGate.gateId>" --decision approve --note "requirement.md §7 carries zero markers" --json
   ```
   In the rare aborted-session case where markers remain, do **not** decide the gate at all: leave
   the run `AWAITING_GATE` and say so — resolving it is a human's call, and approving it anyway
   would be a forced override this stage has no reason to make. Finish by rendering the trail. The
   `--slug` value attaches with an `=`; a space-separated one is rejected with an error rather than
   silently rendering the wrong feature's trail:
   ```bash
   "$DOFLOW" render-audit --slug="<slug>" --json
   ```
   Every call in this step is advisory to the trail, not to the artifact. If one fails for a reason
   outside this flow's control (an unwritable local state directory, say), report the failure plainly and
   continue — a missing `audit.md` entry degrades the record, it does not make `requirement.md`
   wrong. None of these calls is a gate on finishing this skill.
9. **Stop** — report the requirement path and confirmation that §7 has zero remaining
   `[NEEDS CLARIFICATION]` markers (or, in the rare aborted-session case, whatever markers remain).

## Behavioral Posture

Before starting, read `modes/MODE_Brainstorming.md` in the shared guidance tree for
the discovery posture it sets (question depth, when to stop eliciting). That file is loaded on demand through this skill — it has no other trigger,
so skipping the read silently drops the posture it defines.

## Boundaries
**Will:** propose a task class and have the runtime validate it, run Socratic discovery, log each
dialogue round to `intention/`, create the feature branch+dir (if needed), seed and fill
`requirement.md`, batch the stage's evidence and claims at the boundary, and record the stage
handoff (and its clarification gate) through `orchestrate`/`render-audit` — and always (no flag)
consult context7 and sequential-thinking at the points named in Step 3.
**Will Not:** include tech/implementation detail, design architecture (`/do-design`'s job), write
code, run `/do-plan`'s job, elicit under a class the runtime rejected or replaced with `feature`,
call `readiness` for a stage that declares no template; or express evidence, an estimate or readiness as a number, a percentage or a confidence.

## CRITICAL BOUNDARIES
**STOP AFTER REQUIREMENT CREATION.** Output: `agent-docs/doflow/<slug>/intention/requirement.md`
(WHAT/WHY), alongside that stage's `intention/brainstorm-<NN>-question.md` dialogue logs.

**Next Step:** `/do-design` for architecture, then `/do-plan` for the implementation plan (HOW).
