# Implementation Plan: NO UPSTREAM FEATURE — gap recovery for `bench-d3-do-plan-2`

**Feature:** bench-d3-do-plan-2 · **Requirement:** ./requirement.md — **absent** · **Design:** ./design.md — **absent** · **Status:** Draft · **Created:** 2026-08-18

> HOW. This plan has no WHAT and no system shape to work from. `doflow paths --json` on branch
> `task/bench-d3-do-plan-2` reports `has_requirement: false` and `has_design: false`, and
> `candidate_slugs` is empty, so there is no other feature dir in this repo holding them either.
> Invoked as `/do-plan --depth normal`; the depth knob is honoured below, but it can only set the
> granularity of the gap-recovery tasks, because there is no feature to slice.

## 0. Input State

| Input | Resolver field | Present? | Path |
|---|---|---|---|
| requirement.md | `has_requirement` | **no** | `agent-docs/doflow/bench-d3-do-plan-2/requirement.md` |
| design.md | `has_design` | **no** | `agent-docs/doflow/bench-d3-do-plan-2/design.md` |
| plan.md (before this run) | `has_plan` | no | `agent-docs/doflow/bench-d3-do-plan-2/plan.md` |
| Constitution tier-1 | `constitution_base` | **yes** | `.doflow/guidance/references/CONSTITUTION_BASE.md` (v1.0.0) |
| Constitution tier-2 | `has_constitution_local` | **no** | `agent-docs/constitution.md` |

The `agent-docs/` directory did not exist at all before this run. Nothing about a feature — no
name, no user story, no component, no interface — is available from any source in this sandbox.
This plan therefore describes the recovery of the missing inputs and nothing else. It does not
name, scope, or decompose a feature, because doing so would mean writing fiction into the
artifact that `/do-execute-plan` treats as its execution contract.

`/do-plan` step 3 marks the missing-input precondition **advisory (skippable)**, so this run
proceeded rather than aborting. The advisory offer it is supposed to make — "run /do-brainstorm
and /do-design first" — is recorded as Phase A rather than left as an unanswered prompt.

## 1. Approach

Restore the chain in its declared order. `/do-brainstorm` writes `requirement.md`; `/do-design`
reads it and writes `design.md`; `/do-plan` is then re-run and supersedes this document with a
plan whose task list names real source files. No source file is edited by anything in this plan.

Task class **feature**, validated: `doflow classify --task-class feature --json` returned
`outcome: ACCEPTED`, workflow "Feature Delivery"
(discovery → design → planning → implementation → verification → review). This skill is that
workflow's `planning` stage, whose `readinessTemplate` is `null`; the implementation stage's
template is `feature`, which is the contract `/do-execute-plan` will later be graded against.
The signal the class rests on is weak and is declared as such in §3 D5: with no requirement and
no design to derive from, `feature` was chosen because it is the only class in `workflows.yaml`
that contains a `planning` stage — under any other class this skill's correct move would have
been to hand off, not to plan.

Depth `normal` (passed explicitly). Under `--depth shallow` Phase A would collapse to a single
"restore the upstream artifacts" task; under `deep` each `/do-brainstorm` and `/do-design` section
would get its own task. `normal` gives one task per artifact plus one scoping question.

## 2. Constitution Check (GATE)

> Both tiers evaluated. **Tier-1:** `.doflow/guidance/references/CONSTITUTION_BASE.md` v1.0.0,
> principles P1–P6, read in full this run. **Tier-2:** `agent-docs/constitution.md` —
> `has_constitution_local` is `false`, so no repo-level constitution exists; tier-1 stands
> unmodified and there is no overlay to take precedence. Tier-2's verdict is
> **"absent — no overriding or additional principles in force"**, which is a recorded evaluation,
> not a skipped one. (Per `CONSTITUTION_BASE.md` Governance, this verdict is advisory: it is
> recorded here and blocks nothing downstream.)

### Tier-1 — `CONSTITUTION_BASE.md` v1.0.0

- [x] Complies with **P1 — Safety over speed**: nothing destructive or irreversible. The plan
      writes one Markdown file and creates no branch, no commit, no source edit.
- [x] Complies with **P2 — Evidence over assumptions**: every factual claim here is backed by a
      command whose output is quoted (`doflow paths --json`, `doflow classify`, `doflow validate`).
      The one place an assumption was unavoidable — the task class — is labelled an assumption in
      §3 D5 rather than presented as derived.
- [x] Complies with **P3 — Finish what you start**: no task is a stub. Each names its output file
      and its completion signal, and §7 states how the recovery is verified.
- [x] Complies with **P4 — Scope discipline (YAGNI)**: the single largest temptation in this run
      was to fill the template with a plausible feature. Nothing is invented: §4 lists only chain
      artifacts, §5 is `N/A`, and §8 tasks carry `[US-none]` instead of a fabricated `[US1]`.
- [x] Complies with **P5 — Parallel by default**: `[P]` is withheld from every task, and each
      withholding has a named dependency behind it (§8). A.1 consumes A.0's answer, A.2 reads the
      `requirement.md` A.1 writes, B.1 checks A.2's output, B.2 rewrites what B.1 validated.
