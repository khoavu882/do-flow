# Parallel Subagent Orchestration Reference

Protocol for safe concurrent task execution by specialist subagents.

**Write-set isolation is decided by `do-parallel-check.sh`, not by judgement.** The scripts below
compute the grouping and the overlap set deterministically from `plan.md`. Read their output; do
not re-derive it by eye. If a script is unavailable, say so and fall back to `--sync` (one task at
a time) rather than guessing at which tasks are safe to run together.

## Resolving the scripts

Same resolver `SKILL.md` step 1 uses. Every command below assumes `$BASH_DIR` is set:

```bash
RESOLVER="${DOFLOW_CONFIG_DIR:+$DOFLOW_CONFIG_DIR/scripts/doflow/bash/do-paths.sh}"
if [ -z "$RESOLVER" ] || [ ! -f "$RESOLVER" ]; then
  d="$PWD"
  while [ "$d" != / ]; do
    [ -f "$d/.doflow/scripts/doflow/bash/do-paths.sh" ] && RESOLVER="$d/.doflow/scripts/doflow/bash/do-paths.sh" && break
    d="$(dirname "$d")"
  done
fi
BASH_DIR="$(dirname "$RESOLVER")"
```

## 1. Compute the dispatch groups

```bash
bash "$BASH_DIR/do-parallel-check.sh" --phase=<PHASE> --json
```

Returns, alongside the legacy per-task fields (`parallel_tasks`, `sequential_tasks`, `overlaps`,
`parallel_safe`, `serialize`):

| Field | Meaning |
|---|---|
| `groups[]` | `{id, owner, tasks[], files[]}` — one dispatch per entry. `id` is `<phase>:<owner>`. |
| `group_overlaps[]` | `{path, groups[]}` — groups whose write sets collide on `path`. |
| `group_serialize[]` | Group ids that **must not** run concurrently with each other. |
| `unowned_tasks[]` | Tasks with no `owner:`; each forms a singleton group with `owner: null`. |

Tasks sharing an `owner:` in the same phase merge into one group — one subagent runs them in
sequence, which is why two tasks in the *same* group may safely touch the same file. That is the
distinction between `overlaps` (per-task, still reported) and `group_overlaps` (cross-group, the
one that governs dispatch).

## 2. Dispatch

- Launch **one subagent per group**, concurrently, except that any two groups both listed in
  `group_serialize[]` must be run one after the other.
- Never split a group across subagents: its tasks are ordered and may share files.
- `--sync` suppresses fan-out entirely — every task runs serially in dependency order.
- `--no-group` falls back to per-task dispatch, using the legacy `overlaps`/`serialize` fields.

## 3. Build each group's brief

```bash
bash "$BASH_DIR/do-task-brief.sh" --group=<PHASE>:<OWNER> --tasks=<id,id,...> --json
```

Writes the group brief and returns its path in `group_brief`. The brief carries the shared preamble
once (where this fits, global constraints, component boundary), then a per-task block for each id in
the order given. Pass this file to the subagent — it is the whole contract for that dispatch.

For a single-task group the brief is byte-identical to `--task=<id>` output, so a one-task group and
an ungrouped task are the same dispatch.

Report paths for a group come from:

```bash
bash "$BASH_DIR/do-exec-paths.sh" --group=<PHASE>:<OWNER> --tasks=<id,id,...>
```

which returns `group_id`, `group_brief`, and `reports[]` ordered to match the task CSV. Each task
writes its own report before the next one starts.

All three scripts reject path traversal in group and task ids with exit 2. On any non-zero exit,
stop and surface the error — do not proceed with a partial grouping.

## 4. Phase-level quality review

Once every group in a phase reports complete, run an integrated phase quality review before
advancing. Max 2 fix iterations per review finding.

## Behavioral posture

For complex multi-step orchestration and execution checkpoints, consult the Task Management mode in
the installed guidance tree: `<config-dir>/guidance/modes/MODE_Task_Management.md` (for example
`~/.doflow/guidance/modes/MODE_Task_Management.md`). It sits under the DoFlow config directory, not
beside this file.
