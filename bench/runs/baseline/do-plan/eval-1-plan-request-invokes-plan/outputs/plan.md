# Implementation Plan: Recover chain artifacts, then plan the requested feature

**Feature:** task/bench-baseline-do-plan-1 · **Requirement:** ./requirement.md (missing) · **Design:** ./design.md (missing) · **Status:** Draft · **Created:** 2026-08-17

> HOW. Reads `./requirement.md` and `./design.md`. Neither exists in this feature directory —
> see §1 for how this plan proceeds anyway and what it does not claim to know.

## 1. Approach

The request was "turn the design into an implementation plan I can hand to someone," but this
feature directory (`agent-docs/doflow/task/bench-baseline-do-plan-1/`) has no `requirement.md`
and no `design.md`, and no other artifact in the repo describes an intended feature. `do-plan`'s
precondition check on this is advisory, not a hard gate, so rather than refuse outright this plan
documents the gap honestly and scaffolds the one thing that *is* actionable without guessing at
unstated requirements: recovering the missing inputs. **This is not a substitute for a real
implementation plan** — sections 3–7 below are intentionally thin because there is no concrete
design to plan against. Once `requirement.md` and `design.md` exist, re-run `/do-plan` to replace
this draft with one that actually decomposes the feature's work.

**Assumption (recorded, not confirmed by a user):** rather than stopping and asking whether to run
`/do-brainstorm` and `/do-design` first, I assumed the person wants a document to hand off now and
proceeded to produce this scaffold plan, flagging every gap explicitly instead of inventing
requirement or design content that nobody supplied.

## 2. Constitution Check (GATE)

> Both constitution tiers were read: `constitution_base` (global) exists;
> `has_constitution_local` is false, so no repo-local `agent-docs/constitution.md` was consulted
> (per the resolver, not a filesystem check of my own).

- [x] No violation of "implementation completeness / no scaffolding placeholders": the missing
  inputs are surfaced as an explicit, tracked task rather than silently fabricated content.
- [ ] Complies with "plan.md decomposes the feature's actual work": **not yet** — cannot be
  satisfied until `requirement.md` and `design.md` exist to decompose against.

**Result:** FAIL — the plan cannot yet reflect real component/task decomposition because its
required inputs don't exist. Recorded per the advisory gate; not blocking, since stopping outright
would leave the requester with nothing to hand off. Phase A below exists specifically to resolve
this FAIL on the next `/do-plan` run.

## 3. Research & Decisions

- **D1:** Proceed with a gap-recovery scaffold instead of refusing outright — resolves the
  implicit question "should this stop and ask, or produce something usable now?"; rationale: the
  precondition gate is documented as advisory/skippable, and a plan that names the gap is more
  useful to a handoff recipient than no plan at all.

## 4. Components & Changes

| ID | Change | Files | Phase | Status |
|---|---|---|---|---|
| CH1 | Author `requirement.md` for the target feature | `agent-docs/doflow/task/bench-baseline-do-plan-1/requirement.md` | A | Live |
| CH2 | Author `design.md` for the target feature | `agent-docs/doflow/task/bench-baseline-do-plan-1/design.md` | A | Live |
| CH3 | Re-plan against real inputs | `agent-docs/doflow/task/bench-baseline-do-plan-1/plan.md` | B | Live |

**Detail**

- **CH1** → Run `/do-brainstorm` (or otherwise capture WHAT/WHY, user stories, and functional
  requirements) so `requirement.md` exists with resolvable `[NEEDS CLARIFICATION]` markers.
- **CH2** → Run `/do-design` against the resulting `requirement.md` to produce `design.md` (system
  shape, components, C4 diagrams) — this is the actual "design" the original request assumed
  already existed.
- **CH3** → Re-run `/do-plan` once CH1/CH2 land; it will overwrite this draft with a real
  Components & Changes / Tasks breakdown traced to the requirement's user stories.

## 5. Data / Contracts

N/A — no design exists yet to define schemas, APIs, or interfaces against.

## 6. Risks & Mitigations

| ID | Risk | Mitigation | Status |
|---|---|---|---|
| RK1 | This plan is handed off and treated as a real implementation plan, hiding that no requirement/design exists | §1 states the gap in the first paragraph; Constitution Check §2 records an explicit FAIL for this reason | Live |
| RK2 | CH1/CH2 are skipped and implementation starts directly from this scaffold | `/do-execute-plan`'s implement phase is gated on `requirement.md`, `design.md`, and `plan.md` all existing — CH1/CH2 being absent blocks that gate independently of this plan | Live |

**Detail**

- **RK1** → A plan document handed to an engineer reads as authoritative by default; without the
  explicit caveat in §1 and the FAIL in §2, the missing inputs could go unnoticed until well into
  implementation. The mitigation is textual prominence, not a technical control — a reader who
  skips §1 and §2 is not protected.
- **RK2** → The doflow chain's hard gate (artifact existence, enforced by `pre-implement-gate`)
  independently prevents `/do-execute-plan` from proceeding without `requirement.md` and
  `design.md`, so this scaffold cannot itself be used to start implementation even if someone
  tries.

## 7. Validation Strategy

| Requirement | Verified by |
|---|---|
| N/A — no functional requirements exist yet | CH1 (author `requirement.md`) is the prerequisite for any FR-* row here |

## 8. Tasks

### Repo Branch Plan

N/A: single-repo feature.

### Task Summary

| Phase | Tasks | Delivers | [P] |
|---|---|---|---|
| A | 2 | `requirement.md` and `design.md` for the target feature | yes |
| B | 1 | A real, decomposed `plan.md` replacing this scaffold | no |

### Phase A — Recover missing chain inputs

- [ ] A.1 [P] [no user story: requirement.md does not exist yet] Run `/do-brainstorm` to capture WHAT/WHY and produce `requirement.md` — owner: requester; files: agent-docs/doflow/task/bench-baseline-do-plan-1/requirement.md
- [ ] A.2 [P] [no user story: design.md does not exist yet] Run `/do-design` to capture system shape and produce `design.md` — owner: requester; files: agent-docs/doflow/task/bench-baseline-do-plan-1/design.md

### Phase B — Replace this scaffold

- [ ] B.1 [depends on A.1, A.2] Re-run `/do-plan` to produce a real Components & Changes / Tasks breakdown traced to requirement.md's user stories, superseding this draft — owner: requester; files: agent-docs/doflow/task/bench-baseline-do-plan-1/plan.md

### Checkpoints

- After Phase A: confirm `requirement.md` and `design.md` both exist and contain no unresolved `[NEEDS CLARIFICATION]` markers before starting Phase B.

### Completion criteria

- [ ] All tasks checked
- [ ] `requirement.md` and `design.md` exist and are populated
- [ ] `/do-plan` re-run produces a plan.md with a real Components & Changes / Tasks breakdown, superseding this one

## 9. History

None — initial version.
