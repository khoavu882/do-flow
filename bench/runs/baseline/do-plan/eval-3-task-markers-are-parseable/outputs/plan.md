# Implementation Plan: Bench baseline sandbox (no requirement/design yet)

**Feature:** task/bench-baseline-do-plan-3 · **Requirement:** ./requirement.md · **Design:** ./design.md · **Status:** Draft · **Created:** 2026-08-17

> HOW. Reads ./requirement.md and ./design.md. Resolve every `[NEEDS CLARIFICATION]` from the
> requirement here.
>
> Structure follows `references/ARTIFACT_FORMAT.md`: indexed sections carry a table above full
> `**Detail**`, `Status` is only `Live` or `Superseded → <ref>`, and superseded prose moves to §9.

## 1. Approach

Neither `requirement.md` nor `design.md` exists in this feature directory
(`agent-docs/doflow/task/bench-baseline-do-plan-3/`), so there is no WHAT/WHY or system shape to
turn into an implementation plan. The advisory precondition in `/do-plan` step 2 is skippable, not
a hard block, so this plan proceeds rather than refusing — but it cannot invent functional scope
that was never specified. The approach taken here is to record the gap honestly and scope the task
checklist to what is actually actionable right now: producing the missing upstream artifacts. No
implementation tasks for an unspecified feature are included, because writing them would mean
guessing requirements this plan has no authority to invent.

## 2. Constitution Check (GATE)

> Verify against both constitution tiers, tier-2 taking precedence — you reconcile them yourself;
> nothing merges them for you. Any violation = STOP and revise the approach before continuing.
> (Advisory by default; not the hard hook gate.)

- [ ] Complies with P2 (Evidence over assumptions): **No** — there is no `requirement.md` or
  `design.md` to serve as evidence for any implementation decision. Any component/task list beyond
  "produce the missing artifacts" would be assumption-built, not evidence-built.
- [ ] Complies with P4 (Scope discipline / YAGNI): **Unverifiable** — scope cannot be checked
  against a requirement that does not exist.
- [x] Complies with P6 (Professional honesty): **Yes** — this section states the gap plainly
  instead of fabricating a plausible-looking plan.

No tier-2 `agent-docs/constitution.md` exists in this repo (`has_constitution_local: false` from
the resolver), so only the tier-1 base applies.

**Result:** FAIL — reasoning: `/do-plan` normally turns `requirement.md` + `design.md` into HOW.
Both are absent here, so §4–§7 below are scoped only to the recovery path (getting those artifacts
written), not to a fabricated feature implementation. This is recorded as FAIL per instruction
rather than a forced PASS, so the gap is visible to anyone reading this plan later; per the
Constitution Check's own advisory status, this does not block the checklist below from being
written, but no implementation-shaped tasks are proposed.

## 3. Research & Decisions

- **D1:** Do not invent a `requirement.md`/`design.md` on this plan's own authority. Rationale:
  `/do-plan`'s boundaries explicitly exclude writing `design.md` (that's `/do-design`'s job), and
  writing `requirement.md` is `/do-brainstorm`'s job — both require the Socratic/discovery dialogue
  those skills run, not a guess from `/do-plan`. There are also no `[NEEDS CLARIFICATION]` markers
  to resolve, because there is no requirement text containing any.
- **D2:** Because no human was available to answer a clarifying question in this run (non-interactive
  execution), the question "should this plan proceed despite missing requirement.md/design.md, or
  stop and wait?" was not asked via `AskUserQuestion`. Assumption made instead: proceed, per the
  explicit run instruction that this precondition is advisory/skippable — see "Assumptions
  Substituted for Questions" in the accompanying transcript.

## 4. Components & Changes

| ID | Change | Files | Phase | Status |
|---|---|---|---|---|
| CH1 | Capture requirement via `/do-brainstorm` | agent-docs/doflow/task/bench-baseline-do-plan-3/requirement.md | A | Live |
| CH2 | Capture design via `/do-design` | agent-docs/doflow/task/bench-baseline-do-plan-3/design.md | A | Live |

**Detail**

