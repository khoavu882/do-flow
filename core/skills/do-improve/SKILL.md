---
name: do-improve
description: "Refactor or clean up existing code — quality, performance, style, dead code, unused imports/files. Use when the user asks to improve, refactor, optimize, or clean up code that already exists, not to write new code."
argument-hint: "[target] [--type quality|performance|style|cleanup|all] [--safe] [--interactive]"
disable-model-invocation: true
effort: high
---

# do-improve

Refactor existing code for quality/performance/style, or remove dead code/imports/files — both
are the same job (transform existing code toward a better state), distinguished only by `--type`.
Absorbs `do-cleanup`; see the benchmark note in `--type cleanup` below for why they merged.

## Invocation
```text
/do-improve [target] [--type quality|performance|style|cleanup|all] [--safe] [--interactive]
```

## Behavioral Flow
1. **Analyze** the target for issues across categories: code quality/style, performance, and
   dead/unreferenced code (unused imports, unused functions, unreferenced files) — regardless of
   which `--type` was requested. Confirm each finding is actually dead (no callers, not exported)
   before treating it as removable.
2. **Scope the change to what was asked**:
   - `--type cleanup`: only dead code / unused imports / unreferenced files. Do not restructure
     live logic even if it's messy — that's `--type quality`/`performance`, not cleanup. A
     skill-creator benchmark on this exact boundary
     (`agent-docs/doflow/010-skills-core-refactor/benchmarks/quality-cluster-workspace/`) found
     that without this explicit rule, a cleanup-scoped run drifts into full logic restructuring
     whenever the surrounding code happens to look messy — stay inside the requested type.
   - `--type quality|performance|style`: restructure the live logic named in the request. If
     `--type` isn't `all`, do not also delete dead code you notice nearby — **flag it in the
     report instead of silently removing it**; the same benchmark found this exact scope creep
     happening in practice (unrequested dead-code deletion during a pure logic-improvement pass).
   - `--type all` (or no `--type` given and the user's own wording spans both): do both, and say
     so explicitly in the report.
3. **Apply** the in-scope change only. Preserve the existing public interface (exports, function
   signatures) unless the user explicitly asked to change it.
4. **Validate**: for a logic change, trace representative inputs (including edge cases: empty
   input, boundary values) through old vs. new to confirm identical behavior. For a cleanup
   change, confirm the removed symbols truly have zero remaining references.
5. **Report**: what changed, grouped by category (cleanup vs. quality/performance/style); what was
   found but left out-of-scope and why, so the user can request it explicitly next if they want it.

## Boundaries
**Will:** refactor/clean up existing code within the requested `--type` scope; flag out-of-scope
findings instead of silently fixing them; preserve behavior and public interface unless asked
otherwise.
**Will Not:** write new features or new code from scratch (that's `/do-implement`); expand scope
beyond the requested `--type` without flagging it first; skip the behavior-preservation validation
step for a logic change.
