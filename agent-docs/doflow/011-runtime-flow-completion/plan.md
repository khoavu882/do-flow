# Implementation Plan: Runtime Flow Completion

**Feature:** 011-runtime-flow-completion · **Requirement:** ./requirement.md · **Design:** ./design.md · **Status:** Draft · **Created:** 2026-08-19

> HOW. Reads ./requirement.md and ./design.md. Resolve every `[NEEDS CLARIFICATION]` from the
> requirement here.
>
> Structure follows `references/ARTIFACT_FORMAT.md`: indexed sections carry a table above full
> `**Detail**`, `Status` is only `Live` or `Superseded → <ref>`, and superseded prose moves to §9.

## 1. Approach

Three phases ordered by what each depends on, not by conceptual grouping. Phase A wires primitives
that already exist into the skills that should call them — every task edits a different skill file,
so the whole phase runs in parallel. Phase B builds the two new runtime modules; each verb's module,
its dispatcher registration and its documentation land as a single task, because the guards treat
those as one namespace and a partial edit fails the suite. Phase C adds the guard that prevents the
wiring gap recurring, and it must land last: a guard asserting every verb has a caller cannot pass
until every caller from Phases A and B exists.

The key technical decision is that nothing in this plan changes routing. Freshness is recorded and
reported but never consulted when resolving a provider, which is what keeps FR-013 additive rather
than a violation of FR-009's freeze.

## 2. Constitution Check (GATE)

> Verify against both constitution tiers, tier-2 taking precedence. `has_constitution_local` is
> false for this repo, so tier-1 applies alone and there is nothing to reconcile.

- [x] Complies with **P1 (Safety over speed)**: the only behavioural change to existing flows is a
      gate that *refuses* an edit (FR-001). No destructive or irreversible operation is added, and
      FR-012 explicitly freezes the existing hook rather than loosening it.
- [x] Complies with **P2 (Evidence over assumptions)**: every decision in §3 carries a locator; the
      two new state tokens were verified to exist in the runtime before being adopted rather than
      assumed available.
- [x] Complies with **P3 (Finish what you start)**: no task registers a verb whose module is absent.
      Each Phase B task delivers module, registration and documentation together, so no intermediate
      state ships a dispatchable verb that answers with "not implemented".
- [x] Complies with **P4 (Scope discipline)**: retrieval fusion, freshness-gated routing, the
      `capabilities --check` reporting defect and ledger standardization are all named in
      `requirement.md` §5 as out of scope. No speculative abstraction: `providers{}` holds only what
      the report needs to state a remedy.
- [x] Complies with **P5 (Parallel by default)**: Phase A is fully `[P]` across five disjoint skill
      files. Phase B is sequential and owes the reason — its two tasks share four files (D3).
- [x] No violation of **P6 (Professional honesty)**: design risk R9 records a silent failure mode
      rather than presenting freshness coverage as complete, and no task claims a metric.

**Result:** PASS — one qualification worth stating plainly rather than resolving silently. P4 is
satisfied against the requirement as written, but that requirement grew twice during discovery, and
`RetrievalPlan`/`TaskOutcome` remain the only components with no surviving prior-art support
(design R3). This is recorded, not treated as a violation: scope was set deliberately by the user
after the cost was flagged.

## 3. Research & Decisions

- **D1:** Reuse `UNVERIFIED` and `NOT_APPLICABLE` rather than inventing state names — resolves the
  fourth-result-state naming question; rationale: both tokens already exist and carry the intended
  meaning (`src/runtime/health.js:32`, `src/runtime/trace-views.js:256`), so inventing a third
  spelling for a concept the runtime already names twice would create exactly the drift G15 exists
  to prevent.
- **D2:** Probe freshness once per distinct provider at declare time and cache it on the plan record
  — resolves the probe-timing question; rationale: `probeFreshness` calls `newestSourceMtime`, which
  walks the project tree to a `SCAN_FILE_LIMIT` of 4000 (`src/runtime/health.js:71`), so per-need
  probing would pay one full scan per need for answers that are identical per provider.
- **D3:** Bundle each new verb's module, dispatcher registration and documentation into one task —
  resolves how to satisfy design R2 without violating P3; rationale: G12 asserts every Node verb has
  a CLI command and vice versa, while G6/G8/G10 read `docs/reference.md` and `docs/flags.md` as
  inventories (`core/shared/scripts/doflow/bin/doflow-run:346`). Splitting the namespace edit from
  the implementation leaves the suite red between tasks; splitting the implementation from the
  registration ships a stub. Bundling satisfies both, at the cost of making the two Phase B tasks
  non-parallel.
