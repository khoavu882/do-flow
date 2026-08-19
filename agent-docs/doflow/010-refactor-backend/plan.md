# Implementation Plan: Visible installer/runtime boundary in `src/`

**Feature:** 010-refactor-backend · **Requirement:** ./requirement.md · **Design:** ./design.md · **Status:** In Progress · **Created:** 2026-08-19

> HOW. Reads ./requirement.md and ./design.md.
>
> **Reconstructed 2026-08-19** after `agent-docs/doflow/` was deleted mid-execution. Rebuilt from the
> evidence ledger, the branch's commits, and `state.md`'s ledger. Task checkboxes reflect what is
> actually committed, verified against `git log`.

## 1. Approach

Independent changes, each its own commit, ordered so the suite is green at every one: subtract first
(delete the unreachable modules, then add the guard that keeps them gone), relocate the verb
handlers, move harness code into its adapter, unify the adapter entry shape, empty the `src/` top
level, write the one duplicated hook function once, decompose the oversized modules, then reorganise
the test tree. Every step through Phase G is a relocation or a deletion. Phase H is not — it requires
understanding each module before cutting it, and is verified by behavioural comparison rather than by
the suite alone.

## 2. Constitution Check (GATE)

Tier-1 only — `has_constitution_local` is false.

- [x] **P1 (Safety over speed)** — no destructive operation beyond deleting four modules proven to
      have no requirer and no test; git history retains them.
- [x] **P2 (Evidence over assumptions)** — every task's `files:` list derived from an extracted
      require-graph, not from module names. Where a finding of mine proved wrong (FR-012's
      duplication figure), it was corrected on the record rather than quietly.
- [x] **P3 (Finish what you start)** — no task leaves a stub; a phase that lands leaves the suite green.
- [x] **P4 (Scope discipline)** — the two added modules (`cli-result.js`, `hook-commands.js`) are
      each forced by a specific constraint, not chosen; the larger `commands/` alternative is
      rejected on the record.
- [x] **P5 (Parallel by default)** — parallel tasks marked from disjoint `files:` sets, verified by
      `parallel-check`; the sequential ones each name the dependency forcing the order.
- [x] **P6 (Professional honesty)** — no task claims a verification it did not run. The baseline was
      recorded as unestablished until measured, and two of my own errors are recorded in §3.

**Result:** PASS.

## 3. Research & Decisions

- **D1:** A verb's handler lives in the module that backs it — resolves design A1.
- **D2:** `parseToml` extracted; `atomicWrite` stays in the codex cluster — resolves design A2.
- **D3:** `create<Name>Adapter()` takes no arguments; named exports retained — resolves design A3.
- **D4:** Files drop the redundant harness prefix on the move — resolves design A4.
- **D5:** The reachability guard scans `require()` literals statically — resolves design A5.
- **D6:** Deletion precedes the guard within Phase A — adding the guard first would land a
  knowingly-red commit.
- **D7:** Renderer identifiers are not renamed with their files. `core/registry/assets.yaml` declares
  `"renderer": "codex-agents"` and `src/lifecycle/index.js` compares `renderer === 'gemini-hooks'`.
  These are registry contract values that happen to match filenames; renaming them would break
  projection with nothing thrown.
- **D8:** Each destination module defines its own `REPO_ROOT` from its own `__dirname`, and the
  handler keeps its explicit `repoRoot:` argument. Four of the eight relocating handlers referenced
  `REPO_ROOT`, a constant private to `bin/doflow.js`, which the design did not account for. Verified
  rather than assumed: both expressions were computed and compared for string equality.
- **D9:** `test/` is reorganised by module rather than by test kind — grouping by module mirrors the
  `src/` boundaries this feature creates.
- **D10:** NFR-001's installed-layout freeze exempts `runtime.lib`. Began as a suspected regression
  (planned changes 197 → 195) and resolved as correct behaviour: the delta is exactly four deletions
  plus two additions.
- **D11:** Every source-side phase (F, G, H) runs before the test-tree move (E), so E rewrites each
  test's require exactly once against a settled `src/` layout.
- **D12:** `RunLedger`, `sanitizeRunEvent` and the single `appendFileSync` stay in `trace.js`. G12
  scans every file *except* `trace.js` for a second ledger writer, so extracting the ledger — the
  instinctive split — is precisely what that guard prevents.

## 4. Components & Changes

