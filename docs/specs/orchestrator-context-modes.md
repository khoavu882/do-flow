---
description: The design contract for orchestrator context delivery modes.
---
# Spec: orchestrator context modes and context delivery

Design document for orchestrator context delivery (issue #9, feature 075-context-delivery).
It states the contract the implementation and its tests pin, and the final status of the four stages issue #9 tracked (sections 8 and 9).

## 1. Purpose and authority

ADR 3.4 and 3.11 govern context management, and this spec states the implemented subset for context delivery (feature 075-context-delivery). Normative shapes, schemas, and CLI contracts are cited from `agent-docs/doflow/075-context-delivery/design/specs.md` (IC-001 through IC-024).

Context delivery provides deterministic, budget-enforced context packing for workflow stages without silent truncation.

## 2. Delivery modes

Delivery modes operate per item within a context pack rather than across entire orchestrator edges:

- **full**: Complete item payload inline (mandatory items and kept optional items).
- **delta**: State diff relative to `--since <digest>` (dormant in 075 per IC-015; mandatory items remain inline).
- **pointer**: Self-loadable optional material referenced by pointer id (`ptr:<path>:<start>-<end>`, IC-016). Mandatory items are never pointers.
- **bare**: Narrow mode emitting header, objective, and end-of-pack line only (`mode=bare`, IC-001/IC-009).
- **expand**: `--expand <pointer id> --since <digest> --reason <text>` returns one pointer's current slice from a recorded pack (`mode=expand`) and records a `pointer-followed` expansion.

Rules:
- Item-level granularity replaces all-or-nothing edge modes for context delivery.
- In delta mode, unchanged optional items become omissions with reason `unchanged`, while mandatory items are always delivered inline.

## 3. Mandatory and optional content

Items are partitioned into mandatory and optional classes. Mandatory items are always emitted whole and are exempt from item-count limits. Optional items are fitted linearly in strict priority order.

### Classification table

The classification table matches `FIELD_CLASSES` (`src/runtime/context/compose.ts:11-29`) verbatim:

| Field | Class | Optional priority | Item id |
|---|---|---|---|
| objective | mandatory | n/a | objective |
| acceptanceCriteria | mandatory | n/a | ac:<n> |
| constraints | mandatory | n/a | nfr:<NFR-id> |
| verificationRequirements | mandatory | n/a | vr:<n> |
| scopeExcluded | mandatory | n/a | scope:<n> |
| claims.conflicts | mandatory | n/a | claim id |
| blockingGaps | mandatory | n/a | gap:<n> |
| researchRequests (blocking, not ANSWERED) | mandatory | n/a | request id |
| decisions.reason (register unreadable) | mandatory | n/a | decisions:reason |
| decisions.live | optional | 1 | decision id |
| claims.supported | optional | 2 | claim id |
| researchRequests (others) | optional | 3 | request id |
| claims.hypotheses | optional | 4 | claim id |
| pointers | optional | 5 | pointer id (IC-016) |
| relevantFiles | optional | 6 | file:<path> |
| evidenceSummary | optional | 7 | evidence id |
| structuralContext | optional | 8 | struct:<n> |

No field outside this table can be emitted (FR-011).

### Omission reasons

When optional items cannot be included, they are grouped in the omission records per IC-008:
- `not-fresh`: Evidence items with freshness `STALE` or `UNKNOWN` (omitted regardless of budget; never treated as empty or absent evidence).
- `superseded`: Evidence items whose ledger status is `superseded` (omitted regardless of budget; grouped after `not-fresh`).
- `mandatory-overflow`: Optional items omitted because mandatory content exceeds the budget.
- `budget`: Optional items omitted because available budget was exhausted during linear fit.
- `item-cap`: Optional items omitted due to per-field capacity ceilings (`relevantFiles: 15`, `claims.supported: 20`, `claims.hypotheses: 20`, `evidenceSummary: 25`, `researchRequests (others): 20`, `structuralContext: 5`).
- `unchanged`: Optional items unchanged since the `--since` pack digest in delta mode.

## 4. Budget resolution

Available budget is calculated using:
`available = capacity - consumed - reserve`

Specifically, when capacity and reserve are declared:
`available = (capacityTokens - startupTokensEstimate - reserveTokens) * 4` bytes.

### Cap resolution precedence

1. **Override**: `--max-bytes <n>` (positive integer; requires `--reason` if exceeding the resolved cap).
2. **Profile**: Harness `contextProfile` when `capacityTokens` and `reserveTokens` are both declared.
3. **Task class**: Default task class cap from `TASK_CLASS_BUDGETS` (`feature: 225000`, `bug: 71000`, `refactor: 71000`, `trivial-edit: 30000`, etc.).

### Capacity and basis

- Declared capacity reports `{ value: number, basis: "declared:<source>" }`.
- Unknown capacity reports `{ value: null, basis: "unknown:<reason>" }` (in 075, all 8 harnesses are unverified: `basis: "unknown:values belong to 085 (A-19)"`).
- Unstated harness reports `{ value: null, basis: "unknown:harness-unstated" }`.
- No model-name inference is performed.
- The tool-result limit notice (IC-009) prints only when `toolResultLimitBytes` is declared and exceeded.

## 5. Overflow handling

When mandatory content plus envelope exceeds the cap, the pack overflows:
- **No downgrade away from mandatory content**: Mandatory content is complete and emitted whole; nothing in mandatory content is dropped.
- **Exit status**: Exits with `EXIT.OVERFLOW = 3` (IC-002). Precedence is 2 (usage error), 3 (overflow), 1 (empty), 0 (OK).
- **Emitted output**:
  - Markdown: Second line displays `> OVERFLOW (exit 3): mandatory content is complete and nothing in it was dropped. It is <M> B against a <B> B budget (<source>). Split the task or its context, or start a new session, then request the pack again.` (or accounting overflow message).
  - JSON: `status: "OVERFLOW"`, `exitCode: 3`, `overflow: { cause, mandatoryBytes, budgetBytes, excessBytes, action: "split-or-new-session" }`, and `overflowAction: { message }`.
- **Required action**: The caller must act on `overflowAction.message` — split the task or its context, or start a new session, then request the pack again.

This replaces and retires the earlier proposal of downgrading context modes across edges upon budget exhaustion.

## 6. Delivery state, delta and retention

- **Delivery store**: Defined in IC-014 under `.doflow/state/delivery/<feature-ns>/<taskId>.json`.
- **Locking**: Acquired using bounded acquire option (`boundedAcquire`: 1 try + 3 retries 5ms apart) in `src/runtime/task-state.ts:131-155`. If the lock is held, `recorded: false` with `reason: "store-locked"` is returned without changing the exit code.
- **Retention**: At most 5 delivery entries are kept per task; oldest entries are evicted. The first writer of a delivery key (pack digest, form and harness) stands.
- **Delta conditions (IC-015)**: A delta pack requires `--since <digest>` matching a recorded entry, matching source hashes, and harness profile `retention: "supported"`. In 075, profile retention is unverified across all 8 harnesses, so delta is dormant (`deltaRefused: "retention-unproven"` or `"harness-unstated"`).

## 7. Telemetry and silence

- **Telemetry separation (IC-017)**:
  - Tokens: `estimated: { value: Math.ceil(bytes / 4), basis: "estimated:bytes/4" }`.
  - Actual tokens: `{ actual: { unmeasured: ... } }`. Actual tokens are strictly unmeasured in 075.
  - Expansions: Recorded for pointer expansions (`pointer-followed`), cap raises (`cap-raised`), and delta widening (`delta-widened`).
- **Silence on recurring surfaces (IC-024)**: Recurring session and prompt hooks emit no context-pack tokens, delivery markers, or omission data.

## 8. The four stages of issue #9

Issue #9 tracked four stages of orchestrator refinement. None is open: one is superseded, one is replaced by existing records, and two are retired. The principles that survive are kept in the last list of this section.

**Stage 1, modes as data (per-edge `contextMode` in `core/registry/workflows.json`): retired.**
- Item-level delivery (section 2) already decides what a stage receives, per item and from recorded evidence, so an edge-level default would be a second, coarser switch over the same choice.
- Since this stage was proposed, each stage edge in `core/registry/workflows.json` gained an `agent` binding (feature 118), and the pack a stage receives is chosen by the caller's flags and the budget (sections 3 to 5), not by the edge. No code or registry field named `contextMode` exists, and no roadmap row owns one.
- Revisit only if a concrete orchestrator loop needs a per-edge default that item-level flags cannot express. That need would start as a new feature with its own design, not as this stage.

**Stage 2, budget downgrade: superseded by feature 075.** Delivery is per item (section 2): `full`, `delta` (dormant, section 6), `pointer`, `bare` and `expand`. When mandatory content exceeds the cap, the pack is still emitted whole and the verb exits 3 (section 5); nothing is traded away. The implementation is `handleContextPackCommand` in `src/runtime/context-pack.ts`, the classification and linear fit in `src/runtime/context/compose.ts`, budget resolution in `src/runtime/context/budget.ts`, and the delivery store in `src/runtime/context/delivery-store.ts` (its lock in `src/runtime/task-state.ts`). The verb is `doflow context-pack` (see the [reference](../reference.md)).

**Stage 3, handoff events (a proposed append-only `.doflow/state/events.jsonl` bus at the dispatcher seam, never created): replaced by existing records.**
- The run ledger and the offline `trace spans` projection (feature 088):
  - Every dispatched verb, `context-pack` and `orchestrate` included, appends a metadata record to the date-partitioned run ledger (`runs/*.jsonl`, `src/runtime/trace/ledger.ts`).
  - Every stage handoff is a history entry in the orchestration record (`orchestration/*.json`, written by `src/runtime/workflow-orchestrator.ts`; actions such as `complete-stage`, `skip-stage`, `decide-gate`, `annotate` and `complete-run`). `trace spans` (`src/runtime/trace/spans.ts`) turns these into `stage` and `orchestration` spans with the stage id, outcome and execution status, placed inside the run's trace. Spans are projected offline; there is no span store and no second write path.
- The pack a stage was handed (FU-7j3k84):
  - A `complete-stage` entry carries `packs`, a list of `{ taskId, digest }`, oldest first. `digest` is the delivery store's own `packDigest` (section 6), so `context-pack --since <digest>` resolves it; no second hash exists. `WorkflowOrchestrator#packsDelivered` reads the delivery store when the stage completes: the run's own task file, and for a run keyed on its feature's slug every task file under `delivery/<slug>/` too (do-execute-plan compiles one pack per plan task). It keeps each task's latest delivery whose `firstAt` falls in the stage's window. The window starts where `stageSince` starts it, the same window the MCP outcome rule counts evidence in (unbounded for a run the handoff itself started), and it ends at the handoff.
  - The `stage` span carries `pack_count`, plus `pack_task` and `pack_digest` of the latest pack.
  - Absent means unknown, never an error. A stage with no recorded delivery in its window gets no `packs` field and no pack attributes. An orchestration record written before this field existed projects exactly as before, and so does a malformed `packs` value or item.
  - The record is metadata only: a task id and a digest.
  - Accepted ceilings:
    - The delivery store keeps the first delivery time of a key only. A byte-identical pack delivered again in a later stage is not seen there, so that stage records none rather than an earlier stage's pack.
    - A `--no-record` pack leaves no delivery entry and so no link.
    - The store holds no session identity, so another session's pack for the same feature inside the window is counted.
    - A backfilled (imported) stage and an `annotate` rerun record no packs.
  - The `doflow-run` ledger line is unchanged. The dispatcher writes it from the verb name and an argument count and cannot see a digest (NFR-004). A second Node-written line for the same call would count the verb twice in `stats`.
- The proposed `.doflow/state/events.jsonl` was never created. The only `events.jsonl` is the machine-wide failure-capture stream at `<config home>/failures/events.jsonl` (`src/runtime/failure/home.ts:22-28`), a different thing, and not a handoff bus. A separate append-only bus would duplicate the ledger and the orchestration history.

**Stage 4, harness narrowing (per-class mode ceilings in `core/registry/harnesses.json`): retired.** It depended on stage 1's modes, and with stage 1 retired it has nothing to cap. The ceilings that matter are already declared per harness as `contextProfile` (`capacityTokens`, `reserveTokens`, `toolResultLimitBytes`, `retention`) and resolve through the cap precedence in section 4; all eight are unverified in 075, which is why capacity reports `unknown` and delta stays dormant. Verifying those values belongs to feature 085 (A-19), not to a new mode ceiling.

**Principles that still hold:**
- Context-delivery behaviour is declared as registry data where it applies, not as logic in a skill: the budget by task class (`TASK_CLASS_BUDGETS`, `src/runtime/context/budget.ts`) and the harness profile (`contextProfile` in `core/registry/harnesses.json`). A change of behaviour is a data change.
- A harness narrows what a pack may be as a ceiling, never as a different delivery path: the resolved cap (section 4) is the one limit, and an override above it needs a recorded reason.
- Nothing is silently dropped: running out of budget is an exit status and an action, never a quiet reduction of the pack.
- A record of a handoff is metadata only (identifiers, digests, counts), as the run ledger already enforces for its own fields (NFR-004).

## 9. Status per section

Status of each section in this specification, cited with code locations and proving tests:

- **Section 1 (Purpose and authority)**: Governed by ADR 3.4/3.11 and feature 075 contracts
  (`agent-docs/doflow/075-context-delivery/design/specs.md`, IC-001 through IC-024).
- **Section 2 (Delivery modes)**: Implemented by `handleContextPackCommand` in
  `src/runtime/context-pack.ts`; verified by `test/runtime/context-pack-forms.test.ts`.
- **Section 3 (Mandatory and optional)**: Implemented by `FIELD_CLASSES` and `linearFit` in
  `src/runtime/context/compose.ts`; verified by `test/runtime/context-pack-compose.test.ts` and
  `test/runtime/context-pack-omissions.test.ts`.
- **Section 4 (Budget resolution)**: Implemented by `TASK_CLASS_BUDGETS` and `resolveBudget` in
  `src/runtime/context/budget.ts`; verified by `test/runtime/context-budget-resolve.test.ts` and
  `test/runtime/context-pack-cap.test.ts`.
- **Section 5 (Overflow handling)**: Implemented by `EXIT.OVERFLOW` in `src/runtime/cli-result.ts`,
  `linearFit` in `src/runtime/context/compose.ts`, and `handleContextPackCommand` in
  `src/runtime/context-pack.ts`; verified by `test/runtime/context-pack-overflow.test.ts`.
- **Section 6 (Delivery state, delta and retention)**: Bounded locking and atomic writes are
  implemented by `boundedAcquire` and `updateTaskState` in `src/runtime/task-state.ts`; verified by
  `test/runtime/task-state-concurrency.test.ts` and `test/runtime/task-state-acquire.test.ts`.
  Delta rules are specified by IC-015 (dormant in 075).
- **Section 7 (Telemetry and silence)**: Implemented by `handleContextPackCommand` in
  `src/runtime/context-pack.ts`; the always-loaded budget is guarded by
  `test/guards/context-budget.test.ts`.
- **Section 8 (The four stages of issue #9)**:
  - Stage 1 (Modes as data): retired; item-level delivery and stage agent bindings (feature 118) cover the choice.
  - Stage 2 (Budget downgrade): superseded by 075 item-level overflow in `handleContextPackCommand`
    (`src/runtime/context-pack.ts`).
  - Stage 3 (Handoff events): replaced by the run ledger (`src/runtime/trace/ledger.ts`) and the offline
    span projection (`src/runtime/trace/spans.ts`, feature 088). The pack-to-stage link is the
    `complete-stage` entry's `packs` (`packsDelivered` in `src/runtime/workflow-orchestrator.ts`) and the
    stage span's `pack_*` attributes, verified by `test/runtime/stage-pack-link.test.ts`.
  - Stage 4 (Harness narrowing): retired with stage 1; `contextProfile` already declares the ceiling fields (unverified in 075).
