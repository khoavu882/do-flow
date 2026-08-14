---
name: do-test
description: "Execute project builds, automated test suites, and coverage verification with intelligent error reporting"
argument-hint: "[target] [--type unit|integration|e2e|build|all] [--coverage] [--watch] [--clean]"
effort: medium
---

# do-test

Unified build verification and test runner for DoFlow projects.

## Invocation
```text
/do-test [target] [--type unit|integration|e2e|build|all] [--coverage] [--watch] [--clean]
```

## Behavioral Flow

1. **Detect Toolchain & Build System**:
   - Detect test runner and build tools from repository manifests (`package.json`, `pytest.ini`, `Cargo.toml`, `Makefile`, `gradlew`, etc.).

2. **Execute Build or Test Mode**:
   - `--type build`: Run clean compile and package verification (respects `--clean`).
   - `--type unit|integration|e2e|all`: Execute automated test suites mapped to framework patterns.
   - `--coverage`: Measure line and branch coverage; report exact percentages.
   - `--watch`: Launch interactive watcher mode when supported.

3. **Diagnostics & Reporting**:
   - Report pass/fail summaries, exact failure traces, and affected requirements.
   - Never skip or delete failing tests to force passing status.

## Boundaries
**Will:** Detect and execute existing build systems and test runners, report coverage, and highlight failure traces.
**Will Not:** Write new test files (handled during implementation) or modify build configuration files.
