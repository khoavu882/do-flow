# Recording a workflow handoff

## Decisions first

Before the handoff call, run `"$DOFLOW" paths --json` again (not the stage's earlier result, which
can predate the register) and, when it reports `has_decisions: true`:

1. List the live decisions with `"$DOFLOW" decision --action list --json`. A decision that changes a
   live one reuses its topic and names it in `supersedes`; a new topic key is for a genuinely new
   subject only.
2. Register this stage's decisions (question answers, gate answers carrying a choice, decisions the
   user typed as prompts, "Decide for me" defaults, agent resolutions) in one
   `"$DOFLOW" decision --action add --batch <file>.json --json` call. Drop an item that only
   rewords a live decision (such as a gate answer do-flow registered); it neither registers nor
   supersedes. Each item needs `topic` (kebab-case), `statement` (one line), `channel`
   (`question|gate|prompt|default|resolution`), `stage` (the ownership-table stage name) and
   `rationale`; `supersedes`, `refs` and `source` are optional. Skip the call when there are none.
   On exit 1 `topic-conflict`, drop a reword of the named live decision, else add `supersedes` for it,
   and retry; on `register-locked`, retry once; on exit 2, fix the named item and retry. Hand off with the stage's decisions registered, or say which are not.
3. Write each returned `DEC-###` into the lines of this stage's own artifacts that apply it
   (ARTIFACT_FORMAT.md §12). A stage that owns no artifact puts the FR/IC ids each
   decision applies to in the item's `refs` and names the returned `DEC-###` ids in the
   handoff `--note`; it edits no artifact another stage owns.
4. Run `"$DOFLOW" validate`. Fix each `stale` or `unknown` finding in an artifact this stage
   owns, changing only the flagged line (an `unknown` one takes the right identifier from the live
   list); report findings in other artifacts, unedited.
5. Record the handoff below. It compacts History itself and reports `compaction`; its `--task-id`
   must be the feature slug, not a plan task id, or compaction is skipped. A do-execute-plan
   checkpoint (`annotate`) does not compact; the next completed handoff does.

| Stage | Owns |
|---|---|
| discovery | `intention/requirement.md` |
| design | `design/design.md`, `design/specs.md`, `design/data-model.md` |
| planning | `plan.md` |
| implementation, verification, review | none; findings are reported |

With or without a register, record in this step each finding left unfixed, item named out of scope
and gate answer that defers work:
`"$DOFLOW" followup --action add --stage <stage> --statement "<one line>"`.

## Unattended stage

Per stage run `"$DOFLOW" attendance --task-id "<feature_slug>"`. Unless it printed a line starting
`unattended`, ask as the skill says. Otherwise RULE_04 applies and:

1. **Ask nothing, decide no gate.** Gates are the loop's: no `decide-gate` (not even for zero
   markers); hand off and stop. A gate is never a default, nor is closing a goal.
2. **The run supplies** the class (`taskClass` in `orchestrate --action status --task-id
   "<feature_slug>" --json`), the slug (the `feat/<slug>` branch) and `commit.branch`. A rejected
   class, several slugs, a `--from` clash or readiness `ASK_USER` halts.
3. **Adopt the recommended option** where one exists, even if it changes a contract or behaviour
   beyond the request, in the decision batch: `channel` `default`, `rationale` `unattended:<source>`,
   `undo` (one line: how to reverse it), `stage` the nearest accepted ownership-table name.
4. **Also halt, never hand off,** when no option can be recommended, a permission is denied, or the
   step would send content off this machine, start a paid run as the person or delete what the run
   did not create: `"$DOFLOW" followup --action add --stage <stage as in 3> --statement "<why it
   blocks>"`, report and stop; the row is held.
5. **Never apply `--fix` or send private context** (leave the request `unresolved`).

## The handoff call

After a skill finishes its work, call the resolved runtime seam:

```bash
"$DOFLOW" orchestrate --action handoff --task-id "<task>" --calling-skill "<skill>" --note "<what completed>" --json
```

Pass `--mcp-outcome <server>=used|nothing-usable|skipped:<reason>|unavailable` once per MCP server
your step names; a server left without one prints a warning, not a block.

Pass `--task-class` only when a classifying skill has accepted that class and may start a run.
With no run and no class the result is `standalone` and no state is created. A run supplies its own
class (a conflicting one is refused); its program gives stage ownership, including each occurrence
of a repeated skill.

| `disposition` | Meaning | Caller action |
|---|---|---|
| `standalone` | No workflow applies | Finish the standalone report |
| `completed` | This skill's current occurrence was recorded | Report the result and inspect `awaitingGate` |
| `annotated` | All occurrences were already recorded; the latest received a rerun note | Report the amendment; do not replay stages |
| `deferred` | A prior gate, unfinished mutating stage or rejected run prevented the handoff | Report `reason`; leave the transition to its owner |

The runtime imports earlier non-mutating stages as `imported` + `unverified`, skips optional
stages, and stops at every gate and unfinished mutating stage, never approving a gate. A mutating
candidate needs the same live readiness evaluation as `complete-stage`.

Use `--result passed|failed|unverified` to record the stage's outcome. Omission records `unverified`.
For bug reproduction, observing the expected failure can satisfy the stage contract; the command's
nonzero exit alone is not the stage verdict. Reruns append a note and preserve the original outcome.

Only handle an `awaitingGate` if the skill owns that gate and the handoff just completed its anchor;
unattended, never handle one (§ Unattended stage).
Follow the owning skill's decision rules; this API supplies no authorization. A deferral is not a
rejection. The lower-level `decide-gate` action remains explicit.

After recording work, regenerate the feature trail with `render-audit --slug="<task>" --json`.
Report a recording failure; it changes no finding or artifact verdict. A deferred transition stays
deferred even when the artifact is valid. Read the JSON fields, not exit zero, for completed work.
