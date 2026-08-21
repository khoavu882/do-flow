# Implementation Plan: Recover the missing upstream artifacts for `bench-d3-do-plan-1`

**Feature:** bench-d3-do-plan-1 · **Requirement:** ./requirement.md (DOES NOT EXIST) · **Design:** ./design.md (DOES NOT EXIST) · **Status:** Draft · **Created:** 2026-08-18

> HOW. Reads ./requirement.md and ./design.md. Resolve every `[NEEDS CLARIFICATION]` from the
> requirement here.
>
> **Both inputs are missing.** `doflow paths --json` reports `has_requirement: false` and
> `has_design: false` for feature dir `agent-docs/doflow/bench-d3-do-plan-1`. There is no design in
> this repo to turn into an implementation plan, and this plan does not invent one. What follows is
> scoped to recovering the gap, not to any feature.

## 0. Input State (why this plan is not a feature plan)

The request was "turn the design into an implementation plan I can hand to someone." The resolver's
answer for this branch (`task/bench-d3-do-plan-1`):

| Input | Resolver field | Present? | Path |
|---|---|---|---|
| requirement.md | `has_requirement` | **no** | `agent-docs/doflow/bench-d3-do-plan-1/requirement.md` |
| design.md | `has_design` | **no** | `agent-docs/doflow/bench-d3-do-plan-1/design.md` |
| constitution (tier-1) | `constitution_base` | yes | `.doflow/guidance/references/CONSTITUTION_BASE.md` |
| constitution (tier-2) | `has_constitution_local` | **no** | `agent-docs/constitution.md` |

`/do-plan` step 3's precondition is advisory, so this run continues rather than halting — but it
continues with the only honest content available. A design cannot be summarised into tasks when no
design exists; fabricating a feature here would violate P2 (evidence over assumptions) and P4
(scope discipline). The recovery path is Phase A below: run `/do-brainstorm`, then `/do-design`,
then re-run `/do-plan`, which will then have real inputs to decompose.

## 1. Approach

Recover the two missing upstream artifacts in chain order rather than skipping them. `/do-brainstorm`
produces `requirement.md` (WHAT/WHY) with the user in the loop; `/do-design` turns that into
`design.md` (system shape); `/do-plan` is then re-run and replaces this document with a real
feature plan whose §4/§6/§8 describe actual work. No source file is touched by this plan — every
task below writes only under `agent-docs/doflow/bench-d3-do-plan-1/`.

Task class: **feature**, validated by `doflow classify --task-class feature --json` →
`outcome: ACCEPTED`, workflow "Feature Delivery" (discovery → design → planning → implementation →
verification → review). This skill is that workflow's `planning` stage. The signal the class rests
on: the request asks for an implementation plan handed to an implementer, which is the planning
stage of a delivery chain — and `feature` is the only class in `workflows.yaml` that has a
`planning` stage at all. Recorded assumption: with no `requirement.md`/`design.md` to derive from
and no user available to ask, the class was chosen from the request's own shape.

## 2. Constitution Check (GATE)

> Verified against both tiers. **Tier-1** = `CONSTITUTION_BASE.md` v1.0.0 (P1–P6). **Tier-2** =
> `agent-docs/constitution.md` — `has_constitution_local: false`, so no repo overlay exists and
> tier-1 stands unmodified; there is nothing for tier-2 to take precedence over. Both tiers were
> evaluated; the tier-2 evaluation is "absent, no overrides in force", not "skipped".

- [x] Complies with **P1 (Safety over speed)**: no destructive or irreversible action; the plan
      writes documentation only and creates no branch.
- [x] Complies with **P2 (Evidence over assumptions)**: the missing-input claim is backed by the
      `doflow paths --json` output quoted in §0, not by a guess. No feature content is asserted
      that no artifact supports.
- [x] Complies with **P3 (Finish what you start)**: no task below is a stub; each has a concrete
      output file and a completion criterion.
- [x] No violation of **P4 (Scope discipline / YAGNI)**: the plan covers only gap recovery. It
      deliberately does not invent requirements, components, data contracts, or feature tasks.
- [x] Complies with **P5 (Parallel by default)**: A.1 and A.2 are strictly sequential because
      `/do-design` reads the `requirement.md` that A.1 writes, and both write the same feature dir;
      the `[P]` marker is withheld for that reason and no other.
- [x] Complies with **P6 (Professional honesty)**: the absence of both inputs is stated in the
      title, the header, §0 and §1 rather than papered over.

