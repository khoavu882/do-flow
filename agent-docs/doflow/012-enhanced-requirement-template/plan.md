# Implementation Plan: Enhanced Requirement Template

**Feature:** 012-enhanced-requirement-template · **Requirement:** ./requirement.md · **Design:** ./design.md · **Status:** Draft · **Created:** 2026-08-19

> HOW. Reads ./requirement.md and ./design.md. Resolve every `[NEEDS CLARIFICATION]` from the
> requirement here.
>
> Structure follows `references/ARTIFACT_FORMAT.md`: indexed sections carry a table above full
> `**Detail**`, `Status` is only `Live` or `Superseded → <ref>`, and superseded prose moves to §9.

## 1. Approach

Two phases ordered by deliverables and validation dependencies. Phase A updates the templates (`requirement-template.md`, `design-template.md`) and their governing formatting specification (`ARTIFACT_FORMAT.md`). Every Phase A task edits a distinct file, allowing all three tasks to run concurrently in parallel (`[P]`). Phase B adds template consistency and validator verification tests to the guard suite (`test/guards/docs.test.js`), ensuring that the new markdown structures remain valid across all harnesses.

The key technical decision is maintaining strict architectural separation: user-facing functional expectations and Gherkin BDD scenario blocks reside in `requirement.md`, while technical implementation anchors (database models, API endpoints, repository patterns, and UX tokens) are housed in `design.md`.

## 2. Constitution Check (GATE)

> Verify against both constitution tiers, tier-2 taking precedence. `has_constitution_local` is
> false for this repo, so tier-1 applies alone and there is nothing to reconcile.

- [x] Complies with **P1 (Safety over speed)**: Template modifications are declarative and static; no destructive commands or unsafe file operations are introduced.
- [x] Complies with **P2 (Evidence over assumptions)**: Every template enhancement is verified against `validate-artifacts.sh` and the guard suite.
- [x] Complies with **P3 (Finish what you start)**: Both requirement and design templates are updated and synchronized alongside documentation and test assertions in one complete feature.
- [x] Complies with **P4 (Scope discipline)**: No external Gherkin parser or heavyweight runtime dependency is added; templates remain pure GitHub Flavored Markdown (GFM).
- [x] Complies with **P5 (Parallel by default)**: Phase A tasks are marked `[P]` across disjoint files (`requirement-template.md`, `design-template.md`, `ARTIFACT_FORMAT.md`).
- [x] No violation of **P6 (Professional honesty)**: Does not claim automated test execution from Gherkin syntax; explicitly defines scenarios as human- and agent-readable specifications.

**Result:** PASS

## 3. Research & Decisions

- **D1:** Format Acceptance Criteria in §6 as structured checkbox scenario blocks with `Given` / `When` / `Then` sub-bullets — resolves scenario layout; rationale: sub-bulleted blocks provide clean scannability in Markdown viewers while maintaining compatibility with checkbox status tracking.
- **D2:** Route technical implementation notes (ORM schemas, endpoints, repository patterns, UX tokens) to `design-template.md` — resolves technical note placement; rationale: prevents implementation details from polluting WHAT/WHY discovery in requirements while giving technical anchors an explicit home.
- **D3:** Structure User Stories in §2 with hierarchical headings (`### Story X.Y: [Title] (P#)`) followed by standard role/want/benefit syntax — resolves story formatting; rationale: aligns DoFlow requirements with real-world Agile story breakdowns while retaining concise role/want/benefit traceability.

## 4. Components & Changes

| ID | Change | Files | Phase | Status |
|---|---|---|---|---|
| CH1 | `requirement-template.md` story hierarchy and BDD scenario scaffolding | `core/shared/templates/doflow/requirement-template.md` | A | Live |
| CH2 | `design-template.md` technical scaffolding for schemas, endpoints, repositories, and UX | `core/shared/templates/doflow/design-template.md` | A | Live |
| CH3 | `ARTIFACT_FORMAT.md` authoring rules for story titles, BDD scenarios, and technical anchors | `core/shared/guidance/references/ARTIFACT_FORMAT.md` | A | Live |
| CH4 | Template structure and consistency assertions in guard suite | `test/guards/docs.test.js` | B | Live |

**Detail**

