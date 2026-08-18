---
name: do-plan
description: "Generate the implementation plan (HOW) and dependency-ordered task checklist from requirement.md + design.md, with a Constitution Check gate, as Phase 3 of the doflow chain. Use when requirement.md and design.md already exist and the next need is a concrete, owner-and-file-scoped task breakdown before implementation starts, or the user says 'turn this design into a plan' rather than asking to design the system or write code."
argument-hint: "[--depth shallow|normal|deep]"
effort: high
---

# do-plan

Phase 3 of the doflow chain. Turns `requirement.md` (WHAT/WHY) + `design.md` (system shape) into
`plan.md` (HOW to implement, plus the dependency-ordered task checklist).

## Invocation
```text
/do-plan [--depth shallow|normal|deep]
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
   being planned. `/do-flow` passes one when it invoked this skill; a user who named one settles it;
   otherwise derive it from `requirement.md` and `design.md`, not from their mere existence.
   ```bash
   "$DOFLOW" classify --task-class "<proposed>" --json
   ```
   Branch on the returned `outcome` field, not on the exit code.
   - **`ACCEPTED`** — the returned `workflow` is this run's plan of record; this skill is its
     `planning` stage. State the class and the signal it rests on in one line. Its `stageIds` are
     also what §8's phases must decompose toward, and its implementation stage's
     `readinessTemplate` names the contract `/do-execute-plan` will be graded against — read them
     off the returned object rather than assuming the six-stage feature chain.
   - **`REJECTED`** — **stop.** Print `message` verbatim; it names `validClasses` and any
     `suggestions`. Ask the user to choose from `validClasses` via `AskUserQuestion`, then
     re-validate. Never substitute `feature` and never plan under a class the runtime refused.
   - **Exit 2** — the runtime could not answer. Surface its message verbatim and stop.
   If the accepted `stageIds` contain no `planning` stage, say so and hand off to the first stage
   they do name. Only `feature` plans; `bug`, `refactor`, `dependency-change` and `trivial-edit` go
   straight from their analysis stages to implementation, and writing them a `plan.md` adds a gate
   their workflow deliberately does not have.
3. **Precondition (advisory)** — if `has_requirement` or `has_design` is false, warn and offer to
   run `/do-brainstorm` / `/do-design` first. This gate is **advisory** (skippable), not the hard
   hook gate.
4. **Read inputs** — `requirement.md`, `design.md`, and the constitution. Read `constitution_base`,
   then read `constitution_local` **only when `has_constitution_local` is true** — use that flag,
   never a filesystem check of your own (path math belongs to the resolver). You then reconcile the
   two tiers yourself, tier-2 taking precedence: nothing hands you a merged set. See
   `references/DOFLOW_CHAIN.md` → "Two-tier constitution" for what is computed and what is
   convention.
5. **Write `plan.md`, sections 1–7** — copy the plan template into the feature dir. The template is
   `templates/doflow/plan-template.md` inside the same install step 1 resolved: take
   `constitution_base` from that JSON and replace its trailing
   `guidance/references/CONSTITUTION_BASE.md` with that path.
   Fill it: approach, research/decisions that resolve every `[NEEDS CLARIFICATION]` from the
   requirement, components, data/contracts, risks, validation strategy.
   Structure the artifact per `references/ARTIFACT_FORMAT.md` — read it before filling the
   template: index-then-detail for §4/§6, the closed `Live` / `Superseded → <ref>` status
   vocabulary, and §9 History. Its §5 governs §8's `### Task Summary` rollup — the per-task
   `- [ ]` checklist stays the single source of truth and is never mirrored into a per-task index.
6. **Constitution Check (advisory gate)** — evaluate the plan against both tiers as reconciled in
   step 4. On a violation, STOP and revise the approach before continuing, then record PASS/FAIL in
   the plan. The verdict is **advisory**: it is recorded in `plan.md` §2 "Constitution Check" and nothing downstream
   blocks on it — the chain's one hard gate covers artifact existence only. Stopping on a violation
   is a discipline this skill observes, not something a hook enforces.
