# Implementation Plan: [UNRESOLVED — no requirement.md/design.md present]

**Feature:** task/bench-baseline-do-plan-2 · **Requirement:** ./requirement.md (MISSING) · **Design:** ./design.md (MISSING) · **Status:** Draft · **Created:** 2026-08-17

> HOW. Reads ./requirement.md and ./design.md. Resolve every `[NEEDS CLARIFICATION]` from the
> requirement here.
>
> **Precondition not met.** The resolver (`do-paths.sh --json`) reports `has_requirement: false`
> and `has_design: false` for this feature dir (`agent-docs/doflow/task/bench-baseline-do-plan-2/`).
> Per do-plan's Behavioral Flow step 2, this precondition is **advisory, not a hard block** — the
> only hard-enforced gate in the doflow chain is artifact existence at the `/do-execute-plan`
> boundary. This plan therefore proceeds, but honestly: there is no requirement or design to plan
> against, so §1/§3/§4/§5/§7 below cannot contain real content. Sections 1–7 are left as explicit
> gaps rather than invented content, and §8's task list is scoped only to the actionable next step
> (run the earlier chain stages), not to a fabricated feature.
>
> **Recommendation:** run `/do-brainstorm` to produce `requirement.md`, then `/do-design` to
> produce `design.md`, then re-run `/do-plan --strategy systematic` against real inputs.

## 1. Approach

N/A — no `requirement.md` or `design.md` exists to derive an approach from. Nothing to plan.

## 2. Constitution Check (GATE)

> Verify against both constitution tiers, tier-2 taking precedence — you reconcile them yourself;
> nothing merges them for you. Any violation = STOP and revise the approach before continuing.
> (Advisory by default; not the hard hook gate.)

**Tiers evaluated:**

- **Tier-1 (base):** `<home>/.doflow/guidance/references/CONSTITUTION_BASE.md` — present, read in full (v1.0.0, principles P1–P6).
- **Tier-2 (per-repo):** `agent-docs/constitution.md` — **not present** in this repo/sandbox (resolver reports `has_constitution_local: false`). No overlay to reconcile; tier-1 stands alone for this evaluation. This is a factual absence, not a skipped check — the resolver's `constitution_local` path was computed and checked.

- [ ] Complies with P2 (Evidence over assumptions): **NO** — this plan has no `requirement.md` or `design.md` to serve as evidence. Any task list written here would be invented, not derived.
- [ ] Complies with P4 (Scope discipline / YAGNI): **N/A to assess** — there is no requirement to bound scope against.
- [ ] No violation of P3 (Finish what you start): **N/A** — no implementation is being started by this plan; it correctly stops short rather than fabricating a task list against a nonexistent design.

**Result:** **FAIL** — Evaluated against tier-1 only (tier-2 constitution not present in this repo). Violates P2 (Evidence over assumptions): there is no `requirement.md`/`design.md` for this feature slug, so a genuine implementation plan cannot be evidenced. Per Behavioral Flow step 5, a Constitution Check violation means STOP and revise the approach before continuing — the "approach" here is revised down to: do not fabricate §1–§7 content; scope §8 to the remediation steps (`/do-brainstorm`, `/do-design`) instead of invented implementation tasks. The verdict is advisory and blocks nothing downstream, but is recorded honestly rather than as a pass.

## 3. Research & Decisions

None — no `[NEEDS CLARIFICATION]` markers exist to resolve because no `requirement.md` exists.

## 4. Components & Changes

| ID | Change | Files | Phase | Status |
|---|---|---|---|---|
| — | N/A — no design.md to derive components from | — | — | — |

**Detail**

None.

## 5. Data / Contracts

N/A — no design.md exists.

## 6. Risks & Mitigations

| ID | Risk | Mitigation | Status |
|---|---|---|---|
| RK1 | Proceeding to `/do-execute-plan` against this plan would execute a fabricated or empty task list | Do not treat this plan as ready for execution; the only valid next tasks are the remediation tasks in §8 | Live |
| RK2 | A future run of `/do-plan` on this same slug might silently overwrite this honest-gap plan with invented content if not careful | Re-run `/do-brainstorm` and `/do-design` first so the next `/do-plan` pass has real inputs | Live |

**Detail**

- **RK1** → `/do-execute-plan` is gated on `requirement.md`, `design.md`, and `plan.md` all existing (per this skill's own "Next Step" boundary) — this plan's existence alone does not satisfy that gate meaningfully, since it carries no real task content. The mitigation is procedural (documented here), not a hook-enforced block.
- **RK2** → Nothing in the chain currently detects "plan.md exists but was written against missing inputs" as a distinct state from a normal plan; this note is the only guard against that until the earlier stages are run.

## 7. Validation Strategy

| Requirement | Verified by |
|---|---|
| — | N/A — no requirement.md to trace validation against |

## 8. Tasks

> Dependency-ordered. `[P]` = parallel-safe with its phase siblings. `[US#]` = traces to a user
> story in requirement.md — none exist yet, so no task below carries a `[US#]` tag. Scoped to what
> is actually actionable given the missing inputs, not to a fabricated feature.

### Repo Branch Plan

N/A: single-repo feature (and no branch derivation is meaningful without a requirement's `**Ticket:**` field, which does not exist).

### Task Summary

| Phase | Tasks | Delivers | [P] |
|---|---|---|---|
| A | 2 | requirement.md and design.md so a real plan can be written | no |

### Phase A — Recover the missing chain inputs

- [ ] A.1 Run `/do-brainstorm` for this feature slug to produce `requirement.md` — owner: user/agent; files: agent-docs/doflow/task/bench-baseline-do-plan-2/requirement.md
- [ ] A.2 Run `/do-design` against the resulting requirement.md to produce `design.md`, depends on A.1 — owner: user/agent; files: agent-docs/doflow/task/bench-baseline-do-plan-2/design.md

### Checkpoints

- After Phase A: re-run `/do-plan --strategy systematic` against real `requirement.md` + `design.md`; discard or supersede this plan once a real one exists.

### Completion criteria

- [ ] requirement.md exists
- [ ] design.md exists
- [ ] This plan is superseded by a re-run of `/do-plan` with real inputs

## 9. History

None — initial version. This plan itself represents a degraded/gap-documenting pass; a future
superseding plan (once requirement.md/design.md exist) should record this version's supersession
here.