- **CH1** → `requirement-template.md` gains scaffolding for hierarchical story headers (`### Story X.Y: [Story Title] (P#)`) in §2 User Stories, and structured BDD scenario blocks with `- [ ] **Scenario: [Name]** (US#, FR-###)` and `Given` / `When` / `Then` sub-bullets in §6 Acceptance Criteria.
- **CH2** → `design-template.md` gains explicit subsections in §4 and §5 for Data Schemas (database tables/ORM models), API Endpoints (methods, routes, payloads, status codes), Repository & Service Interfaces (`interface` $\rightarrow$ `impl` $\rightarrow$ `mock`), and UX/UI specifications (color tokens, component states).
- **CH3** → `ARTIFACT_FORMAT.md` is updated to document the story title conventions, Given/When/Then scenario checklist rules, and the strict routing of technical implementation anchors to `design.md`.
- **CH4** → `test/guards/docs.test.js` adds assertions verifying that `requirement-template.md` and `design-template.md` contain the required sections and pass `validate-artifacts.sh` checks without errors.

## 5. Data / Contracts

Template definitions under `core/shared/templates/doflow/`:
- `requirement-template.md`: Scaffolds §2 Story headers and §6 BDD scenarios.
- `design-template.md`: Scaffolds §4 Endpoints & Repositories, §5 Schemas & UX.

## 6. Risks & Mitigations

| ID | Risk | Mitigation | Status |
|---|---|---|---|
| RK1 | Sub-bulleted scenario blocks could cause parsing issues in automated checklist counters | Tested against `validate-artifacts.sh` line-parsing logic | Live |
| RK2 | Inconsistent template copying across the 7 harness targets | Verified via `doflow doctor` and `test/install/` suite | Live |

**Detail**

- **RK1** → `validate-artifacts.sh` counts top-level `- [ ]` lines for plan checklist rollups and checks index-detail tables; nested `Given`/`When`/`Then` sub-bullets do not interfere with ID extraction.
- **RK2** → All harness configurations consume shared assets from `core/shared/templates/doflow/` during `doflow install` / `doflow update`, verified by existing installation guards.

## 7. Validation Strategy

| Requirement | Verified by |
|---|---|
| FR-001 | Visual & test inspection of `core/shared/templates/doflow/requirement-template.md` §2 |
| FR-002 | Visual & test inspection of `core/shared/templates/doflow/requirement-template.md` §6 |
| FR-003 | Visual & test inspection of `core/shared/templates/doflow/design-template.md` §4 and §5 |
| FR-004 | Execution of `validate-artifacts.sh` against updated templates and active feature artifacts |
| FR-005 | Review of `ARTIFACT_FORMAT.md` separation-of-concerns documentation |
| NFR-001 | `doflow doctor` and `test/install/` test suite |
| NFR-002 | Assertion that templates use pure standard Markdown with 0 dependencies |
| NFR-003 | Full test suite (`npm test`) passes with 0 regressions |

## 8. Tasks

> Dependency-ordered. `[P]` = parallel-safe with its phase siblings — siblings marked `[P]` must
> write disjoint `files:`. `[US#]` traces to a user story in requirement.md. The `- [ ]` checkboxes
> are the execution contract parsed by `/do-execute-plan`.

### Repo Branch Plan

N/A: single-repo feature. Every task's `files:` path resolves to the same enclosing `.git`, and no
task declares a `depends-on:`. Derived branch: `feat/012-enhanced-requirement-template`, which is
already checked out.

### Task Summary

| Phase | Tasks | Delivers | [P] |
|---|---|---|---|
| A | 3 | Template enhancements and formatting specification updates | yes |
| B | 1 | Guard assertions and artifact validation checks | yes |

### Phase A — Template & Reference Updates

- [x] A.1 [P] [US1] [US2] Update requirement-template.md with story hierarchy in §2 and Gherkin Given/When/Then scenario blocks in §6 — owner: core-implementer; files: core/shared/templates/doflow/requirement-template.md
- [x] A.2 [P] [US3] Update design-template.md with technical scaffolding for schemas, endpoints, repository interfaces, and UX cues — owner: core-implementer; files: core/shared/templates/doflow/design-template.md
- [x] A.3 [P] [US1] [US2] [US3] Update ARTIFACT_FORMAT.md to document story title syntax, scenario block conventions, and technical anchor routing — owner: research-writer; files: core/shared/guidance/references/ARTIFACT_FORMAT.md

### Phase B — Verification & Guard Tests

- [x] B.1 [P] [US2] [US3] Add guard tests in test/guards/docs.test.js asserting template structure consistency and validator compatibility — owner: quality-guardian; files: test/guards/docs.test.js

### Checkpoints

- After Phase A: run `validate-artifacts.sh` on all templates and feature docs; verify formatting.
- After Phase B: run `npm test` and confirm all tests pass; commit changes.

### Completion criteria

- [x] All tasks checked
- [x] Validation gates pass
- [x] state.md updated

## 9. History

None — initial version.