7. **Decompose into Tasks (section 8)** — dependency-ordered, `[US#]`-traced to the requirement's
   user stories, owner+files named per task, with checkpoints and completion criteria.
   `--depth shallow|normal|deep` is the single granularity knob: it sets how finely a phase is
   split into tasks and how much detail each task carries. Default `normal`.
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
   `### Phase <X>` heading. Findings are reported to the user, never repaired automatically. A
   non-zero exit is advisory and does not halt the chain.
10. **Batch this stage's evidence** — one pass here at the stage boundary, never one call per fact.
    `<task id>` is the unit these stores key on: the plan task id for anything scoped to a single
    `- [ ]` task, otherwise the feature slug. Use the same id for every `evidence`, `claim` and
    `readiness` call that concerns it — a different id reads a different task's record.
    ```bash
    "$DOFLOW" evidence --task-id "<task id>" --action add --batch <batch>.json --json
    "$DOFLOW" claim --task-id "<task id>" --action add --statement "<one conclusion>"
    ```
    The batch file is a JSON array, one object per item (scratch input — delete it after the
    write), validated whole: one rejected item writes nothing, so a half-written stage never reads
    as complete. Per item: `kind` (`exact-search`, `semantic-retrieval`, `structural`,
    `historical`, `documentation`, `test-result`, `runtime-observation`, `user-statement`, `diff`,
    `generated-analysis`), `provenance` (`extracted` | `inferred` | `asserted`, with **no default**
    — an unstated one is refused rather than filed as repository fact), and `source` (`provider` +
    `capability`, no `unknown` stand-in). `extracted` needs a `locator`; `inferred` and `asserted`
    need `content`; `generated-analysis` and `user-statement` can never be `extracted`. `id`,
    `freshness`, `supports`/`contradicts`, `stage` and any score field are refused by name.
    The same items are §3 "Research & Decisions" of the `plan.md` you just wrote: per decision, what
    was found, where it came from (a provider + capability, an artifact, or the user), its locator,
    and whether it is **extracted** (read verbatim out of the repository or the user's words) or
    **inferred** (your analysis). Never merge those two provenances into one line — a decision
    recorded as fact is the one a later phase will not re-check.
    Add each `D#` decision as a claim in this same pass. Each is stored as a `hypothesis` and
    becomes supported only through linked evidence; `design.md` having asserted it is not support.
    Relevance is not confidence. A match count, a ranking, a "best hit" is a property of the query,
    not of the fact — record the locator, never a score, a percentage, or a confidence.
    The `planning` stage declares `readinessTemplate: null`. Do **not** call `readiness` here and do
    not report one as skipped: readiness belongs to the implementation stage, which is
    `/do-execute-plan`'s to consult per task.
11. **Stop** — report the plan path, Constitution Check result, the task count (`[P]`/sequential),
   and the derived branch name/repo count when the Repo Branch Plan is populated.

## Boundaries
**Will:** propose a task class and have the runtime validate it, read requirement + design +
constitution, write `plan.md` including its embedded task checklist and Repo Branch Plan, run the
Constitution Check, resolve clarifications, and batch the stage's evidence and claims at the
boundary.
**Will Not:** write `design.md` (that's `/do-design`), write code, execute the plan, create any
git branch (derivation only), plan under a class the runtime rejected or replaced with `feature`,
call `readiness` for a stage that declares no template, or express evidence or readiness as a
number, a percentage or a confidence.

## CRITICAL BOUNDARIES
**STOP AFTER PLAN CREATION.** Output: `agent-docs/doflow/<slug>/plan.md` (HOW + tasks).

**Next Step:** `/do-execute-plan` to execute the tasks. The implement phase is gated: it requires
`requirement.md`, `design.md`, and `plan.md` to all exist.
