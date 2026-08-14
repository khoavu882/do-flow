---
name: confidence-check
description: Mandatory pre-implementation readiness contract gate. Evaluates task readiness across 5 task classes (Bug, Feature, Refactor, Trivial Edit, Dependency Change) before executing source modifications.
when_to_use: Trigger automatically before source edits, test edits, dependency changes, configuration changes, architecture changes, generated workflow execution, bug fixes, or implementation work. Do not trigger for pure explanation, read-only review, brainstorming, estimation, or requirements discovery.
user-invocable: false
effort: low
---

# Pre-Implementation Readiness Contract Gate

Prevents premature or wrong-direction execution by evaluating explicit, grounded **Readiness Contracts** (`src/runtime/readiness.js`) before starting source code modifications.

Replaces subjective numerical confidence estimation with verifiable evidence checks and categorical readiness gating.

---

## 1. Readiness States

| State | Meaning | Permitted Action |
|---|---|---|
| `READY` | All mandatory prerequisites verified by fresh evidence in `EvidenceLedger`. | **PROCEED** with implementation. |
| `NEEDS_EVIDENCE` | Specific required evidence locators or supported claims are missing. | **HALT** implementation. Execute recommended retrieval actions. |
| `NEEDS_USER_DECISION` | Task has unresolved trade-offs or architectural ambiguity. | **HALT** and ask the user for explicit decision. |
| `BLOCKED` | Conflicted claims detected with contradicting evidence. | **HALT**. Resolve contradictory evidence before continuing. |

---

## 2. Task-Specific Readiness Contracts

### A. Bug Fix (`taskClass: "bug"`)
- [ ] **Reproduction Verified**: Failing test or runtime observation recorded (`runtime-observation` or `test-result`).
- [ ] **Affected Code Located**: Target files and symbols identified with source locators (`exact-search` or `semantic-retrieval`).
- [ ] **Root Cause Supported**: Root cause hypothesis validated by evidence into `status: "supported"`.
- [ ] **Blast Radius Mapped**: Callers and downstream components mapped (`structural`).
- [ ] **Regression Plan**: Verification command defined.

### B. Feature Implementation (`taskClass: "feature"`)
- [ ] **Scope Clear**: Scope boundaries and acceptance criteria defined.
- [ ] **Affected Components**: Target integration points and files mapped (`structural` or `semantic-retrieval`).
- [ ] **Verification Plan**: Test execution plan and assertions established.

### C. Refactoring (`taskClass: "refactor"`)
- [ ] **Architecture Mapped**: Call graphs and dependencies mapped (`structural`).
- [ ] **Invariants Captured**: Behavioral invariants documented.
- [ ] **Baseline Green**: Existing test suite passes prior to modifications (`test-result`).
- [ ] **Blast Radius Mapped**: All downstream dependents identified.

### D. Trivial Edit (`taskClass: "trivial-edit"`)
- [ ] **Target Identified**: Exact file and line locator confirmed (`exact-search`).
- [ ] **Scope Verified**: Single-file scope verified with no cascading structural impact.

### E. Dependency Change (`taskClass: "dependency-change"`)
- [ ] **Compatibility Checked**: Official release notes and breaking changes reviewed (`documentation`).
- [ ] **Usage Impact**: All repository usages of the library identified (`exact-search` / `structural`).
- [ ] **Verification Command**: Build and test verification commands established.

---

## 3. Evaluation Flow

1. **Identify Task Class**: Classify the task into `bug`, `feature`, `refactor`, `trivial-edit`, or `dependency-change`.
2. **Query Evidence Ledger**: Verify that required evidence items are registered in `EvidenceLedger` with `freshness.status === "FRESH"`.
3. **Verify Claims**: Verify that key assumptions are promoted to `status: "supported"` in `ClaimsManager`.
4. **Gate Output**:
   - If `READY` → Output `[READY] Proceeding with implementation.`
   - If `NEEDS_EVIDENCE` → List missing evidence locators and recommended retrieval commands from `CapabilityRouter`.
   - If `BLOCKED` → Detail conflicting claims and stop execution.

## Boundaries
**Will:** Enforce task-specific readiness checks; report missing evidence locators; block implementation until required prerequisites are satisfied.
**Will Not:** Allow implementation to start with unverified hypotheses; accept ungrounded numeric self-assessments.
