# Spec: telemetry contract v1

Contract document for feature 088 (IC-001, IC-002, IC-003, IC-004, IC-006, IC-018). The machine-readable
form is `core/registry/telemetry.json`; this page is its prose mirror. When the two disagree the
registry is right, and `test/guards/telemetry-contract.test.js` (G45) is what
notices.

Telemetry here means local metadata about DoFlow's own runs: how long a hook took, which tier of a
verify run ran and how it ended. It is never content, it never leaves the machine, and it never
changes what a command prints, returns or decides.

## What a line is

One JSON object per line, appended to `<config>/state/runs/telemetry/<UTC date>.jsonl`, where
`<config>` is the resolved `.doflow` directory (`DOFLOW_CONFIG_DIR`, else the nearest `.doflow` above
the working directory, passing over a `.doflow` inside another `.doflow` (a dispatch worktree's) to
continue to the project's store; that worktree `.doflow` used to hide the project store because the
launch writes the worker's delivery pack into its own `.doflow/state/delivery`). The directory sits
under `runs/` as a subdirectory, so the run ledger's
readers, which list only `YYYY-MM-DD.jsonl` files directly under `runs/`, never see it. The store is
`runs-telemetry` in `core/registry/storage.json`: date partitions, pruned after 180 days.

Lines are keyed on `kind`, never on `verb`. The run ledger drops any line without a `verb`
(`src/runtime/trace/ledger.ts`), which is why telemetry has its own writer.

## Switch

`DOFLOW_TELEMETRY=off` in the invoking environment stops every telemetry write: no line, no trace id,
no verify record. Any other value, or none, leaves telemetry on. `telemetryOff(env)` in
`src/runtime/trace/telemetry.ts` is the only Node reader of the string; the shell bridge and the
observer compare the same string. Off changes no exit code, output or verdict. The V0 behaviour flag
is a separate switch (`DOFLOW_VERIFY_V0`) and is independent of this one.

## Common keys

Every line carries these. Key order carries no meaning: the Node writer puts them first, and the
bridge writes hook lines in its own fixed order (see Hook lines).

| Key | Type | Class | Source |
|---|---|---|---|
| `timestamp` | `iso8601ms` | T1 | the record's own value when it is ISO 8601 UTC with milliseconds, else the clock |
| `kind` | `enum:kind` | T2 | the record; a record without a registered `kind` is not written |
| `run` | `id` or null | T0 | `DOFLOW_RUN_ID`; `local` and invalid values give null |
| `lineage` | `id` or null | T0 | `DOFLOW_LINEAGE_ID`; invalid gives null |
| `attempt` | `uint` or null | T0 | `DOFLOW_ATTEMPT` (`^[1-9][0-9]{0,3}$`), written as a number |

`run`, `lineage` and `attempt` come from the environment only. A caller cannot supply them.

## Kinds

| Kind | Written by | Keys beyond the common ones |
|---|---|---|
| `hook` | `core/harnesses/shared/hooks/bridge/bridge.sh`, `core/harnesses/claude/hooks/post-shell-observe.sh` | `harness`, `event`, `policy`, `verdict`, `duration_ms`, `session`, `tool`, `tool_call_id`, `role`, `worker_run`, `test_class` (see Hook lines) |
| `verify.run` | `src/runtime/trace/telemetry.ts` | `verify_id`, `source`, `task`, `dispatch_run`, `risk`, `status`, `exit_code`, `duration_ms`, `checks_run` (see Verify lines) |
| `verify.tier` | `src/runtime/trace/telemetry.ts` | `verify_id`, `tier`, `status`, `selection_basis`, `selected`, `total`, `fallback`, `duration_ms` |
| `verify.check` | `src/runtime/trace/telemetry.ts` | `verify_id`, `tier`, `status`, `exit_code`, `duration_ms`, `tests`, `tests_failed`, `cpu_ms`, `resource_basis`, `check_key`, `shared` |

A key is added to a kind in the same change that writes it, with its `phase` (the merge that first
writes it). Until then the writer drops every key it is handed for that kind. Changes to the contract
are additive and `version` stays 1. No `gen_ai.*` name appears in v1.

## Hook lines

The shared bridge writes one `hook` line per invocation of an allowlisted surface, on the native and
the `--emit decision` paths alike, after the verdict is known. The allowlist is the surfaces the
paired perf run measures: `pre-bash-guard` on claude, codex, gemini, kiro, antigravity and pi, and
`user-prompt-submit` on claude and codex. Any other surface writes nothing.

| Key | Type | Class | Source |
|---|---|---|---|
| `harness`, `event`, `policy` | `enum:harness`, `enum:event`, `enum:policy` | T2 | the allowlist entry (Kiro's `preToolUse` is written `PreToolUse`) |
| `verdict` | `enum:verdict` | T2 | the bridge's classified outcome |
| `duration_ms` | `uint` or null | T1 | `EPOCHREALTIME` at bridge entry and at the write; null on bash below 5 (macOS `/bin/bash` 3.2) |
| `session` | `token` or null | T0 | the decoded session id |
| `tool` | `token` or null | T2 | the decoded tool name; null for an MCP tool, so an MCP server or tool name is never recorded |
| `tool_call_id` | `token` or null | T0 | Pi `toolCallId`, Claude and Codex `tool_use_id`; else null |
| `test_class` | `enum:test_class` or null | T2 | command class on post-shell-observe, else null |

The line is `kind, harness, event, policy, verdict, duration_ms, timestamp, session, tool,
tool_call_id, run, lineage, attempt`. Everything after `duration_ms` comes from a tuple that
`envelope.jq` emits as its first line in `--arg mode encode` (only when that mode is passed
explicitly): `{dft:1, date, timestamp, session, tool, tool_call_id, run, lineage, attempt}`, every
value validated in jq. Every telemetry expression sits inside `try`, so a fault there yields
`{"dft":1}`, which writes nothing and leaves the envelope and the policy verdict untouched. Off emits
`{"dft":1}` too.

The target is `<config>/state/runs/telemetry/<UTC date>.jsonl`, with `<config>` from
`DOFLOW_CONFIG_DIR`, else the nearest `.doflow` at or above the working directory, passing over a
`.doflow` inside another `.doflow` (a dispatch worktree's) to continue to the project's store; that
worktree `.doflow` used to hide the project store because the launch writes the worker's delivery
pack into its own `.doflow/state/delivery`. There is no
install or global fallback beyond that walk. Nothing is written unless `<config>/state` exists;
`telemetry/` is created non-recursively (so only when `state/runs` exists), and the target is
appended to only when it is absent or a regular file. A FIFO, a directory or an unwritable target
writes nothing, never blocks, and changes no output or exit code. One `printf >>` per invocation,
builtins only apart from that first `mkdir`.

## Verify lines

`src/runtime/verification/telemetry-emit.ts` builds the lines and hands them to the writer. The
verify verb writes, once its report is printed, one `verify.run`, then for each report tier one
`verify.tier` followed by one `verify.check` per check in that tier. The dispatch runner
(`src/runtime/dispatch/verify-run.ts`) writes one `verify.run` with `source: dispatch` after its
spawn settles, and no tier or check line. All lines of one run share `verify_id`.

| Kind | Key | Type | Class | Source |
|---|---|---|---|---|
| all three | `verify_id` | `hex16` | T0 | 8 random bytes per run, never derived from a path, task or command |
| `verify.run` | `source` | `enum:source` | T2 | `verb` or `dispatch` |
| `verify.run` | `task` | `token` or null | T0 | the task id when it passes `token`, else null |
| `verify.run` | `dispatch_run` | `token` or null | T0 | dispatch run identifier when source is dispatch, else null |
| `verify.run` | `risk` | `enum:risk` or null | T2 | the report's risk level; null from the dispatch runner |
| `verify.run` | `status` | `enum:status` or null | T2 | the report status; a status outside the vocabulary (`INCONCLUSIVE`) is null |
| `verify.run` | `exit_code` | `uint` or null | T1 | the verify run's exit code |
| `verify.run` | `duration_ms` | `uint` or null | T1 | total elapsed milliseconds for the verify run |
| `verify.run` | `checks_run` | `uint` or null | T1 | count of executed checks only |
| `verify.tier`, `verify.check` | `tier` | `token` or null | T2 | the tier id |
| `verify.tier`, `verify.check` | `status` | `enum:status` or null | T2 | the tier's or the check's status |
| `verify.tier` | `selection_basis`, `fallback` | `enum:selection_basis`, `enum:fallback`, or null | T2 | the targeted tier's test selection; null on every other tier |
| `verify.tier` | `selected`, `total` | `uint` or null | T1 | the selection's counts; null when unknown |
| `verify.tier` | `duration_ms` | `uint` or null | T1 | sum of check durations in the tier (derived-sum) |
| `verify.check` | `exit_code` | `uint` or null | T1 | the check process exit code |
| `verify.check` | `duration_ms` | `uint` or null | T1 | check execution duration in milliseconds (null when `NOT_RUN`) |
| `verify.check` | `tests` | `uint` or null | T1 | total test count parsed from test output |
| `verify.check` | `tests_failed` | `uint` or null | T1 | failed test count parsed from test output |
| `verify.check` | `cpu_ms` | `uint` or null | T1 | child CPU time in milliseconds (Linux only, null on other platforms) |
| `verify.check` | `resource_basis` | `enum:resource_basis` or null | T2 | `proc-children`, `unreached-platform`, or `unreached-read` |
| `verify.check` | `check_key` | `hex16` or null | T0 | 16-hex deterministic check key |
| `verify.check` | `shared` | `enum:shared` or null | T2 | `none` for executed checks, `in-run` for deduplicated checks |

`timestamp` is the report's `startedAt` for the run line, the check's own start for a check line,
and the first check's start for a tier line. Timing comes from the contract runner's `metrics`
WeakMap (keyed by each check result, measured with the monotonic clock around the check's spawn),
so the report and `verify --json` carry no timing and are the same bytes with telemetry on, off or
faulted. The lines go to `DOFLOW_CONFIG_DIR` when set; otherwise, the walk selects the nearest
`.doflow` above the verify's working directory that holds `state/runs`, passing over one without
`state/runs` and now also over one inside another `.doflow` (a dispatch worktree's) to continue to
the project's store; before this change, the worktree `.doflow` hid that store after a worker verb
created `state/runs` in it.
A failing check leaves a `.doflow/state/verification/logs` fragment in the working directory, and
the walk passes over it. With no project store nothing is written; there is no global fallback.

Exit code, durations, executed-check count, check key and sharing are declared with phase P3. `level` and `v0` follow in P5.

`recordFields` are not line keys: they are the identifiers a run record carries
(`task-run.run.traceId`, `task-run.history.traceId`, `task-run.history.traceLink`,
`orchestration.run.runKey`, `orchestration.run.traceId`). They are listed so the privacy class of every
identifier is on one page; G45.1 does not compare them with line keys.

## Privacy classes

| Class | Meaning | Recorded |
|---|---|---|
| T0 | identifier (ids, digests) | yes |
| T1 | measure (durations, counts) | yes |
| T2 | descriptor (closed vocabulary values) | yes |
| T2-local | descriptor, never exported | yes, local only |
| T4 | content (commands, paths, prompts, tool output) | never |

A field is declared with a `name` of the form `doflow.<kind>.<key>`, a `class`, a `type` and a
`phase`. No field may be T4.

## Types

Each type may be followed by `|null`. A value that fails its type is written as null; a key the kind
does not declare is dropped, and its value is never echoed.

| Type | Accepts |
|---|---|
| `token` | `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$` (the ledger's `SAFE_TOKEN`) |
| `id` | `^[A-Za-z0-9][A-Za-z0-9_-]{0,55}$` (the run and lineage rule) |
| `uint` | a finite number, truncated, not below 0 |
| `int` | a finite number, truncated |
| `hex16`, `hex32` | lowercase hex of that length |
| `iso8601ms` | `YYYY-MM-DDTHH:MM:SS.mmmZ` |
| `date` | `YYYY-MM-DD` |
| `enum:<name>` | a value of `vocabularies.<name>` |

`runkey` (`<hex16>/<run>/<lineage>`) is a type for `recordFields` only.

## Vocabularies

The closed lists a later export may use. `harness` equals the ids in `core/registry/harnesses.json`,
`status` equals `tierStatuses` and `risk` equals the risk levels of `core/registry/verification.json`;
G45.1 holds those three equal.

| Name | Values |
|---|---|
| `kind` | `hook`, `verify.run`, `verify.tier`, `verify.check` |
| `harness` | the eight harness ids |
| `event` | `PreToolUse`, `BeforeTool`, `tool_call`, `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure` |
| `policy` | `pre-bash-guard`, `user-prompt-submit`, `post-shell-observe` |
| `verdict` | `allow`, `deny`, `advisory`, `error`, `unsupported`, `observe` |
| `source` | `verb`, `dispatch` |
| `status` | `PASS`, `FAIL`, `UNRESOLVED`, `SUBSUMED`, `NOT_APPLICABLE`, `SKIPPED`, `NOT_RUN` |
| `risk` | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |
| `level` | `L0`, `L1`, `L2`, `L3` |
| `selection_basis` | `changed-test-files`, `explicit-pattern`, `none` |
| `fallback` | `change-scope-unavailable`, `no-changed-tests`, `unsafe-path`, `not-scopable` |
| `test_class` | `test.full`, `test.scoped`, `test.other`, `verify.verb`, `none` |
| `shared` | `none`, `in-run`, `leader`, `follower` |
| `failed_first` | `none`, `pass`, `fail` |
| `resource_basis` | `proc-children`, `unreached-platform`, `unreached-read` |
| `v0` | `on`, `off` |

## Excluded stores

Coordination state is not telemetry. `verification-v0` (a transient pid and token in a mode-0600 lock,
deleted after use, plus digests) is listed in `excludedStores` with that reason.

## The writer

`new TelemetryWriter({ registry, env, fsImpl, now, start })` and `write(records)`.

- One open-and-write of all lines per call (`O_APPEND|O_NOFOLLOW|O_NONBLOCK`, after an `lstat` that skips
  any existing target that is not a regular file: a FIFO, directory, socket, device or symlink), to the
  partition named for the UTC date of the first written line. `telemetry/` is created non-recursively and only when `state/runs` already exists.
- It never throws. A fault of any kind (unwritable directory, a directory where the file should be, a
  hostile record) writes nothing for the part it touches and changes no outcome.
- A record with no registered `kind` writes nothing. A `verb` is not a `kind`.
- Off (see Switch) writes nothing and creates nothing.

## Guard

`test/guards/telemetry-contract.test.js` (G45; 086 took G44, so this is the next free number):

1. the registry is well formed, three vocabularies equal their owning registries, and the keys it
   declares per kind equal the keys the writer, the shell `printf` formats and the committed fixture
   lines (`test/fixtures/telemetry/*.jsonl`) carry; `hook.jsonl` there is held equal to a real bridge
   line's keys by `test/hooks/bridge-hook-line.test.js`;
2. no `node` process starts on a shell hook path, and the node files there are the pinned three;
3. no network module or `fetch` under `src/runtime` outside the pinned advice client;
4. no skill, guidance or agent spec names `trace spans`, `trace export`, `trace analyze` or
   `verify-baseline`;
5. the package has no runtime dependency and G30.2 is still enforced;
6. every telemetry store is a declared `runs/` subdirectory the ledger readers skip.

Each check has a self-test that plants a violation and expects the check to name it.
