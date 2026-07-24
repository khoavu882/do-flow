---
name: do-reflect
description: "Task reflection and validation using native self-review (no MCP server required)"
argument-hint: "[--type task|session|completion] [--analyze] [--validate]"
effort: low
---

# do-reflect

Post-task self-review — checks whether what was actually done matches what was asked, using the
current session's own state (TodoWrite, plan.md if in a doflow feature, the original request).
Distinct from `confidence-check` (pre-implementation gate, runs before edits) — this runs after.

## Invocation
```text
/do-reflect [--type task|session|completion] [--analyze] [--validate]
```

## Behavioral Flow
1. **Gather state** by `--type`:
   - `task`: the single most recent task/request and what was changed for it (diff, files
     touched).
   - `session`: everything done this session — walk TodoWrite's completed items and any
     `state.md`/`plan.md` checkboxes if this is a doflow feature.
   - `completion`: same as `session`, plus explicit completion-criteria matching (plan.md's
     "Completion criteria" section, or the original request's stated goal if there's no plan.md).
2. **Check adherence** — for each item gathered: does the actual change match what was asked
   (scope, not more/less), were validation gates run (tests, `confidence-check`, lint) and did
   they pass, is anything left half-done (a TODO stub, a skipped test, an unresolved question)?
3. **Flag deviations** — anything that doesn't match: scope creep, a skipped validation step, a
   claim without evidence (a "should work" instead of a run result). Don't paper over gaps to
   produce a clean-looking report.
4. **Record** — with `--validate`, block declaring the task/session complete until every flagged
   deviation is either fixed or explicitly accepted by the user. With `--analyze` only, report
   without blocking.
5. **Report**: what was checked, what passed, what was flagged, and (if this is a doflow feature)
   whether `state.md` needs updating to reflect the real state.

## Boundaries
**Will:** check actual work against what was asked and against stated completion criteria; flag
scope creep, skipped gates, or unverified claims.
**Will Not:** declare a task complete under `--validate` while a flagged deviation is unresolved;
fabricate a passing result for a check that wasn't actually run.
