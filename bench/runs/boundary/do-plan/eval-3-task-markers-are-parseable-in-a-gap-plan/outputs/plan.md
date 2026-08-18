# Implementation Plan: Recover missing chain artifacts for task/bench-boundary-do-plan-3

**Feature:** task/bench-boundary-do-plan-3 · **Requirement:** ./requirement.md · **Design:** ./design.md · **Status:** Draft · **Created:** 2026-08-18

> HOW. Reads ./requirement.md and ./design.md. Resolve every `[NEEDS CLARIFICATION]` from the
> requirement here.
>
> Structure follows `references/ARTIFACT_FORMAT.md`: indexed sections carry a table above full
> `**Detail**`, `Status` is only `Live` or `Superseded → <ref>`, and superseded prose moves to §9.

## 1. Approach

`/do-plan` was invoked directly on this branch with neither `requirement.md` nor `design.md`
present (`has_requirement: false`, `has_design: false` from the resolver) and no user-supplied
description of a feature to plan. Per this skill's own step 3, that precondition is advisory, not
a hard block, so this plan does not invent a product feature to justify writing one. Instead it
scopes itself to the actual work implied by the invocation: closing the artifact gap so the chain
can proceed honestly — author `requirement.md` via `/do-brainstorm`, then `design.md` via
`/do-design`, then re-enter `/do-plan` for real once there is something concrete to plan.

## 2. Constitution Check (GATE)

> Verify against both constitution tiers, tier-2 taking precedence — you reconcile them yourself;
> nothing merges them for you. Any violation = STOP and revise the approach before continuing.
> (Advisory by default; not the hard hook gate.)

- [x] Complies with P2 (Evidence over assumptions): no claim about a feature's requirements is
      made without a requirement.md to back it — the gap itself is treated as the evidence.
- [x] Complies with P4 (Scope discipline / YAGNI): tasks are limited to recovering the two missing
      artifacts, not to speculatively building out an assumed feature.
- [ ] No local tier-2 constitution present (`has_constitution_local: false`) — only the base tier
      applies; nothing to reconcile.

**Result:** PASS — the plan stays inside what the base constitution (P2, P4) and this skill's own
advisory precondition (step 3) allow when upstream artifacts are missing.

## 3. Research & Decisions

- **D1:** Do not classify this as an invented feature's plan; scope §8 to gap recovery only —
  resolves the absence of any `[NEEDS CLARIFICATION]` markers to inherit (there is no
  requirement.md yet) by not fabricating requirements text here. Rationale: the resolver
  (`doflow paths --json`) reports `has_requirement: false`, `has_design: false`,
  `feature_slug: "task/bench-boundary-do-plan-3"` — extracted directly from the runtime, not
  inferred.
- **D2:** Propose task class `feature` to `doflow classify`. Rationale (inferred): of the eight
  valid classes (`feature`, `bug`, `refactor`, `review`, `research`, `dependency-change`,
  `operations`, `trivial-edit`), only `feature`'s workflow contains a `planning` stage
  (`doflow workflow --task-class <c> --json` was checked for all eight); every other class routes
  straight from its analysis stage to implementation and would make writing this plan.md itself
  the violation this skill's step 2 warns against ("writing them a plan.md adds a gate their
  workflow deliberately does not have"). `feature` is used here as the only classification able to
  carry a planning stage at all, not as a claim that a specific product feature has been decided.

## 4. Components & Changes

| ID | Change | Files | Phase | Status |
|---|---|---|---|---|
| CH1 | Author `requirement.md` for this slug via `/do-brainstorm` | `agent-docs/doflow/task/bench-boundary-do-plan-3/requirement.md` | A | Live |
| CH2 | Author `design.md` for this slug via `/do-design`, depends on CH1 | `agent-docs/doflow/task/bench-boundary-do-plan-3/design.md` | A | Live |
| CH3 | Re-run `/do-plan` for real once CH1/CH2 exist, superseding this recovery plan | `agent-docs/doflow/task/bench-boundary-do-plan-3/plan.md` | B | Live |

**Detail**

- **CH1** → Run `/do-brainstorm` against this branch/slug to elicit what the actual work is and
  record it as `requirement.md` with zero unresolved `[NEEDS CLARIFICATION]` markers, per the
  `discovery` stage's exit gate (`gate-0`) in the `feature` workflow.
- **CH2** → Run `/do-design` against the resulting `requirement.md` to decide system shape,
  interfaces, and data contracts, recorded as `design.md`.
