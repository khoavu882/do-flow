---
description: Contract and schema for machine-local telemetry lines, event kinds, emission boundaries, and storage.
---
# Spec: telemetry contract v1

Contract document for feature 088 (IC-001, IC-002, IC-003, IC-004, IC-006, IC-018). The machine-readable
form is `core/registry/telemetry.json`; this page is its prose mirror. When the two disagree the
registry is right, and `test/guards/telemetry-contract.test.js` (G45) is what
notices.

Telemetry here means local metadata about DoFlow's own runs: how long a hook took, which tier of a
verify run ran and how it ended. It is never content, it leaves the machine only when someone runs
`doflow trace export --otlp-http` (see Export), which sends the filtered span projection to the
configured collector, and it never changes what a command prints, returns or decides.

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
| `hook` | `core/harnesses/shared/hooks/bridge/bridge.sh`, `core/harnesses/claude/hooks/post-shell-observe.sh` | `harness`, `event`, `policy`, `verdict`, `duration_ms`, `tool_duration_ms`, `session`, `tool`, `tool_call_id`, `role`, `worker_run`, `test_class`, `emit_reason`, `emit_bytes`, `emit_digest` (see Hook lines) |
| `verify.run` | `src/runtime/trace/telemetry.ts` | `verify_id`, `source`, `task`, `dispatch_run`, `risk`, `level`, `status`, `exit_code`, `duration_ms`, `checks_run`, `v0` (see Verify lines) |
| `verify.tier` | `src/runtime/trace/telemetry.ts` | `verify_id`, `tier`, `status`, `selection_basis`, `selected`, `total`, `fallback`, `duration_ms` |
| `verify.check` | `src/runtime/trace/telemetry.ts` | `verify_id`, `tier`, `status`, `exit_code`, `duration_ms`, `tests`, `tests_failed`, `cpu_ms`, `resource_basis`, `check_key`, `shared`, `shared_ref`, `failed_first` |
| `review.run` | `src/runtime/trace/telemetry.ts` | `task`, `depth`, `risk`, `protocol`, `head`, `rounds`, `seats`, `seat_findings`, `converged`, `blocker`, `should_fix`, `note`, `open`, `fixed`, `refuted`, `user_accepted`, `pre_existing`, `escaped`, `confirmed`, `plausible`, `unverified_blockers`, `bug_classes`, `advisories`, `errors` (see Review lines) |

A key is added to a kind in the same change that writes it, with its `phase` (the merge that first
writes it). Until then the writer drops every key it is handed for that kind. Changes to the contract
are additive and `version` stays 1. No `gen_ai.*` name appears in v1.

## Hook lines

The shared bridge writes one `hook` line per invocation of an allowlisted surface, on the native and
the `--emit decision` paths alike, after the verdict is known. The allowlist is the surfaces the
paired perf run measures: `pre-bash-guard` on claude, codex, gemini, kiro, antigravity and pi, and
`user-prompt-submit` on claude and codex. Any other surface writes nothing.