- **D4:** Phase A runs fully parallel, Phase B strictly sequential — resolves the phase-parallelism
  question; rationale: Phase A's five tasks edit five disjoint `SKILL.md` files, while Phase B's two
  tasks both write `doflow-run`, `src/runtime/cli.js`, `docs/reference.md` and `docs/flags.md`.
  Per `ARTIFACT_FORMAT` the comparison is over actual `files:` sets, not descriptions, and these
  overlap on four paths.
- **D5:** The verb-caller guard lands after every caller exists — resolves guard ordering; rationale:
  the guard asserts each dispatcher verb has at least one skill caller, and `context-pack`,
  `discover`, `retrieval-plan` and `outcome` acquire theirs in Phases A and B. Introducing it first
  would require allowlisting the very verbs this feature exists to wire, then unlisting them.
- **D6:** The standalone exemption is keyed on the absence of an evidence record for the task id —
  resolves FR-002's trigger; rationale: it is directly observable at
  `.doflow/state/evidence/<taskId>.json` (`src/runtime/evidence-ledger.js:46`), needs no new state,
  and matches the assumption already recorded as A3 in `requirement.md`.
- **D7:** Freshness is stored once per provider on the plan and referenced by each need, never copied
  onto the need — resolves the record shape; rationale: a copied state would let two needs resolving
  to the same provider disagree about that provider's index, which is a contradiction the record
  should be unable to represent.

## 4. Components & Changes

| ID | Change | Files | Phase | Status |
|---|---|---|---|---|
| CH1 | `do-implement` gains readiness gate, exemption and context pack | `core/shared/skills/do-implement/SKILL.md` | A | Live |
| CH2 | ContextPack consumed by the three remaining evidence-acting stages | `core/shared/skills/do-design/SKILL.md`, `do-plan/SKILL.md`, `do-execute-plan/SKILL.md` | A | Live |
| CH3 | `do-code-review` records evidence and claims | `core/shared/skills/do-code-review/SKILL.md` | A | Live |
| CH4 | `do-document` records evidence and claims | `core/shared/skills/do-document/SKILL.md` | A | Live |
| CH5 | `do` reads recorded-run observability | `core/shared/skills/do/SKILL.md` | A | Live |
| CH6 | `retrieval-plan` module, verb and documentation | `src/runtime/retrieval-plan.js`, `src/runtime/cli.js`, `bin/doflow.js`, `core/shared/scripts/doflow/bin/doflow-run`, `docs/reference.md`, `docs/flags.md` | B | Live |
| CH7 | `outcome` module, verb and documentation | `src/runtime/outcome.js`, `src/runtime/cli.js`, `bin/doflow.js`, `core/shared/scripts/doflow/bin/doflow-run`, `docs/reference.md`, `docs/flags.md` | B | Live |
| CH8 | Verb-caller reachability guard | `test/guards/verb-reachability.test.js` | C | Live |
| CH9 | Frozen-behaviour regression assertions | `test/guards/frozen-behaviour.test.js` | C | Live |

**Detail**

- **CH1** → `do-implement` resolves its task class, evaluates readiness before any edit, and refuses
  to proceed on `BLOCKED`, naming the unmet requirement. When no evidence record exists for the task
  id it takes the documented exemption and reports the skip as prominently as a block would be
  reported. It also compiles a context pack when one is available, handling the empty-pack exit
  itself. It gains no behaviour that duplicates the pre-implement-gate hook.
- **CH2** → `do-design`, `do-plan` and `do-execute-plan` each obtain prior context by compiling the
  recorded evidence and claims for the task rather than re-reading artifacts. Each call site states
  its own handling of the empty-pack failure; none may treat a non-zero exit as success.
- **CH3** → `do-code-review` gains the stage-boundary evidence batch and claim recording. Findings
  read from code are `extracted` with locators; judgements are `inferred` with content. It gains no
  gate and no authority to block.
- **CH4** → `do-document` gains the same, recording the factual basis for what it writes. This is the
  safeguard its workflow class already names: the characteristic failure of documentation work is
  asserting something nobody checked.
- **CH5** → `do` reads recorded-run observability and surfaces missed capability opportunities where
  routing decisions are made. An analysis that cannot be settled from recorded metadata continues to
  surface as undetermined rather than clear.
- **CH6** → New module implementing declare and report actions, the four-state result vocabulary, the
  per-provider freshness cache and the freshness-to-result mapping. Registered in `is_node_verb()`
  and the dispatcher help text, given a CLI command, and documented in both inventories — all in one
  task per D3.
- **CH7** → New module implementing record and show actions over the closed outcome vocabulary,
  reading readiness state, verification verdict and evidence count as its basis, and learning the
  terminal stage from the workflow engine. Registered and documented in the same single-task shape.