- [x] Complies with **P6 — Professional honesty**: the missing inputs are the first thing the
      document says, in the title. No metric, percentage or confidence appears anywhere.

### Tier-2 — `agent-docs/constitution.md`

- [x] **Not present** (`has_constitution_local: false`). No additional principle to satisfy, no
      override to reconcile against tier-1. Checked via the resolver flag, not a filesystem
      stat of my own, per step 4.

**Result:** **PASS** — tier-1 PASS on P1–P6; tier-2 absent, therefore vacuously PASS. Recorded
under protest of a sort: this plan passes *as a gap-recovery plan*. Had it been written as the
implementation plan the invocation implicitly asked for, it would have FAILED P2 and P4, and
step 6 would have required a STOP-and-revise before continuing. No violation arose, so no
revision cycle was needed.

## 3. Research & Decisions

- **D1:** Do not invent a feature — resolves the implicit open question "what is being planned?";
  rationale: `doflow paths --json` returns `has_requirement: false`, `has_design: false`,
  `candidate_slugs: []`, and `agent-docs/` does not exist on disk. The absence is complete, not a
  slug mis-resolution.
- **D2:** Continue rather than abort — resolves "does a missing input stop this skill?";
  rationale: `SKILL.md` step 3 labels the precondition advisory and skippable; the chain's one
  hard gate covers artifact existence at *implementation*, not at planning.
- **D3:** Recover via `/do-brainstorm` then `/do-design`, in that order — resolves "may do-plan
  backfill the inputs itself?"; rationale: `SKILL.md` **Will Not** — "write `design.md` (that's
  `/do-design`)".
- **D4:** Record the Constitution Check against both tiers with tier-2 explicitly evaluated as
  absent — resolves "what does the gate say with no repo constitution?"; rationale:
  `CONSTITUTION_BASE.md` Governance requires `/do-plan` to evaluate both tiers together and record
  PASS/FAIL, and `SKILL.md` step 4 says to use `has_constitution_local` as the deciding flag.
- **D5 (declared assumption):** Task class `feature`. Step 2 says to derive the class from
  `requirement.md` and `design.md`; both are absent and no user was available to settle it, so it
  was chosen from the invocation's shape. Recorded as an assumption, not a derivation.
- **D6:** `--depth normal` applied to the recovery tasks — resolves "what does depth mean with no
  feature?"; rationale: depth is the granularity knob for §8 only, and §8 has real content here
  even though it is not feature content.

## 4. Components & Changes

| ID | Change | Files | Phase | Status |
|---|---|---|---|---|
| CH1 | Establish the feature directory and its `requirement.md` | `agent-docs/doflow/bench-d3-do-plan-2/requirement.md` | A | Live |
| CH2 | Produce `design.md` from that requirement | `agent-docs/doflow/bench-d3-do-plan-2/design.md` | A | Live |
| CH3 | Supersede this gap plan with a real feature plan | `agent-docs/doflow/bench-d3-do-plan-2/plan.md` | B | Live |

**Detail**

- **CH1** → `/do-brainstorm` runs the discovery stage of the accepted workflow and writes
  `requirement.md`: problem statement, user stories, functional and non-functional requirements,
  assumptions, and any `[NEEDS CLARIFICATION]` it cannot close in session. Gate `gate-0` of the
  Feature Delivery workflow fires after this stage if any such marker remains.
- **CH2** → `/do-design` reads that requirement and writes `design.md`: C1 Context and C2
  Container diagrams, components and boundaries, data contracts, risks, assumptions. This is the
  artifact whose absence made the present invocation unanswerable as asked.
- **CH3** → Re-running `/do-plan --depth normal` against both real inputs produces §4 rows naming
  code, §5 naming actual contracts, and §8 tasks whose `files:` sit under `src/`. This document is
  then replaced in full and its content moves to that plan's §9 History.

## 5. Data / Contracts

N/A — no schema, API surface, or interface is defined or altered. Every file this plan touches is
Markdown under `agent-docs/doflow/bench-d3-do-plan-2/`. The only contracts this document is itself
bound by are `references/ARTIFACT_FORMAT.md` (index-then-detail in §4 and §6; `ID`/`Status` column
headers spelled exactly; `Live` / `Superseded → <ref>` as the closed status vocabulary; §9 History
present) and the `- [ ]` task-marker syntax that `/do-execute-plan` parses.

## 6. Risks & Mitigations

| ID | Risk | Mitigation | Status |
|---|---|---|---|
| RK1 | This file's existence makes the chain look further along than it is | Absence stated in the title, header, §0, §1 and §2; §8 tasks carry `[US-none]` | Live |
| RK2 | A future reader treats §8 as the feature's task list | §8 tasks name only `agent-docs/` paths; none mutates source | Live |
| RK3 | The intended design exists outside this repo and no resolver can see it | A.0 asks that question first, before the costlier discovery interview | Live |
| RK4 | The task class `feature` is wrong, and the real work needed no plan at all | D5 declares the class an assumption; A.1's output re-decides it on evidence | Live |

