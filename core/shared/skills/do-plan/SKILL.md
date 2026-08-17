---
name: do-plan
description: "Generate the implementation plan (HOW) and dependency-ordered task checklist from requirement.md + design.md, with a Constitution Check gate, as Phase 3 of the doflow chain. Use when requirement.md and design.md already exist and the next need is a concrete, owner-and-file-scoped task breakdown before implementation starts, or the user says 'turn this design into a plan' rather than asking to design the system or write code."
argument-hint: "[--strategy systematic|agile|enterprise] [--depth normal|deep]"
effort: high
---

# do-plan

Phase 3 of the doflow chain. Turns `requirement.md` (WHAT/WHY) + `design.md` (system shape) into
`plan.md` (HOW to implement, plus the dependency-ordered task checklist).

## Invocation
```text
/do-plan [--strategy systematic|agile|enterprise] [--depth normal|deep]
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
2. **Precondition (advisory)** — if `has_requirement` or `has_design` is false, warn and offer to
   run `/do-brainstorm` / `/do-design` first. This gate is **advisory** (skippable), not the hard
   hook gate.
3. **Read inputs** — `requirement.md`, `design.md`, and the constitution. Read `constitution_base`,
   then read `constitution_local` **only when `has_constitution_local` is true** — use that flag,
   never a filesystem check of your own (path math belongs to the resolver). You then reconcile the
   two tiers yourself, tier-2 taking precedence: nothing hands you a merged set. See
   `references/DOFLOW_CHAIN.md` → "Two-tier constitution" for what is computed and what is
   convention.
4. **Write `plan.md`, sections 1–7** — copy `$DOFLOW_CONFIG_DIR/templates/doflow/plan-template.md`
   into the feature
   dir, fill it: approach, research/decisions that resolve every `[NEEDS CLARIFICATION]` from the
   requirement, components, data/contracts, risks, validation strategy.
   Structure the artifact per `references/ARTIFACT_FORMAT.md` — read it before filling the
   template: index-then-detail for §4/§6, the closed `Live` / `Superseded → <ref>` status
   vocabulary, and §9 History. Its §5 governs §8's `### Task Summary` rollup — the per-task
   `- [ ]` checklist stays the single source of truth and is never mirrored into a per-task index.
5. **Constitution Check (advisory gate)** — evaluate the plan against both tiers as reconciled in
   step 3. On a violation, STOP and revise the approach before continuing, then record PASS/FAIL in
   the plan. The verdict is **advisory**: it is recorded in `plan.md` §2 "Constitution Check" and nothing downstream
   blocks on it — the chain's one hard gate covers artifact existence only. Stopping on a violation
   is a discipline this skill observes, not something a hook enforces.
6. **Decompose into Tasks (section 8)** — dependency-ordered, `[US#]`-traced to the requirement's
   user stories, owner+files named per task, with checkpoints and completion criteria.
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
   *does* have a documented contract, also set `contract-doc:` pointing to a doc built from
   `templates/doflow/contract-doc-template.md` — `/do-execute-plan --contracts` generates a real
   frame from it instead of silently skipping the dependency (its default when `contract-doc:` is
   absent). The `- [ ]` checkboxes are the execution contract `/do-execute-plan`
   parses — keep the marker syntax intact, don't reflow it into prose.
7. **Derive branch plan** — read `requirement.md`'s `**Ticket:**` field (absent/`none` → no
   ticket). Branch name: `feat/<TICKET>-<slug-description>` (ticket present, slug's leading
   `NNN-` stripped) or `feat/<slug>` (no ticket). Resolve a repo for each task's `files:` path
   *and* each task's `depends-on:` value the same way — walk up to the nearest `.git`; if a
   `depends-on:` value doesn't resolve to a `.git` (not a real local path), skip that row rather
   than guessing. `contract-doc:` never participates in this derivation — it names a doc in this
   same repo, not an external service repo. Write one row per repo to `plan.md`'s Repo Branch Plan
   table: `primary` if it owns a task via `files:`, `dependency-only` if it's only ever reached via
   `depends-on:`. A single-repo result → `N/A: single-repo feature`. Derivation only — no branch is
   created here (`/do-execute-plan`'s job, lazily, per repo).
8. **Validate** — run the advisory consistency check and surface any findings verbatim:
   ```bash
   bash "$DOFLOW_CONFIG_DIR/scripts/doflow/bash/validate-artifacts.sh" "<plan path>"
   ```
   This also verifies each `### Task Summary` rollup row against the `- [ ]` lines under its
   `### Phase <X>` heading. Findings are reported to the user, never repaired automatically. A
   non-zero exit is advisory and does not halt the chain.
9. **Stop** — report the plan path, Constitution Check result, the task count (`[P]`/sequential),
   and the derived branch name/repo count when the Repo Branch Plan is populated.

## Boundaries
**Will:** read requirement + design + constitution, write `plan.md` including its embedded task
checklist and Repo Branch Plan, run the Constitution Check, resolve clarifications.
**Will Not:** write `design.md` (that's `/do-design`), write code, execute the plan, or create any
git branch (derivation only).

## CRITICAL BOUNDARIES
**STOP AFTER PLAN CREATION.** Output: `agent-docs/doflow/<slug>/plan.md` (HOW + tasks).

**Next Step:** `/do-execute-plan` to execute the tasks. The implement phase is gated: it requires
`requirement.md`, `design.md`, and `plan.md` to all exist.
