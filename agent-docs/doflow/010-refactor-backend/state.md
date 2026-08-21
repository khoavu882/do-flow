# State: Visible installer/runtime boundary in `src/`

**Feature:** 010-refactor-backend · **Plan:** ./plan.md · **Status:** In Progress · **Updated:** 2026-08-19

> Execution state for `/do-execute-plan`. Reflects what has actually happened.
>
> **Reconstructed 2026-08-19** after this file and its sibling artifacts were deleted mid-execution
> while `agent-docs/` was gitignored. Every commit range below is verified against `git log`, not
> recalled. The evidence ledger at `.doflow/state/evidence/` survived intact — 80 items, 22 supported
> claims — and corroborates the findings recorded here.

## Repo Branch Status

N/A: single-repo feature. Branch `feat/010-refactor-backend`, created before discovery.

## Task Ledger

| Task | Commits | Rounds | Review | Status |
|---|---|---|---|---|
| A.1 | `affddf8..b954079` | 0 | clean | complete |
| A.2 | `affddf8..b954079` | 0 | clean | complete |
| B.1 | `b954079..2c3b43d` | 0 | clean | complete |
| B.2 | `b954079..2c3b43d` | 1 | clean | complete |
| B.3 | `b954079..2c3b43d` | 0 | clean | complete |
| B.4 | `b954079..2c3b43d` | 0 | clean | complete |
| B.5 | `b954079..2c3b43d` | 0 | clean | complete |
| C.1 | `2c3b43d..87d8e05` | 0 | clean | complete |
| C.2 | `2c3b43d..87d8e05` | 0 | clean | complete |
| C.3 | `2c3b43d..87d8e05` | 0 | clean | complete |
| C.4 | `2c3b43d..87d8e05` | 1 | clean | complete |
| C.5 | `2c3b43d..87d8e05` | 1 | clean | complete |
| D.1 | `87d8e05..1ce0426` | 0 | clean | complete |
| D.2 | `87d8e05..1ce0426` | 0 | clean | complete |
| D.3 | `87d8e05..1ce0426` | 0 | clean | complete |
| F.1 | `1ce0426..54ee93e` | 0 | clean | complete |
| F.2 | `1ce0426..54ee93e` | 1 | clean | complete |
| F.3 | `1ce0426..54ee93e` | 0 | clean | complete |
| G.1 | `54ee93e..082b8dd` | 1 | clean | complete |
| G.2 | `54ee93e..082b8dd` | 0 | clean | complete (satisfied without change) |
| H.1 | `082b8dd..1c391b1` | 0 | clean | complete |
| H.2 | `082b8dd..1c391b1` | 0 | clean | complete |
| H.3 | `082b8dd..1c391b1` | 0 | clean | complete |
| H.4 | `082b8dd..1c391b1` | 0 | clean | complete |
| E.1 | `1c391b1..b36759b` | 0 | clean | complete |
| E.2 | `1c391b1..b36759b` | 0 | clean | complete |
| E.3 | `1c391b1..b36759b` | 0 | clean | complete |
| E.4 | `1c391b1..b36759b` | 0 | clean | complete |
| E.5 | `1c391b1..b36759b` | 0 | clean | complete |
| E.6 | `1c391b1..b36759b` | 0 | clean | complete |
| I.1 | working tree | 0 | clean | complete |

## Findings

- **[I.1 Test-Quality Assessment]** — Evaluated the full suite (598 tests across 60 files) against the brief's criteria:
  - *Behavior vs Implementation*: Adapter and lifecycle tests exercise native file generation, planning, applying, and verification against isolated temp directories, avoiding assertions on private state.
  - *Zero Mocking Libraries*: With zero production or dev dependencies in `package.json`, tests rely entirely on pure parameter injection (`repoRoot`, `fsImpl`, `scriptsDir`) rather than synthetic mock frameworks.
  - *Structural Invariants vs Regressions*: Guard tests (`test/guards/`) act as executable architecture contracts (verifying reachability, zero-dependency constraints, byte budgets, dispatcher parity, and doc-path synchronization).
  - *Test Tree Organization*: All 43 test files now mirror `src/` modules cleanly (`test/adapters/`, `test/lifecycle/`, `test/runtime/`, `test/registry/`, `test/state/`, `test/helper/`, `test/install/`, `test/e2e/`, `test/guards/`), eliminating root clutter while preserving 100% test passing parity (598/598).
