# Task attempts

A task is done when the ledger says so, never from a `[x]` box or a `state.md` row. Every call takes
`--slug "<slug>"` (step 1's `feature_slug`) and `--json`; `<task id>` is the plan id (`A.1`).

**At resume**, read `"$DOFLOW" task-attempt --action status --slug "<slug>" --json` and branch on
each task's `derived`: `done` skip; `ready` claim; `running` inspect `active` (owner, start) and
release it if that worker is gone; `blocked` report it; `pending` an earlier phase is open. A task in
`unclaimedChecked` is ticked without a COMPLETED attempt: claim and verify it, or untick it.

**Before dispatch**, claim. `--mode` is `subagent`, `sequential` or `manual`:

```bash
"$DOFLOW" task-attempt --action claim --slug "<slug>" --task "<task id>" --owner "<agent>" --mode subagent --json
```

`claimed` returns the `token`; keep it. A refusal (exit 1) means do not dispatch: `active-attempt`,
`already-done`, `unmet-phase` (an earlier-phase task lacks a COMPLETED attempt; `unmet` lists them)
or `unknown-task`.

**After the agent returns**, verify in the parent run, record the result as evidence after the
claim (`--kind test-result --observed-command "<cmd>" --observed-exit <n>`, schema in the guidance
tree's `references/EVIDENCE_LEDGER.md`), then finish with the evidence id it returned:

```bash
"$DOFLOW" task-attempt --action finish --slug "<slug>" --task "<task id>" --token <token> --result COMPLETED --evidence-id "<id>" --json
```

COMPLETED needs an active, non-stale `test-result` that exited 0, is bound to the slug or the task
id, and was observed no earlier than the claim. The refusal names the reason; fix it and finish again.
`plan-changed` means the task's plan line was edited after the claim: release, reread, claim again.

**Otherwise** finish with `BLOCKED`, `ABANDONED` or `INCONCLUSIVE` (no evidence needed), or abandon a
dispatch with `--action release --token <token> --reason "<why>"`. `stale` (exit 1) means the token
is no longer the active one, so a late result from an abandoned dispatch changed nothing; read
`status`. There is no lease: a crashed claimer is cleared only by an explicit release.

**Before step 10**, read `status`; `complete: true` means every plan task has a COMPLETED attempt.
`orchestrate` refuses to complete this stage while a ledger exists and is incomplete, and records
`unverified` when the feature has no ledger. Exit 2 (malformed input, torn or newer-version store)
leaves the file unchanged: report it, do not repair it.
