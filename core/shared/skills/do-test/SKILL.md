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

6. **Record the handoff** — when this run is a chain stage rather than a standalone test run, record
   it on the feature's trail. Resolve the feature and ask the state machine where it stands:

```bash
"$DOFLOW" paths --json
"$DOFLOW" orchestrate --action status --task-id "<feature_slug>" --json
```

   - **`feature_slug` is `null`, or `status` reports `No workflow run for task`** (exit 1) — this is
     a standalone verification run: no chain stage started a run for this feature, and this skill
     proposes no task class of its own to start one from. Record nothing and skip the rest of this
     step; the report you already produced is the whole output. Do not invent a run.
   - **A run exists** — its response names the `taskClass` it was started under. That is where this
     skill's class comes from: it proposes none of its own and runs no `classify` call.
   - **Resolve this skill's candidate stage ids — there may be more than one.** List *every* entry in
     `"$DOFLOW" workflow --task-class "<taskClass>" --json`'s `stages[]` whose `skill` is `do-test`,
     in workflow order, and comma-join them. One entry in the `feature` workflow (`verification`);
     **two** in `bug` (`reproduction,regression-verification`) and in `refactor`
     (`baseline-verification,verification`), because those classes run this skill twice. Passing both
     is what makes a second real run of this skill land on the second occurrence rather than misfire
     on the first, already-completed one — `catch-up` walks past a completed stage because it is no
     longer the current node. Never hardcode a stage id, and never pass only the first match.
   - **Position the run and act on where it stops:**
     ```bash
     "$DOFLOW" orchestrate --action catch-up --task-id "<feature_slug>" --task-class "<taskClass>" --stage "<id1[,id2]>" --note "entering verification" --json
     ```
     Branch on the response's `caughtUpTo` / `reason`, not on the exit code:
     - **`caughtUpTo` is one of your ids** (`reason: reached-candidate`) — that occurrence is the
       run's current node, and it is the one this run completes:
       ```bash
       "$DOFLOW" orchestrate --action complete-stage --task-id "<feature_slug>" --stage "<caughtUpTo>" --note "<one line: the contract's verdict and tier summary>" --json
       ```
     - **`reason` starts with `already-completed:`** — every occurrence you named is already
       recorded (a re-invocation after both `bug`/`refactor` test stages already completed, say).
       Use `annotate` instead of `complete-stage`:
       ```bash
       "$DOFLOW" orchestrate --action annotate --task-id "<feature_slug>" --node "<one of the ids>" --note "<what changed on this re-run>" --json
       ```
     - **`reason` starts with `awaiting-gate:`** — the run is paused on a gate a human (or that
       gate's own owning skill) decides. No gate in any shipped workflow is this skill's to answer,
       so report the gate id plainly and stop rather than resolving one that is not yours.
     - **`reason` is `blocked-on-mutating-stage:<id>`** — a source-mutating stage sits ahead of this
       one and its own skill has not executed it. In `bug` and `refactor` that is the ordinary answer
       when this skill is re-invoked before the fix has been applied. Name `<id>`, report the block
       plainly, and stop.
     - **`reason` is `run-completed` or `run-rejected`** — the run is finished and takes no further
       stage. Report it and stop.
   - No gate is anchored to this stage in any shipped workflow, and the `complete-stage` response
     says so directly: its `awaitingGate` comes back `null`. Read that field rather than re-deriving
     it from `workflow.gates[]`, and decide no gate when it is null. Finish by rendering the trail —
     the `--slug` value attaches with an `=`; a space-separated one is rejected with an error rather
     than silently rendering the wrong feature's trail:
     ```bash
     "$DOFLOW" render-audit --slug="<feature_slug>" --json
     ```
   - Every call in this step is advisory to the trail, not to the verdict. If one fails for a reason
     outside this flow's control (an unwritable local state directory, say), report the failure plainly
     and continue — a missing `audit.md` entry changes nothing about what the tiers reported, and
     none of these calls gates this skill's own completion.

## Boundaries
**Will:** Compile the verification contract before running anything, run the tiers it names, report every tier's status including the ones that were never reached, report the coverage the detected runner emits, highlight failure traces, and record the stage handoff through `orchestrate`/`render-audit` when this run is part of a chain — against whichever of its own stage occurrences the run is actually positioned on, in a class that runs it twice.
**Will Not:** Write new test files (handled during implementation), modify build configuration files, narrow the compiled tier set, report a verdict the contract did not produce, resolve a workflow gate, or start a workflow run for a standalone verification.
