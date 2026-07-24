---
name: do-analyze
description: "Comprehensive code analysis across quality, security, performance, and architecture domains"
when_to_use: Trigger automatically for read-only quality, security, performance, architecture, or technical-debt analysis. Auto mode must report findings and recommendations only; edits require explicit user request and confidence-check first.
argument-hint: "[target] [--focus quality|security|performance|architecture] [--depth shallow|normal|deep] [--format text|json|report]"
disable-model-invocation: false
user-invocable: true
effort: medium
---

# do-analyze

Read-only, multi-domain code analysis — produces findings and recommendations, never edits.
Distinct from `/do-troubleshoot` (issue-driven diagnosis of something already broken) — this is a
proactive audit of code that may be working fine today.

## Invocation
```text
/do-analyze [target] [--focus quality|security|performance|architecture] [--depth shallow|normal|deep] [--format text|json|report]
```

## Behavioral Flow
1. **Scope the target** — resolve `[target]` to a file/directory/glob; if omitted, default to the
   current working directory. Detect language(s) present (by extension/build files) so domain
   checks below use the right tooling per language rather than generic pattern-matching.
2. **Run domain checks** per `--focus` (all four if omitted):
   - `quality`: duplication, long functions/files, inconsistent naming, missing error handling at
     system boundaries.
   - `security`: hardcoded secrets/credentials, unvalidated input reaching a sink (SQL/shell/eval),
     missing auth checks on new endpoints, outdated dependencies with known CVEs if a lockfile is
     present.
   - `performance`: O(n²)+ patterns in hot paths, N+1 query patterns, unbounded loops/recursion,
     missing pagination on list endpoints.
   - `architecture`: circular dependencies, layering violations (e.g. UI importing DB internals),
     god objects/files, technical-debt markers (`TODO`/`FIXME`/`HACK`) left in delivered code.
   `--depth shallow` limits to the target's own files; `normal` follows direct imports/callers;
   `deep` follows the full dependency graph.
3. **Rate severity** — critical (security exploit / data loss), high (correctness/perf risk),
   medium (maintainability), low (style) — based on actual impact, not just presence of a pattern.
4. **Report** in `--format` (`text` default, `json` for tooling, `report` for a shareable
   markdown doc): findings grouped by domain and severity, each with file:line, why it matters,
   and a concrete fix direction (not just "consider refactoring").

## Boundaries
**Will:** perform read-only static analysis across the requested domain(s); rate and prioritize
findings; recommend concrete fixes.
**Will Not:** modify any file or apply a fix — that requires an explicit follow-up request through
`/do-improve` (refactor/cleanup) and passes through `confidence-check` first, same as any other
edit. Does not execute code or run a build (static analysis only).

## Next Step
`/do-improve --type quality|performance|style|cleanup` to apply the recommended fixes, or
`/do-troubleshoot` if a finding turns out to be an active, reproducing bug rather than a latent
risk.
