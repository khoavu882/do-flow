# Implementation Plan: `--since <date>` window for the run ledger

**Feature:** bench-d3-do-flow-2 · **Requirement:** ./requirement.md · **Design:** ./design.md · **Status:** Draft · **Created:** 2026-08-18

## 1. Approach

Add `since` to `RunLedger.read()` in `src/runtime/trace.js` as a second expression of the cutoff it
already computes, validate it there, and pass `--since` through from `bin/doflow.js` without
interpreting it. `ledgerSummary` gains `windowSince` additively so `trace --json` stays
backward-compatible. Tests go in the existing runtime trace test file; docs are updated in the two
places G8/G10 cross-check.

## 2. Constitution Check (GATE)

Verified against the tier-1 base at `.doflow/guidance/references/CONSTITUTION_BASE.md`. No
`agent-docs/constitution.md` exists in this repo (`has_constitution_local: false` from
`paths --json`), so tier-1 is the whole check and there is nothing to reconcile.

- [x] Complies with P1 (Safety over speed): invalid input is rejected rather than silently widened
      to the whole ledger — an empty window can no longer be read as "nothing happened".
- [x] Complies with P2 (Evidence over assumptions): the applied window is stated in output, so the
      reader is not left inferring which of two flags won.
- [x] Complies with P4 (Scope discipline): `--until`, ranges, and `stats`/`discover` are excluded;
      one flag on one command.
- [x] No violation of P3 (Finish what you start): docs and the flag index are in the task list, not
      deferred — an undocumented flag is a half-shipped one in this repo, where G8/G10 fail on it.
- [x] No violation of P6 (Professional honesty): no claim of coverage beyond the four acceptance
      criteria.

**Result:** PASS — no revision needed.

## 3. Research & Decisions

- **D1:** `since` is validated inside `read()`, not in the CLI parser — rationale: `read()` already
  owns the cutoff rule for `--days`, and splitting validation from the rule is how the two drift.
- **D2:** Both cutoffs are floored to local start-of-day before comparison — rationale: the design's
  named risk; the existing `--days` cutoff is millisecond-precise and would otherwise win a
  same-day comparison against a date boundary for part of every day.

## 4. Components & Changes

| ID | Change | Files | Phase | Status |
|---|---|---|---|---|
| CH1 | `read()` accepts and validates `since`, resolves one cutoff | src/runtime/trace.js | A | Live |
| CH2 | `ledgerSummary` emits `windowSince`; trace output states the applied window | src/runtime/trace.js | A | Live |
| CH3 | `--since` parsed and threaded to the trace case | bin/doflow.js | A | Live |
| CH4 | Tests for FR-001/002/003 and NFR-001 | test/runtime/trace.test.js | B | Live |
| CH5 | Flag documented in the help text and both doc indexes | bin/doflow.js, docs/reference.md, docs/flags.md | B | Live |

**Detail**

- **CH1** → `read({ days = null, since = null })`; reject a non-`YYYY-MM-DD` string or a future date
  with a named error; compute the narrower of the two cutoffs.
- **CH2** → additive field only; `windowDays` keeps its current meaning and nullability.
- **CH3** → parser change only, no date semantics; `--since` joins `--days` on the trace case.
- **CH4** → one test per acceptance criterion, plus one asserting `windowDays` still appears.
- **CH5** → `--days` is documented in `bin/doflow.js`'s help block; `--since` goes beside it.

## 5. Data / Contracts

Per design §4. No persisted shape changes.

## 6. Risks & Mitigations

| ID | Risk | Mitigation | Status |
|---|---|---|---|
| RK1 | Local/UTC boundary makes the cutoff off by one day | D2: floor both to local start-of-day; test at a boundary date | Live |
| RK2 | A doc index goes stale and G8/G10 fail | CH5 updates both indexes in the same phase as the code | Live |

**Detail**

- **RK1** → Manifests as a record from the named date being dropped for part of the day. The
  mitigation covers the comparison; it does not cover a user in a different timezone from the
  machine that wrote the ledger, which stays a stated limitation.
- **RK2** → This repo's guard suite fails the build on a documented/implemented flag mismatch in
  either direction, so the mitigation is to treat docs as part of the change, not a follow-up.

## 7. Validation Strategy

| Requirement | Verified by |
|---|---|
| FR-001 | `node --test test/runtime/trace.test.js` — records before the date excluded |
| FR-002 | same file — non-zero exit and message names the flag |
| FR-003 | same file — narrower window applied and stated |
| NFR-001 | same file — `ledger.windowDays` still present in `--json` |
| all | `npm test` green, including guards G8 and G10 |

## 8. Tasks

### Task Summary

| Phase | Tasks | Delivers | [P] |
|---|---|---|---|
| A | 2 | window semantics and CLI plumbing | yes |
| B | 2 | tests and documentation | yes |

### Phase A — window semantics and plumbing

- [ ] A.1 [US1] Add `since` to `RunLedger.read` with validation and cutoff resolution; emit `windowSince` — owner: core-implementer; files: src/runtime/trace.js
- [ ] A.2 [P] [US1] Parse `--since` and thread it to the trace case — owner: system-architect; files: bin/doflow.js

### Phase B — verification and documentation

- [ ] B.1 [P] [US1] Tests for FR-001, FR-002, FR-003, NFR-001 — owner: quality-guardian; files: test/runtime/trace.test.js
- [ ] B.2 [P] [US1] Document `--since` in help text and both flag indexes — owner: core-implementer; files: docs/reference.md, docs/flags.md

### Checkpoints

- After Phase A: `doflow trace --since <date>` runs end to end; commit `feat(trace): --since window`
- After Phase B: `npm test` green

### Completion criteria

- [ ] All tasks checked
- [ ] Validation gates pass
- [ ] state.md updated
