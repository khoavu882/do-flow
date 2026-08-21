# Implementation Plan: Gap recovery — no requirement and no design exist for `bench-d3-do-plan-3`

**Feature:** bench-d3-do-plan-3 · **Requirement:** ./requirement.md — **does not exist** · **Design:** ./design.md — **does not exist** · **Status:** Draft · **Created:** 2026-08-18

> HOW. There is no WHAT and no system shape upstream of this plan. `doflow paths --json` on branch
> `task/bench-d3-do-plan-3` reports `has_requirement: false`, `has_design: false`,
> `has_plan: false`, `candidate_slugs: []`. The tasks in §8 are therefore scoped to recovering
> those inputs. They are written in the exact marker syntax `/do-execute-plan` parses, because a
> plan whose checklist does not parse is worse than no plan at all — the executor would see an
> empty phase rather than an error.

## 0. Input State

| Input | Resolver field | Present? | Path |
|---|---|---|---|
| requirement.md | `has_requirement` | **no** | `agent-docs/doflow/bench-d3-do-plan-3/requirement.md` |
| design.md | `has_design` | **no** | `agent-docs/doflow/bench-d3-do-plan-3/design.md` |
| Constitution tier-1 | `constitution_base` | yes | `.doflow/guidance/references/CONSTITUTION_BASE.md` v1.0.0 |
| Constitution tier-2 | `has_constitution_local` | **no** | `agent-docs/constitution.md` |

No feature name, user story, component, interface or ticket is available from any source here, so
none is asserted below. §8 recovers the gap; it does not implement anything.

## 1. Approach

Run the chain's missing stages in order — `/do-brainstorm` for `requirement.md`, `/do-design` for
`design.md` — record the gap in `state.md` while that happens, then re-run `/do-plan` so the real
feature plan supersedes this one. Nothing under `src/` is touched by any task here.

Task class **feature**, validated by `doflow classify --task-class feature --json` →
`outcome: ACCEPTED`, workflow "Feature Delivery"
(discovery → design → planning → implementation → verification → review), gates gate-0, gate-a,
gate-b. This skill is that workflow's `planning` stage (`readinessTemplate: null`); the
implementation stage's template is `feature`. Signal the class rests on: declared in §3 D4 as an
assumption rather than a derivation, because the artifacts step 2 says to derive it from are the
very ones that are missing.

