# Implementation Plan: [BLOCKED — no design.md found]

**Feature:** task/bench-boundary-do-plan-1 · **Requirement:** ./requirement.md (MISSING) · **Design:** ./design.md (MISSING) · **Status:** Draft — precondition not met · **Created:** 2026-08-17/18

> This file is a **gap-disclosure stub**, not a completed plan. `do-plan`'s own resolver
> (`doflow-run paths --json`) reported `has_requirement: false` and `has_design: false` for this
> feature dir (`agent-docs/doflow/task/bench-boundary-do-plan-1/`). Per `do-plan`'s SKILL.md step 3
> ("Precondition (advisory)"), the skill's documented behavior on this signal is to **warn and
> offer to run `/do-brainstorm` / `/do-design` first** — not to invent a design. No requirement.md
> or design.md content exists anywhere in this sandbox to derive §1, §3, §4, §5, §6, or §7 from, so
> those sections are intentionally left undone below rather than fabricated.

## 1. Approach

BLOCKED. No `requirement.md` (WHAT/WHY) and no `design.md` (system shape) exist in this repo to
read. Nothing in the sandbox authored a design for this feature, so there is no real "approach" to
transcribe — writing one here would mean inventing a design, which the skill instructs against.

## 2. Constitution Check (GATE)

Not evaluated — there is no proposed approach to check against the constitution tiers.

**Result:** N/A — blocked upstream of this gate.

## 3. Research & Decisions

None recorded. No `requirement.md` exists, so there are no `[NEEDS CLARIFICATION]` markers to
resolve.

## 4. Components & Changes

| ID | Change | Files | Phase | Status |
|---|---|---|---|---|
| — | none — no design.md to derive components from | — | — | — |

## 5. Data / Contracts

N/A — no design.md.

## 6. Risks & Mitigations

| ID | Risk | Mitigation | Status |
|---|---|---|---|
| RK1 | Proceeding to plan without requirement.md/design.md would require fabricating both, silently misrepresenting the feature's actual scope to whoever executes this plan. | Do not fabricate; disclose the gap and stop here. Route back to `/do-brainstorm` then `/do-design`. | Live |

## 7. Validation Strategy

N/A — no requirement.md, so no `FR-###` acceptance criteria exist to validate against.

## 8. Tasks

Only one real task exists at this point in the chain: unblock the precondition.

### Repo Branch Plan

N/A: single-repo feature (only repo in scope: this worktree).

### Task Summary

| Phase | Tasks | Delivers | [P] |
|---|---|---|---|
| A | 1 | Unblocks planning by producing requirement.md and design.md | no |

### Phase A — Produce upstream artifacts

- [ ] A.1 [US-none] Run `/do-brainstorm` to produce `requirement.md`, then `/do-design` to produce
      `design.md`, for `agent-docs/doflow/task/bench-boundary-do-plan-1/` — owner: user/agent;
      files: `agent-docs/doflow/task/bench-boundary-do-plan-1/requirement.md`,
      `agent-docs/doflow/task/bench-boundary-do-plan-1/design.md`

### Checkpoints

- After Phase A: re-run `/do-plan` — its resolver will report `has_requirement: true` and
  `has_design: true`, and the real §1–§7 content can then be filled from those artifacts.

### Completion criteria

- [ ] requirement.md exists
- [ ] design.md exists
- [ ] `/do-plan` re-run with both present

## 9. History

None — initial version. This stub exists only to record that `do-plan` was invoked, found no
`design.md`/`requirement.md`, and disclosed that fact rather than proceeding.
