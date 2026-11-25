---
name: do-test
description: "Execute project builds, automated test suites, and coverage verification with intelligent error reporting across whatever toolchain the repo already uses. Use whenever the user wants to run existing tests, execute test suites, verify builds, check test coverage, or check compile status (e.g., 'run the tests', 'execute test suite', 'check coverage', 'verify build', 'does this still build'). Always activate this skill when verifying test suites or running builds without writing new application code."
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
[ -x "$DOFLOW" ] || { echo "doflow: no runtime found in any .doflow/ above $PWD, nor at $HOME/.doflow. Run: npx @khoavu882/doflow install -t <harness>" >&2; exit 2; }
```

Run every command below from the project root — the walk-up starts at `$PWD`. On exit 2, print the message verbatim and stop; it names every path searched.

2. **State the contract before running anything** — compile it, do not recall it:

   `<task id>` is the plan task id when the run is scoped to one task, otherwise the feature slug —
   the same id every other stage used for it. `--risk` is an input the caller supplies: a change touching
   security, auth, payments or data migration is what `HIGH` is for.

   Optionally ask for a decision-model second opinion before compiling the contract:

```bash
"$DOFLOW" advise --kind verify-risk --state "<what the change touches, one paragraph>" --static "<the level you chose>" --task-id "<task id>" --json
```

   When `status` is `answered` and `agrees` is `false`, say so in one line and keep or change the level
   by your own judgement. Record the level used, and skip both calls when `status` is not `answered`:

```bash
"$DOFLOW" advise --action outcome --pick-id "<pickId>" --actual "<level>"
```

```bash
"$DOFLOW" verify --task-id "<task id>" --risk "<LOW|MEDIUM|HIGH|CRITICAL>" --action contract --json
```

   Report, before any tier runs:
   - the compiled `tiers[]` in the order returned — that list, and nothing else, is what will run;
   - the `riskLevel` it compiled at and the `maxRecoveryIterations` it carries;
   - `detection.absent` — the command roles the runtime could not find; those tiers are the likeliest to come
     back unresolved, so name them up front.

   Do not re-derive the toolchain by hand or substitute a runner the contract did not compile.

3. **Run the contract and report against it**:

```bash
"$DOFLOW" verify --task-id "<task id>" --risk "<the same level>" --action report --json
```

   When an explicit manifest and pinned ancestor baseline are provided, pass `--verification-input <file> --verification-phase postimplementation --baseline-ref <ref>`.

   Report every tier step 2 listed with the status the report gives it; a tier the run did not reach
   is reported as unreached, never omitted.

   With a feature map (the project's or the feature's), also read this skill's `references/feature-map.md` and run it. Before a property or fuzz campaign, run `"$DOFLOW" verify --action inner-loop --task-id "<task id>"`, relay a `REFUSED` verbatim and start no campaign.

4. **Read the verdict as it stands**:
   - Report `status` and its `reason` as the verb returns them. Never call a check passed that was
     not run, and never narrow the set to make the report green.
   - Coverage comes with the test tiers and with what the detected runner already emits, not from a
     separate request: report line and branch numbers when the runner produces them, and say
     plainly that it does not when it does not.
   - `--clean` forces a clean compile before the deterministic tiers run.
   - `--watch` launches interactive watcher mode when the detected runner supports it. It is an
     interactive session, not a verification run: it produces no contract verdict.

5. **Diagnostics & Reporting**:
   - Report pass/fail summaries, exact failure traces, and affected requirements.
   - Never skip or delete failing tests to force passing status.

6. **Record the handoff** — read the guidance tree's `references/WORKFLOW_HANDOFF.md`.
   Use the feature slug as `<task id>`; if no feature is active, this is standalone and there is
   no workflow handoff. After completing this skill's work:
   ```bash
   "$DOFLOW" orchestrate --action handoff --task-id "<task id>" --calling-skill do-test --note "<work completed and verification result>" --result <passed|failed> --json
   ```
   Report the returned `disposition` (a `deferred` one with its `reason`); resolve no gate in this
   skill. Render the trail after a recorded handoff:
   ```bash
   "$DOFLOW" render-audit --slug="<task id>" --json
   ```
   `passed` means the contract was met, including an expected failure in a reproduction stage.
   Missing verification is `unverified`, never an implied pass.

## Embedded feature research

For an external fact gap or request, follow the Gap or request protocol in `../do-document/references/embedded-research.md` before stage completion.

## Boundaries
**Will:** Run the compiled tiers, report every status (including unreached), coverage, and failure traces; hand off the current stage in a chain.
**Will Not:** Write tests or build config, narrow tiers, invent a verdict, resolve gates, or start a standalone run.
