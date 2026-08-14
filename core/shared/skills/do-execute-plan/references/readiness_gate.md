# Task Readiness Gate & Confidence Check Contract

Pre-implementation contract gate evaluated across 5 task classes:

## Task Classes & Requirements
1. **Bug Fix**:
   - Requires reproducing test / stack trace + proven root cause mechanism.
2. **New Feature**:
   - Requires `requirement.md` acceptance criteria + `design.md` architectural contract.
3. **Refactor**:
   - Requires green baseline tests + verified blast radius scope.
4. **Trivial Edit**:
   - Requires localized single-file target with no behavioral mutation.
5. **Dependency Update**:
   - Requires compatibility report + lockfile verification.

## Enforcement
- If prerequisites are incomplete, mark task `BLOCKED` or `NEEDS_EVIDENCE`.
- Never execute modifications while in a `BLOCKED` state.
