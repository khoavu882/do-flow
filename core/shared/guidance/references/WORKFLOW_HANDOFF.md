# Recording a workflow handoff

## Decisions first

Before the handoff call, run `"$DOFLOW" paths --json` again (not the stage's earlier result, which
can predate the register) and, when it reports `has_decisions: true`:

1. List the live decisions with `"$DOFLOW" decision --action list --json`. A decision that changes a
   live one reuses its topic and names it in `supersedes`; a new topic key is for a genuinely new
   subject only. A replacement on another topic, or of part of one, is recorded after the add with `"$DOFLOW" decision --action link --from <new> --to <old> --kind supersedes|narrows|reopens`, and a settled decision leaves the live view with `decision --action retire`, not with prose.
2. Register this stage's decisions (question answers, gate answers carrying a choice, decisions the
   user typed as prompts, "Decide for me" defaults, agent resolutions) in one
   `"$DOFLOW" decision --action add --batch <file>.json --json` call. Drop an item that only
   rewords a live decision (such as a gate answer do-flow registered); it neither registers nor
   supersedes. Each item needs `topic`, `statement`, `channel` (`question|gate|prompt|default|resolution`), `stage` (the ownership-table
   stage name) and `rationale`; the verb names a bad value. Skip the call when there are none.
   On exit 1 `topic-conflict`, drop a reword of the named live decision, else add `supersedes` for it,
   and retry; on `register-locked`, retry once; on exit 2, fix the named item and retry. Hand off with the stage's decisions registered, or say which are not.
3. Write each returned `DEC-###` into the lines of this stage's own artifacts that apply it
   (ARTIFACT_FORMAT.md §12). A stage that owns no artifact puts the FR/IC ids each
   decision applies to in the item's `refs` and names the returned `DEC-###` ids in the
   handoff `--note`; it edits no artifact another stage owns.
4. Run `"$DOFLOW" validate`. Fix each `stale` or `unknown` finding in an artifact this stage
   owns, changing only the flagged line (an `unknown` one takes the right identifier from the live
   list); report findings in other artifacts, unedited.
5. Record the handoff below. Its `--task-id` must be the feature slug, not a plan task id, or
   History compaction is skipped.

| Stage | Owns |
|---|---|
| discovery | `intention/requirement.md` |
| design | `design/design.md`, `design/specs.md`, `design/data-model.md` |
| planning | `plan.md` |
| implementation, verification, review | none; findings are reported |

With or without a register, record in this step each finding left unfixed, item named out of scope
and gate answer that defers work:
`"$DOFLOW" followup --action add --stage <stage> --statement "<one line>"`.
When `add` flags a similar item, run `"$DOFLOW" followup --action propose` and offer the check before any prose line.

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
your step names.

Pass `--task-class` only when a classifying skill has accepted that class and may start a run.

| `disposition` | Meaning | Caller action |
|---|---|---|
| `standalone` | No workflow applies | Finish the standalone report |
| `completed` | This skill's current occurrence was recorded | Report the result and inspect `awaitingGate` |
| `annotated` | All occurrences were already recorded; the latest received a rerun note | Report the amendment; do not replay stages |
| `deferred` | A prior gate, unfinished mutating stage or rejected run prevented the handoff | Report `reason`; leave the transition to its owner |

Use `--result passed|failed|unverified` to record the stage's outcome. Omission records `unverified`.
For bug reproduction, observing the expected failure can satisfy the stage contract; the command's
nonzero exit alone is not the stage verdict.

Only handle an `awaitingGate` if the skill owns that gate and the handoff just completed its anchor;
unattended, never handle one (§ Unattended stage).
Follow the owning skill's decision rules; this API supplies no authorization.

After recording work, regenerate the feature trail with `render-audit --slug="<task>" --json`.
Report a recording failure; it changes no finding or artifact verdict. Read the JSON fields, not exit zero, for completed work.
