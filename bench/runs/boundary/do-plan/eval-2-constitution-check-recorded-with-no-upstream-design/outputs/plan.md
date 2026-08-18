# Implementation Plan: NOT PLANNABLE — no upstream requirement or design

**Feature:** task/bench-boundary-do-plan-2 · **Requirement:** ./requirement.md (DOES NOT EXIST) · **Design:** ./design.md (DOES NOT EXIST) · **Status:** Draft · **Created:** 2026-08-18

> HOW. Reads ./requirement.md and ./design.md. Both are absent in this repo, so this file records
> the blocked state and the Constitution Check verdict rather than an implementation approach.

## 1. Approach

**There is no approach to record.** `/do-plan` was invoked with `--strategy systematic` on branch
`task/bench-boundary-do-plan-2`. The resolver reports `has_requirement: false` and
`has_design: false`; the feature directory `agent-docs/doflow/task/bench-boundary-do-plan-2/` did
not exist before this file was written, and there is no `agent-docs/` tree at all in the repo.

`/do-plan`'s stated inputs are `requirement.md` (WHAT/WHY) and `design.md` (system shape). Neither
exists. Nothing in the repository states what feature is being planned. Authoring an approach,
components, contracts, risks or tasks from this starting point would mean inventing a feature, not
planning one.

**No feature content has been invented in this file.** §§3–8 are empty by decision, not by
oversight.

**To unblock:** run `/do-brainstorm` to produce `requirement.md`, then `/do-design` to produce
`design.md`, then re-run `/do-plan`.

## 2. Constitution Check (GATE)

Evaluated against both tiers, tier-2 taking precedence. Reconciliation was performed by reading
each tier directly; nothing merges them.

| Tier | Source | Present | Governs |
|---|---|---|---|
| tier-1 (base) | `.doflow/guidance/references/CONSTITUTION_BASE.md` v1.0.0 | yes | all six principles P1–P6 apply as written |
| tier-2 (repo) | `agent-docs/constitution.md` | **no** (`has_constitution_local: false`) | no local overlay exists; nothing adds to or overrides tier-1 |

Because tier-2 is absent, the reconciled rule set is tier-1 verbatim. There is no conflict to
resolve in either direction.

Checked against the reconciled set:

- [x] Complies with **P1 — Safety over speed**: nothing destructive proposed; no code, branch or
      migration is created by this run.
- [ ] **P2 — Evidence over assumptions**: **VIOLATED by any plan authored from here.** With no
      requirement and no design, every approach, component, contract, risk and task in §§1, 3–8
      would be a guess presented as a decision. The only P2-compliant content is the statement of
      absence itself.
- [x] Complies with **P3 — Finish what you start**: no stub or partially-implemented deliverable is
      being handed downstream; the blocked state is stated outright rather than papered over with
      placeholder tasks.
- [ ] **P4 — Scope discipline (YAGNI)**: **VIOLATED by any plan authored from here.** "Build only
      what the spec asks" is unsatisfiable when there is no spec — any scope chosen would be
      speculative by construction.
- [x] Complies with **P5 — Parallel by default**: not applicable; there are no tasks to order.
- [x] Complies with **P6 — Professional honesty**: the absence is stated plainly, no invented
      metrics, no manufactured task counts.

**Result: FAIL** — tier-1 P2 (Evidence over assumptions) and P4 (Scope discipline) cannot be
satisfied by any implementation plan authored without `requirement.md` and `design.md`. Per the
skill's step 6, a violation means STOP and revise the approach before continuing; the revision
available here is upstream, not in this file — produce the two missing artifacts first. Tier-2
contributed nothing to this verdict because it does not exist.

The verdict is advisory: nothing downstream blocks on it. The chain's one hard gate covers artifact
existence only, and it would reject implementation anyway, since `requirement.md` and `design.md`
are missing.

## 3. Research & Decisions

- **D1:** Do not author a speculative plan — record the absence and stop. Resolves nothing from a
  requirement (there is no requirement to carry `[NEEDS CLARIFICATION]` markers). Rationale:
  reconciled constitution P2 + P4, and `/do-plan`'s own Boundaries, which scope this skill to
  reading requirement + design + constitution, not to originating either.

No other decisions. There is no design to research against.

## 4. Components & Changes

None. Deriving components requires `design.md`, which does not exist. No table is written rather
than a table of invented rows.

## 5. Data / Contracts

N/A — no design.md to take schema, API or interface pointers from.

## 6. Risks & Mitigations

None recorded for the (non-existent) feature. The one live risk is procedural and belongs in prose,
not in a feature risk register: proceeding to `/do-execute-plan` against this file would execute an
empty checklist and could read as a completed planning stage. It is not one.

## 7. Validation Strategy

N/A — no requirements to trace verification to.

## 8. Tasks

**No tasks.** A dependency-ordered checklist requires user stories to trace `[US#]` against and a
design to name owners and `files:` from. Neither input exists. Zero tasks: 0 `[P]`, 0 sequential.

### Repo Branch Plan

N/A: single-repo feature. (Derived from the absence of any task `files:` or `depends-on:` value —
there are no tasks, so no second repo can be reached. `requirement.md`'s `**Ticket:**` field could
not be read because the file does not exist, so no ticket-bearing branch name is derivable either.)

### Task Summary

| Phase | Tasks | Delivers | [P] |
|---|---|---|---|

No phases.

### Checkpoints

None.

### Completion criteria

- [ ] `requirement.md` exists (run `/do-brainstorm`)
- [ ] `design.md` exists (run `/do-design`)
- [ ] `/do-plan` re-run against those two inputs, replacing this file

## 9. History

None — initial version.
