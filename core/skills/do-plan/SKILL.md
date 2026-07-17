---
name: do-plan
description: "Generate the implementation plan (HOW) and dependency-ordered task checklist from requirement.md + design.md, with a Constitution Check gate."
argument-hint: "[--strategy systematic|agile] [--depth normal|deep] [--parallel]"
disable-model-invocation: true
effort: high
---

# do-plan

Phase 3 of the doflow chain. Turns `requirement.md` (WHAT/WHY) + `design.md` (system shape) into
`plan.md` (HOW to implement, plus the dependency-ordered task checklist).

## Invocation
```text
/do-plan [--strategy systematic|agile] [--depth normal|deep] [--parallel]
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
2. **Precondition (advisory)** — if `has_requirement` or `has_design` is false, warn and offer to
   run `/do-brainstorm` / `/do-design` first. This gate is **advisory** (skippable), not the hard
   hook gate.
3. **Read inputs** — `requirement.md`, `design.md`, and the resolved constitution
   (`constitution_base` overlaid by `constitution_local`; local wins).
4. **Write `plan.md`, sections 1–7** — copy `templates/doflow/plan-template.md` into the feature
   dir, fill it: approach, research/decisions that resolve every `[NEEDS CLARIFICATION]` from the
   requirement, components, data/contracts, risks, validation strategy.
5. **Constitution Check (gate)** — evaluate the plan against the resolved constitution. On a
   violation, STOP and revise the approach before continuing. Record PASS/FAIL in the plan.
6. **Decompose into Tasks (section 8)** — dependency-ordered, `[P]`-marked where parallel-safe,
   `[US#]`-traced to the requirement's user stories, owner+files named per task, with checkpoints
   and completion criteria. Set `depends-on:` on a task when it references a service (via its
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
8. **Stop** — report the plan path, Constitution Check result, the task count (`[P]`/sequential),
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
