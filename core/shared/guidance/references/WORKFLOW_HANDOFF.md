# Recording a workflow handoff

## Decisions first

Before the handoff call, run `"$DOFLOW" paths --json` again (not the stage's earlier result, which
can predate the register) and, when it reports `has_decisions: true`:

1. List the live decisions with `"$DOFLOW" decision --action list --json`. A decision that changes a
   live one reuses its topic and names it in `supersedes`; a new topic key is for a genuinely new
   subject only.
2. Register this stage's decisions (question answers, gate answers carrying a choice, decisions the
   user typed as prompts, "Decide for me" defaults, agent resolutions) in one
   `"$DOFLOW" decision --action add --batch <file>.json --json` call. Leave out an item already live
   with the same statement, such as a gate answer do-flow registered. Each item needs `topic`
   (kebab-case), `statement` (one line), `channel` (`question|gate|prompt|default|resolution`),
   `stage` (the ownership-table stage name) and `rationale`; `supersedes`, `refs` and `source` are
   optional. Skip the call when there are none. On exit 1 `topic-conflict`, add `supersedes` for the
   named live decision or drop the duplicate item, then retry; on exit 1 `register-locked`, retry
   once; on exit 2, fix the named item and retry. Never hand off with the stage's decisions
   unregistered without saying so.
3. Write each returned `DEC-###` into the lines of this stage's own artifacts that apply it
   (ARTIFACT_FORMAT.md §12).
4. Run `"$DOFLOW" validate`. Correct each `stale` or `unknown` finding in an artifact this stage
   owns, changing only the flagged line; report findings in other artifacts without editing them.
5. Record the handoff below. It compacts History itself and reports `compaction`; its `--task-id`
   must be the feature slug, not a plan task id, or compaction is skipped. A do-execute-plan
   checkpoint (`annotate`) does not compact; the next completed handoff does.

| Stage | Owns |
|---|---|
| discovery | `intention/requirement.md` |
| design | `design/design.md`, `design/specs.md`, `design/data-model.md` |
| planning | `plan.md` |
| implementation, verification, review | none; findings are reported |

## The handoff call

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