- **[artifacts] the chain artifacts were deleted mid-execution and were not recoverable from git** —
  `agent-docs/doflow/010-refactor-backend/` vanished between a passing `prereqs` check and the next
  command in the same turn. `agent-docs/` was listed in `.gitignore`, so nothing was in any commit
  and nothing was in the Trash. The evidence ledger survived because it lives at `.doflow/state/`,
  deliberately separate. All four artifacts were reconstructed from the ledger, the commit messages
  and session context. `agent-docs/doflow/` is now un-ignored and tracked. Ruling: the reconstruction
  is faithful but is a rewrite, not a restore — the ledger holds findings, not normative text.
- **[G.1] a finding of mine that was wrong, and the near-miss it caused** — I reported the two
  adapter hooks modules shared ninety-three identical lines. The measurement intersected the two
  files' *sets of line strings*, so structure counted as duplication: thirty-three of the
  ninety-three are a lone `}`. A per-symbol diff showed only `verifyHookCommands` is genuinely
  shared. Had extraction proceeded on my figure, merging `SUPPORTED_EVENTS` would have given both
  harnesses the union of their event sets — they share two members of eleven — with nothing thrown
  and no test failing. FR-012 superseded by FR-014.
- **[Phase C] a suspected regression that was not one** — the installer's planned change count moved
  197 → 195. Root cause: `core/registry/assets.yaml` declares `runtime.lib` with `source: src`, so
  `src/` is a projected asset and the count tracks its file count. The delta is exactly four
  deletions plus two additions. It surfaced a real conflict, resolved as NFR-005.
- **[A.1] FR-008 was unsatisfiable as written** — `CLAUDE.md` is untracked, so no commit can carry
  it. Superseded by FR-009; the structural narrative migrated into `docs/architecture.md` at C.5.
- **[C.4/F.2] guard path literals updated, assertions untouched** — `test/guards/registry.test.js`
  hardcoded `src/lifecycle-view.js` and `src/targets.js`. Both literals were repointed in the same
  commit as the move that invalidated them. The case NFR-003 explicitly permits.
- **[verification method] an invalid comparison, corrected** — an early behavioural check ran
  `node bin/doflow.js $v` under zsh, which does not word-split unquoted expansions, so every verb
  received one malformed argument and both trees returned the same `unknown command` error. The
  comparison reported IDENTICAL while proving nothing. Redone under bash with argument arrays.
  Two subagents independently hit the same trap and diagnosed it correctly.
- **[A.1] pre-existing drift corrected in passing** — `CLAUDE.md` quoted "572 tests across 59 files"
  against an actual 596/60. Corrected locally with the owner's approval; not in any commit, since
  the file is untracked.

## Completed

- [x] A.1–A.2 — four unreachable `src/runtime/` modules deleted (683 lines); guard G16 added and
      demonstrated to fail on an unreferenced module, then pass once removed
- [x] B.1–B.5 — `bin/doflow.js` reduced 1528 → 1003; eight verb handlers relocated to the engines
      that back them; `cli-result.js` added to prevent the repository's first import cycle
- [x] C.1–C.5 — codex and gemini modules moved inside their adapters; `parseToml` extracted;
      `lifecycle-view` joined the lifecycle layer; architecture prose migrated to a tracked doc
- [x] D.1–D.3 — all seven adapters expose `create<Name>Adapter()`; no test file needed editing
- [x] F.1–F.3 — `src/helper/` and `src/install/` created; `src/` top level holds only directories;
      `docs/how-doflow-work.md` written and added to the mkdocs nav
- [x] G.1–G.2 — `verifyHookCommands` and its two helpers extracted; the three divergent symbols
      verified byte-identical to their prior state
- [x] H.1–H.4 — oversized runtime modules decomposed (`verification.js` 1256 → 955, `scaffold.js` 1239 → 980, `trace.js` 1083 → 609), helpers extracted into `verification-registry.js`, `verification-contract-runner.js`, `scaffold-artifacts.js`, `scaffold-fingerprint.js`, `scaffold-languages.js`, `trace-views.js`, `trace-render.js`. All verb comparisons verified identical/expected against pre-phase commit.
- [x] E.1–E.6 — all 43 test files organised into module directories mirroring `src/` (`adapters/`, `lifecycle/`, `runtime/`, `registry/`, `state/`, `helper/`, `install/`, `e2e/`), full suite 598 tests / 0 failures verified.
- [x] I.1 — test quality assessed against brief's criteria.

## In Progress

None.

## Blocked

None.

## Next Action

Gate B — Review and commit/merge preparation via `/do-git`.
