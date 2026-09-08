---
name: do-plan
description: "Generate the implementation plan (HOW) and dependency-ordered task checklist from requirement.md + design.md (plus design/specs.md's IC-### interface contracts when the feature has one), with a Constitution Check gate, as Phase 3 of the doflow chain. Use whenever requirement.md and design.md exist and the next step is creating an actionable, owner-and-file-scoped task breakdown before implementation, or when the user says 'create an implementation plan', 'break this down into tasks', 'plan the work', or 'plan Phase 3'. Always activate this skill before executing feature implementation."
argument-hint: "[--depth shallow|normal|deep]"
effort: high
---

# do-plan

Phase 3 of the doflow chain. Turns `requirement.md` (WHAT/WHY) + `design.md` (system shape) — and
`design/specs.md`'s `IC-###` interface contracts when `/do-design` wrote one — into `plan.md` (HOW to
implement, plus the dependency-ordered task checklist).

## Invocation
```text
/do-plan [--depth shallow|normal|deep]
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
   being planned. `/do-flow` passes one when it invoked this skill; a user who named one settles it;
   otherwise derive it from `requirement.md` and `design.md`, not from their mere existence.
   ```bash
   "$DOFLOW" classify --task-class "<proposed>" --calling-skill do-plan --json
   ```
Branch on the returned `outcome` field, not the exit code.
- **`ACCEPTED`** — the returned `workflow` is this run's plan of record; read `stages`, `gates` and `handoff` off it rather than from memory.
- **`REJECTED`** — **stop.** Print `message` verbatim (it already names `validClasses` and any `suggestions`), ask the user to choose from `validClasses`, then re-validate. Never substitute `feature`.
  A rejection may be about **you** rather than the class (`reason: caller-not-a-stage`). Then the fix is to propose one of the classes in `fit.hostingClasses`, or to hand the work to the skill this class names for the stage you meant — not to re-propose the same class.
- **Exit 2** — surface the message verbatim and stop.

This skill is the accepted workflow's `planning` stage: state the class and the signal it rests on
in one line. Its `stageIds` are also what §8's phases must decompose toward, and its implementation
stage's `readinessTemplate` names the contract `/do-execute-plan` will be graded against — read them
off the returned object rather than assuming the six-stage feature chain. If the accepted `stageIds`
contain no `planning` stage, say so and hand off to the first stage they do name. Only `feature`
plans; `bug`, `refactor`, `dependency-change` and `trivial-edit` go straight from their analysis
stages to implementation, and writing them a `plan.md` adds a gate their workflow deliberately does
not have.

3. **Precondition (advisory)** — if `has_requirement` or `has_design` is false, warn and offer to
   run `/do-brainstorm` / `/do-design` first. This gate is **advisory** (skippable), not the hard
   hook gate.
4. **Read inputs** — compile the recorded prior context first, using the same task id rule step 10
   uses below (the plan task id for anything already scoped to a single `- [ ]` task, otherwise the
   feature slug):
   ```bash
   "$DOFLOW" context-pack --task-id "<task id>" --json
   ```
   **Exit 1 means the pack came back empty.** By this point `do-design` should already have batched
   its own stage-boundary evidence and claims (its step 8), so an empty pack here carries more
   weight than it does at design time: either that batch never ran, or this task id doesn't match
   the one design used. Treat it as advisory rather than blocking — plan's hard gate is artifact
   existence only — but say so plainly in this stage's report, and in `plan.md`'s own §3 "Research &
   Decisions": a decision written straight from `requirement.md`/`design.md` prose, with no compiled
   pack behind it, must not be recorded as if it traced to prior evidence it doesn't have. When the
   pack is non-empty, read it alongside `requirement.md`, `design.md`, and the constitution.
   **Also read `specs.md` when step 1's `has_specs` is true** — use that flag, never a filesystem
   check of your own, and read the `specs` path the resolver returned. `/do-design` moves the
   interface and data-model contracts out of `design.md` into `specs.md` §1 as numbered `IC-###`
   entries, so on a feature that has one, `design.md`'s §4/§5 are a pointer and the contracts this
   plan must decompose toward live only in `specs.md`. Planning from `design.md` alone on such a
   feature plans against a pointer. When `has_specs` is false (an old-layout feature dir, which never
   had a `specs.md`), the contracts are still in `design.md` §4/§5 and there is nothing extra to
   read. Read
   `constitution_base`,
   then read `constitution_local` **only when `has_constitution_local` is true** — use that flag,
   never a filesystem check of your own (path math belongs to the resolver). You then reconcile the
   two tiers yourself, tier-2 taking precedence: nothing hands you a merged set. See
   the guidance tree's `references/DOFLOW_CHAIN.md` → "Two-tier constitution" for what is computed
   and what is convention.