| ID | Change | Files | Phase | Status |
|---|---|---|---|---|
| CH1 | Delete four unreachable runtime modules | `src/runtime/` | A | Live |
| CH2 | Add the module-reachability guard | `test/guards/module-reachability.test.js` | A | Live |
| CH3 | Add the dependency-free presentation module | `src/runtime/cli-result.js` | B | Live |
| CH4 | Move eight verb handlers to their engines | eight `src/runtime/*.js` | B | Live |
| CH5 | Reduce the entry point to parse and dispatch | `bin/doflow.js` | B | Live |
| CH6 | Extract generic TOML parsing | `src/helper/toml.js` | C | Live |
| CH7 | Move the codex cluster into its adapter | `src/adapters/codex/` | C | Live |
| CH8 | Move gemini hooks and re-export one symbol | `src/adapters/gemini/` | C | Live |
| CH9 | Move the lifecycle view into its layer | `src/lifecycle/view.js` | C | Live |
| CH10 | Add the two missing adapter factories | `src/adapters/{claude,codex}/index.js` | D | Live |
| CH11 | Track structure in tracked docs, per phase | `docs/architecture.md`, `docs/capability-map.md` | A–D | Live |
| CH12 | Create `src/helper/` and `src/install/` | `src/helper/`, `src/install/` | F | Live |
| CH13 | Extract the one duplicated hook function | `src/adapters/hook-commands.js` | G | Live |
| CH14 | Decompose the three oversized runtime modules | `src/runtime/` | H | Live |
| CH15 | Reorganise `test/` by module | `test/` | E | Live |

## 5. Data / Contracts

No schema, entity or persisted format changes. Interface contracts are fixed in design §4. The
dispatcher-facing surface is frozen by NFR-005 and altered by no task here.

## 6. Risks & Mitigations

| ID | Risk | Mitigation | Status |
|---|---|---|---|
| RK1 | Renderer identifiers renamed along with their files | D7 | Live |
| RK2 | Handler relocation creates the first import cycle | CH3 lands before CH4 | Live |
| RK3 | A backticked doc path goes stale mid-phase | CH11 puts doc edits in the same commit | Live |
| RK4 | A handler is edited rather than moved | Move whole functions; review the diff | Live |
| RK5 | G5's constructed adapter path stops resolving | Adapter `index.js` filenames never change | Live |
| RK6 | The baseline is not yet known to be green | Discharged: 596 pass / 0 fail before Phase A | Live |
| RK7 | Splitting `trace.js` creates a second ledger writer | D12 | Live |
| RK8 | A duplication metric reports structure as duplication | Realised, not merely risked — see §3 | Live |

**Detail**

- **RK1** → `core/registry/assets.yaml` declares `"renderer": "codex-agents"` and
  `src/lifecycle/index.js` compares `renderer === 'gemini-hooks'`. A search-and-replace treating
  these as filenames would leave the registry naming a renderer nothing answers to — silent at
  require time, surfacing only as a projection producing nothing. Held: no `renderer` line changed.
- **RK2** → `cli.js` requires `claims.js`; `claims.js` gaining `handleClaimCommand` and importing
  `finishRuntime` from `cli.js` closes the loop. The repository has no cycle and no guard detecting
  one, so this would have landed unnoticed. Mitigated by ordering `cli-result.js` first. Held: cycle
  detection reports none after every phase.
- **RK3** → G8 asserts every backticked repo path in a doc exists. A commit moving a file named in
  `docs/architecture.md` without editing it is red. Realised twice (`src/toml.js`, and the new
  `docs/how-doflow-work.md` missing from the mkdocs nav); both fixed within the same commit.
- **RK4** → The mechanical risk of relocating handlers is not a broken import — that fails loudly —
  but a handler subtly rewritten during the move. Mitigated behaviourally: whole functions moved,
  diffs read for anything that is not a location change.
- **RK5** → G5 builds `src/adapters/<harness.adapter>/index.js` and fails if nothing is there.
  Adding sibling files is safe; renaming `index.js` is not, and no task does.
- **RK6** → Discharged before Phase A: 596 pass / 0 fail plus 8/8 analyzer fixtures, so every later
  failure is attributable.
- **RK7** → G12 asserts `trace.js` is the only ledger writer and that its single `appendFileSync` is
  the one guarded by `sanitizeRunEvent`. The instinctive split — extract `RunLedger` — is exactly
  what that guard prevents. Mitigated by moving only view and rendering code out (D12).