**Detail**

- **RK1** → The hard pre-implement hook keys on the existence of `requirement.md`, `design.md` and
  `plan.md`. This run supplies one of the three. The gate still blocks, correctly, but for a
  reason unrelated to whether this plan's *content* means anything — nothing anywhere compares a
  plan's body against the inputs it claims to derive from.
- **RK2** → Mitigated only by disclosure and by task content: every `files:` value below is under
  `agent-docs/`, so an executor that ran this plan verbatim would produce documentation and no
  code. That is a containment property, not a guarantee.
- **RK3** → If "the design" lives in a ticket, a chat, or another repo, no output of
  `doflow paths` would reveal it, and the discovery interview would redo work that already exists.
  A.0 costs one question and can save the whole of A.1.
- **RK4** → `feature` was assumed. If `requirement.md` turns out to describe a bug fix or a
  dependency bump, the correct workflow has no `planning` stage at all and this plan should be
  discarded rather than refreshed. B.1 is the checkpoint where that becomes visible.

## 7. Validation Strategy

| Requirement | Verified by |
|---|---|
| The missing inputs are disclosed, not worked around | Title, header, §0 table, §1, §2 Result line |
| No feature content is fabricated | §4 rows are chain artifacts only; §5 is N/A; §8 tasks carry `[US-none]` and `agent-docs/` paths |
| A Constitution Check verdict exists for **tier-1** | §2 tier-1 subsection, P1–P6 each addressed individually |
| A Constitution Check verdict exists for **tier-2** | §2 tier-2 subsection, recorded absent via `has_constitution_local: false` |
| The artifact is machine-valid | `doflow validate agent-docs/doflow/bench-d3-do-plan-2/plan.md` (step 9) |
| Task-summary counts match the checklists | Same validator; `### Task Summary` rows vs `- [ ]` lines per `### Phase <X>` |
| The gap is actually closed | `doflow paths --json` after Phase A reports both `has_requirement` and `has_design` true |

## 8. Tasks

> Dependency-ordered. `[P]` = parallel-safe with its phase siblings. `[US#]` traces to a user story
> in `requirement.md`; **no user stories exist**, so every task carries `[US-none]` as an explicit
> record of the missing trace rather than a fabricated id. Depth: `normal`.

### Repo Branch Plan

N/A: single-repo feature. Every task's `files:` path walks up to the same `.git`
(`<repo>/.doflow/worktrees/bench-d3-do-plan-2`), and no task sets
`depends-on:`, so there is no second repo to reach. Derived branch name (derivation only; no branch
is created by this skill): `requirement.md` is absent so its `**Ticket:**` field cannot be read →
ticket absent → `feat/<slug>` → **`feat/bench-d3-do-plan-2`**. The checked-out branch is
`task/bench-d3-do-plan-2`, a bench sandbox branch, which is not what the derivation produces.

### Task Summary

| Phase | Tasks | Delivers | [P] |
|---|---|---|---|
| A | 3 | requirement.md and design.md, recovered in chain order | no |
| B | 2 | A feature plan derived from real inputs, replacing this one | no |

### Phase A — Recover the upstream artifacts

- [ ] A.0 [US-none] Ask whether "the design" already exists outside this repo (ticket, doc, sibling repo) and point /do-design at it if so — owner: spec-analyst; files: agent-docs/doflow/bench-d3-do-plan-2/requirement.md
- [ ] A.1 [US-none] Run /do-brainstorm to produce requirement.md with problem, user stories and FR/NFR, closing every [NEEDS CLARIFICATION] it raises [depends A.0] — owner: spec-analyst; files: agent-docs/doflow/bench-d3-do-plan-2/requirement.md
- [ ] A.2 [US-none] Run /do-design against that requirement to produce design.md with C1/C2 diagrams, components, data contracts and risks [depends A.1] — owner: system-architect; files: agent-docs/doflow/bench-d3-do-plan-2/design.md

### Phase B — Re-plan on real inputs

- [ ] B.1 [US-none] Re-run doflow paths --json, confirm has_requirement and has_design are true, and re-derive the task class from the recovered requirement rather than from D5's assumption [depends A.2] — owner: quality-guardian; files: agent-docs/doflow/bench-d3-do-plan-2/state.md
- [ ] B.2 [US-none] Re-run /do-plan --depth normal and supersede this document, moving its content to the new plan's §9 History [depends B.1] — owner: system-architect; files: agent-docs/doflow/bench-d3-do-plan-2/plan.md

### Checkpoints

- After Phase A: `doflow paths --json` shows both inputs present and `doflow validate` passes on each; commit `docs(doflow): recover requirement and design for bench-d3-do-plan-2`
- After Phase B: this gap plan is superseded; commit `docs(doflow): replace gap plan with a derived feature plan`

### Completion criteria

- [ ] All tasks checked
- [ ] Validation gates pass
- [ ] state.md updated
- [ ] The task class has been re-decided against a real `requirement.md`, replacing D5's assumption

## 9. History

None — initial version.
