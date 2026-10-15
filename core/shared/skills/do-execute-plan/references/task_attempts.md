# Task attempts

A task is done when the ledger says so, never from a `[x]` box or a `state.md` row. Every call takes
`--slug "<slug>"` (step 1's `feature_slug`) and `--json`; `<task id>` is the plan id (`A.1`).

**Read the JSON, not the exit code.** Exit 0: `claimed`, `applied`, `released`, `started`, `paused`,
`cancelled`, `resumed`, `reopened`, `usage-recorded`, or a `status`/`inspect` read. Exit 1:
`disposition` `refused`, `stale` or `ack-required`, with a `reason`. Exit 2: `{ ok: false, error }`.
No parseable JSON means the runtime is too old: treat it as `unsupported`, do not dispatch or record
a refusal, report the runtime version.

**Which flow.** A plan headed `**Task graph:** v1` follows every section below. Any other plan keeps
the legacy flow: skip resume and claim without `--epoch`.

**Resume first, every session (graph plan).** Before any other call:

```bash
"$DOFLOW" task-attempt --action resume --slug "<slug>" --json
```

It answers `ack-required` (exit 1) with `report` and `digest`. Read `report` (`control`, `epoch`,
`activeAttempts` with owner, age, `execWorktree`; `changedSources` and `doneChanged`, files edited
since a claim or COMPLETED; `unverifiable`, `staleContext`, `graph.changed`), act on it, then ack:

```bash
"$DOFLOW" task-attempt --action resume --slug "<slug>" --ack <digest> --by "<who>" --json
```

`resumed` returns the new `epoch`; `report-changed` means state moved, so read the new report and
ack its digest. Keep the epoch in session memory, never in `state.md` or any file.

**Autonomous runs** with no run (`control: 'none'`) start one with an explicit budget instead of
acking; `started` returns `epoch: 1`:

```bash
"$DOFLOW" task-attempt --action start --slug "<slug>" --by "<who>" --budget-attempts <n> [--budget-tokens <n>] --json
```

**Read state** with `--action status` (or `inspect` for graph, budgets and run totals) and branch on
each task's `derived`: `done` skip; `ready` claim (`reason` `reopened` or `plan-changed-after-done`:
the done attempt no longer counts, redo it); `running` inspect `active` (owner, start), release if
that worker is gone; `failed` claim again while `budget.used < budget.limit`, else replan;
`cancelled` clears only on resume; `blocked` report it; `pending` a dependency or earlier phase is
open (`unmet`, `held`). A task in `unclaimedChecked` is ticked with no COMPLETED attempt: claim and
verify it, or untick it.

**Claim before dispatch**, from the main session; a worker never claims. `--owner` is the task's
declared role; `--mode` (`subagent`, `sequential`, `manual`) must be the executor that will run. A
graph plan passes `--epoch`, a worker run `--exec-worktree <path>` (not the main session's: run refuses `exec-worktree-shared`), and a
run with a token limit `--reserve-tokens <n>` on every claim:

```bash
"$DOFLOW" task-attempt --action claim --slug "<slug>" --task "<task id>" --owner "<declared role>" --mode subagent --epoch <n> [--exec-worktree <path>] [--reserve-tokens <n>] --json
```

`claimed` returns the `token`; the worker finishes with it. A refusal means do not dispatch:
`active-attempt`, `already-done`, `unmet-phase`, `unmet-dependency`, `dependency-held` (`unmet`,
`held` list them), `unknown-task`, `resume-required` (resume first), `run-paused`, `run-cancelled`,
`owner-mismatch` (`declared` names the role; `--owner-override "<reason>"` only when deliberate),
`worker-session`, `budget-exhausted`, `cancelled` (resume clears it), `reservation-required`,
`aggregate-unaccounted` (on each ended attempt left unreported, `--action report-usage --task <id>
--token <n> --tokens <n> --tokens-basis …`) or `aggregate-exhausted`.

**After the agent returns**, verify in the parent run, record evidence after the claim (`--kind
test-result --observed-command "<cmd>" --observed-exit <n>`; schema in `references/EVIDENCE_LEDGER.md`),
and finish with the returned evidence id:

```bash
"$DOFLOW" task-attempt --action finish --slug "<slug>" --task "<task id>" --token <token> --result COMPLETED --evidence-id "<id>" [--tokens <n> --tokens-basis measured|estimated] --json
```

COMPLETED needs an active, non-stale `test-result` that exited 0, bound to the slug or task id,
observed no earlier than the claim; on refusal fix the named reason and finish again.
`plan-changed`: the plan line was edited after the claim, so release, reread, claim again.
`--tokens` and `--tokens-basis` go together, on finish or release; report them under a token limit.

**Otherwise** finish `BLOCKED`, `ABANDONED` or `INCONCLUSIVE` (no evidence), or `FAILED` with
`--reason "<why>"`; or abandon a dispatch with `--action release --token <token> --reason "<why>"`.
`stale` (exit 1): the token is no longer active, so a late result from an abandoned or cancelled
(`attempt-cancelled`) dispatch changed nothing; read `status`. There is no lease: only an explicit
release or cancel clears a crashed claimer.

**Run controls** (main session only, each with `--by "<who>"`):

- `--action pause --reason "<why>"`: claims refuse `run-paused`; active attempts may still finish.
- `--action cancel --reason "<why>"`: marks every active attempt of the run cancelled (`--adopt-unowned` adds attempts with no run; `--task <id> --token <n>` limits it to one). It stops no process.
- An acknowledged resume sets a paused or cancelled run running and clears its cancels.
- `--action reopen --task <id> --token <done token> --reason "<why>"`: the done attempt stops counting, the task is `ready` with `reason: reopened`; `dependentsActive` lists running dependents.
- Refusals: `run-exists` resume it; `identity-solo` or `worker-session` act from the main session; `control-unchanged` already so; `foreign-run` cancel from that run; `no-active-attempt`/`token-mismatch` (attempt cancel) or `not-done`/`token-mismatch` (reopen) read `status` for the token; `run-cancelled` resume first.

**Before step 10**, read `status`: `complete: true` means every task has a COMPLETED attempt (in a
graph plan, with its plan line unchanged; else `plan-changed-after-done`). `orchestrate` refuses to
complete this stage while a ledger exists and is incomplete, and records `unverified` with no
ledger. Exit 2 (malformed input, torn or newer-version store) leaves the file unchanged: report it,
do not repair it.