**Result:** **PASS** (tier-1 PASS, tier-2 not present — no overlay to violate) — the plan passes
*as a gap-recovery plan*. It would fail P2 and P4 if it claimed to be the implementation plan for a
feature, because no design exists here to implement.

## 3. Research & Decisions

- **D1:** Do not invent a feature — resolves the open question "what design is the user referring
  to?"; rationale: `doflow paths --json` on branch `task/bench-d3-do-plan-1` returns
  `has_requirement: false`, `has_design: false`, and `candidate_slugs: []`, so there is no other
  feature dir in this repo that could hold the intended design either. The absence is total, not a
  slug-resolution miss.
- **D2:** Continue rather than halt — resolves "does a missing input abort this skill?"; rationale:
  `SKILL.md` step 3 marks the precondition **advisory (skippable)**; the chain's one hard gate
  covers artifact existence for *implementation*, not for planning.
- **D3:** Recover through `/do-brainstorm` → `/do-design` rather than writing `design.md` here —
  resolves "can do-plan backfill the missing design?"; rationale: `SKILL.md` **Will Not** states
  "write `design.md` (that's `/do-design`)".
- **D4:** Record the Constitution Check against both tiers with tier-2 explicitly noted as absent —
  resolves "what verdict applies with no repo constitution?"; rationale: `has_constitution_local`
  is the flag the skill's step 4 says to use, and `CONSTITUTION_BASE.md` Governance requires a
  recorded PASS/FAIL regardless.
- **D5 (assumption, no user available):** Task class `feature`. In a normal session step 2 would
  derive this from `requirement.md` + `design.md`; with neither present the choice was made from
  the request's shape and is recorded here as an assumption rather than a derivation.

## 4. Components & Changes

| ID | Change | Files | Phase | Status |
|---|---|---|---|---|
| CH1 | Create the missing `requirement.md` via `/do-brainstorm` | `agent-docs/doflow/bench-d3-do-plan-1/requirement.md` | A | Live |
| CH2 | Create the missing `design.md` via `/do-design` | `agent-docs/doflow/bench-d3-do-plan-1/design.md` | A | Live |
| CH3 | Replace this gap plan with a real feature plan by re-running `/do-plan` | `agent-docs/doflow/bench-d3-do-plan-1/plan.md` | B | Live |

**Detail**

- **CH1** → `/do-brainstorm` interviews the requester and writes `requirement.md`: problem, user
  stories, functional and non-functional requirements, and any `[NEEDS CLARIFICATION]` markers it
  cannot resolve in-session. Nothing downstream can be scoped until this exists, because user
  stories are what §8's `[US#]` traces point at.
- **CH2** → `/do-design` reads that `requirement.md` and writes `design.md`: C1/C2 diagrams,
  components and boundaries, data contracts, risks. This is the artifact the original request
  ("turn the design into…") presumed already existed.
- **CH3** → Re-running `/do-plan` with both inputs present produces a plan whose §4 lists real code
  changes and whose §8 lists real implementation tasks with `files:` under `src/`. This document is
  then superseded in full; it is a placeholder for a plan, not a plan for the feature.

## 5. Data / Contracts

N/A — no schema, API, or interface is defined or changed by this plan. All three tasks write
Markdown under `agent-docs/doflow/bench-d3-do-plan-1/`. The only contract this document itself
must honour is `references/ARTIFACT_FORMAT.md` (index-then-detail in §4 and §6, closed `Status`
vocabulary, §9 History) and the `- [ ]` task-marker syntax `/do-execute-plan` parses.

## 6. Risks & Mitigations

| ID | Risk | Mitigation | Status |
|---|---|---|---|
| RK1 | A reader mistakes this for the feature's implementation plan | Title, header, §0 and §1 all state that both inputs are missing | Live |
| RK2 | `/do-execute-plan` runs this plan and "implements" nothing of value | Every task is a chain-artifact task, none mutates source; the hard pre-implement gate is satisfied by file existence alone and would not catch this | Live |
| RK3 | The user's "the design" lives somewhere this resolver does not look | `candidate_slugs` is empty and no other feature dir exists; if the design is outside this repo it must be pointed at explicitly | Live |

**Detail**

- **RK1** → The failure mode is silent: a downstream reader sees `plan.md` exists, the hard gate
  goes green, and implementation begins against a plan describing only its own recovery. Mitigated
  by disclosure in four places, which is the strongest tool available to a document. Not mitigated
  by any mechanism — nothing checks a plan's *content* against its inputs.