- **RK8** → This one landed rather than being avoided. A duplication scan intersecting the two hooks
  files' *sets of line strings* reported ninety-three shared lines, thirty-three of them a lone `}`.
  It drove a scope decision. Caught only because the executing task was gated on producing a
  per-symbol identical/differs table before editing. The lesson: measure contiguous runs, not line
  membership.

## 7. Validation Strategy

| Requirement | Verified by |
|---|---|
| FR-001 | Absence of the four files; `freshness.js`/`worktree.js` still present |
| FR-002 | New guard fails on a deliberately added unreferenced module, passes otherwise |
| FR-003 | G12's verb↔command parity assertions; `test/cli-e2e.test.js` |
| FR-004 | No harness-named module directly under `src/` |
| FR-005 | No `src/lifecycle/` file imports a path inside an adapter directory |
| FR-006 | `src/lifecycle/view.js` exists; its test passes |
| FR-007 | Each adapter's factory returns the six functions; adapter tests unchanged |
| FR-009 | G8's backticked-path assertion |
| FR-010 | Test count unchanged after the move; `npm test` still scoped to `test/` |
| FR-011 | `ls src/*.js` returns nothing |
| FR-013 | Verb-by-verb behavioural comparison against the pre-phase commit |
| FR-014 | The three divergent symbols verified byte-identical to their prior state |
| NFR-002 | Full suite green at each phase checkpoint before its commit |
| NFR-003 | Guard diffs contain no assertion change, only path/value updates |
| NFR-004 | `package.json` still declares no dependencies |
| NFR-005 | Verb-by-verb comparison against the branch point, run under bash |

## 8. Tasks

### Repo Branch Plan

N/A: single-repo feature. Branch `feat/010-refactor-backend`.

### Task Summary

| Phase | Tasks | Delivers | [P] |
|---|---|---|---|
| A | 2 | Dead code gone and unable to return | no |
| B | 5 | Verb handlers out of the entry point | yes |
| C | 5 | Harness code inside its adapter | partial |
| D | 3 | One adapter entry shape | yes |
| F | 3 | `src/` top level holds directories only | partial |
| G | 2 | The one duplicated hook function written once | no |
| H | 4 | Oversized runtime modules decomposed | yes |
| E | 6 | Test tree organised by module | yes |
| I | 1 | Test-quality findings reported | no |

### Phase A — Subtraction

- [x] A.1 [US2] Delete the four unreachable runtime modules — owner: core-implementer; files: src/runtime/context-router.js, src/runtime/retrieval-bridge.js, src/runtime/evidence-normalizer.js, src/runtime/benchmark.js
- [x] A.2 [US2] Add the module-reachability guard, proven to fail on a throwaway unreferenced module [depends A.1] — owner: quality-guardian; files: test/guards/module-reachability.test.js

### Phase B — Verb handlers leave the entry point

- [x] B.1 [US1] Create the dependency-free presentation module — owner: core-implementer; files: src/runtime/cli-result.js
- [x] B.2 [P] [US1] Move `handleClassifyCommand` and `handleWorkflowCommand` [depends B.1] — owner: core-implementer; files: src/runtime/task-classifier.js, src/runtime/workflow-engine.js
- [x] B.3 [P] [US1] Move `handleRouteCommand`, `handleClaimCommand`, `handleContextPackCommand` [depends B.1] — owner: core-implementer; files: src/runtime/capability-router.js, src/runtime/claims.js, src/runtime/context-pack.js
- [x] B.4 [P] [US1] Move `handleVerifyCommand`, `handleRecoverCommand`, `handleScaffoldCommand` [depends B.1] — owner: core-implementer; files: src/runtime/verification.js, src/runtime/recovery.js, src/runtime/scaffold.js
- [x] B.5 [US1] Remove the eight handler bodies from the entry point and repoint its requires [depends B.2, B.3, B.4] — owner: core-implementer; files: bin/doflow.js, docs/architecture.md

### Phase C — Harness code inside its adapter

