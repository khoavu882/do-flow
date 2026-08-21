# Implementation Plan: Runtime Integrity Gaps

**Feature:** 014-runtime-integrity-gaps · **Requirement:** ./requirement.md · **Design:** ./design.md · **Status:** Draft · **Created:** 2026-08-20

> HOW. Reads ./requirement.md and ./design.md.

## 1. Approach

Build the two shared primitives first (`locator-resolve.js`, `leak-scan.js`) with their tests, then
wire their consumers, because every other task calls one of them and a consumer written against an
unbuilt module cannot be tested. The analyser bundle and the shipped content files are independent of
that chain by file set and proceed on their own track. Inventory updates land last, in one pass, so
the guards are run against a finished surface rather than a moving one.

The single biggest correctness risk is not in any new module: it is the early return for terminal
states in `claims.js`. Without it every other retraction change is inert, so it is a named task with
its own regression test rather than a line folded into a larger edit.

## 2. Constitution Check (GATE)

- [x] Complies with **P1 — Safety over speed**: no destructive path is added. `retract` and
      `supersede` are additive state transitions that delete nothing (NFR-003); the leak check
      reports and never blocks a write (FR-010).
- [x] Complies with **P2 — Evidence over assumptions**: every decision in §3 carries a locator read
      from this checkout, recorded in the ledger. Two of the five originally reported root causes
      were corrected against the code rather than accepted as given.
- [x] Complies with **P3 — Finish what you start**: no task delivers a stub. Each of A.1, A.2, C.1
      and C.2 ships with its tests in the same task, and E.3 runs the full suite plus the
      separately-scoped Python fixtures.
- [x] Complies with **P4 — Scope discipline (YAGNI)**: four alternatives were rejected and recorded
      in design §7 (new hook script, duplicated leak rule, declarative config schema, sixth agent
      archetype). Nothing is built that an existing surface already provides.
- [x] Complies with **P5 — Parallel by default**: 10 of 15 tasks are `[P]`. Every unmarked task names
      the dependency that forces its order — either a shared file or an unbuilt callee.
- [x] Complies with **P6 — Professional honesty**: the feature's whole subject is removing two
      places where the system reports success it has not earned. R8 records that the hook half of
      FR-010 reaches three of seven harnesses rather than claiming universal coverage.

**Result:** PASS — no violation. Tier-1 only; `has_constitution_local` is false, so no tier-2
overlay applies and nothing needed reconciling.

## 3. Research & Decisions

- **D1:** Terminal claim states get an early return at the top of `evaluateClaim` — because
  `evaluateAll()` runs on every `list`/`status` call and `evaluateClaim` unconditionally rewrites
  `status` from evidence links (`src/runtime/claims.js:130-178`). Without the guard a retraction is
  undone by the next read.
- **D2:** The readiness gate needs no change to stop counting a terminal claim — its block condition
  is `taskClaims.filter((c) => c.status === 'conflicted')` (`src/runtime/readiness.js:152`), which a
  terminal claim no longer matches. FR-003's gating half is therefore a consequence of D1, not
  separate work.
- **D3:** Locator resolution lives in one module called by two consumers, not duplicated — G16
  requires every `src/` module be reachable by static require, and G12 forbids one verb having two
  implementations. `cli.js` calls it to refuse (FR-004); `readiness.js` calls it to report (FR-005).
  The module holds no policy, which is what lets the two differ.
- **D4:** A `uri`-only locator resolves as `not-checkable` rather than as a failure — `cli.js:182`
  admits `file`, `line`, `symbol` and `uri`, and the resolver cannot read a URI. Grading something
  it cannot read would reintroduce the invented verdict this feature removes.
- **D5:** The always-on leak check extends `stop-check.sh` rather than adding a hook —
  `post-edit-lint.sh:4` is a pure collector appending edited paths to a session list, and
  `stop-check.sh:42` already partitions that list by extension. A new hook would add a script, a
  settings matcher, a registry asset and seven lifecycle mappings to do work an existing loop is
  already shaped for.
- **D6:** Coverage reporting enforces an existing contract rather than adding a policy —
  `do-code-review/SKILL.md:88` already states that a file the derivation includes but never opened
  is reported as not reviewed. The defect is that `code_quality_checker.py:915` discards per-file
  errors before the average is computed.
- **D7:** `--plan-path` is a wiring change, not a feature — `command-detect.js:44` defines the
  `doflow-verification` override block and `verification.js:888` accepts `planPath`, but
  `bin/doflow.js:1009` passes only `taskId`, `action`, `risk`, `json` and `projectRoot`.
