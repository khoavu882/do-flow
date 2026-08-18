# Implementation Plan: DoFlow Runtime Evolution — Evidence Ledger & Readiness Contracts

**Feature:** 005-evidence-ledger-readiness · **Branch:** `feat/005-evidence-ledger-readiness` · **Status:** Draft · **Created:** 2026-08-14

> Execution contract for `/do-execute-plan`. Reads ./requirement.md and ./design.md.
>
> Structure follows `references/ARTIFACT_FORMAT.md`: indexed sections carry a table above full
> `**Detail**`, `Status` is only `Live` or `Superseded → <ref>`, and superseded prose moves to §9.

## 1. Summary

Implement **Release B** of the DoFlow v3 runtime architecture: the **Evidence Ledger**, **Claims Model**, **ContextPack Compiler**, and **Readiness Contract Engine**. This milestone replaces raw context dumping with structured, grounded evidence capture and transforms subjective confidence guessing into deterministic, task-specific readiness gating (`READY`, `NEEDS_EVIDENCE`, `NEEDS_USER_DECISION`, `BLOCKED`) across Claude Code, Gemini CLI, and Antigravity.

## 2. Technical Strategy

- Implement modular in-process JavaScript classes in `src/runtime/` with zero external binary dependencies.
- Persist task evidence and claims to neutral JSON state under `.doflow/state/evidence/<task_id>.json`.
- Provide declarative task class readiness contract templates in `core/registry/readiness-templates.yaml` for 5 task types (Bug, Feature, Refactor, Trivial Edit, Dependency Change).
- Integrate Git HEAD and file mtime freshness checking to automatically invalidate stale evidence.
- Compile compact, budget-controlled `ContextPack` structures synthesizing only verified facts and supported claims.
- Refactor `confidence-check` skill into a `ReadinessContract` evaluator and expose `doflow readiness` / `doflow evidence` CLI inspection commands.

## 3. User Review Required

None. All technical choices adhere to the architectural decisions established in the deep research and brainstorming phases.

## 4. Open Questions

None.

## 5. Constitution Checklist

