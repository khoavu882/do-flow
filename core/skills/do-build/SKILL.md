---
name: do-build
description: "Build, compile, and package projects with intelligent error handling and optimization"
argument-hint: "[target] [--type dev|prod|test] [--clean] [--optimize] [--verbose]"
effort: medium
---

# do-build

Run the project's own build using its existing build system — never invents a build process.

## Invocation
```text
/do-build [target] [--type dev|prod|test] [--clean] [--optimize] [--verbose]
```

## Behavioral Flow
1. **Detect the build system** from what's actually present: `package.json` scripts
   (`build`/`build:dev`/`build:prod`), `Makefile`, `gradlew`/`build.gradle`, `pom.xml`, `Cargo.toml`,
   or a language-specific convention. If `[target]` names a subdirectory in a multi-project
   workspace, detect within that directory, not the repo root.
2. **Resolve the command** for `--type`: map `dev`/`prod`/`test` to whatever the detected build
   system actually calls them (e.g. `npm run build:dev` vs `npm run build`) — don't guess a script
   name that doesn't exist in `package.json`; list available scripts if the mapping is ambiguous.
3. **Run it** — `--clean` runs the project's own clean step first if one exists (e.g. `npm run
   clean`, `./gradlew clean`), not a generic `rm -rf`. `--verbose` passes the build tool's own
   verbose flag through rather than adding extra logging on top.
4. **On failure**: parse the actual error output (don't just report "build failed") — identify
   which file/step failed and why, and stop; do not attempt to fix build configuration or install
   missing dependencies without the user's explicit request (that's out of scope here — see
   `/do-troubleshoot --type build` for diagnosis-first investigation of a failing build).
5. **On success with `--optimize`**: only apply optimizations the build system already supports
   natively (e.g. a production build flag, tree-shaking already configured) — do not add new
   bundler config.
6. **Report**: command run, exit status, artifact location(s) if produced, and timing.

## Boundaries
**Will:** detect and run the project's existing build system; report errors and artifact
locations; apply build-system-native optimizations under `--optimize`.
**Will Not:** create or modify build configuration/scripts; install missing dependencies or
toolchain components; diagnose *why* a build is failing beyond surfacing the raw error (that's
`/do-troubleshoot`'s job).
