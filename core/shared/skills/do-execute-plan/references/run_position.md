# Step 3 — positioning the run and dispatching on gate state

The gate-state dispatch behind `/do-execute-plan`'s step 3. The step's own purpose — which gate
stands before this stage, and why this skill is where it gets answered — stays in `SKILL.md`; what
follows is the call that positions the run and every branch off its response.

- `<slug>` is step 1's `feature_slug`; `<class>` is the class step 2's `classify` call accepted;
  `<stage id>` is the id of the entry in that call's `workflow.stages[]` whose `skill` is
  `do-execute-plan` (`implementation` in the `feature` workflow) — read it off that response,
  never hardcode a guess. One call positions the run: it starts one when none exists yet (an
  old-layout feature, or a chain that skipped straight here), backfills any earlier non-mutating
  stage as a routine handoff (marked `backfilled` in the trail, distinct from a stage its own
  skill actually completed), and stops on the node this skill must act on — or on any gate in the
  way, `clarification`-kind included, since only a human or that gate's own owning skill may
  decide it.
  ```bash
  "$DOFLOW" orchestrate --action catch-up --task-id "<slug>" --task-class "<class>" --stage "<stage id>" --note "entering implementation" --json
  ```
- Branch on the response's `caughtUpTo` / `reason`, not on the exit code:
- **`reason` is `awaiting-gate:<gate id>`** — **first check `<gate id>` against step 2's
  `<expected gate id>`.** They match in the ordinary case (`gate-a`, standing immediately before
  this stage) — present `awaitingGate.prompt` to the user through `AskUserQuestion` as a plain
  go/no-go, the same way step 1's prerequisite gate stops and asks rather than assuming. On yes:
  ```bash
  "$DOFLOW" orchestrate --action decide-gate --task-id "<slug>" --gate "<awaitingGate.gateId>" --decision approve --note "<the user's own answer, one line>" --json
  ```
  Then re-run the same `catch-up` call to land on this stage. If that re-run itself stops on
  *another* `awaiting-gate:`, re-apply this same check from the top — do not assume one approval
  clears the path; walk it exactly as far as it goes. On no: **stop the whole run here.** The gate
  is terminal in the same sense step 1's prerequisite gate is — report that the gate was not
  approved and dispatch nothing.
  **They do not match** — this is a gate belonging to an earlier stage, not this one. `gate-0`,
  left open by an aborted `/do-brainstorm` session, is exactly this case: it now surfaces here
  (catch-up stops on every gate, `clarification`-kind included) instead of being silently
  resolved on the way past. Report the gate id plainly and stop, the same way `do-design`,
  `do-plan`, `do-test` and `do-brainstorm` already handle a gate that isn't theirs. Never approve
  a gate this stage did not expect regardless of what the user answers — a "yes" given in an
  implementation context is not an answer to a different stage's clarification prompt, and
  `reject`'s "terminate the run outright" semantics are the wrong shape for a gate this stage has
  no standing to decide either way.
- **`caughtUpTo` is this stage id** (`reason: reached-candidate`) — the run is positioned exactly
  here and there is no gate to ask. That covers three cases at once and needs no special-casing
  between them: `/do-flow` already recorded the user's answer to that gate while driving the
  chain, this skill just recorded it in the branch above, or the accepted class declares no gate
  at all — `feature` is the only shipped class that declares any. Never ask a gate the run does
  not report as open; that is exactly the double-prompt this branch exists to prevent. Carry this
  `caughtUpTo` value to step 10; it is the stage id that call completes.
- **`reason` is `blocked-on-mutating-stage:<id>`** — a *different* source-mutating stage sits
  ahead of this one and its own skill has not executed it. Name `<id>`, report the block plainly,
  and dispatch nothing.
- **`reason` starts with `already-completed:`** — this stage was already recorded on an earlier
  run of this skill (a `--scope resume` after an interrupted run, say). Use `annotate` instead of
  `complete-stage`:
  ```bash
  "$DOFLOW" orchestrate --action annotate --task-id "<slug>" --node "<stage id>" --note "<what changed on this re-run>" --json
  ```
- **`reason` is `run-completed` or `run-rejected`** — the run is finished and takes no further
  stage. Report it and stop.
- Positioning the run is advisory to the trail, not to the work: if the `catch-up` call itself
  fails for a reason outside this flow's control (an unwritable local state directory, say),
  report the failure plainly and continue — the hard prerequisite gate step 1 already enforced is
  what governs whether this run may proceed. A user's explicit "no" above is not that case; it
  stops the run.
