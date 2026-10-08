# Step 10 — recording the stage handoff

The procedural detail behind `/do-execute-plan`'s step 10. `SKILL.md` carries when the step runs
and the completion-vs-checkpoint decision it turns on; what follows is how each branch is carried
out. `readiness_gate.md`, referenced below, sits beside this file.

- **First: is this run a completion or a checkpoint?** Re-read `plan.md`'s task checklist and
  count the task lines still unchecked. A real task line matches `^- \[ \] [A-Z]+\.[0-9]+` (a
  phase letter, a dot, a number — `- [ ] B.2`); the pattern deliberately excludes the generic
  `- [ ] All tasks checked` line in the plan's own "Completion criteria" section, which carries
  no phase-letter id and is not a task.
  ```bash
  grep -cE '^- \[ \] [A-Z]+\.[0-9]+' "<plan path>"
  ```
  **Any such line remaining means this run's handoff is a checkpoint, not a completion** — the
  normal outcome of a `--scope next` or `--scope phase:N` run, which finishes some of the plan by
  design. Record the checkpoint and stop; do **not** attempt `complete-stage`, which would hand
  the stage off while tasks nobody executed are still open:
  ```bash
  "$DOFLOW" orchestrate --action annotate --task-id "<slug>" --node "<stage id>" --note "<checkpoint: N of M tasks done, scope was --scope next|phase:X>" --json
  ```
  Only when zero such lines remain does the completion flow below run.
- **Then: confirm the readiness record before completing.** This stage is the workflow's
  `mutatesSource` stage, so the handoff reads the record `readiness` wrote and refuses without a
  `READY` one made before the call; it evaluates nothing itself (`readiness_gate.md`).
  1. The `affected_components` evidence batch and the `READY` readiness call, both under the
     feature slug, happen before Phase 1 is dispatched (`SKILL.md` step 4), not here. A refusal names the `readiness` command to run:
     run it, gather what it lists until it reports `READY`, then repeat the handoff.
  2. Then record the handoff. This is the genuine completion case (every task checked), the one
     case where reaching this stage's candidate and recording it as done are the same fact, so
     `handoff`'s always-complete-on-reach behavior is exactly right here and cannot mismark
     unfinished work: the checkpoint branch above never reaches this call:
     ```bash
     "$DOFLOW" orchestrate --action handoff --task-id "<slug>" --task-class "<class>" --calling-skill do-execute-plan \
       --note "<one line, e.g. tasks A.1–E.5 complete>" --result passed --json
     ```
     `--task-class` still matters here even though the run already carries one: a conflicting
     value is refused, so passing it is a check, not a formality. `--result` reflects step 9's phase
     review (when it ran) and step 6's own check runs, never asserted as `passed` when a review
     finding was left unfixed. Without `--review` the result rests on the verification the run did,
     and the note says the per-phase review was not requested.
- **Report the resulting `disposition` plainly.** `completed` means a `READY` record was
  found and the cursor advanced to the verification stage — check
  its `awaitingGate`; `null` means no gate follows this stage in this workflow. `deferred` means
  a gate, an unfinished mutating stage elsewhere, or a rejected run prevented it — report
  `reason` plainly, this stage resolves no gate. If the handoff refuses for readiness,
  report exactly what is unmet and fix that with the `readiness` command it names — do not
  re-run under a class that grades looser, never assert `READY` yourself, and do not swallow the
  failure into an `annotate`. The `annotate` path above belongs to the unfinished-tasks case
  alone; it is not a catch-all for an unexpected readiness failure here. Finish by rendering the
  trail — the `--slug` value attaches with an `=`; a space-separated one is rejected with an
  error rather than silently rendering the wrong feature's trail:
  ```bash
  "$DOFLOW" render-audit --slug="<slug>" --json
  ```
- Same standing as step 8's `state.md` write: bookkeeping, not a gate. A failure here degrades
  the trail, not the correctness of the work already done — report it and continue.