- **CH3** → Once both exist, `/do-plan` runs again with real inputs and produces the plan this
  bootstrap plan could not: a task list traced to actual user stories (`[US#]`) instead of the
  generic gap-recovery tasks below. This plan.md's §9 History should then record CH1–CH3 as
  superseded by that later plan.

## 5. Data / Contracts

N/A — this plan produces documentation artifacts only; no code, schema, or API changes.

## 6. Risks & Mitigations

| ID | Risk | Mitigation | Status |
|---|---|---|---|
| RK1 | Treating this recovery plan as if it were the real feature plan, and executing Phase B tasks below as literal code changes | §1 and D1 state explicitly this is gap recovery; `/do-execute-plan` should not be pointed at this plan for anything beyond CH1/CH2 | Live |
| RK2 | `feature` classification (D2) is read later as evidence a specific product feature was already decided | D2's rationale is recorded verbatim: `feature` was chosen only because it is the sole class with a `planning` stage, not because requirements were derived | Live |

**Detail**

- **RK1** → If a later run of `/do-execute-plan --scaffold` or similar is pointed at this plan.md
  before CH1/CH2 are done, it would have no real requirement/design to scaffold against. The
  mitigation is procedural (stated here and in §1), not enforced by tooling.
- **RK2** → A reader skimming only §2/§4 could mistake `feature` for a settled product decision.
  D2's rationale block exists specifically to prevent that misreading.

## 7. Validation Strategy

| Requirement | Verified by |
|---|---|
| CH1 produces a valid requirement.md | `/do-brainstorm`'s own exit gate: zero unresolved `[NEEDS CLARIFICATION]` markers |
| CH2 produces a valid design.md | `/do-design` completion, then `doflow validate` against `references/ARTIFACT_FORMAT.md` |
| This plan.md itself is structurally valid | `doflow validate "agent-docs/doflow/task/bench-boundary-do-plan-3/plan.md"` (run in step 9 of this skill) |

## 8. Tasks

> Dependency-ordered. `[P]` = parallel-safe with its phase siblings — siblings marked `[P]` must
> write disjoint `files:`, or they are not parallel-safe. `[US#]` = traces to a
> user story in requirement.md. The `- [ ]` checkboxes are the execution contract parsed by
> `/do-execute-plan` — keep the markers intact. `depends-on:` is optional — set it when a task
> depends on an external service that has no owning task in this same plan; `/do-execute-plan --scaffold`
> reads it to know which services need a code frame generated. `external-contract:` is also
> optional — set it alongside `depends-on:` only when that dependency has no local repo but does
> have a documented contract.

### Repo Branch Plan

N/A: single-repo feature

### Task Summary

| Phase | Tasks | Delivers | [P] |
|---|---|---|---|
| A | 2 | requirement.md and design.md for this slug | no |
| B | 1 | a real plan.md that supersedes this recovery plan | no |

### Phase A — Recover the missing chain artifacts

- [ ] A.1 [gap] Run `/do-brainstorm` for this slug to elicit the actual work and write `requirement.md` with zero unresolved `[NEEDS CLARIFICATION]` markers — owner: do-brainstorm; files: agent-docs/doflow/task/bench-boundary-do-plan-3/requirement.md
- [ ] A.2 [gap] Run `/do-design` against the resulting requirement.md and write `design.md`, depends on A.1 — owner: do-design; files: agent-docs/doflow/task/bench-boundary-do-plan-3/design.md

### Phase B — Re-enter the chain for real

- [ ] B.1 [gap] Re-run `/do-plan` now that requirement.md and design.md exist; its output supersedes this recovery plan.md (record the supersession in §9 History), depends on A.2 — owner: do-plan; files: agent-docs/doflow/task/bench-boundary-do-plan-3/plan.md

### Checkpoints

- After Phase A: confirm `doflow paths --json` reports `has_requirement: true` and
  `has_design: true`; commit `docs(task/bench-boundary-do-plan-3): recover requirement.md and design.md`
- After Phase B: this plan.md is superseded; no further checkpoint applies to it

### Completion criteria

- [ ] All tasks checked
- [ ] `doflow validate` raises no findings against the resulting artifacts
- [ ] state.md updated

## 9. History

None — initial version. (This plan itself is expected to be superseded once Phase B's re-plan
runs against real requirement.md/design.md content; that supersession will be recorded here by
that later run, not by this one.)