- **D8:** Review offload reuses `quality-guardian` — its spec already lists code quality review among
  its capabilities, so no sixth archetype is added. Naming it inside a skill triggers G9, so the
  `MODEL_SELECTION.md` reference ships in the same task.

## 4. Components & Changes

| ID | Change | Files | Phase | Status |
|---|---|---|---|---|
| CH1 | Shared locator resolvability module | `src/runtime/locator-resolve.js` | A | Live |
| CH2 | Shared internal-identifier scan module and verb | `src/runtime/leak-scan.js` | A | Live |
| CH3 | Terminal claim states and lifecycle actions | `src/runtime/claims.js` | B | Live |
| CH4 | Write-time locator validation | `src/runtime/cli.js` | B | Live |
| CH5 | Gate-time resolvability reporting | `src/runtime/readiness.js` | B | Live |
| CH6 | CLI surface: flags, cases, verb table, help | `bin/doflow.js`, `doflow-run` | B | Live |
| CH7 | Analyser coverage honesty | `code_quality_checker.py` | C | Live |
| CH8 | Shell, YAML and JSON analysis | `code_quality_checker.py` | C | Live |
| CH9 | New rules files for the two dispatch axes | `languages/shell.md`, `content-types/config.md` | D | Live |
| CH10 | Review skill dispatch, contract and offload | `do-code-review/SKILL.md` | D | Live |
| CH11 | Stop-hook leak pass | `stop-check.sh` | D | Live |
| CH12 | Documented inventories | `docs/`, `README.md`, `CHANGELOG.md` | E | Live |

**Detail**

- **CH1** → Exports `resolveLocator({ locator, repoRoot, fsImpl })` returning
  `{ resolved, reason, actual }` with `reason` drawn from `file-missing`, `line-beyond-eof`,
  `symbol-absent`, `not-checkable`. Reads files; decides no policy.
- **CH2** → Exports `scanPaths(...)` returning findings, scanned and unscanned lists, plus
  `handleLeakScanCommand`. Holds the pattern vocabulary as module data and excludes the artifact
  directory before matching.
- **CH3** → Adds `retracted` and `superseded` to `CLAIM_STATUSES`, exports
  `TERMINAL_CLAIM_STATUSES`, adds `supersededBy` and `terminalAt` to the record, adds
  `retractClaim` / `supersedeClaim`, adds the two actions to `handleClaimCommand`, corrects the
  `unknown --action` message, and adds the early return in `evaluateClaim`.
- **CH4** → Calls CH1 from `validateEvidenceItem` for `extracted` items and throws a message naming
  the file, what was requested and what the file offers. Batch atomicity is inherited, not rebuilt.
- **CH5** → Calls CH1 while evaluating supporting evidence; reports unresolvable items by id and
  locator, keeping *unresolvable* distinct from the existing *stale*.
- **CH6** → Adds `--plan-path` and `--replaced-by` to the value-flag table, passes `planPath` in the
  `verify` case, adds the `leak-scan` case, adds `leak-scan` to `is_node_verb()` in the shell
  dispatcher, and updates the help text's action lists.
- **CH7** → Retains per-file errors, adds `skipped`, `files_skipped` and `coverage` to
  `analyze_directory`'s result, replaces the `"No supported files found"` error string with a
  structured all-skipped result, and renders a SKIPPED section in `print_report`.
- **CH8** → Adds `shell`, `yaml` and `json` to `LANGUAGE_EXTENSIONS` and their analysis paths: shell
  as code, YAML and JSON as declarative structure with no SOLID or complexity reporting.
- **CH9** → `languages/shell.md` (functions, nesting, quoting, `set -euo pipefail`, trap hygiene) and
  `content-types/config.md` (nesting depth, duplicate keys, anchor sprawl, parse validity, secrets in
  plain text).
- **CH10** → Adds both dispatch rows, a leak-scan step to the Review Contract, the `quality-guardian`
  offload note, the `MODEL_SELECTION.md` reference G9 requires, and the language list in the skill's
  own `description` frontmatter.
- **CH11** → One added partition and one `leak-scan` invocation in the existing batch loop, emitting
  a warning on findings and never a non-zero exit.
- **CH12** → `docs/reference.md`, `docs/flags.md`, `README.md` counts, `CHANGELOG.md`.

## 5. Data / Contracts

Claim record gains `supersededBy` (optional string) and `terminalAt` (optional ISO string); the
`status` vocabulary gains `retracted` and `superseded`. No existing field changes meaning, so a
claims file written before this feature loads and evaluates unchanged. Full shapes in design §4 and §5.

## 6. Risks & Mitigations

