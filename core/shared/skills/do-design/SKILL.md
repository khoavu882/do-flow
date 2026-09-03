---
name: do-design
description: "Design system architecture, APIs, and component interfaces (HOW at the system-shape level); writes design.md as Phase 2 of the doflow chain, turning requirement.md into concrete architecture and interface decisions. Use when requirement.md already exists and the next need is system-shape decisions — diagrams, API contracts, data models — or the user says 'design the architecture for this' rather than asking for an implementation plan or task list."
argument-hint: "[target] [--type architecture|api|component|database]"
effort: high
---

# do-design

Phase 2 of the doflow chain. Turns `requirement.md` (WHAT/WHY) into `design.md` — the system
shape: architecture, APIs, data/interface contracts. Distinct from `/do-plan`'s HOW, which covers
implementation approach and task decomposition, not system-shape decisions.

## Invocation
```text
/do-design [target] [--type architecture|api|component|database]
```

## Behavioral Flow

1. **Resolve** — run the resolver, parse JSON. Every DoFlow runtime call in this skill goes through
   the runtime seam. Resolve it **once** here and reuse `$DOFLOW` for every later call in this skill:

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

`feature_slug` `null` with a non-empty `candidate_slugs` is an unresolved choice, not "no active feature": ask one option per entry, re-resolve with `"$DOFLOW" paths --json --slug="<chosen>"`, and use that slug for the rest of this flow. `/do-flow` passing `--slug` already resolves it — no prompt then.

2. **Propose one task class; the runtime validates it** — name exactly one class id for the work
   being designed. `/do-flow` passes one when it invoked this skill; a user who named one settles
   it; otherwise derive it from `requirement.md`'s scope, not from the fact that a `requirement.md`
   exists.
   ```bash
   "$DOFLOW" classify --task-class "<proposed>" --calling-skill do-design --json
   ```
Branch on the returned `outcome` field, not the exit code.
- **`ACCEPTED`** — the returned `workflow` is this run's plan of record; read `stages`, `gates` and `handoff` off it rather than from memory.
- **`REJECTED`** — **stop.** Print `message` verbatim (it already names `validClasses` and any `suggestions`), ask the user to choose from `validClasses`, then re-validate. Never substitute `feature`.
  A rejection may be about **you** rather than the class (`reason: caller-not-a-stage`). Then the fix is to propose one of the classes in `fit.hostingClasses`, or to hand the work to the skill this class names for the stage you meant — not to re-propose the same class.
- **Exit 2** — surface the message verbatim and stop.

This skill is the accepted workflow's `design` stage: state the class and the signal it rests on in
one line. If the accepted `stageIds` contain no `design` stage, say so and hand off to the first
stage they do name. A `bug` or `trivial-edit` run has no design stage by construction, and producing
a `design.md` for it invents an artifact its workflow never reads.

3. **Precondition (advisory)** — if `has_requirement` is false, warn that there's no
   `requirement.md` and offer to run `/do-brainstorm` first. This gate is **advisory**
   (skippable), not the hard hook gate.
4. **Read inputs** — compile the recorded prior context before reading artifacts directly, using
   the same task id rule step 8 uses below (the plan task id once `plan.md` exists, otherwise the
   feature slug):
   ```bash
   "$DOFLOW" context-pack --task-id "<task id>" --json
   ```
   **Exit 1 means the pack came back empty.** This early in the chain that is ordinary rather than a
   problem — a feature reaching design for the first time has nothing recorded against it yet, and
   `do-brainstorm` may not have batched evidence at all. Treat it the same way step 3's precondition
   treats a missing `requirement.md`: note the gap in this stage's report and fall through to
   reading `requirement.md` directly, which this step always did. When the pack is non-empty, read
   it alongside `requirement.md` for the user stories, FRs, and NFRs the design must serve.