- **CH8** → New guard asserting every verb the dispatcher exposes is invoked by at least one skill,
  or appears in an allowlist carrying a per-entry reason. Static scanning only, in the same shape as
  G16 — no execution of the code under audit.
- **CH9** → Assertions pinning the two behaviours this feature promises *not* to change: the set of
  skills resolving needs through the capability router (FR-009), and the pre-implement-gate hook's
  behaviour (FR-012). Without these, "we did not change it" rests on nobody having noticed.

## 5. Data / Contracts

Two new per-task records under the invoking project's state root, specified in `design.md` §5:
`.doflow/state/retrieval/<taskId>.json` and `.doflow/state/outcome/<taskId>.json`. Both reuse the
existing safe-task-id constraint so a task id can never name a path, and both stamp their own
timestamps rather than accepting them from the caller.

CLI contracts for `retrieval-plan` and `outcome` are fixed in `design.md` §4, including the
freshness-to-result mapping table. No existing verb's flags change; `context-pack`'s empty-pack exit
contract is explicitly preserved (FR-004).

## 6. Risks & Mitigations

| ID | Risk | Mitigation | Status |
|---|---|---|---|
| RK1 | Phase B's two tasks conflict on four shared files | Sequential ordering, B.2 depends on B.1 | Live |
| RK2 | Phase A's five parallel tasks each add a runtime call with no integration test | Phase A checkpoint runs the full suite before Phase B starts | Live |
| RK3 | The new guard fails on verbs this feature does not wire | Allowlist with a stated reason per entry | Live |
| RK4 | A Phase A skill edit silently swallows the empty-pack exit | Each call site must state its handling; reviewed at the Phase A checkpoint | Live |
| RK5 | Freshness probing slows every retrieval-declaring stage | Probe once per provider per plan (D2); no probe at all when no plan is declared | Live |

**Detail**

- **RK1** → `CH6` and `CH7` both write `src/runtime/cli.js`, `doflow-run`, `docs/reference.md` and
  `docs/flags.md`. Run in parallel they would conflict on every one of those. Mitigated by ordering
  rather than by splitting, because splitting is what D3 rejected. The cost is that Phase B has no
  parallelism available to it at all.
- **RK2** → Five skills each gain a runtime call in parallel, and nothing in Phase A exercises those
  calls end to end. The mitigation is a checkpoint, not a test: the full suite runs before Phase B
  begins, so a skill edit that breaks a guard is caught at the phase boundary rather than after two
  more phases of work.
- **RK3** → The guard asserts a caller for every dispatcher verb, including any this feature does not
  touch. If such a verb exists, the guard fails on introduction. Mitigated by the allowlist — but the
  mitigation is only honest if each entry states *why* that verb has no caller, which is what stops
  the allowlist becoming a place to hide the problem this guard exists to surface.
- **RK4** → `context-pack` exits 1 on an empty pack, and a skill that ignores the exit code reads
  that failure as success. This is the most likely defect in Phase A because it is invisible: nothing
  fails, the stage simply proceeds with no prior context. Mitigated only by review, which is weaker
  than a test — noted as such rather than presented as covered.
- **RK5** → Every stage declaring a retrieval plan pays at least one 4000-file scan per distinct
  provider. Mitigated by caching per plan (D2). Not mitigated: a stage declaring a plan in a very
  large repository still pays that scan, and no budget or timeout is specified for it.

## 7. Validation Strategy

| Requirement | Verified by |
|---|---|
| FR-001 | A `bug`-class task with a `BLOCKED` readiness state cannot edit source through `do-implement` |
| FR-002 | A standalone invocation with no evidence record completes, and its report names the skipped gate |
| FR-003 | Each of the four stages issues a context-pack call; asserted by the CH8 guard's caller scan |
| FR-004 | `context-pack`'s exit-1-on-empty behaviour is unchanged; each new call site states its handling |
| FR-005, FR-006 | A review run and a document run each leave evidence and claims on the task record |
| FR-007 | `do` reads observability; asserted by the CH8 guard's caller scan |
| FR-008 | Removing the last caller of any verb fails the guard, and the failure names that verb |
| FR-009 | CH9 pins the set of router-resolving skills; a change to it fails the suite |
| FR-010, FR-014, FR-015 | Report emits every declared item; an unlocatable index yields `UNVERIFIED`, a verified provider returning nothing yields `EMPTY` |
| FR-011 | A completed task records a terminal state from the closed vocabulary with its basis |
| FR-012 | CH9 pins the pre-implement-gate hook's behaviour |
| FR-013 | A declared need records its provider's freshness, and that state does not alter provider resolution |
| NFR-001 | No new state is a number; score-shaped flags stay refused by name |
| NFR-002 | `npm test` green; `doflow doctor` reports all seven adapters PASS |
| NFR-003 | `test/guards/evals.test.js` continues to assert the default command's scoping |
| NFR-004 | The FR-002 and FR-015 checks above both assert the skip/unverified case is reported, not silent |

