---
name: do-test
description: "Execute project builds, automated test suites, and coverage verification with intelligent error reporting across whatever toolchain the repo already uses. Use when the user wants existing tests or builds run and reported on rather than new tests written, or says 'run the tests' / 'check coverage' / 'does this still build' rather than asking to implement or review code changes."
argument-hint: "[target] [--clean] [--watch]"
effort: medium
---

# do-test

Unified build verification and test runner for DoFlow projects.

## Invocation
```text
/do-test [target] [--clean] [--watch]
```

## Behavioral Flow

1. **Resolve the runtime** — every DoFlow runtime call in this skill goes through the runtime seam.
   Resolve it **once** here and reuse `$DOFLOW` for every later call in this skill:

```bash
# Resolve the DoFlow runtime: nearest project install wins, then the global one.
D=$PWD; while [ "$D" != / ] && [ ! -x "$D/.doflow/scripts/doflow/bin/doflow-run" ]; do D=$(dirname "$D"); done
DOFLOW="$D/.doflow/scripts/doflow/bin/doflow-run"
[ -x "$DOFLOW" ] || DOFLOW="$HOME/.doflow/scripts/doflow/bin/doflow-run"
[ -x "$DOFLOW" ] || { echo "doflow: no runtime found in any .doflow/ above $PWD, nor at $HOME/.doflow. Run: npx @khoavu882/doflow install" >&2; exit 2; }
```

Run every command below from the project root — the walk-up starts at `$PWD`. On exit 2, print the message verbatim and stop; it names every path searched.

2. **State the contract before running anything** — compile it, do not recall it:

```bash
"$DOFLOW" verify --task-id "<task id>" --risk "<LOW|MEDIUM|HIGH|CRITICAL>" --action contract --json
```

   `<task id>` is the plan task id when the run is scoped to one task, otherwise the feature slug —
   the same id every other stage used for it. `--risk` is an input the caller supplies: omitted, the
   contract compiles at the registry's default; a change touching security, auth, payments or data
   migration is what `HIGH` is for, and the level also sets `maxRecoveryIterations`. Report, before a
   single tier runs:
   - the compiled `tiers[]` in the order returned — that list, and nothing else, is what will run;
   - the `riskLevel` it compiled at and the `maxRecoveryIterations` it carries;
   - `detection.absent` — the command roles the runtime could not find in this repo's manifests
     (`detection.manifests` names what it read). Those are the tiers most likely to come back
     unresolved, and naming them up front is the difference between a gap and a surprise.

   Detection belongs to the verb. Do not re-derive the toolchain by hand, and do not substitute a
   runner the contract did not compile.

3. **Run the contract and report against it**:

```bash
"$DOFLOW" verify --task-id "<task id>" --risk "<the same level>" --action report --json
```

   Every tier step 2 listed gets a status in the report — `PASS`, `FAIL`, `UNRESOLVED`, `SUBSUMED`,
   `NOT_APPLICABLE`, `SKIPPED` or `NOT_RUN`. Report all of them. A tier the contract named and the
   run did not reach is reported as unreached, never omitted.
**Stop when** every required tier the contract names has an answer or a stated gap, **and** the last round produced no new required tier. A round that only restates what you already have is the last round. Report the remaining gaps rather than continuing.

4. **Read the verdict as it stands**:
   - A tier whose command cannot be detected is `UNRESOLVED`, and one unresolved required tier makes
     the whole run `INCONCLUSIVE`. The verb computes that and returns it in `status` with a `reason`
     naming the tiers — report it as it stands. Never call a check passed that was not run, and
     never narrow the set to make the report green.
   - Coverage comes with the test tiers and with what the detected runner already emits, not from a
     separate request: report line and branch numbers when the runner produces them, and say
     plainly that it does not when it does not.
   - `--clean` forces a clean compile before the deterministic tiers run.
   - `--watch` launches interactive watcher mode when the detected runner supports it. It is an
     interactive session, not a verification run: it produces no contract verdict.

5. **Diagnostics & Reporting**:
   - Report pass/fail summaries, exact failure traces, and affected requirements.
   - Never skip or delete failing tests to force passing status.

## Boundaries
**Will:** Compile the verification contract before running anything, run the tiers it names, report every tier's status including the ones that were never reached, report the coverage the detected runner emits, and highlight failure traces.
**Will Not:** Write new test files (handled during implementation), modify build configuration files, narrow the compiled tier set, or report a verdict the contract did not produce.
