# Spec: telemetry contract v1

Contract document for feature 088 (IC-001, IC-002, IC-018). The machine-readable form is
`core/registry/telemetry.json`; this page is its prose mirror. When the two disagree the registry is
right, and `test/guards/telemetry-contract.test.js` (G44, provisional number) is what notices.

Telemetry here means local metadata about DoFlow's own runs: how long a hook took, which tier of a
verify run ran and how it ended. It is never content, it never leaves the machine, and it never
changes what a command prints, returns or decides.

## What a line is

One JSON object per line, appended to `<config>/state/runs/telemetry/<UTC date>.jsonl`, where
`<config>` is the resolved `.doflow` directory (`DOFLOW_CONFIG_DIR`, else the nearest `.doflow` above
the working directory). The directory sits under `runs/` as a subdirectory, so the run ledger's
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

Every line carries these, in this order, before its kind's own keys.

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
| `hook` | `core/harnesses/shared/hooks/bridge/bridge.sh` | none declared yet; the hook-line keys arrive with the bridge writer |
| `verify.run` | `src/runtime/trace/telemetry.ts` | none declared yet |
| `verify.tier` | `src/runtime/trace/telemetry.ts` | none declared yet |
| `verify.check` | `src/runtime/trace/telemetry.ts` | none declared yet |

A key is added to a kind in the same change that writes it, with its `phase` (the merge that first
writes it). Until then the writer drops every key it is handed for that kind. Changes to the contract
are additive and `version` stays 1. No `gen_ai.*` name appears in v1.

`recordFields` are not line keys: they are the identifiers a run record carries
(`task-run.run.traceId`, `task-run.history.traceId`, `task-run.history.traceLink`,
`orchestration.run.runKey`, `orchestration.run.traceId`). They are listed so the privacy class of every
identifier is on one page; G44.1 does not compare them with line keys.

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
G44.1 holds those three equal.

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

- One `appendFileSync` of all lines per call, to the partition named for the UTC date of the first
  written line. `telemetry/` is created non-recursively and only when `state/runs` already exists.
- It never throws. A fault of any kind (unwritable directory, a directory where the file should be, a
  hostile record) writes nothing for the part it touches and changes no outcome.
- A record with no registered `kind` writes nothing. A `verb` is not a `kind`.
- Off (see Switch) writes nothing and creates nothing.

## Guard

`test/guards/telemetry-contract.test.js` (G44; the number is the next free one when it was written and
is re-checked at merge):

1. the registry is well formed, three vocabularies equal their owning registries, and the keys it
   declares per kind equal the keys the writer, the shell `printf` formats and the committed fixture
   lines (`test/fixtures/telemetry/*.jsonl`) carry;
2. no `node` process starts on a shell hook path, and the node files there are the pinned three;
3. no network module or `fetch` under `src/runtime` outside the pinned advice client;
4. no skill, guidance or agent spec names `trace spans`, `trace export`, `trace analyze` or
   `verify-baseline`;
5. the package has no runtime dependency and G30.2 is still enforced;
6. every telemetry store is a declared `runs/` subdirectory the ledger readers skip.

Each check has a self-test that plants a violation and expects the check to name it.