5. **Write `plan.md`, sections 1–7** — copy the plan template to the `plan` path step 1 resolved
   (`<feature_dir>/plan.md`, the same flat location under both the structured and legacy layouts),
   `mkdir -p`-ing its parent directory first.
The template is `templates/doflow/plan-template.md` in the install step 1 resolved: take `constitution_base` from that JSON and swap its trailing `guidance/references/CONSTITUTION_BASE.md` for that path.
   Fill `[REQUIREMENT_PATH]`/`[DESIGN_PATH]` with that same step 1 resolution's `requirement`/`design`
   fields, verbatim (repo-root-relative, exactly as the resolver returns them) — never hand-written
   `./` links, which assume the artifact sits next to `plan.md`; under `layout: structured` it
   instead sits in a sibling subdirectory, and only the resolver's own field says which.
   Fill it: approach, research/decisions that resolve every `[NEEDS CLARIFICATION]` from the
   requirement, components, data/contracts, risks, validation strategy.
   §5 "Data / Contracts" cites contracts by id, not by pointer: when step 4 read a `specs.md`, name
   the `IC-###` ids that this plan's tasks implement or consume, one per contract, so a task can be
   traced to the contract it satisfies. Pointing §5 at `design.md` is only correct when `has_specs`
   is false and the contracts genuinely still live there.
   When the feature has a `data-model.md` (check the resolver's `has_data_model` flag, the same way
   `has_specs` is already checked), also name any entities/tables from its schema catalog that this
   plan's tasks touch, citing them by the name the schema catalog already gives them — never
   inventing a new id scheme, since `data-model.md` carries no `ID`-bearing index the way `specs.md`
   does.
**Stop when** every `[NEEDS CLARIFICATION]` marker / open decision the contract names has an answer or a stated gap, **and** the last round produced no new `[NEEDS CLARIFICATION]` marker / open decision. A round that only restates what you already have is the last round. Report the remaining gaps rather than continuing.
Structure the artifact per the guidance tree's `references/ARTIFACT_FORMAT.md` — read it before filling the template; it names which of this artifact's sections take an index-then-detail table.
   Its §5 governs §8's `### Task Summary` rollup — the per-task `- [ ]` checklist stays the single
   source of truth and is never mirrored into a per-task index.
   Read `references/ARTIFACT_VOICE.md` at the same point: it carries the prose rules the artifact's sentences follow, and the carve-outs where one of those rules meets a construct the checker parses.
   This stage fills the plan from requirement + design + constitution rather than by eliciting, so
   it writes no dialogue log — its sibling stages' `intention/`/`design/` question files have no
   counterpart here. Should a future revision of this skill add an `AskUserQuestion` clarification
   loop, each of its rounds logs to `plan-<NN>-question.md` at the feature root exactly as
   `/do-brainstorm` and `/do-design` log theirs to their own subdirectories, numbered from step 1's
   `plan_next_round`.
6. **Constitution Check (advisory gate)** — evaluate the plan against both tiers as reconciled in
   step 4. On a violation, STOP and revise the approach before continuing, then record PASS/FAIL in
   the plan. The verdict is **advisory**: it is recorded in `plan.md` §2 "Constitution Check" and nothing downstream
   blocks on it — the chain's one hard gate covers artifact existence only. Stopping on a violation
   is a discipline this skill observes, not something a hook enforces.
7. **Decompose into Tasks (section 8)** — dependency-ordered, `[US#]`-traced to the requirement's
   user stories, owner+files named per task, with checkpoints and completion criteria.
   `--depth shallow|normal|deep` is the single granularity knob: it sets how finely a phase is
   split into tasks and how much detail each task carries. Default `normal`.
   **Why explicit task scoping and `[P]` markers**: Specifying concrete file paths (`files: [...]`)
   and named specialist owners (`system-architect`, `core-implementer`, `quality-guardian`) per task
   enables `/do-execute-plan` to compute write-set isolation (`parallel-check`). Tasks with disjoint
   file sets run concurrently without merge conflicts, while overlapping tasks are safely serialized.
   **Mark `[P]` by default:** parallel execution is the framework default, so apply `[P]` to every
   task whose `files:` set is disjoint from its phase siblings' and leave it off only where a real
   dependency forces the order — an unmarked task is the exception that owes a reason, not the norm.
   Siblings that write any path in common are not parallel-safe however independent they otherwise
   look, so compare the actual `files:` sets rather than judging by description. Do not change the
   marker's syntax or meaning: unmarked still means sequential, which is what keeps plans written
   before this rule behaving as they always did.
   Set `depends-on:` on a task when it references a service (via its
   `files:` or description) that has no owning task in this plan and is external to what the plan
   builds. When such a dependency has no local repo at all (a vendor API, a SaaS integration) but
   *does* have a documented contract, also set `external-contract:` pointing to a doc built from
   `templates/doflow/external-contract-template.md` — `/do-execute-plan --scaffold` generates a real
   frame from it instead of silently skipping the dependency (its default when `external-contract:` is
   absent). The `- [ ]` checkboxes are the execution contract `/do-execute-plan`
   parses — keep the marker syntax intact, don't reflow it into prose.
