# Implementation Plan: Task-attempt ledger

**Feature:** 070-task-attempt-ledger · **Branch:** `feat/070-task-attempt-ledger` · **Maturity:** Approved
**Created:** 2026-10-11 · **Design:** [design.md](design/design.md)

## 1. Approach

Build the ledger module and verb, wire the orchestrator gate, then document adoption for do-execute-plan.

## 2. Constitution Check

PASS. P2: completion needs evidence. P4: no leases, no DAG, no process control.

## 3. Decisions

The design §1 table.

## 8. Tasks

### Task Summary

| Phase | Tasks | Delivers | [P] |
|---|---|---|---|
| A | 1 | Ledger and verb | no |
| B | 1 | Orchestrator gate and adoption reference | no |

N/A: two sequential phases.

### Phase A

- [ ] [A.1] `src/runtime/task-attempts.js`, verb registration, storage declaration, tests for FR-001 to FR-005, FR-007, NFR-001

### Phase B

- [ ] [B.1] Orchestrator gate (FR-006), `references/task_attempts.md`, SKILL.md pointer, docs row, full suite

## 9. History

None — initial version.