5. **Design** — per `--type` (architecture/api/component/database), produce the system-shape
   decisions: a C4 System Context diagram (actors + external systems this feature touches) and,
   when the feature spans more than one deployable unit, a C4 Container diagram; component
   boundaries, API/interface contracts, data model, sequence/data-flow where useful. Output shape
   inside `design.md` is not a choice: the guidance tree's `references/ARTIFACT_FORMAT.md` §4 fixes
   which diagrams and sections the artifact carries. For a trivial, single-file change with no new external interaction, write
   "N/A: [why]" in the System Overview section instead of forcing a diagram.
   **MCP Integration**:
   - **Context7**: the design records a library/framework/API decision (e.g. confirming an API
     surface, config shape, or version-specific behavior) → verify it, per `MCP_Context7.md`'s
     Tool IDs, before it lands in `design.md`.
   - **Sequential-thinking**: architecture, trade-off, or component-boundary reasoning → route it
     per `MCP_Sequential.md`'s Tool IDs.
   Before finalizing system-shape decisions, run the same clarification loop `do-brainstorm` uses
   for any design-level ambiguity encountered while shaping architecture/API/data-model choices
   (e.g. "extend an existing endpoint vs. add a new one", "single container vs. split service").
   Concretely: partition ambiguities surfaced while designing into independent ones (up to 4,
   batched into one `AskUserQuestion` call) and dependent ones (asked individually, in dependency
   order, after their dependency resolves, never batched with what they depend on). Every question
   built for this loop MUST include an explicit "Decide for me" choice among its listed options
   (on top of the tool's automatic "Other" free-text escape), so this defer path is actually
   selectable. A question where the user picks that "Decide for me" option (distinct from the
   general "Other" free-text escape) resolves via a recorded assumption, not by re-prompting —
   see Step 6 below for where that's recorded.
**Stop when** every design-level ambiguity the contract names has an answer or a stated gap, **and** the last round produced no new design-level ambiguity. A round that only restates what you already have is the last round. Report the remaining gaps rather than continuing.
   **Log each round.** One file per round, never appended to a prior round's file:
   `<feature dir>/design/design-<NN>-question.md`, shaped by
   `templates/doflow/question-log-template.md` (same install path resolution step 6 uses for the
   design template) — every question as asked, the options offered, and the answer given, with a
   "Decide for me" pick recorded as the assumption it becomes rather than as an answer. `<NN>` is
   zero-padded to two digits and starts at step 1's `design_next_round` — never hand-counted: the
   resolver already scanned the subdir, and this session's second round is that value plus one, its
   third plus two. `mkdir -p <feature dir>/design` before the first write, and write each round's
   file as soon as its answers land rather than batching them at the end.

6. **Write `design.md` and `specs.md`** — copy the design template into the feature dir and fill it
   from step 5, splitting the narrative from the contracts across two files at the paths step 1
   resolved: `design` (`design/design.md` in the structured layout) and `specs`
   (`design/specs.md`). `mkdir -p` their parent directory first.
   The narrative sections — §1 Architecture Approach, §2 System Overview (C4), §3 Components &
   Boundaries, §6 Sequence / Data Flow, §7 Risks, §8 Assumptions, §9 History — stay in `design.md`.
   The technical scaffolding `references/ARTIFACT_FORMAT.md` §7 names — `design-template.md`'s §4
   API / Interface Contracts and §5 Data Model — moves to `specs.md`, built from
   `templates/doflow/specs-template.md`, where each contract becomes one `IC-###` entry under that
   template's index-then-detail §1 so `plan.md` and implementation can cite a contract by id
   instead of a paragraph. Leave `design.md`'s §4/§5 headings as a one-line pointer to `./specs.md`
   rather than restating their content in both files.
   When `specs` is `null` (an old-layout feature dir, which never had a `specs.md`), do not create
   one: fill §4/§5 in `design.md` exactly as before and leave that dir's layout alone — this feature
   migrates nothing.
The template is `templates/doflow/design-template.md` in the install step 1 resolved: take `constitution_base` from that JSON and swap its trailing `guidance/references/CONSTITUTION_BASE.md` for that path.
   Fill `[REQUIREMENT_PATH]` with step 1's own resolved `requirement` field, verbatim
   (repo-root-relative, exactly as the resolver returns it) — never hand-compute it, which is only
   correct under the legacy layout; under `layout: structured` the two artifacts sit in sibling
   subdirectories (`design/design.md` vs `intention/requirement.md`), so a hand-computed path would
   be wrong there. Reading it off the resolver, the same way `constitution_base` already is, is
   what keeps the pointer correct under either layout.
   `design-template.md`'s §8 "Assumptions" section must read "None" unless a design-level
   clarification question was resolved via the defer escape hatch in Step 5, in which case record it
   there with a one-line rationale.
Structure the artifact per the guidance tree's `references/ARTIFACT_FORMAT.md` — read it before filling the template; it names which of this artifact's sections take an index-then-detail table.
   Its §4 also governs the C4 diagrams — keep C4 as the conceptual zoom model but render every level
   with Mermaid `flowchart` plus `subgraph` boundaries; the experimental `C4Context` / `C4Container`
   types must not be used.
7. **Validate** — run the advisory consistency check and surface any findings verbatim:
   ```bash
   "$DOFLOW" validate "<design path>"
   ```
   Run it a second time against the specs path when step 6 wrote one — `specs.md`'s §1 Interface
   Contracts is an indexed section, so it is checked the same way. Surface findings verbatim; a
   non-zero exit is advisory and does not halt the chain.
8. **Batch this stage's evidence** — one pass here at the stage boundary, never one call per fact.
   `<task id>` is the unit these stores key on: the plan task id once `plan.md` exists, otherwise
   the feature slug. Use the same id for every `evidence`, `claim` and `readiness` call in the run —
   a different id reads a different task's record.
   ```bash
   "$DOFLOW" evidence --task-id "<task id>" --action add --batch <batch>.json --json
   "$DOFLOW" claim --task-id "<task id>" --action add --statement "<one conclusion>"
   ```
Item schema, provenance rules, and the refused-field list: the guidance tree's `references/EVIDENCE_LEDGER.md`. Read it before writing the batch.
   This stage's items are the block you just wrote into `design.md`: what the system shape rests on,
   where each part came from, and its locator. Add every system-shape conclusion as a claim in the
   same pass.
9. **Record the handoff** — drive the workflow state machine, then regenerate the trail it projects
   into `audit.md`. `<slug>` is step 1's `feature_slug`; `<class>` is the class step 2's `classify`
   call accepted; `<stage id>` is the id of the entry in that call's `workflow.stages[]` whose
   `skill` is `do-design` (`design` in the `feature` workflow) — read it off that response, never
   hardcode a guess. One call positions the run — it starts one when none exists yet (an old-layout
   feature, or a chain that started here), and it backfills any earlier non-mutating stage the chain
   skipped, so this stage never has to decide between `start` and `complete-stage` for itself:
   ```bash
   "$DOFLOW" orchestrate --action catch-up --task-id "<slug>" --task-class "<class>" --stage "<stage id>" --note "entering design" --json
   ```
   Branch on the response's `caughtUpTo` / `reason`, not on the exit code:
- **`caughtUpTo` is this stage id** (`reason: reached-candidate`) — the run is positioned exactly here, which is the normal case. Complete the stage:
  ```bash
  "$DOFLOW" orchestrate --action complete-stage --task-id "<slug>" --stage "<caughtUpTo>" --note "<design and specs paths written>" --json
  ```
- **`reason` starts with `already-completed:`** — this stage was already recorded on an earlier run of this skill (a re-invocation to amend `design.md`, say). Use `annotate` instead of `complete-stage`:
  ```bash
  "$DOFLOW" orchestrate --action annotate --task-id "<slug>" --node "<stage id>" --note "<what changed on this re-run>" --json
  ```
- **`reason` starts with `awaiting-gate:`** — the run is paused on a gate a human (or that gate's own owning skill) decides. Two shapes reach here: `gate-a` (after planning, later than this stage) should never be open this early and its appearance signals something went wrong upstream; `gate-0` (after discovery, `clarification`-kind) reaching here is the ordinary recovery path when `[NEEDS CLARIFICATION]` markers survived an aborted `/do-brainstorm` session — `do-brainstorm/SKILL.md` deliberately leaves it open rather than forcing an approval. Either way, this stage does not own it: report the gate id plainly and stop rather than resolving a gate that is not this stage's.
- **`reason` is `blocked-on-mutating-stage:<id>`** — a source-mutating stage ahead of this one has not been executed by its own skill. Name `<id>`, report the block plainly, and stop.
- **`reason` is `run-completed` or `run-rejected`** — the run is finished and takes no further stage. Report it and stop.

   No gate is anchored to this stage, and the `complete-stage` response says so directly: its
   `awaitingGate` comes back `null` in the `feature` workflow, because the next gate (`gate-a`) sits
   after planning and is `/do-plan`'s neighbour, not this stage's. Read that field rather than
   re-deriving it from `workflow.gates[]`, and decide no gate when it is null. Finish by rendering
   the trail. The `--slug` value attaches with an `=`; a space-separated one is rejected with an
   error rather than silently rendering the wrong feature's trail:
   ```bash
   "$DOFLOW" render-audit --slug="<slug>" --json
   ```
   Every call in this step is advisory to the trail, not to the artifact. If one fails for a reason
   outside this flow's control (an unwritable local state directory, say), report the failure plainly and
   continue — a missing `audit.md` entry degrades the record, it does not make `design.md` wrong.
   None of these calls is a gate on finishing this skill.
10. **Stop** — report the design path, and the specs path when one was written.

## Boundaries
**Will:** propose a task class and have the runtime validate it, read `requirement.md`, produce
system-shape design decisions, log each clarification round to `design/`, write `design.md` and
`specs.md`, batch the stage's evidence and claims at the boundary, record the stage handoff
through `orchestrate`/`render-audit`, and always consult context7 and sequential-thinking at the
points named in Step 5.
**Will Not:** write `plan.md` (implementation approach/task decomposition — that's `/do-plan`),
write code, execute anything, design under a class the runtime rejected or replaced with `feature`,
call `readiness` for a stage that declares no template; or express evidence, an estimate or readiness as a number, a percentage or a confidence.

## CRITICAL BOUNDARIES
**STOP AFTER DESIGN CREATION.** Output: `agent-docs/doflow/<slug>/design/design.md` (narrative) and
`design/specs.md` (contracts), alongside that stage's `design/design-<NN>-question.md` dialogue logs.

**Next Step:** `/do-plan` to turn the design into an implementation plan (HOW to build it).