8. **Derive branch plan** — read `requirement.md`'s `**Ticket:**` field (absent/`none` → no
   ticket). Branch name: `feat/<TICKET>-<slug-description>` (ticket present, slug's leading
   `NNN-` stripped) or `feat/<slug>` (no ticket). Resolve a repo for each task's `files:` path
   *and* each task's `depends-on:` value the same way — walk up to the nearest `.git`; if a
   `depends-on:` value doesn't resolve to a `.git` (not a real local path), skip that row rather
   than guessing. `external-contract:` never participates in this derivation — it names a doc in this
   same repo, not an external service repo. Write one row per repo to `plan.md`'s Repo Branch Plan
   table: `primary` if it owns a task via `files:`, `dependency-only` if it's only ever reached via
   `depends-on:`. A single-repo result → `N/A: single-repo feature`. Derivation only — no branch is
   created here (`/do-execute-plan`'s job, lazily, per repo).
9. **Validate** — run the advisory consistency check and surface any findings verbatim:
   ```bash
   "$DOFLOW" validate "<plan path>"
   ```
   This also verifies each `### Task Summary` rollup row against the `- [ ]` lines under its
   `### Phase <X>` heading. Surface findings verbatim; a non-zero exit is advisory and does not halt
   the chain.
10. **Batch this stage's evidence** — one pass here at the stage boundary, never one call per fact.
    `<task id>` is the unit these stores key on: the plan task id for anything scoped to a single
    `- [ ]` task, otherwise the feature slug. Use the same id for every `evidence`, `claim` and
    `readiness` call that concerns it — a different id reads a different task's record.
    ```bash
    "$DOFLOW" evidence --task-id "<task id>" --action add --batch <batch>.json --json
    "$DOFLOW" claim --task-id "<task id>" --action add --statement "<one conclusion>"
    ```
Item schema, provenance rules, and the refused-field list: the guidance tree's `references/EVIDENCE_LEDGER.md`. Read it before writing the batch.
    This stage's items are §3 "Research & Decisions" of the `plan.md` you just wrote: per decision,
    what was found, where it came from, and its locator. Add each `D#` decision as a claim in the
    same pass.
11. **Record the handoff** — read the guidance tree's `references/WORKFLOW_HANDOFF.md`.
   Use the feature slug as `<task id>`; if no feature is active, this is standalone and there is
   no workflow handoff. After completing this skill's work:
   ```bash
   "$DOFLOW" orchestrate --action handoff --task-id "<task id>" --calling-skill do-plan --task-class "<validated class>" --note "<work completed and verification result>" --json
   ```
   The runtime selects this skill's stage, records completion or a rerun annotation, and returns
   `disposition`. Report `deferred` with its `reason`; resolve no gate in this skill.
   `standalone` means no run was created. Render the trail after a recorded handoff:
   ```bash
   "$DOFLOW" render-audit --slug="<task id>" --json
   ```
   Leave any returned approval gate for `/do-flow` or `/do-execute-plan` to present.

12. **Stop** — report the plan path, Constitution Check result, the task count (`[P]`/sequential),
   and the derived branch name/repo count when the Repo Branch Plan is populated.

## Boundaries
**Will:** propose a task class and have the runtime validate it, read requirement + design + specs
(when `has_specs`) + constitution, cite `specs.md`'s `IC-###` contracts in §5, write `plan.md`
including its embedded task checklist and Repo Branch Plan, run the
Constitution Check, resolve clarifications, batch the stage's evidence and claims at the boundary,
and record the stage handoff through `orchestrate`/`render-audit`.
**Will Not:** write `design.md` or `specs.md` (that's `/do-design`) — it cites their contracts, it
does not author or amend them — write code, execute the plan, decide the
approval gate its own handoff opens, create any
git branch (derivation only), plan under a class the runtime rejected or replaced with `feature`,
call `readiness` for a stage that declares no template; or express evidence, an estimate or readiness as a number, a percentage or a confidence.

## CRITICAL BOUNDARIES
**STOP AFTER PLAN CREATION.** Output: `agent-docs/doflow/<slug>/plan.md` (HOW + tasks).

**Next Step:** `/do-execute-plan` to execute the tasks. The implement phase is gated: it requires
`requirement.md`, `design.md`, and `plan.md` to all exist.
