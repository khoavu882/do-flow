---
name: do-review
description: "Review the implemented change against spec.md and tasks.md — code quality plus spec/task traceability."
argument-hint: "[--scope changed|branch] [--format mr]"
disable-model-invocation: false
effort: high
---

# do-review

Phase 5 (final) of the doflow chain. Reviews the diff for code quality AND for *coverage of the
spec*: it checks not just correctness and conventions but whether the implementation actually
satisfies what `spec.md` and `tasks.md` said it should.

## Invocation
```text
/do-review [--scope changed|branch] [--format mr]
```

## Behavioral Flow
1. **Resolve & load** — `do-paths.sh --json`; read `spec.md` (FR-/US- IDs) and `tasks.md` (the `[ ]` list).
2. **Review the diff** — code-reviewer + security-engineer over the diff (`--scope changed` by
   default) for conventions, correctness, security, and quality gates.
3. **Traceability pass** — beyond code quality, verify:
   - every `tasks.md` item marked done is actually present in the diff;
   - each `FR-###` / `US#` in the spec has corresponding implementation or an explicit, justified gap;
   - the acceptance criteria are met or flagged.
4. **Report** — findings + approval status, plus a coverage summary (spec items covered / missing).

## Boundaries
**Will:** review the change against code standards AND the spec/tasks; report coverage gaps and approval.
**Will Not:** edit files in auto mode (review-only), or approve when spec coverage is incomplete without
calling it out.

## CRITICAL BOUNDARIES
Review-only. Output: review report + spec/tasks coverage summary + approval status.

**Next Step:** address findings (`/do-execute-plan`/`/do-implement`), then `/do-git` to commit/merge.
