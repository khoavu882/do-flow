# Code review: `--since <date>` window for the run ledger

**Scope:** `src/runtime/trace.js`, `bin/doflow.js`, `docs/reference.md`, `test/runtime-trace-window.test.js`
**Suite:** `npm test` → 579/579 pass (572 before this change; +7 new).

## Findings

| ID | Severity | Finding | Status |
|---|---|---|---|
| F1 | Low | `cutoffs.sort()` mutates and re-sorts a 2-element array to pick a max | Accepted as-is |
| F2 | Info | Design risk RK1 (local/UTC off-by-one) is not the risk the design claimed | Corrected here |
| F3 | Low | Plan named a test path that does not exist in this repo | Corrected during implementation |
| F4 | Low | Plan named `docs/flags.md` as a target; `--since` does not belong there | Corrected during implementation |

**F1** — `cutoffs.sort()[cutoffs.length - 1]` is a max over at most two ISO date strings. Correct
(lexical order equals chronological order for `YYYY-MM-DD`) and the comment says so, but a plain
comparison would be clearer. Not worth a change at this size; noted rather than fixed.

**F2** — design §7 and plan D2 asserted that the `--days` cutoff is millisecond-precise and must be
floored to local start-of-day. Reading the existing code, it already collapses to a UTC date string
via `.toISOString().slice(0, 10)` and compares against partition filenames, which are UTC dates. So
there is no local/UTC comparison to floor, and the mitigation the plan bought was unnecessary. The
real, unchanged limitation is that partition dates are UTC while a user's "since 1st of the month"
is local — a user west of UTC can miss part of their first day. That limitation predates this change
and this change does not widen it, but the design overstated the risk it was solving. Recording the
correction rather than quietly dropping D2.

**F3** — plan CH4 named `test/runtime/trace.test.js`. This repo has no `test/runtime/` directory;
runtime tests are flat and named `runtime-*.test.js`. Implemented as
`test/runtime-trace-window.test.js`, matching the existing convention.

**F4** — plan CH5 named `docs/flags.md`. That file indexes flags declared in a **skill's**
`argument-hint`; `--since` is a CLI flag, so adding it there would have been wrong and would have
broken G10, which cross-checks that file against skill frontmatter in both directions. Documented
in `bin/doflow.js`'s help block and `docs/reference.md`'s command table only. `npm test` passing
includes G8 and G10, which confirms the doc surface is consistent.

## Acceptance criteria

- [x] `doflow trace --since 2026-08-01` returns only records on or after that date (FR-001) —
      covered by test 1 and verified manually against this sandbox's own ledger.
- [x] `doflow trace --since notadate` exits non-zero naming the flag and form (FR-002) — verified
      manually: `doflow: --since expects a YYYY-MM-DD date, got 'notadate'`, exit 2.
- [x] `--since` with `--days` states the applied window (FR-003) — `Window: from <date> (applied
      from --days N + --since D)`.
- [x] `trace --json` still emits `ledger.windowDays` (NFR-001) — asserted in test 6.

## Approval status

**APPROVED WITH NOTES.** F1 is optional; F2–F4 are already corrected in the delivered change, and
the corrections are recorded above rather than folded in silently.