| ID | Risk | Mitigation | Status |
|---|---|---|---|
| RK1 | The `evaluateClaim` guard is omitted or placed after the evidence walk | Own task with a dedicated regression test asserting status survives `evaluateAll` | Live |
| RK2 | Write-time locator checks break the project's own test fixtures | E.3 runs the full suite; fixtures using synthetic locators are updated with the change that breaks them | Live |
| RK3 | New analyser paths change scores for already-covered languages | C.1 and C.2 touch one file sequentially, and the Python fixture script is run explicitly in E.3 | Live |
| RK4 | Leak patterns fire across this repository's own documentation | Artifact-directory exclusion, report-not-block, and E.3 running the verb over the repo to inspect the finding set | Live |
| RK5 | Guards fail late because an inventory was missed | Inventory is one phase, and E.3 is a task rather than a checkpoint note | Live |
| RK6 | `--plan-path` passes through but the override is not honoured end to end | E.3 exercises `verify` against a fixture repo with no manifest and a plan-declared command | Live |

**Detail**

- **RK1** → The failure is silent: retraction appears to work, the claim reads `retracted` once, and
  the next `list` restores it. A test that retracts, calls `evaluateAll`, then re-reads is the only
  thing that catches it.
- **RK2** → `test/runtime/runtime-evidence-write.test.js` and `runtime-readiness.test.js` write
  evidence with locators; any that name files or lines that do not exist will now be refused. That is
  the feature working, so the fixtures move to real locators rather than the check being relaxed.
- **RK3** → Both changes edit `code_quality_checker.py`, so they are sequential by file. The fixture
  script is outside `npm test` and would otherwise not run at all.
- **RK4** → This repository legitimately discusses `FR-###` and `agent-docs/` in its own docs. The
  mitigation is inspection of the real finding set before the task is called done, not a guess at the
  pattern set.
- **RK5** → G6, G8 and G10 all read documented inventories; a missed row fails the suite at the end
  of the work rather than at the change that caused it.
- **RK6** → Passing the flag and honouring the override are different failures. The end-to-end check
  is what distinguishes them.

## 7. Validation Strategy

| Requirement | Verified by |
|---|---|
| FR-001 | `runtime-claims.test.js` — retract moves to terminal, record and links intact; unknown and already-terminal ids refused |
| FR-002 | `runtime-claims.test.js` — supersede sets the forward pointer; unrecorded `--replaced-by` refused |
| FR-003 | `runtime-claim-status.test.js` — terminal status survives `evaluateAll`; `runtime-readiness.test.js` — no BLOCKED from a retracted claim |
| FR-004 | `runtime-evidence-write.test.js` — line beyond EOF, missing file, and absent symbol each refuse the whole batch |
| FR-005 | `runtime-readiness.test.js` — a gate with an unresolvable supporting item is not READY and names the item |
| FR-006 | `test/code-review-fixtures.sh` — a mixed directory reports every skipped file with its reason |
| FR-007 | `test/code-review-fixtures.sh` — YAML, shell and JSON fixtures produce findings |
| FR-008 | `test/code-review-fixtures.sh` — a largely-unanalysable change reports partial coverage |
| FR-009 | `runtime-leak-scan.test.js` — identifiers outside the artifact dir are found with file and line; identical text inside it is not |
| FR-010 | `runtime-leak-scan.test.js` for the rule; manual run of `stop-check.sh` against a seeded edited-files list for the caller |
| FR-011 | End-to-end `verify` against a fixture repo with no manifest and a `doflow-verification` block |
| FR-012 | `SKILL.md` names the archetype and references `MODEL_SELECTION.md`; G9 enforces the pairing |
| NFR-001 | G5 and `doflow doctor` — no new entry in `external-tools.yaml` |
| NFR-002 | `stop-check.sh` calls the verb without a blocking exit path; hook contract unchanged |
| NFR-003 | `runtime-claims.test.js` — claim count is unchanged after retract and supersede |
| NFR-004 | `runtime-claims.test.js` — a pre-feature claims fixture loads and evaluates identically |
| NFR-005 | `npm test` — all guard files green |
| NFR-006 | Every new test runs against a temp dir with no feature directory |

## 8. Tasks

### Repo Branch Plan

N/A: single-repo feature. `requirement.md`'s `**Ticket:**` field is `none`, so the derived branch is
`feat/014-runtime-integrity-gaps`, which is already checked out.

### Task Summary