## 8. Tasks

> Dependency-ordered. `[P]` = parallel-safe with its phase siblings — siblings marked `[P]` must
> write disjoint `files:`. `[US#]` traces to a user story in requirement.md. The `- [ ]` checkboxes
> are the execution contract parsed by `/do-execute-plan`.

### Repo Branch Plan

N/A: single-repo feature. Every task's `files:` path resolves to the same enclosing `.git`, and no
task declares a `depends-on:`. Derived branch from `**Ticket:** none` plus the feature slug:
`feat/011-runtime-flow-completion`, which is already checked out.

### Task Summary

| Phase | Tasks | Delivers | [P] |
|---|---|---|---|
| A | 5 | Existing primitives wired into the skills that should call them | yes |
| B | 2 | The two absent flow nodes, each registered and documented | no |
| C | 2 | Enforcement against recurrence, and pins on what must not change | yes |

### Phase A — Wire what already exists

- [x] A.1 [P] [US1] [US3] Add readiness evaluation, the standalone exemption and context-pack compilation to do-implement — owner: core-implementer; files: core/shared/skills/do-implement/SKILL.md
- [x] A.2 [P] [US3] Add context-pack compilation to do-design, do-plan and do-execute-plan, each stating its empty-pack handling — owner: core-implementer; files: core/shared/skills/do-design/SKILL.md, core/shared/skills/do-plan/SKILL.md, core/shared/skills/do-execute-plan/SKILL.md
- [x] A.3 [P] [US3] Add stage-boundary evidence and claim recording to do-code-review — owner: core-implementer; files: core/shared/skills/do-code-review/SKILL.md
- [x] A.4 [P] [US3] Add stage-boundary evidence and claim recording to do-document — owner: core-implementer; files: core/shared/skills/do-document/SKILL.md
- [x] A.5 [P] [US4] Add a recorded-run observability read to the do dispatcher — owner: core-implementer; files: core/shared/skills/do/SKILL.md

### Phase B — Build the absent flow nodes

- [x] B.1 [US5] [US6] Implement retrieval-plan with the four-state vocabulary, per-provider freshness cache and freshness-to-result mapping; register the verb and document it — owner: core-implementer; files: src/runtime/retrieval-plan.js, src/runtime/cli.js, bin/doflow.js, core/shared/scripts/doflow/bin/doflow-run, docs/reference.md, docs/flags.md
- [x] B.2 [US5] Implement outcome over the closed terminal vocabulary reading readiness, verification and the terminal stage; register the verb and document it, after B.1 — owner: core-implementer; files: src/runtime/outcome.js, src/runtime/cli.js, bin/doflow.js, core/shared/scripts/doflow/bin/doflow-run, docs/reference.md, docs/flags.md

### Phase C — Prevent recurrence

- [x] C.1 [P] [US2] Add the verb-caller reachability guard with a reasoned allowlist, in the static-scanning shape of G16 — owner: quality-guardian; files: test/guards/verb-reachability.test.js
- [x] C.2 [P] [US1] Add regression assertions pinning the router-resolving skill set and the pre-implement-gate hook's behaviour — owner: quality-guardian; files: test/guards/frozen-behaviour.test.js

### Checkpoints

- After Phase A: run `npm test` and confirm every guard is green with five new call sites present;
  review each new context-pack call site for explicit empty-pack handling (RK4); commit
  `feat(skills): wire readiness, context pack, evidence and observability into their stages`
- After Phase B: run `npm test`, then `doflow retrieval-plan --help` and `doflow outcome --help` to
  confirm both verbs dispatch and answer; commit `feat(runtime): add retrieval-plan and outcome verbs`
- After Phase C: run `npm test`; deliberately remove one verb's last caller and confirm the guard
  fails naming that verb, then restore it; commit `test(guards): assert every dispatcher verb has a caller`

### Completion criteria

- [x] All tasks checked
- [x] Validation gates pass
- [x] state.md updated

## 9. History

None — no plan item has been superseded.

Corrected on 2026-08-19 during execution: CH6 and CH7, and their B.1/B.2 task lines, omitted
`bin/doflow.js` from their `files:` sets. G12 asserts at `test/guards/runtime-unification.test.js:282`
that every verb the dispatcher advertises on its Node arm has a CLI command, and that command is
dispatched from `bin/doflow.js` — so the file was always required and the omission would have made
either task fail the guard. Recorded rather than silently fixed because the `files:` sets are what
`parallel-check` reads to decide write-set isolation; an inaccurate set is a correctness problem for
dispatch, not a documentation nit.