- **RK2** → `/do-execute-plan`'s prerequisite gate is keyed on artifact *existence*
  (`requirement.md`, `design.md`, `plan.md` all present), and this plan's own existence moves that
  gate one third of the way to open while the other two files remain absent. The gate would still
  block, which is the desired outcome — but for a reason unrelated to this plan's content.
- **RK3** → If the requester meant a design held outside this repo (a doc, a ticket, a
  conversation), no resolver output would reveal it. A.0 exists to surface exactly that question
  before the more expensive `/do-brainstorm` interview begins.

## 7. Validation Strategy

| Requirement | Verified by |
|---|---|
| The absence of `requirement.md` and `design.md` is stated, not worked around | Present in the title, the header, §0, §1 and §2's Result line |
| No feature content is invented | §4, §5, §6 and §8 reference only chain artifacts; §5 is N/A rather than a fabricated schema |
| A Constitution Check verdict is recorded against **both** tiers | §2 names tier-1 v1.0.0 P1–P6 individually and records tier-2 as absent via `has_constitution_local: false` |
| Task markers stay machine-parseable | `doflow validate agent-docs/doflow/bench-d3-do-plan-1/plan.md` (step 9), plus the `### Task Summary` counts matching the `- [ ]` lines per phase |
| The recovery actually closes the gap | Re-running `doflow paths --json` after Phase A reports `has_requirement: true` and `has_design: true` |

## 8. Tasks

> Dependency-ordered. `[P]` = parallel-safe with its phase siblings. `[US#]` = traces to a user
> story in requirement.md — **no user stories exist yet**, so tasks below carry `[US-none]` as an
> explicit marker of the missing trace rather than a fabricated `[US1]`.

### Repo Branch Plan

N/A: single-repo feature. Every task's `files:` path resolves to the enclosing
`.git` at `<repo>/.doflow/worktrees/bench-d3-do-plan-1`, and no task
carries a `depends-on:`. Derived branch name (derivation only — no branch is created here): no
`requirement.md` exists, so no `**Ticket:**` field can be read; ticket is treated as absent and the
name is `feat/bench-d3-do-plan-1` (slug has no leading `NNN-` to strip). The branch actually checked
out is `task/bench-d3-do-plan-1`, a bench sandbox branch.

### Task Summary

| Phase | Tasks | Delivers | [P] |
|---|---|---|---|
| A | 3 | The two missing upstream artifacts | no |
| B | 2 | A real feature plan replacing this one | no |

### Phase A — Recover the upstream artifacts

- [ ] A.0 [US-none] Confirm with the requester whether "the design" refers to something outside this repo, and if so point `/do-design` at it — owner: spec-analyst; files: agent-docs/doflow/bench-d3-do-plan-1/requirement.md
- [ ] A.1 [US-none] Run `/do-brainstorm` to elicit the problem, user stories and requirements, resolving every `[NEEDS CLARIFICATION]` it raises [depends A.0] — owner: spec-analyst; files: agent-docs/doflow/bench-d3-do-plan-1/requirement.md
- [ ] A.2 [US-none] Run `/do-design` against that requirement to produce C1/C2 diagrams, components, data contracts and risks [depends A.1] — owner: system-architect; files: agent-docs/doflow/bench-d3-do-plan-1/design.md

### Phase B — Re-plan against real inputs

- [ ] B.1 [US-none] Re-run `doflow paths --json` and confirm `has_requirement` and `has_design` are both true [depends A.2] — owner: core-implementer; files: agent-docs/doflow/bench-d3-do-plan-1/state.md
- [ ] B.2 [US-none] Re-run `/do-plan --depth normal` and replace this document with a feature plan whose §8 tasks name real source files [depends B.1] — owner: system-architect; files: agent-docs/doflow/bench-d3-do-plan-1/plan.md

### Checkpoints

- After Phase A: `doflow paths --json` reports both inputs present; commit `docs(doflow): recover requirement and design for bench-d3-do-plan-1`
- After Phase B: this gap plan no longer exists in its current form; commit `docs(doflow): replace gap plan with feature plan`

### Completion criteria

- [ ] All tasks checked
- [ ] Validation gates pass
- [ ] state.md updated
- [ ] This document has been superseded by a plan derived from a real `design.md`

## 9. History

None — initial version.
