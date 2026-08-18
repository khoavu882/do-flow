# do-diagnose — root cause: `npm test` wall time

**Task class:** `bug` (ACCEPTED via `doflow classify`; this run serves the `root-cause` stage of
the Bug Fix workflow: reproduction → **root-cause** → implementation → regression-verification →
review). `--type perf` selected the investigation mode (Classify Intent & Scope, step 3).

## Claim (status: supported)

> The suite's wall-clock time is dominated by three subprocess-spawning end-to-end test files
> (`cli-e2e.test.js`, `runtime-evidence-write.test.js`, `install-shapes.test.js`) that shell out to
> real `node <cli/runtime>` invocations with real filesystem I/O rather than testing in-process; two
> of those files were added today, pushing full-suite wall time from ~14.6s (pre-today) to ~16.5s
> (current), while the pre-existing `cli-e2e.test.js` (~13s standalone) is unchanged in this window.

Recorded in the runtime evidence ledger at
`.doflow/state/evidence/bench-boundary-do-diagnose-2.json` as `claim_msybvkc6_1`, linked to 8
supporting evidence items (`ev_msybverz_1`..`ev_msybverz_9`, minus the test-result item which is
unrelated to timing).

## Evidence (extracted unless noted)

1. **Full-suite baseline, current HEAD (`f5fa836`)** — `npm test`, three runs: `# tests 573`,
   `# pass 572`, `# fail 1`, `# duration_ms` 16382.06 / 16084.84; `time npm test` wall clock
   16.553s total (18.18s user, 12.42s system, 184% cpu). This matches the prompt's "about 15
   seconds" observation closely enough to treat as the same suite.

2. **Per-file timing sweep** — `node --test <file>` run individually for all 59 files under
   `test/`. Top 3 by wall time: `test/cli-e2e.test.js` 13109ms, `test/runtime-evidence-write.test.js`
   7912ms, `test/install-shapes.test.js` 7593ms. Next-highest: `test/guards/reachability.test.js`
   1989ms, then a long tail under 500ms each. These three files alone account for the entire
   critical path; everything else is noise by comparison.

3. **Structural cause in the heaviest file** — `test/cli-e2e.test.js` has 46 top-level `test()`
   cases and its `run()` helper (`spawnSync('node', [DOFLOW, ...args])`) appears ~90 times
   (definition + call sites) — roughly 145ms per spawn given 13109ms over 90 spawns. Each spawn
   performs a real install/update/rollback against a temp `HOME` across the full harness tree —
   this is process-spawn-and-disk-I/O cost, not algorithmic complexity in the test bodies.

4. **Same pattern in the other two heavy files** — `test/runtime-evidence-write.test.js` (28
   tests) and `test/install-shapes.test.js` (7 tests) each define their own
   `spawnSync('node', [CLI/DOFLOW, ...])` helper; `runtime-evidence-write.test.js` calls it at 22
   call sites.

5. **Historical check — what actually changed "this week"** — `git log --diff-filter=A` shows
   `test/runtime-evidence-write.test.js` and `test/install-shapes.test.js` were both **added
   today** (2026-08-18) by commits `1fbab13` (09:23 +0700) and `f5fa836` (13:19 +0700).
   `test/cli-e2e.test.js`, by contrast, has existed since `e3748a7` (2026-07-09) and is unchanged
   in size (795 lines / 46 tests) between `bbbaf4a` (the commit immediately before today's
   additions) and current HEAD.

6. **Direct before/after measurement** — `npm test` run against commit `bbbaf4a` in a temporary
   detached `git worktree` (node_modules symlinked from the sandbox, then torn down after
   measuring): `# tests 473`, `# pass 473`, `# fail 0`, `# duration_ms 14406.95`; wall clock
   14.588s total (9.57s user, 5.64s system, 104% cpu).

7. **Isolating the one file that didn't change** — `node --test test/cli-e2e.test.js` alone
   against the `bbbaf4a` worktree: `# duration_ms 13002.89`, wall clock 13.039s — matches its
   13109ms cost measured against current HEAD to within noise. This file's cost is pre-existing,
   not new this week.

8. **Unrelated observation, not chased** (`--focus performance` scopes this run) — one
   reproducible failure, `not ok 299 - G11: real feature artifacts generate a contained, idempotent
   scaffold`, present on every run at current HEAD. Flagged for a separate `bug`-class diagnosis;
   out of scope here.

## Reading the numbers

- Wall time went from ~14.6s to ~16.5s this week (+~2s, +14%), while test count grew from 473 to
  573 (+100) and file count from 39 to 59 (+20).
- The increase is **not** explained by the previously-dominant `cli-e2e.test.js` — it's byte- and
  timing-identical before and after.
- It **is** explained by two new subprocess-heavy e2e files landing on the same day, adding a
  second and third multi-second-per-file cost. `node --test` parallelizes across a limited pool
  (10 CPUs on this machine); with ~56 of 59 files finishing in well under 500ms, the suite's floor
  is set by whichever of the three heavy files finishes last, not by their sum — so each new
  multi-second file extends the critical path roughly by its own marginal cost over whatever was
  previously the slowest file.
- Root cause, in one line: **the regression is process-spawn-and-real-disk-I/O cost in newly added
  end-to-end CLI tests, not an algorithmic slowdown** — `install`/`update`/`rollback` lifecycle
  behavior is being exercised via full subprocess round-trips (~100-150ms each) rather than
  in-process calls into the adapter/runtime functions the tests are actually trying to cover.

## What this run does NOT do

Per the skill's Boundaries, no `--fix` was passed, so no remediation was applied. Boundaries:
"Will Not: Apply edits without `--fix` and explicit confirmation." Candidate remediation
directions (not applied, for a future `--fix` pass with user approval): batching multiple
assertions per subprocess spawn where the CLI supports composite invocations, converting a subset
of the lifecycle assertions to call the adapter functions directly (in-process) instead of via
`spawnSync('node', ...)`, or explicitly bounding `node --test`'s concurrency so the three heavy
files run alongside more of the light ones rather than serializing on top of each other.
