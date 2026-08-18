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

1. **Detect Toolchain & Build System**:
   - Detect test runner and build tools from repository manifests (`package.json`, `pytest.ini`, `Cargo.toml`, `Makefile`, `gradlew`, etc.).

2. **Run the Tiers the Verification Contract Requires**:
   - Which tiers run is not a choice the caller makes. The task's risk level selects them —
     `MEDIUM` unless the change touches security, auth, payments or data migration, which raises
     it — and the contract fixes their order: parse, build, static analysis, targeted tests, broad
     tests, then the structural and requirement checks the higher levels add. Run exactly that set.
   - A tier whose command cannot be detected is `UNRESOLVED`, and one unresolved required tier
     makes the whole run `INCONCLUSIVE`. Report that verdict as it stands — never call a check
     passed that was not run, and never narrow the set to make the report green.
   - Coverage comes with the test tiers and with what the detected runner already emits, not from a
     separate request: report line and branch numbers when the runner produces them, and say
     plainly that it does not when it does not.
   - `--clean` forces a clean compile before the deterministic tiers run.
   - `--watch` launches interactive watcher mode when the detected runner supports it. It is an
     interactive session, not a verification run: it produces no contract verdict.

3. **Diagnostics & Reporting**:
   - Report pass/fail summaries, exact failure traces, and affected requirements.
   - Never skip or delete failing tests to force passing status.

## Boundaries
**Will:** Detect and execute existing build systems and test runners, report coverage, and highlight failure traces.
**Will Not:** Write new test files (handled during implementation) or modify build configuration files.