- **CH1** → No `requirement.md` exists for this feature slug. `/do-brainstorm` needs to run first
  to establish WHAT/WHY through Socratic discovery before any HOW can be planned. This plan cannot
  perform that discovery itself — it is out of `/do-plan`'s boundaries.
- **CH2** → Once `requirement.md` exists, `/do-design` turns it into a system shape
  (`design.md`). Only after both exist can a real `/do-plan` pass produce implementation-shaped
  tasks (components, data/contracts, risks tied to an actual feature) instead of this
  gap-acknowledgment plan.

## 5. Data / Contracts

N/A — no design exists to derive data or contract shapes from.

## 6. Risks & Mitigations

| ID | Risk | Mitigation | Status |
|---|---|---|---|
| RK1 | This plan is mistaken for a real implementation plan and executed as-is | Constitution Check recorded as FAIL above and §8 contains no implementation tasks, only the recovery path | Live |
| RK2 | `/do-execute-plan`'s hard prerequisite gate (`do-prereqs.sh --require-plan`) still requires `requirement.md` and `design.md` to exist, so it will refuse to run against this feature dir until CH1/CH2 land | Sequencing A.1 before A.2 in §8 makes that dependency explicit | Live |

**Detail**

- **RK1** → A reader skimming only §8 could assume the checklist is ready to execute. The FAIL
  verdict in §2 and the absence of any `files:`-scoped implementation task are the guardrails
  against that misreading.
- **RK2** → `/do-execute-plan` enforces `requirement.md` + `design.md` + `plan.md` all existing
  before it will dispatch any task, regardless of what this `plan.md` says. Writing this `plan.md`
  does not itself satisfy that gate — CH1 and CH2 still have to be completed first.

## 7. Validation Strategy

| Requirement | Verified by |
|---|---|
| N/A — no `requirement.md` exists | `bash scripts/doflow/bash/validate-artifacts.sh` confirms this plan's own index/detail and rollup consistency; it does not and cannot validate against a requirement that was never written |

## 8. Tasks

> Dependency-ordered. `[P]` = parallel-safe with its phase siblings — siblings marked `[P]` must
> write disjoint `files:`, or they are not parallel-safe. `[US#]` = traces to a
> user story in requirement.md. The `- [ ]` checkboxes are the execution contract parsed by
> `/do-execute-plan` — keep the markers intact. `depends-on:` is optional — set it when a task
> depends on an external service that has no owning task in this same plan (not a service also
> touched by another task here); `/do-execute-plan --contracts` reads it to know which services
> need a code frame generated. `contract-doc:` is also optional — set it alongside `depends-on:`
> only when that dependency has no local repo (a vendor API, a SaaS integration) but *does* have a
> documented contract; points to a doc built from `templates/doflow/contract-doc-template.md`, and
> tells `--contracts` to generate a real frame from it instead of silently skipping a non-local
> dependency (the default when no `contract-doc:` is set — not every dependency needs one).
>
> No `[US#]` tags appear below: `requirement.md` does not exist, so there are no user stories to
> trace tasks to. Both tasks are recovery steps (produce the missing artifacts), not feature
> implementation steps.

### Repo Branch Plan

N/A: single-repo feature

### Task Summary

| Phase | Tasks | Delivers | [P] |
|---|---|---|---|
| A | 2 | requirement.md and design.md, unblocking a real /do-plan pass | no |

### Phase A — Recover missing chain artifacts

- [ ] A.1 Run `/do-brainstorm` to produce requirement.md — owner: do-brainstorm; files: agent-docs/doflow/task/bench-baseline-do-plan-3/requirement.md
- [ ] A.2 Run `/do-design` to produce design.md, once A.1 lands — owner: do-design; files: agent-docs/doflow/task/bench-baseline-do-plan-3/design.md

### Checkpoints

- After Phase A: re-run `/do-plan` with `requirement.md` and `design.md` both present, so §2's
  Constitution Check can evaluate real functional/scope decisions and §4–§7 can describe an actual
  feature instead of this recovery path; commit `docs(plan): recover requirement/design gap`.

### Completion criteria

- [ ] All tasks checked
- [ ] Validation gates pass
- [ ] state.md updated

## 9. History

None — initial version.
