# Recording a workflow handoff

After a skill finishes its work, call the resolved runtime seam:

```bash
"$DOFLOW" orchestrate --action handoff --task-id "<task>" --calling-skill "<skill>" --note "<what completed>" --json
```

Pass `--task-class` only when a classifying skill has accepted that class and may start a run.
Without an existing run or an explicit class, the result is `standalone` and no state is created.
An existing run supplies its own class; a conflicting supplied class is refused. Stage ownership
comes from that run's program, including every occurrence of a skill used more than once.

| `disposition` | Meaning | Caller action |
|---|---|---|
| `standalone` | No workflow applies | Finish the standalone report |
| `completed` | This skill's current occurrence was recorded | Report the result and inspect `awaitingGate` |
| `annotated` | All occurrences were already recorded; the latest received a rerun note | Report the amendment; do not replay stages |
| `deferred` | A prior gate, unfinished mutating stage or rejected run prevented the handoff | Report `reason`; leave the transition to its owner |

The runtime imports earlier non-mutating stages as `imported` + `unverified`, skips optional
stages, and stops at every gate and unfinished mutating stage. It never approves a gate. A mutating
candidate still requires the same live readiness evaluation as `complete-stage`.

Use `--result passed|failed|unverified` to record the stage's outcome. Omission records `unverified`.
For bug reproduction, observing the expected failure can satisfy the stage contract; the command's
nonzero exit alone is not the stage verdict. Reruns append a note and preserve the original outcome.

Only handle an `awaitingGate` if the skill owns that gate and the handoff just completed its anchor.
Follow the owning skill's decision rules; this API supplies no authorization. A deferral is not a
rejection. The lower-level `decide-gate` action remains explicit.

After recording work, regenerate the feature trail with `render-audit --slug="<task>" --json`.
An external recording failure must be reported; it does not change the substantive findings or
artifact correctness. A deferred workflow transition is still deferred, even when the artifact is
valid. Read the JSON fields rather than interpreting exit zero as completed work.