- **Base Constitution:** [`core/shared/guidance/references/CONSTITUTION_BASE.md`](file:///Users/kai/Workspace/learning/do-flow/core/shared/guidance/references/CONSTITUTION_BASE.md) (All rules satisfied).
- **Per-repo Constitution:** N/A (single-repo).
- **Invariants Verified:**
  - In-process evaluation executes in < 25ms (NFR-001).
  - Semantic retrieval similarity is strictly decoupled from factual claim confidence (NFR-002).
  - State isolation guarantees zero source tree pollution outside `.doflow/state/evidence/` (NFR-003).
  - Argument vectors used for all subshell executions (zero shell injection risk).

## 6. Proposed Changes

### Configuration & Declarative Templates

#### [NEW] [readiness-templates.yaml](file:///Users/kai/Workspace/learning/do-flow/core/registry/readiness-templates.yaml)
- Declarative template specifications for 5 task classes (`bug`, `feature`, `refactor`, `trivial-edit`, `dependency-change`).

### Runtime Subsystems (`src/runtime/`)

#### [NEW] [evidence-ledger.js](file:///Users/kai/Workspace/learning/do-flow/src/runtime/evidence-ledger.js)
- `EvidenceLedger` class managing structured evidence lifecycle, locators, provenance, and `.doflow/state/evidence/` JSON persistence.

#### [NEW] [claims.js](file:///Users/kai/Workspace/learning/do-flow/src/runtime/claims.js)
- `ClaimsManager` class governing the epistemic state machine (`hypothesis` → `supported` / `conflicted` / `invalidated`).

#### [NEW] [freshness.js](file:///Users/kai/Workspace/learning/do-flow/src/runtime/freshness.js)
- `FreshnessValidator` checking recorded evidence commit hashes and file modifications against live Git state.

#### [NEW] [context-pack.js](file:///Users/kai/Workspace/learning/do-flow/src/runtime/context-pack.js)
- `ContextPackCompiler` assembling budget-controlled structured context documents for coding agents.

#### [NEW] [readiness.js](file:///Users/kai/Workspace/learning/do-flow/src/runtime/readiness.js)
- `ReadinessEngine` evaluating task profiles against templates and emitting categorical readiness reports with actionable diagnostic pointers.

#### [MODIFY] [cli.js](file:///Users/kai/Workspace/learning/do-flow/src/runtime/cli.js)
- Add handlers for `doflow readiness` and `doflow evidence` CLI commands.

### CLI & Skills Integration

#### [MODIFY] [doflow.js](file:///Users/kai/Workspace/learning/do-flow/bin/doflow.js)
- Wire `readiness` and `evidence` commands into the CLI dispatch and `--help` text.

#### [MODIFY] [SKILL.md (confidence-check)](file:///Users/kai/Workspace/learning/do-flow/core/shared/skills/confidence-check/SKILL.md)
- Refactor skill to execute the `ReadinessEngine` and output structured readiness verdicts with missing-evidence locators.

### Test Suites (`test/`)

#### [NEW] [runtime-evidence-ledger.test.js](file:///Users/kai/Workspace/learning/do-flow/test/runtime-evidence-ledger.test.js)
- Unit tests for evidence creation, schema validation, provenance tracking, and JSON persistence.

#### [NEW] [runtime-claims.test.js](file:///Users/kai/Workspace/learning/do-flow/test/runtime-claims.test.js)
- Unit tests for claims lifecycle, evidence linking, contradiction detection, and state transitions.

#### [NEW] [runtime-readiness.test.js](file:///Users/kai/Workspace/learning/do-flow/test/runtime-readiness.test.js)
- Unit tests for readiness evaluation across all 5 task classes, missing evidence actions, and ContextPack compilation.

## 7. Verification Plan

### Automated Tests
- `node --test test/runtime-evidence-ledger.test.js`
- `node --test test/runtime-claims.test.js`
- `node --test test/runtime-readiness.test.js`
- `npm test` (Full multi-harness regression suite, 330+ tests)

### Manual & CLI Verification
- `node bin/doflow.js readiness --task-class bug`
- `node bin/doflow.js evidence --list`
- `bash core/shared/scripts/doflow/bash/validate-artifacts.sh agent-docs/doflow/005-evidence-ledger-readiness/requirement.md agent-docs/doflow/005-evidence-ledger-readiness/design.md agent-docs/doflow/005-evidence-ledger-readiness/plan.md`

## 8. Tasks

> Dependency-ordered. `[P]` = parallel-safe with its phase siblings — siblings marked `[P]` must
> write disjoint `files:`, or they are not parallel-safe. `[US#]` = traces to a
> user story in requirement.md. The `- [ ]` checkboxes are the execution contract parsed by
> `/do-execute-plan` — keep the markers intact.

### Repo Branch Plan

N/A: single-repo feature

### Task Summary

| Phase | Tasks | Delivers | [P] |
|---|---|---|---|
| A | 2 | Declarative Task Templates & Evidence Schemas | yes |
| B | 3 | Evidence Ledger & Claims State Machine | yes |
| C | 3 | Freshness Invalidation & ContextPack Compiler | yes |
| D | 3 | Readiness Engine & Skill Refactoring | yes |
| E | 2 | CLI Surface, End-to-End Verification & Gate Check | no |

### Phase A — Declarative Task Templates & Evidence Schemas

- [x] A.1 [P] [US3] Create declarative readiness templates in `core/registry/readiness-templates.yaml` for 5 task classes — owner: developer; files: core/registry/readiness-templates.yaml
- [x] A.2 [P] [US1] Initialize feature execution state in `agent-docs/doflow/005-evidence-ledger-readiness/state.md` — owner: developer; files: agent-docs/doflow/005-evidence-ledger-readiness/state.md

### Phase B — Evidence Ledger & Claims State Machine

- [x] B.1 [P] [US1] Implement `EvidenceLedger` class in `src/runtime/evidence-ledger.js` — owner: developer; files: src/runtime/evidence-ledger.js
- [x] B.2 [P] [US2] Implement `ClaimsManager` class in `src/runtime/claims.js` — owner: developer; files: src/runtime/claims.js
- [x] B.3 [P] [US1, US2] Add unit tests for ledger and claims in `test/runtime-evidence-ledger.test.js` and `test/runtime-claims.test.js` — owner: developer; files: test/runtime-evidence-ledger.test.js, test/runtime-claims.test.js

### Phase C — Freshness Invalidation & ContextPack Compiler

- [x] C.1 [P] [US5] Implement `FreshnessValidator` in `src/runtime/freshness.js` — owner: developer; files: src/runtime/freshness.js
- [x] C.2 [P] [US4] Implement `ContextPackCompiler` in `src/runtime/context-pack.js` — owner: developer; files: src/runtime/context-pack.js
- [x] C.3 [P] [US4, US5] Add unit tests for freshness invalidation and context pack generation in `test/runtime-readiness.test.js` — owner: developer; files: test/runtime-readiness.test.js

### Phase D — Readiness Engine & Skill Refactoring

- [x] D.1 [US3] Implement `ReadinessEngine` class in `src/runtime/readiness.js` — owner: developer; files: src/runtime/readiness.js
- [x] D.2 [P] [US3] Refactor `core/shared/skills/confidence-check/SKILL.md` to evaluate readiness contracts — owner: developer; files: core/shared/skills/confidence-check/SKILL.md
- [x] D.3 [P] [US3] Add unit tests for readiness evaluation across 5 task classes in `test/runtime-readiness.test.js` — owner: developer; files: test/runtime-readiness.test.js

### Phase E — CLI Surface & End-to-End Verification

- [x] E.1 [US6] Add CLI handlers for `doflow readiness` and `doflow evidence` in `src/runtime/cli.js` and `bin/doflow.js` — owner: developer; files: src/runtime/cli.js, bin/doflow.js
- [x] E.2 [US1, US3] Run full automated test suite, validate artifact consistency, and confirm zero regressions — owner: developer; files: test/

### Checkpoints

- After Phase A: Verify YAML syntax and state file; commit `feat(registry): add readiness templates for 5 task classes`
- After Phase B: Run ledger and claims unit tests; commit `feat(runtime): implement evidence ledger and claims state machine`
- After Phase C: Run freshness and context pack tests; commit `feat(runtime): implement freshness validator and context pack compiler`
- After Phase D: Run readiness engine tests; commit `feat(runtime): implement readiness engine and refactor confidence check`
- After Phase E: Run full test suite; commit `feat(cli): add readiness and evidence inspection commands`

### Completion criteria

- [x] All tasks checked
- [x] Validation gates pass (`validate-artifacts.sh`, `npm test`)
- [x] state.md updated

## 9. History

None — initial version.