| Phase | Tasks | Delivers | [P] |
|---|---|---|---|
| A | 2 | The two shared runtime primitives, with tests | yes |
| B | 4 | Runtime consumers and the CLI surface | yes |
| C | 2 | Analyser coverage honesty and non-code analysis | no |
| D | 4 | Shipped rules files, skill dispatch, hook caller | yes |
| E | 3 | Inventories and the full verification pass | yes |

### Phase A — Shared runtime primitives

- [ ] A.1 [P] [US2] Build the locator resolvability module and its tests — owner: core-implementer; files: src/runtime/locator-resolve.js, test/runtime/runtime-locator-resolve.test.js
- [ ] A.2 [P] [US4] Build the internal-identifier scan module, its command handler, and its tests — owner: core-implementer; files: src/runtime/leak-scan.js, test/runtime/runtime-leak-scan.test.js

### Phase B — Runtime consumers and CLI surface

- [ ] B.1 [P] [US1] Add terminal claim states, retract and supersede actions, and the evaluateClaim early return — owner: core-implementer; files: src/runtime/claims.js, test/runtime/runtime-claims.test.js, test/runtime/runtime-claim-status.test.js
- [ ] B.2 [P] [US2] Call the resolver from evidence write validation and refuse the batch on an unresolvable extracted locator — owner: core-implementer; files: src/runtime/cli.js, test/runtime/runtime-evidence-write.test.js
- [ ] B.3 [P] [US2] Report unresolvable supporting evidence at the readiness gate, distinct from stale — owner: core-implementer; files: src/runtime/readiness.js, test/runtime/runtime-readiness.test.js
- [ ] B.4 [US1] [US4] [US5] Wire the CLI surface: --plan-path and --replaced-by flags, the leak-scan case, planPath in the verify case, the shell verb table, and help text (depends B.1, A.2) — owner: core-implementer; files: bin/doflow.js, core/shared/scripts/doflow/bin/doflow-run

### Phase C — Analyser bundle

- [ ] C.1 [US3] Retain per-file errors and report skipped files and partial coverage — owner: core-implementer; files: core/shared/skills/do-code-review/scripts/code_quality_checker.py, test/code-review-fixtures.sh
- [ ] C.2 [US3] Add shell, YAML and JSON analysis paths (depends C.1, same file) — owner: core-implementer; files: core/shared/skills/do-code-review/scripts/code_quality_checker.py, test/code-review-fixtures.sh

### Phase D — Shipped content

- [ ] D.1 [P] [US3] Write the shell rules file — owner: quality-guardian; files: core/shared/skills/do-code-review/languages/shell.md
- [ ] D.2 [P] [US3] Write the declarative-config rules file for YAML and JSON — owner: quality-guardian; files: core/shared/skills/do-code-review/content-types/config.md
- [ ] D.3 [US3] [US4] [US6] Update the review skill: both dispatch rows, the leak-scan contract step, the quality-guardian offload note with its MODEL_SELECTION reference, and the description frontmatter (depends D.1, D.2, A.2) — owner: system-architect; files: core/shared/skills/do-code-review/SKILL.md
- [ ] D.4 [P] [US4] Add the leak-scan pass to the Stop hook's existing batch loop (depends A.2) — owner: core-implementer; files: core/harnesses/claude/hooks/stop-check.sh

### Phase E — Inventories and verification

- [ ] E.1 [P] Update the CLI and flag inventories the guards read — owner: system-architect; files: docs/reference.md, docs/flags.md
- [ ] E.2 [P] Update the README counts and the changelog — owner: system-architect; files: README.md, CHANGELOG.md
- [ ] E.3 Run the full verification pass: npm test, the Python fixture script, the leak verb over this repository, and verify against a no-manifest fixture (depends all) — owner: quality-guardian; files: test/

### Checkpoints

- After Phase A: `node --test test/runtime/runtime-locator-resolve.test.js test/runtime/runtime-leak-scan.test.js`; commit `feat(runtime): add locator resolvability and leak-scan primitives`
- After Phase B: `node --test "test/runtime/**/*.test.js"` and `node --test test/guards/dispatch.test.js test/guards/runtime-unification.test.js`; commit `feat(runtime): claim lifecycle, locator validation, and CLI wiring`
- After Phase C: `bash test/code-review-fixtures.sh`; commit `feat(code-review): honest coverage reporting and non-code analysers`
- After Phase D: `node --test test/guards/consumers.test.js test/guards/dispatch.test.js`; commit `feat(code-review): shell and config rules, leak-scan dispatch, review offload`
- After Phase E: `npm test`; commit `docs: update inventories for runtime integrity gaps`

### Completion criteria

- [ ] All tasks checked
- [ ] Validation gates pass
- [ ] state.md updated

## 9. History

None — initial version.
