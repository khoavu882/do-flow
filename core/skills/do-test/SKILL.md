---
name: do-test
description: "Execute tests with coverage analysis and automated quality reporting"
argument-hint: "[target] [--type unit|integration|e2e|all] [--coverage] [--watch] [--fix]"
effort: medium
---

# do-test

Run the project's own existing test suite — never writes new test files (that's part of an
implementation task, not this skill's job).

## Invocation
```text
/do-test [target] [--type unit|integration|e2e|all] [--coverage] [--watch] [--fix]
```

## Behavioral Flow
1. **Detect the test runner** from what's present: `package.json`'s `test` script and the actual
   framework it invokes (Jest/Vitest/Mocha/Node's `--test`), `pytest.ini`/`pyproject.toml` for
   Python, `./gradlew test` for Gradle, or the project's documented test command (check
   `CLAUDE.md`/`README.md` first — many repos have a non-default test invocation).
2. **Scope by `--type`**: `unit`/`integration` map to whatever the runner's own naming/tags use
   for that split (e.g. a directory convention or a `--grep` pattern) — don't invent a split the
   project doesn't have. `e2e` requires a browser-driving tool (Playwright if configured in this
   project) — if none is configured, say so rather than attempting to run e2e tests that can't run.
3. **Run it** — `[target]` scopes to a file/pattern if given. `--watch` uses the runner's own watch
   mode flag, not a custom file-watcher.
4. **On failure**: report the actual failing assertion/stack trace per test, not just a pass/fail
   count. `--fix` is only for `--fix`-supporting runners' own auto-fix (e.g. snapshot updates you
   explicitly confirm) — never silently skip, disable, or delete a failing test to make the run
   green (RULE_01_SAFETY).
5. **With `--coverage`**: use the runner's own coverage tool (`--coverage` flag, `nyc`, `coverage.py`)
   — report the actual percentage and uncovered lines, don't estimate.
6. **Report**: pass/fail counts, failing test details, coverage percentage if requested, and
   whether this changes any doflow feature's Completion Criteria (if `state.md` exists for the
   active feature).

## Boundaries
**Will:** run the project's existing test suite/runner as configured; report real coverage and
failure detail; respect `--watch`/`--fix` as the runner's own native behavior.
**Will Not:** write new test cases; modify test framework configuration; skip, disable, or delete
a failing test to force a green run.
