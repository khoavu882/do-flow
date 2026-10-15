# Task attempts

A task is done when the ledger says so, never from a `[x]` box or a `state.md` row. Every call takes
`--slug "<slug>"` (step 1's `feature_slug`) and `--json`; `<task id>` is the plan id (`A.1`).

**Read the JSON, not the exit code.** Exit 0 is `claimed`, `applied`, `released`, `started`,
`paused`, `cancelled`, `resumed`, `reopened` or a `status`/`inspect` read; exit 1 carries
`disposition` `refused`, `stale` or `ack-required` with a `reason`; exit 2 carries `{ ok: false,
error }`. No parseable JSON on stdout means the runtime is too old for the call: treat it as
`unsupported`, do not dispatch, do not record a refusal, and report the runtime version.

**Which flow.** A plan whose header carries `**Task graph:** v1` is a graph plan and follows every
section below. A plan without that header keeps the legacy flow: skip resume, claim without
`--epoch`, and the rest reads as written.

**First call of every session (graph plan): resume.** Before any other runtime call, read the report:

```bash
"$DOFLOW" task-attempt --action resume --slug "<slug>" --json
```

It answers `ack-required` (exit 1) with `report` and `digest`. Read `report`: `control`, `epoch`,
`activeAttempts` (owner, age, `execWorktree`), `changedSources` and `doneChanged` (files edited since
a claim or a COMPLETED), `unverifiable`, `staleContext` and `graph.changed`. Act on what it shows,
then acknowledge with the digest you read:

```bash
"$DOFLOW" task-attempt --action resume --slug "<slug>" --ack <digest> --by "<who>" --json
```

`resumed` returns the new `epoch`. `report-changed` means the state moved between the two calls:
read the new report and acknowledge its digest. Keep the epoch in this session's memory only; never
write it to `state.md` or any file, so the next session must resume and read the report itself.

**Autonomous runs** with no run yet (`control: 'none'`) start one instead of acknowledging, with
an explicit budget rather than the derived default; `started` returns `epoch: 1`:

```bash
"$DOFLOW" task-attempt --action start --slug "<slug>" --by "<who>" --budget-attempts <n> [--budget-tokens <n>] --json
```

**Then read state**: `"$DOFLOW" task-attempt --action status --slug "<slug>" --json` (or `inspect`
for graph, budgets and run totals), and branch on each task's `derived`: `done` skip; `ready` claim
(`reason` `reopened` or `plan-changed-after-done` means a done attempt no longer counts, so redo
it); `running` inspect `active` (owner, start) and release it if that worker is gone; `failed`
claim again while `budget.used < budget.limit`, otherwise replan; `cancelled` clears only on a
resume; `blocked` report it; `pending` a dependency or earlier phase is open (`unmet`, `held`). A
task in `unclaimedChecked` is ticked without a COMPLETED attempt: claim and verify it, or untick it.

**Before dispatch**, the main session claims; a worker never claims. `--owner` is the task's
declared role in all three modes; `--mode` (`subagent`, `sequential` or `manual`) names the
executor and must be the mode that will run. In a graph plan pass `--epoch`, and for a worker run
`--exec-worktree <path>`, the worktree it is dispatched into:

```bash
"$DOFLOW" task-attempt --action claim --slug "<slug>" --task "<task id>" --owner "<declared role>" --mode subagent --epoch <n> [--exec-worktree <path>] [--reserve-tokens <n>] --json
```

`claimed` returns the `token`; hand it to the worker, which finishes with it. A run with a token
limit needs `--reserve-tokens <n>` on every claim. A refusal (exit 1) means do not dispatch:
`active-attempt`, `already-done`, `unmet-phase`, `unmet-dependency` or `dependency-held` (`unmet`,
`held` list them), `unknown-task`, `resume-required` (resume first), `run-paused`, `run-cancelled`,
`owner-mismatch` (`declared` names the role; `--owner-override "<reason>"` only when deliberate),
`worker-session` (a worker tried to claim), `budget-exhausted`, `cancelled` (resume clears it),
`reservation-required`, `aggregate-unaccounted` (report usage on earlier attempts) or
`aggregate-exhausted`.

**After the agent returns**, verify in the parent run, record the result as evidence after the
claim (`--kind test-result --observed-command "<cmd>" --observed-exit <n>`, schema in the guidance
tree's `references/EVIDENCE_LEDGER.md`), then finish with the evidence id it returned:

```bash
"$DOFLOW" task-attempt --action finish --slug "<slug>" --task "<task id>" --token <token> --result COMPLETED --evidence-id "<id>" [--tokens <n> --tokens-basis measured|estimated] --json
```

COMPLETED needs an active, non-stale `test-result` that exited 0, is bound to the slug or the task
id, and was observed no earlier than the claim. The refusal names the reason; fix it and finish again.
`plan-changed` means the task's plan line was edited after the claim: release, reread, claim again.
`--tokens` and `--tokens-basis` go together, on finish or release; report them under a token limit.

**Otherwise** finish with `BLOCKED`, `ABANDONED` or `INCONCLUSIVE` (no evidence needed), or `FAILED`,
which needs `--reason "<why>"`; or abandon a dispatch with `--action release --token <token>
--reason "<why>"`. `stale` (exit 1) means the token is no longer the active one, so a late result
from an abandoned or cancelled (`attempt-cancelled`) dispatch changed nothing; read `status`. There
is no lease: a crashed claimer is cleared only by an explicit release or cancel.

**Run controls** (main session only; each takes `--by "<who>"`):

- `--action pause --reason "<why>"`: claims refuse `run-paused`; active attempts keep running and may finish.
- `--action cancel --reason "<why>"`: cancels every active attempt of the run (`--adopt-unowned` also takes attempts with no run); with `--task <id> --token <n>`, only that attempt. It marks attempts; it does not stop a process.
- Paused or cancelled, an acknowledged resume sets the run running again and clears its cancels.
- `--action reopen --task <id> --token <done token> --reason "<why>"`: the done attempt stops counting, the task is `ready` with `reason: reopened`; `dependentsActive` names running dependents for you to decide about.

**Before step 10**, read `status`; `complete: true` means every plan task has a COMPLETED attempt
(in a graph plan, one whose plan line is unchanged; `plan-changed-after-done` otherwise).
`orchestrate` refuses to complete this stage while a ledger exists and is incomplete, and records
`unverified` when the feature has no ledger. Exit 2 (malformed input, torn or newer-version store)
leaves the file unchanged: report it, do not repair it.