Depth: no `--depth` was passed, so `normal` (the skill's stated default) applies — one task per
recovered artifact, files and owner named, no per-section sub-tasking.

## 2. Constitution Check (GATE)

> Evaluated against both tiers. **Tier-1**: `CONSTITUTION_BASE.md` v1.0.0, P1–P6, read this run.
> **Tier-2**: `agent-docs/constitution.md`, reported absent by `has_constitution_local: false`
> (the resolver flag, not a filesystem check of my own) — so nothing overlays tier-1 and nothing
> takes precedence over it. Advisory verdict, per that file's Governance section.

- [x] **P1 Safety over speed** — no destructive or irreversible action; one Markdown file written,
      no branch, no commit, no source edit.
- [x] **P2 Evidence over assumptions** — the "no upstream artifacts" finding is quoted from
      `doflow paths --json`, and the marker-syntax claim in §7 is checked by running the runtime's
      own parser rather than asserted.
- [x] **P3 Finish what you start** — every task names an output file and a completion signal; no
      stub, no TODO.
- [x] **P4 Scope discipline (YAGNI)** — no feature is invented to fill the template. §5 is `N/A`,
      §8 traces are `[US-none]`, and every `files:` value is under `agent-docs/`.
- [x] **P5 Parallel by default** — A.1 and A.2 write disjoint files with no dependency between
      them and are marked `[P]`. A.0, A.3, B.1 and B.2 are unmarked and each owes a reason,
      given inline in §8.
- [x] **P6 Professional honesty** — the missing inputs lead the title and are repeated in the
      header, §0 and §3 D1; no metric, score or confidence appears anywhere in this document.
- [x] **Tier-2** — absent; no additional or overriding principle exists to check against.

**Result:** **PASS** — tier-1 PASS on P1–P6; tier-2 absent and recorded as such. No violation
arose, so step 6's STOP-and-revise did not trigger. This verdict is for a gap-recovery plan; the
same document presented as a feature's implementation plan would FAIL P2 and P4.

## 3. Research & Decisions

- **D1:** No feature is invented — resolves "what is being planned?"; rationale:
  `doflow paths --json` returns `has_requirement: false`, `has_design: false`,
  `candidate_slugs: []`.
- **D2:** Emit a real, parseable checklist anyway rather than prose — resolves "should §8 be
  skipped when there is nothing to implement?"; rationale: `SKILL.md` step 7 calls the `- [ ]`
  checkboxes the execution contract and says not to reflow them into prose. A gap plan that
  dropped the markers would hand `/do-execute-plan` an unparseable file.
- **D3:** Recovery via `/do-brainstorm` then `/do-design` — resolves "can do-plan backfill?";
  rationale: `SKILL.md` **Will Not** — "write `design.md` (that's `/do-design`)".
- **D4 (declared assumption):** Task class `feature`, chosen from the invocation's shape because
  the artifacts step 2 says to derive it from are absent and no user was available to settle it.
- **D5:** Marker syntax verified empirically — resolves "do these markers actually parse?";
  rationale: `doflow task-brief` and `doflow parallel-check` are the runtime's own readers of this
  file; both were run against it and their output is recorded in §7.

## 4. Components & Changes

| ID | Change | Files | Phase | Status |
|---|---|---|---|---|
| CH1 | Create `requirement.md` through the discovery stage | `agent-docs/doflow/bench-d3-do-plan-3/requirement.md` | A | Live |
| CH2 | Create `design.md` from that requirement | `agent-docs/doflow/bench-d3-do-plan-3/design.md` | A | Live |
| CH3 | Record the gap and the recovery decision in `state.md` | `agent-docs/doflow/bench-d3-do-plan-3/state.md` | A | Live |
| CH4 | Supersede this gap plan with a plan derived from real inputs | `agent-docs/doflow/bench-d3-do-plan-3/plan.md` | B | Live |

**Detail**

- **CH1** → `/do-brainstorm` elicits problem, user stories and FR/NFR and writes `requirement.md`.
  Until it exists, `[US#]` traces have no target, which is why §8 uses `[US-none]`.
- **CH2** → `/do-design` reads that requirement and writes `design.md` — C1/C2 diagrams,
  components and boundaries, data contracts, risks. This is the artifact whose absence makes the
  bare `/do-plan` invocation unanswerable as posed.
- **CH3** → `state.md` records what was true at this run: both inputs missing, a gap plan written,
  recovery chosen. This is knowable now and does not wait on CH1, which is what makes it
  parallel-safe with it.
- **CH4** → Re-running `/do-plan` with real inputs yields §4 rows naming source files and §8 tasks
  under `src/`. This document's content then moves to that plan's §9 History.

## 5. Data / Contracts

N/A — no schema, API or interface is defined or changed. Every task writes Markdown under
`agent-docs/doflow/bench-d3-do-plan-3/`. The contracts this document is itself bound by:
`references/ARTIFACT_FORMAT.md` for §4/§6 index-then-detail and the closed `Status` vocabulary,
and the `- [ ]` / `[P]` / `[US#]` / `owner:` / `files:` marker grammar in §8 that
`/do-execute-plan` parses.

## 6. Risks & Mitigations

| ID | Risk | Mitigation | Status |
|---|---|---|---|
| RK1 | The file's existence makes the chain look further along than it is | Absence stated in title, header, §0, §3 D1; all `files:` under `agent-docs/` | Live |
| RK2 | The checklist parses but describes no product work | Deliberate: parseable-and-honest beats unparseable; §7 records what the parsers returned | Live |
| RK3 | The assumed task class is wrong for whatever the work turns out to be | D4 declares it an assumption; B.1 re-decides it against the recovered requirement | Live |

**Detail**

- **RK1** → `/do-execute-plan`'s hard prerequisite is the existence of all three chain artifacts.
  Writing this file supplies one of three, so the gate still blocks — correctly, but for a reason
  unrelated to whether this plan's body means anything. No check anywhere compares a plan's
  content against the inputs it claims to derive from.
- **RK2** → An executor handed this plan would produce documentation, not code, and would produce
  it correctly. The alternative — omitting §8 so nothing could be executed — would make the file
  parse as a plan with zero tasks, which is indistinguishable from a plan whose tasks were lost.
- **RK3** → If the recovered `requirement.md` describes a bug fix or a dependency bump, the right
  workflow has no `planning` stage and this plan should be discarded rather than refreshed. B.1 is
  where that becomes visible, before any implementation effort is spent.

## 7. Validation Strategy

| Requirement | Verified by |
|---|---|
| Missing inputs are disclosed rather than filled in | Title, header, §0 table, §3 D1 |
| No feature content is fabricated | §4 rows are chain artifacts; §5 is N/A; §8 traces are `[US-none]` |
| Constitution verdict recorded against both tiers | §2 — P1–P6 individually plus an explicit tier-2 absent line |
| Artifact structure is machine-valid | `doflow validate agent-docs/doflow/bench-d3-do-plan-3/plan.md` |
| `### Task Summary` counts match the checklists | Same validator, per phase |
| **Task markers actually parse** | `doflow task-brief` and `doflow parallel-check` run against this file; results recorded in §9 of this run's transcript |
| The gap is closed | `doflow paths --json` after Phase A reports both inputs true |

## 8. Tasks

> Dependency-ordered. `[P]` = parallel-safe with its phase siblings, which requires disjoint
> `files:` sets. `[US#]` traces to a user story in `requirement.md`; none exists, so `[US-none]`
> records the missing trace instead of fabricating an id. The `- [ ]` markers are the execution
> contract — kept verbatim in the template's grammar. Depth: `normal` (default; no flag passed).

### Repo Branch Plan

N/A: single-repo feature. Every `files:` path below walks up to the same enclosing `.git` at
`<repo>/.doflow/worktrees/bench-d3-do-plan-3`, and no task sets
`depends-on:`, so no second repo is reachable. Derived branch (derivation only — no branch is
created by this skill): `requirement.md` is absent so no `**Ticket:**` can be read → ticket
treated as absent → `feat/<slug>` → **`feat/bench-d3-do-plan-3`**.

### Task Summary

| Phase | Tasks | Delivers | [P] |
|---|---|---|---|
| A | 4 | requirement.md, design.md and a state.md record of the gap | yes |
| B | 2 | A feature plan derived from real inputs, superseding this one | no |

### Phase A — Recover the upstream artifacts

- [ ] A.0 [US-none] Confirm whether a design already exists outside this repo (ticket, doc, sibling repo) before running discovery — owner: spec-analyst; files: agent-docs/doflow/bench-d3-do-plan-3/state.md
- [ ] A.1 [P] [US-none] Run /do-brainstorm to produce requirement.md with problem, user stories and FR/NFR, closing every [NEEDS CLARIFICATION] it raises — owner: spec-analyst; files: agent-docs/doflow/bench-d3-do-plan-3/requirement.md
- [ ] A.2 [P] [US-none] Record in state.md that both upstream artifacts were missing at this run and that gap recovery was chosen — owner: research-writer; files: agent-docs/doflow/bench-d3-do-plan-3/state.md
- [ ] A.3 [US-none] Run /do-design against the recovered requirement to produce design.md with C1/C2 diagrams, components, data contracts and risks, depends A.1 — owner: system-architect; files: agent-docs/doflow/bench-d3-do-plan-3/design.md

### Phase B — Re-plan on real inputs

- [ ] B.1 [US-none] Re-run doflow paths --json, confirm has_requirement and has_design are both true, and re-decide the task class against the recovered requirement rather than D4's assumption, depends A.3 — owner: quality-guardian; files: agent-docs/doflow/bench-d3-do-plan-3/state.md
- [ ] B.2 [US-none] Re-run /do-plan and supersede this document, moving its content to the new plan's section 9 History, depends B.1 — owner: system-architect; files: agent-docs/doflow/bench-d3-do-plan-3/plan.md

> Why A.0, A.3, B.1 and B.2 are unmarked: A.0 gates the whole phase (its answer can cancel A.1);
> A.3 reads the file A.1 writes; B.1 depends on A.3's output existing; B.2 rewrites the plan B.1
> validated. A.0 and A.2 both name `state.md`, so A.0 is additionally not parallel-safe with A.2
> on write-set grounds.

### Checkpoints

- After Phase A: `doflow paths --json` reports both inputs present and `doflow validate` passes on each; commit `docs(doflow): recover requirement and design for bench-d3-do-plan-3`
- After Phase B: this gap plan is superseded; commit `docs(doflow): replace gap plan with a derived feature plan`

### Completion criteria

- [ ] All tasks checked
- [ ] Validation gates pass
- [ ] state.md updated
- [ ] The task class has been re-decided against a real requirement.md

## 9. History

None — initial version.
