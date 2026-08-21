# Implementation Plan: Freshness Wiring

**Feature:** 019-freshness-wiring · **Requirement:** ./requirement.md · **Design:** ./design.md · **Status:** Draft · **Created:** 2026-08-21

## 1. Approach

Memo first, then the call site. The memo is behaviour-preserving on its own and can be verified
against the existing freshness tests before anything changes what readiness does; wiring the call
first would mix a performance change into a behaviour change and make a regression ambiguous.

## 2. Constitution Check (GATE)

- [x] **P1 Safety** — no destructive path. The change makes a gate stricter, and explicitly never
      writes to the ledger (FR-002).
- [x] **P2 Evidence** — the disconnection was verified by reading, not inferred: `measureFreshness`
      returns `FRESH` unconditionally, `validateLedgerFreshness` has zero production callers.
- [x] **P3 Finish** — no stubs; each task ships with its tests.
- [x] **P4 Scope** — `invalidateFiles` and write-time persistence are named out of scope, not
      quietly included.
- [x] **P5 Parallel** — 2 of 4 tasks `[P]`; the two that are not name the dependency.
- [x] **P6 Honesty** — R1 states plainly that gates passing today will begin failing, which is the
      intended effect rather than a regression to be hidden.

**Result:** PASS. Tier-1 only; `has_constitution_local` is false.

## 3. Research & Decisions

- **D1:** Re-evaluate at read time, never persist — a stored verdict goes stale itself, and a read
  that writes is surprising. `handleReadinessCommand` mutates the in-memory ledger and never calls
  `save`.
- **D2:** Memoise on the recorded commit, not on the file — `checkEvidenceFreshness` calls
  `getModifiedFilesSince(recordedCommit)` per item, and a batch of evidence shares one commit, so
  the commit is the axis that collapses the work.
- **D3:** Report stale items separately from unresolvable ones — they are different failures. An
  unresolvable locator points at nothing; a stale one points at something that changed.

## 4. Components & Changes

| ID | Change | Files | Phase | Status |
|---|---|---|---|---|
| CH1 | Per-commit memo in the validator | `src/runtime/freshness.js` | A | Live |
| CH2 | Re-validation before evaluation | `src/runtime/cli.js` | B | Live |
| CH3 | Stale items in the verdict | `src/runtime/readiness.js` | B | Live |
| CH4 | Tests for both halves | `test/runtime/runtime-readiness.test.js` | B | Live |

**Detail**

- **CH1** → A `Map` on the instance from commit sha to modified-file `Set`; `getModifiedFilesSince`
  consults it before shelling out. Same return, same signature.
- **CH2** → One `validateLedgerFreshness(ledger)` call between load and evaluate, and no `save`.
- **CH3** → `staleEvidence[]` on the report, mirroring `unresolvableEvidence[]`, appended to the
  summary so it cannot be overwritten by the base verdict.
- **CH4** → A moved file makes a gate not-ready and names the item; the ledger file is byte
  identical afterwards; one commit means one diff.

## 5. Data / Contracts

No stored shape changes. `staleEvidence` is added to the readiness report only.

## 6. Risks & Mitigations

| ID | Risk | Mitigation | Status |
|---|---|---|---|
| RK1 | Existing readiness fixtures start failing | Their locators name real files; a fixture that goes stale is the feature working, and is updated rather than the check relaxed | Live |
| RK2 | Repeated git work per gate call | D2's memo; verified by counting invocations through an injected runner | Live |

**Detail**

- **RK1** → `runtime-readiness.test.js` already names real repository files after an earlier fix. A
  test that now reports stale is telling the truth about a modified working tree.
- **RK2** → The freshness tests already inject a `gitRunner`, so the call count is directly
  observable rather than inferred from timing.

## 7. Validation Strategy

| Requirement | Verified by |
|---|---|
| FR-001 | `runtime-readiness.test.js` — a modified file makes the gate not-ready |
| FR-002 | the ledger file's bytes are compared before and after |
| FR-003 | injected `gitRunner` call count with several items on one commit |
| FR-004 | the report names the stale item by id |
| NFR-002 | a pre-feature ledger fixture loads and evaluates |
| NFR-003 | `npm test` |

## 8. Tasks

### Repo Branch Plan

N/A: single-repo feature. Branch `feat/019-freshness-wiring`, already checked out.

### Task Summary

| Phase | Tasks | Delivers | [P] |
|---|---|---|---|
| A | 2 | The memo, verified alone | yes |
| B | 2 | The wiring and its report | no |

### Phase A — Memo

- [ ] A.1 [P] [US2] Memoise the per-commit diff in FreshnessValidator — owner: core-implementer; files: src/runtime/freshness.js
- [ ] A.2 [P] [US2] Assert the git call count collapses for items sharing a commit — owner: quality-guardian; files: test/runtime/runtime-readiness.test.js

### Phase B — Wiring

- [ ] B.1 [US1] Re-validate freshness in handleReadinessCommand without saving (depends A.1) — owner: core-implementer; files: src/runtime/cli.js
- [ ] B.2 [US1] Report stale items in the verdict and cover the behaviour (depends B.1) — owner: core-implementer; files: src/runtime/readiness.js, test/runtime/runtime-readiness.test.js

### Checkpoints

- After Phase A: `node --test test/runtime/runtime-readiness.test.js`
- After Phase B: `npm test` and `bash test/doflow-chain-test.sh`

### Completion criteria

- [ ] All tasks checked
- [ ] Validation gates pass
- [ ] state.md updated

## 9. History

None — initial version.