| Key | Type | Class | Phase | Source |
|---|---|---|---|---|
| `harness`, `event`, `policy` | `enum:harness`, `enum:event`, `enum:policy` | T2 | P2 | the allowlist entry (Kiro's `preToolUse` is written `PreToolUse`) |
| `verdict` | `enum:verdict` | T2 | P2 | the bridge's classified outcome |
| `duration_ms` | `uint` or null | T1 | P2 | hook latency from `EPOCHREALTIME` at bridge entry and at the write; null on bash below 5 (macOS `/bin/bash` 3.2), and always null on `post-shell-observe` (IC-005) |
| `tool_duration_ms` | `uint` or null | T1 | P3 | the tool's native `duration_ms` runtime on the observer, validated as a nonnegative safe integer; null on other hook lines or when absent or invalid |
| `session` | `token` or null | T0 | P2 | the decoded session id |
| `tool` | `token` or null | T2 | P2 | the decoded tool name; null for an MCP tool, so an MCP server or tool name is never recorded |
| `tool_call_id` | `token` or null | T0 | P2 | Pi `toolCallId`, Claude and Codex `tool_use_id`; else null |
| `role` | `enum:role` or null | T2 | P2 | `DOFLOW_SESSION_ROLE` (`main` or `worker` exactly; else null) |
| `worker_run` | `token` or null | T0 | P2 | worker run identifier from `DOFLOW_WORKER_RUN` |
| `test_class` | `enum:test_class` or null | T2 | P3 | command class on post-shell-observe or classified via `envelope.jq`, else null |
| `emit_reason` | `enum:emit_reason` or null | T2 | P6 | on `user-prompt-submit`, the emission adapter's `DF_EMIT_REASON` (`policies/emission.sh`); null on other bridge hook lines, with no emit record, or when any of the three emit values fails its pattern; absent from `post-shell-observe` lines, as are `emit_bytes` and `emit_digest` |
| `emit_bytes` | `uint` or null | T1 | P6 | the byte length of the response the policy printed, for `emit` and `refused:*`; 0 for `silent:*` and `fault:*`; null as for `emit_reason` |
| `emit_digest` | `token` or null | T0 | P6 | 8 lowercase hex of h = (h*31 + c) mod 2^32 over the code points of exactly the printed response (without its trailing newline), computed in the `emission.jq` render process for `emit` and `refused:*` and only with telemetry on; else null. It keys duplicate emissions and is never exported |

The bridge line is `kind, harness, event, policy, verdict, duration_ms, emit_reason, emit_bytes, emit_digest, timestamp, session, tool, tool_call_id, run, lineage, attempt, role, worker_run, tool_duration_ms, test_class`. The three `emit_*` values come from the policy's emit record, one `\036{"v":1,"emit":{"reason","bytes","digest"}}` line on the decision fd that the bridge reads apart from the decision record and checks with builtins (a vocabulary member, digits, 8 lowercase hex or null); they carry no content, only a reason, a count and a hash. Everything after `emit_digest` comes from a tuple that `envelope.jq` emits as its first line in `--arg mode encode` (only when that mode is passed explicitly): `{dft:1, date, timestamp, session, tool, tool_call_id, run, lineage, attempt, role, worker_run, tool_duration_ms, test_class}`, every value validated in jq. Every telemetry expression sits inside `try`, so a fault there yields `{"dft":1}`, which writes nothing and leaves the envelope and the policy verdict untouched. Off emits `{"dft":1}` too.

The observer uses `--arg mode observe` to emit only the tuple, adding `duration_ms:null` and `tool_duration_ms`; its front door writes that tuple with the observer's `test_class`. Hook lines carry no content and may reach about 700 bytes with maximum-length ids.

### Harness observation coverage (NFR-008)

No behaviour depends on one harness; observation coverage is tabulated per harness across all eight targets:

| Harness | Pre-shell event | Command class | Post-shell observation | Duration & status |
|---|---|---|---|---|
| `claude` | observed (`PreToolUse`) | observed | observed (`PostToolUse`, `PostToolUseFailure`) | measured |
| `codex` | observed (`PreToolUse`) | observed | none | `unreached` |
| `gemini` | observed (`BeforeTool`) | observed | none | `unreached` |
| `kiro` | observed (`PreToolUse`) | observed | none | `unreached` |
| `antigravity` | observed (`PreToolUse`) | observed | none | `unreached` |
| `pi` | observed (`tool_call`) | observed | none | `unreached` |
| `opencode` | unobserved | unobserved | none | unobserved |
| `copilot` | unobserved | unobserved | none | unobserved |

The target is `<config>/state/runs/telemetry/<UTC date>.jsonl`, with `<config>` from
`DOFLOW_CONFIG_DIR`, else the nearest `.doflow` at or above the working directory, passing over a
`.doflow` inside another `.doflow` (a dispatch worktree's) to continue to the project's store; that
worktree `.doflow` used to hide the project store because the launch writes the worker's delivery
pack into its own `.doflow/state/delivery`. There is no
install or global fallback beyond that walk. Nothing is written unless `<config>/state` exists;
`telemetry/` is created non-recursively (so only when `state/runs` exists), and the target is
appended to only when it is absent or a regular file. A FIFO, a directory or an unwritable target
writes nothing, never blocks, and changes no output or exit code. One `printf >>` per invocation,
builtins only apart from that first `mkdir`. `emit_digest` adds no process: the prompt policy's
existing jq render computes it, only with telemetry on.

## Verify lines

`src/runtime/verification/telemetry-emit.ts` builds the lines and hands them to the writer. The
verify verb writes, once its report is printed, one `verify.run`, then for each report tier one
`verify.tier` followed by one `verify.check` per check in that tier. The dispatch runner
(`src/runtime/dispatch/verify-run.ts`) writes one `verify.run` with `source: dispatch` after its
spawn settles, and no tier or check line. All lines of one run share `verify_id`.

| Kind | Key | Type | Class | Phase | Source |
|---|---|---|---|---|---|
| all three | `verify_id` | `hex16` | T0 | P2 | 8 random bytes per run, never derived from a path, task or command |
| `verify.run` | `source` | `enum:source` | T2 | P2 | `verb` or `dispatch` |
| `verify.run` | `task` | `token` or null | T0 | P2 | the task id when it passes `token`, else null |
| `verify.run` | `dispatch_run` | `token` or null | T0 | P2 | dispatch run identifier when source is dispatch, else null |
| `verify.run` | `risk` | `enum:risk` or null | T2 | P2 | the report's risk level; null from the dispatch runner |
| `verify.run` | `level` | `enum:level` or null | T2 | P5.1 | the verification level (L1..L3) derived from risk; null from the dispatch runner |
| `verify.run` | `status` | `enum:status` or null | T2 | P2 | the report status; a status outside the vocabulary (`INCONCLUSIVE`) is null |
| `verify.run` | `exit_code` | `uint` or null | T1 | P3 | the verify run's exit code |
| `verify.run` | `duration_ms` | `uint` or null | T1 | P3 | total elapsed milliseconds for the verify run |
| `verify.run` | `checks_run` | `uint` or null | T1 | P3 | count of executed checks only |
| `verify.run` | `v0` | `enum:v0` or null | T2 | P5.2 | whether V0 optimizations were enabled (`on`/`off`); L3 is null with the flag on and `off` with the flag off; dispatch is null |
| `verify.tier`, `verify.check` | `tier` | `token` or null | T2 | P2 | the tier id |
| `verify.tier`, `verify.check` | `status` | `enum:status` or null | T2 | P2 | the tier's or the check's status |
| `verify.tier` | `selection_basis`, `fallback` | `enum:selection_basis`, `enum:fallback`, or null | T2 | P2 | the targeted tier's test selection; null on every other tier |
| `verify.tier` | `selected`, `total` | `uint` or null | T1 | P2 | the selection's counts; null when unknown |
| `verify.tier` | `duration_ms` | `uint` or null | T1 | P3 | sum of check durations in the tier (derived-sum) |
| `verify.check` | `exit_code` | `uint` or null | T1 | P3 | the check process exit code |
| `verify.check` | `duration_ms` | `uint` or null | T1 | P3 | check execution duration, or the follower's wait, in milliseconds (null when `NOT_RUN`) |
| `verify.check` | `tests` | `uint` or null | T1 | P3 | total test count parsed from test output |
| `verify.check` | `tests_failed` | `uint` or null | T1 | P3 | failed test count parsed from test output |
| `verify.check` | `cpu_ms` | `uint` or null | T1 | P3 | child CPU time in milliseconds (Linux only, null on other platforms) |
| `verify.check` | `resource_basis` | `enum:resource_basis` or null | T2 | P3 | `proc-children`, `unreached-platform`, or `unreached-read` |
| `verify.check` | `check_key` | `hex16` or null | T0 | P3 | 16-hex deterministic check key |
| `verify.check` | `shared` | `enum:shared` or null | T2 | P3 | `none` for unshared checks, `in-run` for checks reused within a run, `leader` or `follower` for overlapping V0 checks, `reused` for a recorded PASS reused on an unchanged check key (089) |
| `verify.check` | `shared_ref` | `hex32` or null | T0 | P5.4 | random lock token for a leader or follower, the reuse record's random ref for `reused`, else null |
| `verify.check` | `failed_first` | `enum:failed_first` or null | T2 | P5.3 | `none` for normal runs, `pass` or `fail` when failed-first ran; null when `NOT_RUN` |

`timestamp` is the report's `startedAt` for the run line, the check's own start for a check line,
and the first check's start for a tier line. Timing comes from the contract runner's `metrics`
WeakMap (keyed by each check result, measured with the monotonic clock around the check's spawn),
so the report and `verify --json` carry no timing and are the same bytes with telemetry on, off or
faulted. The lines go to `DOFLOW_CONFIG_DIR` when set; otherwise, the walk selects the nearest
`.doflow` above the verify's working directory that holds `state/runs`, passing over one without
`state/runs` and now also over one inside another `.doflow` (a dispatch worktree's) to continue to
the project's store; before this change, the worktree `.doflow` hid that store after a worker verb
created `state/runs` in it.
The verify verb writes failing checks' logs under the resolved store's `state/verification/logs`;
only when no `DOFLOW_CONFIG_DIR`, project, install or `~/.doflow` store exists do they land in a
`.doflow` at the working directory's project root, which has no `state/runs`, so the walk passes
over it. With no project store nothing is written; there is no global fallback.

Exit code, durations, executed-check count, check key and sharing are declared with phase P3. `level` is declared with phase P5.1; `v0` is declared with phase P5.2; `failed_first` is declared with phase P5.3; `shared_ref` and leader/follower sharing are declared with phase P5.4. Followers and reused checks are excluded from `checks_run`.

`recordFields` are not line keys: they are the identifiers a run record carries
(`task-run.run.traceId`, `task-run.history.traceId`, `task-run.history.traceLink`,
`orchestration.run.runKey`, `orchestration.run.traceId`). They are listed so the privacy class of every
identifier is on one page; G45.1 does not compare them with line keys.

## Review lines

`doflow review --action check` (`src/runtime/review/command.ts`) writes through `TelemetryWriter`, one line per check run, including invalid records. Invalid records use null for nullable counts; `advisories` and `errors` remain integers. No locator, summary, sweep, path, seat id or finding id is recorded.

| Kind | Key | Type | Class | Phase | Source |
|---|---|---|---|---|---|
| `review.run` | `task` | `token` or null | T0 | P7 | the record's `slug` only when the record is valid and the slug passes `token`; otherwise null (an invalid record's slug is never written) |
| `review.run` | `depth` | `enum:depth` or null | T2 | P7 | the record's `depth` (`single` or `deep`) when the record is valid and carries one; otherwise null |
| `review.run` | `risk` | `enum:risk` or null | T2 | P7 | the record's `risk` when the record is valid and carries one; otherwise null |
| `review.run` | `protocol` | `enum:protocol` or null | T2 | P7 | the record's `protocol.id` (a review preset id) when the record is valid and carries one; otherwise null |
| `review.run` | `head` | `token` or null | T0 | P7 | the record's `reviewedHead` when the record is valid; otherwise null |
| `review.run` | `rounds` | `uint` or null | T1 | P7 | review round count; null when invalid |
| `review.run` | `seats`, `seat_findings`, `converged` | `uint` or null | T1 | P7 | counts; null when invalid |
| `review.run` | `blocker`, `should_fix`, `note` | `uint` or null | T1 | P7 | severity counts; null when invalid |
| `review.run` | `open`, `fixed`, `refuted`, `user_accepted` | `uint` or null | T1 | P7 | disposition counts; null when invalid |
| `review.run` | `pre_existing`, `escaped`, `confirmed`, `plausible`, `unverified_blockers`, `bug_classes` | `uint` or null | T1 | P7 | finding counts; null when invalid |
| `review.run` | `advisories` | `uint` | T1 | P7 | advisory count |
| `review.run` | `errors` | `uint` | T1 | P7 | error count; zero when valid |

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
`status` equals `tierStatuses`, and `risk` equals the risk levels of `core/registry/verification.json`;
G45.1 holds those three equal.
`depth` and `protocol` are not listed in `telemetry.json`: the writer reads them from `core/registry/protocols.json`
through `validateProtocols` (`src/runtime/trace/telemetry.ts` `DERIVED_VOCABULARIES`): `protocol` is `order.review`, `depth`
the `depth` labels of those presets, loosest first. A preset added there, with its own depth label, is a valid `protocol`
and `depth` with no edit here, and G45.1 refuses a copy. When protocols.json cannot be read or fails its validator, both are
written null and the rest of the line is unchanged.

| Name | Values |
|---|---|
| `kind` | `hook`, `verify.run`, `verify.tier`, `verify.check`, `review.run` |
| `harness` | the eight harness ids |
| `event` | `PreToolUse`, `BeforeTool`, `tool_call`, `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure` |
| `policy` | `pre-bash-guard`, `user-prompt-submit`, `post-shell-observe` |
| `verdict` | `allow`, `deny`, `advisory`, `error`, `unsupported`, `observe` |
| `source` | `verb`, `dispatch` |
| `status` | `PASS`, `FAIL`, `UNRESOLVED`, `SUBSUMED`, `NOT_APPLICABLE`, `SKIPPED`, `NOT_RUN` |
| `risk` | `LOW`, `MEDIUM`, `HIGH`, `CRITICAL` |
| `depth` | derived: the `depth` labels of the `order.review` presets in `core/registry/protocols.json`, loosest first (today `single`, `deep`) |
| `protocol` | derived: the ids of `order.review` in `core/registry/protocols.json` (today `review-deep`, `review-single`) |
| `role` | `main`, `worker` |
| `level` | `L0`, `L1`, `L2`, `L3` |
| `selection_basis` | `changed-test-files`, `explicit-pattern`, `none` |
| `fallback` | `change-scope-unavailable`, `no-changed-tests`, `unsafe-path`, `not-scopable` |
| `test_class` | `test.full`, `test.scoped`, `test.other`, `verify.verb`, `none` |
| `shared` | `none`, `in-run`, `leader`, `follower`, `reused` |
| `failed_first` | `none`, `pass`, `fail` |
| `resource_basis` | `proc-children`, `unreached-platform`, `unreached-read` |
| `v0` | `on`, `off` |
| `tool` | `Bash` (the canonical tool name passed to allowlisted `pre-bash-guard` front doors) |
| `emit_reason` | `emit`, `refused:mandatory-over-budget`, `silent:already-bootstrapped`, `silent:unchanged`, `silent:no-home`, `fault:deps`, `fault:unit`, `fault:slot`, `fault:summary`, `fault:grant`, `fault:warning`, `fault:render` (the `DF_EMIT_REASON` values of `policies/emission.sh`) |

## Analysis

`doflow trace analyze` (091 IC-001..IC-005, IC-011) evaluates trace spans projected by `projectSpans` across scopes (each trace, and each ungrouped `session:` or `day:` group). The command writes nothing, loads no network module, and exits 0 when there are no findings, 1 on at least one finding, and 2 on usage errors.

### Thresholds

Configured in `core/registry/telemetry.json` under `analysis`. All four must be positive integers; anything else is a usage error:

| Key | Value | Meaning |
|---|---|---|
| `minSamples` | 5 | Minimum duration samples required for a `(kind, name)` span group to qualify for latency hotspot detection, and threshold for inclusion in the `latency` context list |
| `tailRatio` | 4 | Minimum ratio of 95th percentile to median duration (`p95 >= tailRatio * p50`) for latency hotspots |
| `minTailMs` | 1000 | Minimum absolute difference in milliseconds between 95th percentile and median (`p95 - p50 >= minTailMs`) for latency hotspots |
| `retryRun` | 2 | Minimum consecutive failed verification runs with an identical failure class to qualify as a retry loop |

### Detectors and rules

Three detectors run per scope:

1. **`latency-hotspots`**: Groups spans with integer `durationMs` by `(kind, name)`. A span whose `shared` is set to anything other than `none` or `leader` (`in-run`, `follower`, `reused`) is left out of every group: its `durationMs` is a lookup or a wait, not a run of the check (the same executed-check rule as `redundant-verification`). A group with at least `minSamples` durations is a finding when `p95 >= tailRatio * p50` and `p95 - p50 >= minTailMs`. Reported spans are those with `durationMs > p50`; the 20 slowest (descending duration, then `spanId`) are kept and listed by start then `spanId` (`measures.spanCount` reports the uncapped count). Percentiles use nearest-rank `percentile` from `views.ts`. State: `FINDING` if any group qualifies; `CLEAR` if at least one group has `minSamples` durations and none qualifies; `NOT_DETERMINED` ("no span name has <minSamples> durations") otherwise. A `verify.tier` hotspot whose scope also has a `verify.check` hotspot carries `derivedFrom: verify.check` and is left out of `--emit followups` (one slow check is one proposal; FU-b4nbjn). The `test` group spans a whole session, so its hotspots mix unrelated commands (FU-xz9h35).
2. **`redundant-verification`**: Evaluates executed `verify.check` spans with a non-null `attrs.check_key`. A key observed on two or more executed `PASS` checks with no `FAIL` check of the same key between first and last is a finding; measures `{checkKey, passes, tier}`. State: `FINDING` if any key qualifies; `CLEAR` if at least one executed keyed check exists and none qualifies; `NOT_DETERMINED` ("no executed verify.check carries a check_key") otherwise. The check key is local-only (T0) and is never exported.
3. **`retry-loops`**: Groups `verify.run` spans sorted by start then `spanId` by `attrs.task` (a null task groups by scope). The failure class of a `FAIL` run is the sorted set of failing `verify.tier` names under it (`attrs.verify_id` matching), or `exit:<exit_code>` when it has no tier spans. Runs with status neither `PASS` nor `FAIL` (null, `UNRESOLVED`) neither extend nor break a sequence. A maximal sequence of at least `retryRun` consecutive `FAIL` runs with an identical failure class and no `PASS` between is a finding; measures `{task, runs, failureClass, grouping}` (`grouping` is `"task"` or `"scope"`). State: `FINDING` if any group qualifies; `CLEAR` if at least one `verify.run` carries a non-null status and none qualifies; `NOT_DETERMINED` ("no verify.run carries a status") otherwise.

### Executed-check rule (IC-011)

A `verify.check` span counts as executed only when:
- `attrs.status` is not null and not `NOT_RUN`, and
- `attrs.shared` is `none`, `leader`, or null.

`follower` and `in-run` mark reused results within a verify run and do not count. `reused` (feature 089 cross-run verification-reuse on an unchanged check key) marks reuse across runs and does not count. Any `shared` value not explicitly in `{none, leader, null}` does not count, preventing false redundancy findings from future reuse extensions.

### States and verdict

Each detector reports state `FINDING`, `CLEAR`, or `NOT_DETERMINED`. The overall view `verdict` follows `trace discover`:
- `findings`: at least one detector reports `FINDING`.
- `insufficient-data`: every detector reports `NOT_DETERMINED`.
- `no-findings-in-the-analyses-that-could-run`: some detectors report `NOT_DETERMINED` and the rest report `CLEAR`.
- `no-findings`: every detector reports `CLEAR`.

### Finding IDs

A finding id is the first 16 hex characters of sha256 over:
`${detector}\n${scope}\n${sorted_span_ids.join(',')}`

Findings contain no score, rank, or confidence fields; finding spans are capped at 20 and sorted by start time then `spanId`.

### Batch formats

The analyzer prints two machine-readable batch formats:

- **Evidence batch (`--emit evidence`)**: JSON array accepted unchanged by `evidence --action add --batch -`. One `runtime-observation` item per finding:
  ```json
  {
    "kind": "runtime-observation",
    "provenance": "extracted",
    "source": { "provider": "doflow", "capability": "trace.analyze" },
    "observation": { "command": "doflow trace analyze --json [--run <key|id>] [-g]", "exitCode": 1 },
    "content": "trace-analyze finding <id> detector=<detector> scope=<scopeKind>:<scope> spans=<spanId,...> <measures keys sorted>..."
  }
  ```
  `observation.command` includes only view-altering flags (`--run`, `-g`), never the project path. `content` contains numbers and identifiers only, and carries the token `finding <id>` exactly once.
- **Proposal batch (`--emit followups [--task-id <id>]`)**: JSON array accepted unchanged by `followup --action add --batch <file>`. One proposal item per finding:
  ```json
  {
    "statement": "trace-analyze <detector> <findingId>: metric <metric>=<value>; baseline span set finding <findingId>; evidence <ev-id>[,<ev-id>]|unrecorded; verify: re-run trace analyze on a later window and compare <metric>",
    "stage": "maintain",
    "source": { "kind": "manual" }
  }
  ```
  Statements are at most 280 characters and carry no 32-character run so `maskLine` leaves them unchanged. Metric is `p95_ms:<kind>/<name>` (hotspots), `passes:<tier>` (redundant), or `failed_runs:<task|scopeKind>` (retry). With `--task-id`, the command reads that task's evidence ledger (read-only) and cites up to two newest matching evidence IDs; without `--task-id` or matching evidence, it cites `unrecorded` (meaning no matching evidence in the store that was read: the main checkout's namespaced ledger; a pre-115 worktree-local store is not read). Lines exceeding 280 characters drop the second evidence ID and truncate `<name>` or replace it with `h<sha16(name).slice(0, 8)>`.

### Context section (rider R1)

The analysis view includes a top-level `context` object reporting `UserPromptSubmit` emission metadata per session. It provides session context, is not a detector, and does not alter the verdict or exit code. Over hook and folded test spans whose `attrs.session` is set:
- `status`: `MEASURED` if any hook span carries `emit_reason`, else `NOT_DETERMINED` (with empty `sessions: []`).
- `sessions`: sorted by `session`, each containing:
  - `session`: session token
  - `hookCalls`: count of all hook and test spans in the session
  - `emissions`: count of hook lines where `emit_reason` is `emit` or `refused:*`
  - `emittedBytes`: sum of `emit_bytes` for emissions (0 for `silent:*` and `fault:*`)
  - `duplicates`: count of emissions whose `emit_digest` matched an earlier emission in the same session (ordered by start then `spanId`); duplicates are a hash-match count on the 32-bit `emit_digest`, not byte identity (two different responses can collide)
  - `duplicateBytes`: sum of `emit_bytes` for duplicate emissions
  - `reasons`: dictionary of counts per `emit_reason`

The hook line metadata fields (`emit_reason`, `emit_bytes`, `emit_digest`) are defined under [Hook lines](#hook-lines).

## Export

`doflow trace export --otlp-http` (091 IC-006..IC-009) exports spans from `projectSpans` to an OpenTelemetry collector via OTLP/HTTP JSON (OTLP v1.11.1 JSON encoding). The `export` block in `core/registry/telemetry.json` declares the semantic convention pin, resource attributes, span name mappings, attribute rules, and external name owners.

### Semantic conventions pin and re-pin procedure

The export pins semantic conventions in `export.semconv`:
- `repo`: `open-telemetry/semantic-conventions-genai`
- `commit`: `547934afa90a34298441caf80c43b27255c3a292`
- `schemaUrl`: `https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev`

**Re-pin procedure (IC-008):**
1. Read the HEAD commit SHA and `schema_url` from `model/manifest.yaml` of `open-telemetry/semantic-conventions-genai`.
2. Check that every mapped name in `telemetry.json` (`gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.agent.name`, `gen_ai.operation.name`, operations `execute_tool`, `invoke_agent`, `invoke_workflow`) still exists in `model/gen-ai/registry.yaml`.
3. Update `export.semconv.commit` and `export.semconv.schemaUrl` in `core/registry/telemetry.json` together.

### Span mapping

Spans are exported with `kind: 1` (INTERNAL). `parentSpanId` is omitted on root spans. Exported span ids are not the local view's ids. At export time each span id is remapped to `sha16` of values already in the payload (trace id, exported span name, start and end times, exported attributes and status, the remapped parent id, and an ordinal among spans with identical values, ordered by the exported content of their subtrees), so no local identifier (slug, task id, locator, run key or path hash) is an input. `parentSpanId` and links are remapped the same way inside one export; a parent that is not exported is dropped. Two dry runs are byte-identical. A re-export after a span's end changes yields a new id (the collector sees a duplicate). Spans are grouped by trace in view order and, within each trace, ordered by start time then exported id; each request is the next 512-span slice of that list. Span names map according to `export.spans`:

| Local Kind | Export Span Name | Operation (`gen_ai.operation.name`) |
|---|---|---|
| `hook` | `execute_tool {tool}` | `execute_tool` |
| `test` | `execute_tool {tool}` | `execute_tool` |
| `worker` | `invoke_agent {harness}` | `invoke_agent` |
| `run` | `invoke_workflow` | `invoke_workflow` |
| `*` | `doflow.{kind} {name}` | (none) |

Placeholders `{tool}`, `{harness}`, and `{name}` resolve to their filtered attribute value; if the value is `other` or unlisted, the placeholder suffix is dropped (`execute_tool`, `invoke_agent`). Kinds without an owning name list resolve to `doflow.{kind}`.

### Attribute mapping and privacy filter rules

Each `export.attributes` entry holds exactly one rule key, `id: true` (boolean, only on `tool_call_id`), `vocabulary: <list name>` or `measure: true`, optionally `export: <key>`; any other shape is dropped by the mapper and fails G45.7. Attributes are mapped according to `export.attributes`, applying these rules in order:

1. A local attribute not listed in `export.attributes` is not exported.
2. An entry with `id: true` exports the value unchanged only when it passes `SAFE_TOKEN`; only `tool_call_id` carries this. All other T0 fields are never listed.
3. An entry with `vocabulary` exports the value if it is a member of the named vocabulary list, else `other`. The list is either in `telemetry.json` `vocabularies`, or one of the lists owned in `export.names`: `cli-commands` (`COMMANDS` in `src/cli/index.ts`), `workflow-stages` (stage IDs in `core/registry/workflows.json`), or `workflow-classes` (class IDs in `core/registry/workflows.json`).
4. An entry with `measure: true` exports a T1 number unchanged (integers formatted as `intValue` decimal strings).
5. The local name `doflow.<kind>.<key>` from the registry field `name` is the export key unless the entry gives `export`.
6. Span names replace `{tool}`, `{harness}`, `{name}` with the filtered attribute value (rule 3); unlisted values drop the suffix.
7. `gen_ai.operation.name` is set from the span specification's `operation`. No other `gen_ai.*` key is emitted.

| Local Attribute | Export Key | Rule | Specification |
|---|---|---|---|
| `tool` | `gen_ai.tool.name` | Rule 3 | `vocabulary: "tool"` |
| `tool_call_id` | `gen_ai.tool.call.id` | Rule 2 | `id: true` (only T0 exported) |
| `harness` | `gen_ai.agent.name` | Rule 3 | `vocabulary: "harness"` |
| `event` | `doflow.hook.event` | Rule 3 | `vocabulary: "event"` |
| `policy` | `doflow.hook.policy` | Rule 3 | `vocabulary: "policy"` |
| `verdict` | `doflow.hook.verdict` | Rule 3 | `vocabulary: "verdict"` |
| `role` | `doflow.hook.role` | Rule 3 | `vocabulary: "role"` |
| `test_class` | `doflow.hook.test_class` | Rule 3 | `vocabulary: "test_class"` |
| `source` | `doflow.verify.run.source` | Rule 3 | `vocabulary: "source"` |
| `risk` | `doflow.verify.run.risk` | Rule 3 | `vocabulary: "risk"` |
| `level` | `doflow.verify.run.level` | Rule 3 | `vocabulary: "level"` |
| `status` | `doflow.<kind>.status` | Rule 3 | `vocabulary: "status"` |
| `v0` | `doflow.verify.run.v0` | Rule 3 | `vocabulary: "v0"` |
| `selection_basis` | `doflow.verify.tier.selection_basis` | Rule 3 | `vocabulary: "selection_basis"` |
| `fallback` | `doflow.verify.tier.fallback` | Rule 3 | `vocabulary: "fallback"` |
| `resource_basis` | `doflow.verify.check.resource_basis` | Rule 3 | `vocabulary: "resource_basis"` |
| `shared` | `doflow.verify.check.shared` | Rule 3 | `vocabulary: "shared"` |
| `failed_first` | `doflow.verify.check.failed_first` | Rule 3 | `vocabulary: "failed_first"` |
| `verb` | `doflow.<kind>.verb` (ledger spans: `doflow.ledger.verb`) | Rule 3 | `vocabulary: "cli-commands"` |
| `stage` | `doflow.<kind>.stage` | Rule 3 | `vocabulary: "workflow-stages"` |
| `task_class` | `doflow.<kind>.task_class` | Rule 3 | `vocabulary: "workflow-classes"` |
| `duration_ms` | `doflow.<kind>.duration_ms` | Rule 4 | `measure: true` |
| `tool_duration_ms` | `doflow.hook.tool_duration_ms` | Rule 4 | `measure: true` |
| `exit_code` | `doflow.<kind>.exit_code` | Rule 4 | `measure: true` |
| `checks_run` | `doflow.verify.run.checks_run` | Rule 4 | `measure: true` |
| `selected` | `doflow.verify.tier.selected` | Rule 4 | `measure: true` |
| `total` | `doflow.verify.tier.total` | Rule 4 | `measure: true` |
| `tests` | `doflow.verify.check.tests` | Rule 4 | `measure: true` |
| `tests_failed` | `doflow.verify.check.tests_failed` | Rule 4 | `measure: true` |
| `cpu_ms` | `doflow.verify.check.cpu_ms` | Rule 4 | `measure: true` |
| `error.type` | `error.type` | Error rule | Set to status value or `exit:<code>` when `status.code` is 2 |
| `gen_ai.operation.name` | `gen_ai.operation.name` | Rule 7 | Set from span specification `operation` |

### What is never exported

- **Identifiers (T0)**: All T0 fields except `tool_call_id` are never exported: `run`, `lineage`, `attempt`, `session`, `task`, `worker_run`, `dispatch_run`, `verify_id`, `check_key`, `shared_ref`, `token`, and `emit_digest`.
- **Local span ids**: the local view's span ids (digests of record locators) are never exported; see Span mapping.
- **Local-only descriptors (T2-local)**: Descriptors marked `T2-local` are never exported.
- **Content (T4)**: Content is never recorded and never exported.
- **Ungrouped and start-less spans**: Spans lacking a `traceId` (`view.ungrouped`) and spans with a null `start` are not exported (counted as `skipped`).
- **Network secrecy**: Endpoint URLs, header names and values, and response bodies are never logged, printed, or saved.

### Environment variables and request bounds

The sender resolves configuration once from the invoking environment:

| Variable | Fallback | Syntax and validation |
|---|---|---|
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | `OTEL_EXPORTER_OTLP_ENDPOINT` (appends `/v1/traces`) | Valid URL, `http:` or `https:`, no username or password |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | `OTEL_EXPORTER_OTLP_HEADERS` | Comma-separated `k=v` pairs, trimmed, values percent-decoded; bad escape or empty key exits 2 |
| `OTEL_EXPORTER_OTLP_TRACES_TIMEOUT` | `OTEL_EXPORTER_OTLP_TIMEOUT` | Integer milliseconds, default 10000, clamped to maximum 30000; non-positive integer exits 2 |

An empty or whitespace-only value counts as unset; `TRACES_*` overrides only when non-empty; empty header members are skipped; header names must be RFC 7230 tokens and values must not contain CR, LF or NUL (exit 2, the error names the variable only); other control characters and characters above U+00FF are not checked here: `fetch` refuses such a value, so the export exits 1 (`connection` or `bad-response`) with no request sent and no value echoed; `OTEL_EXPORTER_OTLP_ENDPOINT` gets `/v1/traces` appended to its path, its query is kept, a fragment on either endpoint variable exits 2; `OTEL_EXPORTER_OTLP_[TRACES_]PROTOCOL` is not read: `--otlp-http` always sends HTTP/JSON, and a value other than `http/json` prints one stderr note naming the variable.

**Bounds:**
- Spans are chunked into requests of at most 512 spans each.
- At most 20 requests per export invocation (maximum 10,240 spans). Larger exports are refused before any network connection with exit 2 advising `--run`.
- Requests are sent sequentially using `fetch` with `redirect: "error"` and `AbortSignal.timeout(timeoutMs)`. Node's own proxy support applies: with `NODE_USE_ENV_PROXY=1` and `HTTP_PROXY`/`HTTPS_PROXY` set, the payload and the auth headers go through that proxy.
- The first failure (timeout, network error, redirect, or non-2xx status) stops the send loop with status `failed`. No retries are attempted.
- A 2xx response parses `partialSuccess.rejectedSpans` (a JSON number or the int64 decimal string); if positive, status is `partial`. A count that is not a non-negative safe integer, a `partialSuccess` that is not an object, or the snake_case `partial_success` form gives `failed`/`bad-response` (the request counts as sent and the loop stops).
- A 2xx body is read up to 64 KiB; a body read that times out gives `failed`/`timeout`, a connection lost during the body gives `failed`/`connection`, a body over 64 KiB gives `failed`/`bad-response`; in each case the request counts as sent, `httpStatus` is the 2xx code and the loop stops; a body received in full that is not JSON counts as accepted.

### Exit codes

- `0`: All requests accepted with zero rejected spans, or `--dry-run`.
- `1`: Any request failed or returned rejected spans (`partial` or `failed`).
- `2`: Usage error (missing `--otlp-http`, missing endpoint, invalid URL scheme, userinfo or a fragment, malformed headers/timeout including a header name that is not a token or a value with CR, LF or NUL, request cap exceeded).

## Excluded stores

Coordination state is not telemetry. `verification-v0` (a transient pid and token in a mode-0600 lock,
deleted after use, plus digests) is listed in `excludedStores` with that reason. `verification-reuse`
(mode-0600 records of passing checks: key and payload digests, a random ref, bounded output
excerpts) is listed there too; a `verify.check` line carries only the record's ref.

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
3. no network use under `src` (`.ts .js .mjs .cjs .mts .cts`, `src/cli` included) outside the pinned advice client and export sender. It is a static source check, not a sandbox, and it catches only these shapes: a network module `import` or a direct `require(...)` call, any reference to `fetch` (including `globalThis.fetch`, member access and aliases), `WebSocket`, `EventSource`, `process.getBuiltinModule`, `undici`, computed `globalThis[...]` access, `process.binding`, and `require`/`import` with a non-literal argument; comments and string, template and regex literals are not code; a verbatim copy of the sender under another name fails. It does not catch `createRequire`, `module.require` or `process.mainModule.require`, an aliased `globalThis` (`g = globalThis; g[...]`), `Reflect.get(globalThis, ...)` or `(0, globalThis)[...]` access, `eval`/`new Function`/Worker `eval` strings, a subprocess that reaches the network, `node:inspector`, or any file under `bin/` (FU-tgfbkv);
4. no skill, guidance or agent spec names `trace spans`, `trace export`, `trace analyze` or
   `verify-baseline`;
5. the package has no runtime dependency and G30.2 is still enforced;
6. every telemetry store is a declared `runs/` subdirectory the ledger readers skip;
7. the export block maps only closed descriptors and the analysis block is well formed; each attribute rule is typed (one rule key; `id: true` only on `tool_call_id`) and the mapper uses the same check.

Each check has a self-test that plants a violation and expects the check to name it.