- [x] C.1 [US3] Extract `parseToml` and its private helpers into a generic module — owner: core-implementer; files: src/toml.js, src/codex-config.js, src/lifecycle-view.js, test/codex-config.test.js
- [x] C.2 [P] [US3] Move the four codex modules into the codex adapter directory, leaving renderer identifiers untouched [depends C.1] — owner: core-implementer; files: src/adapters/codex/, bin/doflow.js, four test files
- [x] C.3 [P] [US3] Move gemini hooks into the gemini adapter and re-export `planGeminiHooks` [depends C.1] — owner: core-implementer; files: src/adapters/gemini/, src/lifecycle/index.js, test/gemini-hooks.test.js
- [x] C.4 [US3] Move the lifecycle view into the lifecycle layer [depends C.1, C.2 — both edit bin/doflow.js] — owner: core-implementer; files: src/lifecycle/view.js, bin/doflow.js, test/lifecycle-view.test.js
- [x] C.5 [US3] Update the ownership table and migrate the structural narrative out of the untracked CLAUDE.md [depends C.2, C.3, C.4] — owner: research-writer; files: docs/architecture.md

### Phase D — One adapter entry shape

- [x] D.1 [P] [US4] Add `createClaudeAdapter()` — owner: core-implementer; files: src/adapters/claude/index.js
- [x] D.2 [P] [US4] Add `createCodexAdapter()` — owner: core-implementer; files: src/adapters/codex/index.js
- [x] D.3 [US4] Record the uniform entry shape in the docs [depends D.1, D.2] — owner: research-writer; files: docs/capability-map.md, docs/architecture.md

### Phase F — `src/` top level holds directories only

- [x] F.1 [P] [US6] Move the six cross-layer primitives into `src/helper/` — owner: core-implementer; files: src/helper/, and every requirer
- [x] F.2 [US6] Move the six installer-domain modules into `src/install/` [depends F.1] — owner: core-implementer; files: src/install/, and every requirer
- [x] F.3 [US6] Record the settled `src/` layout and the `helper/` admission rule [depends F.1, F.2] — owner: research-writer; files: docs/architecture.md

### Phase G — The one duplicated hook function written once

- [x] G.1 [US7] Extract `verifyHookCommands` and its two private helpers into one shared module, leaving the three divergent symbols in place — owner: core-implementer; files: src/adapters/hook-commands.js, src/adapters/codex/hooks.js, src/adapters/gemini/hooks.js
- [x] G.2 [US7] Satisfied without change: each hooks test imports `verifyHookCommands` from its own adapter, so it exercises the shared implementation *and* proves that adapter's re-export. Repointing would be strictly less coverage — owner: quality-guardian; files: test/codex-hooks.test.js, test/gemini-hooks.test.js

### Phase H — Oversized runtime modules decomposed

- [x] H.1 [P] [US8] Decompose `src/runtime/verification.js` — owner: core-implementer; files: src/runtime/verification.js
- [x] H.2 [P] [US8] Decompose `src/runtime/scaffold.js`, breaking up `generateScaffold()` — owner: core-implementer; files: src/runtime/scaffold.js
- [x] H.3 [P] [US8] Decompose `src/runtime/trace.js`, keeping the ledger writer in place per D12 — owner: core-implementer; files: src/runtime/trace.js, src/runtime/trace-views.js, src/runtime/trace-render.js
- [x] H.4 [US8] Behavioural comparison of every verb against the pre-phase commit [depends H.1, H.2, H.3] — owner: quality-guardian; files: docs/architecture.md

### Phase E — Test tree organised by module

- [ ] E.1 [P] [US5] Move the adapter tests into per-harness directories under `test/adapters/` — owner: quality-guardian
- [ ] E.2 [P] [US5] Move the lifecycle tests into `test/lifecycle/` — owner: quality-guardian
- [ ] E.3 [P] [US5] Move the runtime tests into `test/runtime/` — owner: quality-guardian
- [ ] E.4 [P] [US5] Move the registry, state and shared-module tests — owner: quality-guardian
- [ ] E.5 [P] [US5] Move the whole-CLI and fixture-driven tests into `test/e2e/` — owner: quality-guardian
- [ ] E.6 [US5] Verify the reorganised tree: same test count, still scoped to `test/`, no stale path [depends E.1–E.5] — owner: quality-guardian

### Phase I — Test-quality findings

- [ ] I.1 [US5] Assess the suite against the brief's testing criteria and record findings without changing tests — owner: quality-guardian; files: agent-docs/doflow/010-refactor-backend/state.md

### Checkpoints

- Before Phase A: baseline recorded — 596 pass / 0 fail, 8/8 analyzer fixtures. Done.
- After each phase: `npm test`; commit. Phases A, B, C, D, F, G committed green.
- After Phase H: `npm test` plus a full verb-by-verb behavioural comparison.

### Completion criteria

- [ ] All tasks checked
- [ ] Validation gates pass
- [ ] state.md updated

## 9. History

None — initial version (reconstructed).
