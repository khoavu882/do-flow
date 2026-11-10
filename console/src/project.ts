'use strict';

// Console projection (feature 093, IC-004; FR-002, NFR-003): one projector per allow-listed argv
// shape. A projector builds a new body from the listed fields only, each checked for type and
// value set; everything else in the core's output is never read, so journal notes, gate prompts,
// files, warnings and reason texts cannot reach a route. A required field missing or of the wrong
// type refuses the whole body as `core-contract-mismatch`; there is no partial body.
//
// The closed sets are copies of the core's (this package ships without it); project.test.ts checks
// each one against its source file.

const { isSemVer } = require('./handshake.ts');
const { maskLite } = require('./mask-lite.ts');
// One contract-mismatch class for every projector: place.ts's `boundedText` throws it on a non-string,
// and `project()` maps it to `core-contract-mismatch` (151 IC-006).
const { Mismatch, anchorsOf, boundedText, placePath } = require('./place.ts');

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LABEL = /^[A-Za-z0-9 ._:/@-]{1,64}$/;
const WITHHELD = '(withheld)';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
/** `cwdHash` (worktreeKey) and the bridge's session key: 16 lowercase hex. */
const KEY16 = /^[0-9a-f]{16}$/;
const HEAD12 = /^[0-9a-f]{12}$/;
/** IC-018: a harness id outside the registry is shown as this fixed text. */
const OTHER_HARNESS = '(other)';

const CLOSED_SETS = Object.freeze({
  /** src/runtime/workflow-orchestrator.ts RUN_STATES */
  runStates: Object.freeze(['RUNNING', 'AWAITING_GATE', 'COMPLETED', 'REJECTED']),
  /** src/runtime/workflow-orchestrator.ts compileProgram node types */
  nodeTypes: Object.freeze(['stage', 'gate']),
  /** src/runtime/implementation-gate.ts run entry origins */
  origins: Object.freeze(['current', 'other']),
  /** IC-012 */
  timelineActions: Object.freeze(['start', 'complete-stage', 'skip-stage', 'skip-gate', 'decide-gate', 'annotate', 'complete-run']),
  /** src/runtime/workflow-orchestrator.ts STAGE_OUTCOMES */
  stageOutcomes: Object.freeze(['passed', 'failed', 'unverified']),
  /** src/runtime/workflow-orchestrator.ts GATE_DECISIONS */
  gateDecisions: Object.freeze(['approve', 'reject']),
  /** src/runtime/task-graph.ts DERIVED keys */
  taskStates: Object.freeze(['PLANNED', 'READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED']),
  /** src/runtime/task-graph.ts deriveTasks and readinessOf */
  taskReasons: Object.freeze(['completed', 'active-attempt', 'budget', 'cancelled', 'failed', 'result-blocked',
    'dependency-held', 'unmet-dependency', 'unmet-phase', 'ready', 'plan-changed-after-done', 'reopened']),
  /** the task-attempt ledger (src/runtime/task-attempts.ts, task-run.ts) */
  attemptStates: Object.freeze(['active', 'finished', 'released', 'cancelled', 'superseded']),
  /** src/runtime/task-attempts.ts MODES */
  attemptModes: Object.freeze(['manual', 'sequential', 'subagent']),
  /** src/runtime/task-attempts.ts RESULTS */
  attemptResults: Object.freeze(['COMPLETED', 'BLOCKED', 'ABANDONED', 'INCONCLUSIVE', 'FAILED']),
  /** src/runtime/capability-router.ts resolveCapability */
  capabilityStatuses: Object.freeze(['HEALTHY', 'FALLBACK', 'UNAVAILABLE']),
  /** core/registry/harnesses.json harness ids */
  harnessIds: Object.freeze(['claude', 'codex', 'opencode', 'pi', 'copilot', 'kiro', 'antigravity']),
  /** src/runtime/worker/command.ts statusView states, with the end states of supervisor.ts and cancel.ts */
  workerStates: Object.freeze(['starting', 'running', 'unknown', 'exited', 'timed-out', 'cancelled']),
  /** src/runtime/worker/command.ts statusView reasons */
  workerReasons: Object.freeze(['supervisor-lost', 'liveness-unknown', 'process-lost']),
  /** src/runtime/roadmap/loop.ts operationalState hold states */
  roadmapHoldStates: Object.freeze(['held', 'paused']),
  /** IC-018 a */
  checkoutRoles: Object.freeze(['main', 'linked']),
  sessionKinds: Object.freeze(['hook', 'launched']),
  observedStores: Object.freeze(['present', 'absent']),
  /** src/runtime/fleet/projects.ts sources (IC-019) */
  projectSources: Object.freeze(['upkeep-roots', 'hook-dirs']),
  /** src/runtime/fleet/tree.ts node kinds, model bases, liveness and edge bases (IC-020) */
  agentKinds: Object.freeze(['main-session', 'harness-subagent', 'doflow-run', 'worker-run', 'child-worker-run']),
  modelBases: Object.freeze(['hook-observation', 'worker-binding', 'harness-record', 'dispatch-snapshot']),
  livenessStates: Object.freeze(['process-seen', 'process-gone', 'not-checked']),
  edgeBases: Object.freeze(['harness-subagent-record', 'worker-caller', 'worker-childOf', 'attempt-runKey', 'dispatch-claim']),
  /** IC-020 `transcript.reason` and IC-022 */
  transcriptReasons: Object.freeze(['no-reader', 'not-linked', 'not-found']),
  /** IC-021 `status` */
  readerStatuses: Object.freeze(['supported', 'events-only', 'unknown']),
  /** IC-022 event kinds, tool statuses and `record.type` */
  eventKinds: Object.freeze(['reply', 'tool-call', 'tool-result', 'usage', 'model-change', 'subagent-start', 'turn-end', 'record']),
  toolStatuses: Object.freeze(['ok', 'error']),
  recordTypes: Object.freeze(['worker-run-start', 'worker-run-end', 'attempt-claim', 'attempt-end', 'hook-record']),
  /** IC-023 pair bases */
  pairBases: Object.freeze(['same-model', 'same-task', 'overlap']),
  /** 150 IC-011: src/runtime/worker/run-store.ts PHASES */
  phases: Object.freeze(['starting', 'running', 'cancelling', 'ended']),
  /** the `end.state` values supervisor.ts and cancel.ts write */
  endStates: Object.freeze(['exited', 'timed-out', 'cancelled']),
  /** src/runtime/worker/supervisor.ts resultOfRun withheld codes */
  withheldCodes: Object.freeze(['not-exited', 'outside-write', 'branch-moved', 'isolation-unverifiable', 'read-only-violation', 'read-only-unverifiable',
    'report-denied', 'report-quota', 'report-failure', 'report-unparsed', 'group-survived']),
  /** src/runtime/worker/parsers/common.ts Report status */
  reportStatuses: Object.freeze(['success', 'failure', 'denied', 'unparsed']),
  /** src/runtime/worker/worktree-check.ts Comparison status: the read-only and isolation checks */
  checkStatuses: Object.freeze(['clean', 'violated', 'unverifiable']),
  /** src/runtime/worker/supervisor.ts isolationOf reasons */
  isolationReasons: Object.freeze(['outside-write', 'branch-moved', 'isolation-unverifiable']),
  /** src/runtime/worker/process-tree.ts escalate and cancel.ts cleanup statuses (`process.leftover`, `cleanup`) */
  leftoverStatuses: Object.freeze(['verified', 'survivors', 'unknown']),
  /** src/runtime/worker/supervisor.ts `process.kind` */
  processKinds: Object.freeze(['exited', 'not-started']),
  /** src/runtime/worker/log-read.ts LOG_STREAMS */
  logStreams: Object.freeze(['out', 'err']),
  /** src/runtime/worker/reads.ts IC-002 log states */
  logStates: Object.freeze(['waiting', 'open', 'gone', 'none']),
});

// 151 IC-007, IC-008: the closed sets of the management reads, each a copy project.test.ts checks against its source.
/** src/runtime/settings/resolve.ts:54 `Layer` */
const LAYERS: readonly string[] = Object.freeze(['env', 'local', 'project', 'user', 'default']);
/** src/runtime/settings/resolve.ts:57 `Status` */
const CANDIDATE_STATUSES: readonly string[] = Object.freeze(['decided', 'overridden', 'shadowed', 'redundant', 'ignored-scope', 'not-narrower', 'no-effect', 'invalid']);
/** src/runtime/settings/resolve.ts:58 `Via`, null aside */
const VIA: readonly string[] = Object.freeze(['fail-safe', 'cross-key', 'no-config-home']);
/** src/runtime/settings/files.ts:26 `LayerCode` */
const FILE_CODES: readonly string[] = Object.freeze(['unparseable', 'schema', 'too-large', 'not-file', 'unreadable']);
/** the `scope` values of core/registry/settings.json keys */
const SCOPES: readonly string[] = Object.freeze(['global-only', 'narrow-only', 'project-overridable']);
/** src/runtime/advice/report.ts:50 to :54, the modes tally */
const ADVICE_MODES: readonly string[] = Object.freeze(['shadow', 'act', 'unrecorded']);
// 151 IC-009 to IC-011: the closed sets of the follow-up, health and worker reads.
/** src/runtime/lifecycle/followup.ts:33 `STATES` */
const FOLLOWUP_STATES: readonly string[] = Object.freeze(['open', 'taken', 'done', 'dismissed']);
/** RK2: the union of `SOURCE_KINDS` (src/runtime/lifecycle/followup.ts:34), the `stage` kind buildItems accepts (:165) and the `report` kind reportSource writes (:243). */
const SOURCE_KINDS: readonly string[] = Object.freeze(['stage', 'run', 'release', 'manual', 'report']);
/** src/runtime/lifecycle/status.ts:289 `releaseMode` */
const RELEASE_MODES: readonly string[] = Object.freeze(['tagged', 'untagged', 'unknown']);
/** src/runtime/lifecycle/status.ts:257 `BUCKET` values */
const FEATURE_BUCKETS: readonly string[] = Object.freeze(['finished', 'awaitingRelease', 'inProgress', 'unknown']);
/** src/runtime/worker/matrix.ts `STATUSES` */
const MATRIX_STATUSES: readonly string[] = Object.freeze(['supported', 'unknown', 'unsupported']);
/** src/runtime/worker/matrix.ts `GROUPS` */
const MATRIX_GROUPS: readonly string[] = Object.freeze(['worker', 'orchestration']);

/** IC-022: the byte caps of the two text fields, re-checked here after the second masking pass (IC-024). */
const TEXT_CAP_BYTES = 4096;
const ARGS_CAP_BYTES = 512;
/** IC-022: a transcript cursor, `<inode>:<byteOffset>:<recordSeq>:<recordAtMs>`. */
const CURSOR = /^[0-9]+:[0-9]+:[0-9]+:[0-9]+$/;

type Check<T> = (value: unknown) => T;
type Projected = { ok: true; body: any } | { ok: false; code: 'core-contract-mismatch' };

const fail = (): never => {
  throw new Mismatch();
};

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : fail();
const each = <T>(check: Check<T>): Check<T[]> => (value) => (Array.isArray(value) ? value.map((item) => check(item)) : fail());
const orNull = <T>(check: Check<T>): Check<T | null> => (value) => (value === null ? null : check(value));
const oneOf = (set: readonly string[]): Check<string> => (value) => (typeof value === 'string' && set.includes(value) ? value : fail());
const id: Check<string> = (value) => (typeof value === 'string' && ID.test(value) ? value : fail());
const text: Check<string> = (value) => (typeof value === 'string' ? value : fail());
/** A label is a name, never a place or a secret: a leading `/` or `~`, a drive prefix, or text the mask would change is withheld. */
const PATH_LABEL = /^[/~]|^[A-Za-z]:[\\/]/;
const label: Check<string> = (value) => (typeof value !== 'string' ? fail() : LABEL.test(value) && !PATH_LABEL.test(value) && maskLite(value) === value ? value : WITHHELD);
const iso: Check<string> = (value) => (typeof value === 'string' && ISO.test(value) && !Number.isNaN(Date.parse(value)) ? value : fail());
const count: Check<number> = (value) => (Number.isInteger(value) && (value as number) >= 0 ? (value as number) : fail());
const bool: Check<boolean> = (value) => (typeof value === 'boolean' ? value : fail());
const one: Check<1> = (value) => (value === 1 ? 1 : fail());
const key16: Check<string> = (value) => (typeof value === 'string' && KEY16.test(value) ? value : fail());
const token: Check<number> = (value) => (Number.isInteger(value) && (value as number) >= 1 ? (value as number) : fail());
const harness: Check<string> = (value) => (typeof value !== 'string' ? fail() : CLOSED_SETS.harnessIds.includes(value) ? value : OTHER_HARNESS);
/** A non-negative finite number (a rate, or a sum the core rounded to two decimals). */
const rate: Check<number> = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fail());
const cursor: Check<string> = (value) => (typeof value === 'string' && CURSOR.test(value) ? value : fail());
/** 150: a worker run id (`RUN_ID`, src/runtime/worker/run-store.ts). */
const RUN_ID = /^w-[0-9a-f]{12}$/;
const runId: Check<string> = (value) => (typeof value === 'string' && RUN_ID.test(value) ? value : fail());
const digits: Check<string> = (value) => (typeof value === 'string' && /^[0-9]+$/.test(value) ? value : fail());
/**
 * IC-024: a *text* field. The cap is checked on the bytes received, the text is masked a second time
 * (mask-lite.ts), and the cap is checked again on the result: a field over its cap on either side is
 * refused, never cut (a cut would need `cut` to say so, and the core owns that).
 */
const maskedText = (cap: number): Check<string> => (value) => {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > cap) return fail();
  const masked: string = maskLite(value);
  return Buffer.byteLength(masked, 'utf8') > cap ? fail() : masked;
};
/** A field the core emits only in some states (worker `overdue`, `supervisorLost`): absent reads as null. */
const optional = <T>(check: Check<T>): Check<T | null> => (value) => (value === undefined ? null : orNull(check)(value));

/** The fields `status` and a `list` row share (snapshotRun in the core). */
function runFields(row: Record<string, unknown>) {
  return {
    taskId: id(row.taskId),
    taskClass: id(row.taskClass),
    workflowName: label(row.workflowName),
    state: oneOf(CLOSED_SETS.runStates)(row.state),
    current: orNull((value) => {
      const node = record(value);
      return { type: oneOf(CLOSED_SETS.nodeTypes)(node.type), id: id(node.id), kind: orNull(id)(node.kind) };
    })(row.current),
    // The gate's name is dropped: the registry supplies it.
    awaitingGate: orNull((value) => ({ gateId: id(record(value).gateId) }))(row.awaitingGate),
    progress: ((progress) => ({ done: count(progress.done), total: count(progress.total) }))(record(row.progress)),
    revision: count(row.revision),
  };
}

function listRow(value: unknown) {
  const row = record(value);
  return {
    ...runFields(row),
    featureSlug: orNull(id)(row.featureSlug),
    startedAt: orNull(iso)(row.startedAt),
    updatedAt: orNull(iso)(row.updatedAt),
    origin: oneOf(CLOSED_SETS.origins)(row.origin),
  };
}

function list(value: unknown) {
  const body = record(value);
  one(body.v);
  const unreadable = Array.isArray(body.unreadable) ? body.unreadable : fail();
  return { v: 1, runs: each(listRow)(body.runs), unreadableCount: unreadable.length };
}

/**
 * The journal's copy of the awaiting gate is compared with the registry gate of the projected
 * `workflow` body and only the verdict leaves. A different class, no workflow or no such gate in it
 * cannot confirm the journal, so it counts as differing.
 */
function status(value: unknown, context?: { workflow?: any }) {
  const body = record(value);
  const run = runFields(body);
  let journalGateDiffers = false;
  if (run.awaitingGate) {
    const journal = record(body.awaitingGate);
    const name = text(journal.name);
    const prompt = orNull(text)(journal.prompt);
    const workflow = context?.workflow;
    const gate = workflow && workflow.taskClass === run.taskClass
      ? workflow.stages.flatMap((stage: any) => stage.gatesAfter).find((g: any) => g.id === run.awaitingGate!.gateId)
      : undefined;
    journalGateDiffers = !gate || gate.name !== name || gate.prompt !== prompt;
  }
  return { ...run, journalGateDiffers };
}

const timelineEvent = (value: unknown) => {
  const event = record(value);
  return {
    at: orNull(iso)(event.at),
    action: oneOf(CLOSED_SETS.timelineActions)(event.action),
    node: orNull(id)(event.node),
    outcome: orNull(oneOf(CLOSED_SETS.stageOutcomes))(event.outcome),
    decision: orNull(oneOf(CLOSED_SETS.gateDecisions))(event.decision),
    forced: bool(event.forced),
    synthetic: bool(event.synthetic),
  };
};

function timeline(value: unknown) {
  const body = record(value);
  return {
    v: one(body.v),
    taskId: id(body.taskId),
    featureSlug: orNull(id)(body.featureSlug),
    revision: count(body.revision),
    startedAt: orNull(iso)(body.startedAt),
    events: each(timelineEvent)(body.events),
    otherEvents: count(body.otherEvents),
  };
}

const graphTask = (value: unknown) => {
  const task = record(value);
  return { id: id(task.id), phase: id(task.phase), owner: orNull(label)(task.owner), taskDeps: each(id)(task.taskDeps), parallel: bool(task.parallel) };
};

/** IC-013: no reason text, evidence id, worktree, usage or trace; IC-018 c: the checkout key, run and lineage of its runKey. */
const attempt = (value: unknown) => {
  const entry = record(value);
  return {
    token: token(entry.token),
    owner: label(entry.owner),
    mode: oneOf(CLOSED_SETS.attemptModes)(entry.mode),
    state: oneOf(CLOSED_SETS.attemptStates)(entry.state),
    startedAt: orNull(iso)(entry.startedAt),
    endedAt: orNull(iso)(entry.endedAt),
    result: orNull(oneOf(CLOSED_SETS.attemptResults))(entry.result),
    worktreeKey: orNull(key16)(entry.worktreeKey),
    run: orNull(id)(entry.run),
    lineage: orNull(id)(entry.lineage),
  };
};

/** IC-018 d: a write-set overlap as its two task ids and a file count; the file names are dropped. */
const overlap = (value: unknown) => {
  const pair = record(value);
  return { a: id(pair.a), b: id(pair.b), fileCount: each(text)(pair.files).length };
};

const taskRow = (value: unknown) => {
  const task = record(value);
  const budget = record(task.budget);
  return {
    id: id(task.id),
    state: oneOf(CLOSED_SETS.taskStates)(task.state),
    reason: oneOf(CLOSED_SETS.taskReasons)(task.reason),
    budget: { used: count(budget.used), limit: count(budget.limit) },
    attempts: each(attempt)(task.attempts),
  };
};

/** Dropped: files, acceptance, warnings, overlaps[].files, run, advisory (and slug, defaults, readiness). */
function attempts(value: unknown) {
  const body = record(value);
  const graph = record(body.graph);
  return {
    revision: count(body.revision),
    graph: {
      digest: typeof graph.digest === 'string' && DIGEST.test(graph.digest) ? graph.digest : fail(),
      graphPlan: bool(graph.graphPlan),
      tasks: each(graphTask)(graph.tasks),
      overlaps: each(overlap)(graph.overlaps),
    },
    tasks: each(taskRow)(body.tasks),
  };
}

const gate = (value: unknown) => {
  const entry = record(value);
  return { id: id(entry.id), name: text(entry.name), kind: id(entry.kind), trigger: id(entry.trigger), prompt: text(entry.prompt) };
};

const stage = (value: unknown) => {
  const entry = record(value);
  return {
    id: id(entry.id),
    skill: id(entry.skill),
    agent: id(entry.agent),
    kind: id(entry.kind),
    optional: bool(entry.optional),
    purpose: text(entry.purpose),
    gatesAfter: each(gate)(entry.gatesAfter),
  };
};

/** Registry texts (`purpose`, gate `name` and `prompt`) are kept: they come from the shipped registry. */
function workflow(value: unknown) {
  const body = record(value);
  return { taskClass: id(body.taskClass), name: label(body.name), stages: each(stage)(body.stages) };
}

function capabilities(value: unknown) {
  const capability = (item: unknown) => {
    const entry = record(item);
    return { capability: id(entry.capability), status: oneOf(CLOSED_SETS.capabilityStatuses)(entry.status), providerId: orNull(id)(entry.providerId) };
  };
  return { capabilities: each(capability)(record(value).capabilities) };
}

// ---- IC-018: the Sessions reads ----

/** IC-018 a: checkouts with branch, HEAD and its commit time; hook and launched sessions by key. No path or raw id exists in the input. */
function observed(value: unknown) {
  const body = record(value);
  const checkout = (item: unknown) => {
    const entry = record(item);
    return {
      worktreeKey: key16(entry.worktreeKey),
      role: oneOf(CLOSED_SETS.checkoutRoles)(entry.role),
      current: bool(entry.current),
      branch: orNull(label)(entry.branch),
      head: orNull((v) => (typeof v === 'string' && HEAD12.test(v) ? v : fail()))(entry.head),
      headCommittedAt: orNull(iso)(entry.headCommittedAt),
    };
  };
  const session = (item: unknown) => {
    const entry = record(item);
    return {
      sessionKey: key16(entry.sessionKey),
      worktreeKey: key16(entry.worktreeKey),
      kind: oneOf(CLOSED_SETS.sessionKinds)(entry.kind),
      harness: orNull(harness)(entry.harness),
      model: orNull(label)(entry.model),
      modelFirstSeenAt: orNull(iso)(entry.modelFirstSeenAt),
      startedAt: orNull(iso)(entry.startedAt),
      branchAtStart: orNull(label)(entry.branchAtStart),
      lastHookRecordAt: orNull(iso)(entry.lastHookRecordAt),
      launched: orNull((v) => {
        const unit = record(v);
        return { run: id(unit.run), lineage: id(unit.lineage), attempt: id(unit.attempt) };
      })(entry.launched),
    };
  };
  return {
    v: one(body.v),
    store: oneOf(CLOSED_SETS.observedStores)(body.store),
    checkouts: each(checkout)(body.checkouts),
    sessions: each(session)(body.sessions),
    truncated: bool(body.truncated),
    unreadable: count(body.unreadable),
  };
}

/** IC-018 b: slot holders and waiter counts; no pid, start, cwd or waiter detail exists in the input. */
function slots(value: unknown) {
  const body = record(value);
  const holder = (item: unknown) => {
    const entry = record(item);
    const alive = entry.alive === true || entry.alive === false || entry.alive === 'unknown' ? entry.alive : fail();
    return { label: orNull(label)(entry.label), since: orNull(iso)(entry.since), alive, worktreeKey: orNull(key16)(entry.worktreeKey) };
  };
  const slot = (item: unknown) => {
    const entry = record(item);
    return { name: id(entry.name), holder: orNull(holder)(entry.holder), waiters: count(entry.waiters) };
  };
  return { v: one(body.v), slots: each(slot)(body.slots), unreadable: count(body.unreadable) };
}

/** A process-group cleanup verdict (`process.leftover`, `cleanup`): status and reason; `survivors` and `zombies` (pids) are never read. */
const leftover = (value: unknown) => {
  const entry = record(value);
  return { status: oneOf(CLOSED_SETS.leftoverStatuses)(entry.status), reason: orNull(id)(entry.reason) };
};

/**
 * 150 IC-011: the run record's `process`, field by field. The core writes `code`, `signal`,
 * `groupAlive` and `leftover` for an exited run only and `reason` for a not-started one, so each
 * absent one reads as null. `pid`, `pgid` and `start` are never read.
 */
const processState = (value: unknown) => {
  const p = record(value);
  const code = optional(count)(p.code);
  if (code !== null && code > 255) fail();
  return {
    kind: oneOf(CLOSED_SETS.processKinds)(p.kind),
    code,
    signal: optional(label)(p.signal),
    at: orNull(iso)(p.at),
    reason: optional(id)(p.reason),
    groupAlive: optional((v) => (v === true || v === false || v === 'unknown' ? v : fail()))(p.groupAlive),
    leftover: optional(leftover)(p.leftover),
  };
};

/**
 * IC-018 d, widened by 150 IC-011 (FR-016): one worker run's state, the process check, the deadline,
 * the granter, the process outcome and the cleanup verdict. Dropped: identity, report, output, edit,
 * isolation, cancel, verified, withheld, every pid, pgid, process start, survivor and zombie, and the
 * rest. The four 150 fields read absent as null, as `overdue` does. The core's answer for an attempt
 * with no worker run (`run: null`) projects to null.
 */
function workerStatus(value: unknown) {
  const body = record(value);
  if (body.disposition !== 'status') fail();
  if (Object.hasOwn(body, 'run')) {
    if (body.run !== null) fail();
    id(body.task);
    token(body.token);
    return null;
  }
  return {
    runId: id(body.runId),
    task: id(body.task),
    token: token(body.token),
    harness: orNull(harness)(body.harness),
    state: oneOf(CLOSED_SETS.workerStates)(body.state),
    reason: orNull(oneOf(CLOSED_SETS.workerReasons))(body.reason),
    startedAt: orNull(iso)(body.startedAt),
    endedAt: orNull(iso)(body.endedAt),
    overdue: optional(bool)(body.overdue),
    supervisorLost: optional(bool)(body.supervisorLost),
    attemptActive: bool(body.attemptActive),
    deadline: optional(iso)(body.deadline),
    childOf: optional(runId)(body.childOf),
    process: optional(processState)(body.process),
    cleanup: optional(leftover)(body.cleanup),
  };
}

// ---- 150 IC-011: the Session screen's worker reads ----

/** IC-004: the bounded run list of one feature, ended and child runs included (`limits.ended: 'listed'`). */
function workerRuns(value: unknown) {
  const body = record(value);
  const run = (item: unknown) => {
    const r = record(item);
    return {
      runId: runId(r.runId),
      task: id(r.task),
      token: token(r.token),
      harness: orNull(harness)(r.harness),
      childOf: orNull(runId)(r.childOf),
      phase: oneOf(CLOSED_SETS.phases)(r.phase),
      endState: orNull(oneOf(CLOSED_SETS.endStates))(r.endState),
      createdAt: orNull(iso)(r.createdAt),
      startedAt: orNull(iso)(r.startedAt),
      endedAt: orNull(iso)(r.endedAt),
      edit: orNull(bool)(r.edit),
    };
  };
  const runs = each(run)(body.runs);
  const limits = record(body.limits);
  const shown = count(limits.shown);
  if (shown !== runs.length) fail();
  return {
    v: one(body.v),
    slug: id(body.slug),
    source: 'worker-runs',
    store: oneOf(CLOSED_SETS.observedStores)(body.store),
    runs,
    limits: { shown, notShown: count(limits.notShown), ended: 'listed' },
  };
}

/** IC-003's keys, exactly: a body with any other key is refused. */
const RESULT_KEYS: ReadonlySet<string> = new Set(['v', 'runId', 'task', 'token', 'harness', 'phase', 'endState', 'endedAt', 'reportStatus', 'readOnly',
  'isolation', 'resultOffered', 'withheld', 'quota']);

/** IC-003: the result fields of one run. `resultOffered` must agree with `withheld` being empty, as `resultOfRun` builds them. */
function workerResult(value: unknown) {
  const body = record(value);
  const keys = Object.keys(body);
  if (keys.length !== RESULT_KEYS.size || !keys.every((key) => RESULT_KEYS.has(key))) fail();
  const resultOffered = bool(body.resultOffered);
  const withheld = each(oneOf(CLOSED_SETS.withheldCodes))(body.withheld);
  if (resultOffered !== (withheld.length === 0)) fail();
  return {
    v: one(body.v),
    runId: runId(body.runId),
    task: id(body.task),
    token: token(body.token),
    harness: orNull(harness)(body.harness),
    phase: oneOf(CLOSED_SETS.phases)(body.phase),
    endState: orNull(oneOf(CLOSED_SETS.endStates))(body.endState),
    endedAt: orNull(iso)(body.endedAt),
    reportStatus: orNull(oneOf(CLOSED_SETS.reportStatuses))(body.reportStatus),
    readOnly: orNull(oneOf(CLOSED_SETS.checkStatuses))(body.readOnly),
    isolation: orNull((v) => {
      const isolation = record(v);
      return { status: oneOf(CLOSED_SETS.checkStatuses)(isolation.status), reason: orNull(oneOf(CLOSED_SETS.isolationReasons))(isolation.reason) };
    })(body.isolation),
    resultOffered,
    withheld,
    quota: orNull((v) => {
      const quota = record(v);
      return { signal: label(quota.signal), basis: label(quota.basis) };
    })(body.quota),
  };
}

/**
 * IC-002: one page of a run's `out` or `err` log. `from <= to <= size`; piece offsets rise strictly
 * inside `[from, to)`; each piece text is masked a second time (mask-lite.ts). A piece the core cut
 * inside a line carries `cut: true`; an absent `cut` reads false.
 */
function workerLog(value: unknown) {
  const body = record(value);
  const size = count(body.size);
  const from = count(body.from);
  const to = count(body.to);
  if (from > to || to > size) fail();
  let last = -1;
  const piece = (item: unknown) => {
    const p = record(item);
    const at = count(p.at);
    if (at < from || at >= to || at <= last) fail();
    last = at;
    return { at, text: maskLite(text(p.text)), cut: p.cut === undefined ? false : bool(p.cut) };
  };
  return {
    v: one(body.v),
    runId: runId(body.runId),
    stream: oneOf(CLOSED_SETS.logStreams)(body.stream),
    phase: oneOf(CLOSED_SETS.phases)(body.phase),
    log: oneOf(CLOSED_SETS.logStates)(body.log),
    ino: orNull(digits)(body.ino),
    size,
    from,
    to,
    pieces: each(piece)(body.pieces),
    eof: bool(body.eof),
    reset: bool(body.reset),
    capped: orNull(bool)(body.capped),
    cursor: orNull(cursor)(body.cursor),
    before: orNull(cursor)(body.before),
  };
}

/** IC-018 d: the open loop run, the lease's run id and time, and the holds. Dropped: pid, host, reason, rows, rowStatus, openIntents. */
function roadmap(value: unknown) {
  const body = record(value);
  one(body.schema);
  if (body.action !== 'status') fail();
  const hold = (item: unknown) => {
    const entry = record(item);
    return { row: id(entry.row), state: oneOf(CLOSED_SETS.roadmapHoldStates)(entry.state), kind: orNull(id)(entry.kind) };
  };
  return {
    run: orNull(id)(body.run),
    lease: orNull((v) => {
      const lease = record(v);
      return { runId: orNull(id)(lease.runId), acquiredAt: orNull(iso)(lease.acquiredAt) };
    })(body.lease),
    holds: each(hold)(body.holds),
  };
}

// ---- IC-019..IC-023: the V8 Fleet reads ----

/** IC-019. `root` (the main checkout path, for the Console server only) is never read: it cannot reach a body. */
function projects(value: unknown) {
  const body = record(value);
  const entry = (item: unknown) => {
    const p = record(item);
    return {
      projectKey: key16(p.projectKey),
      label: label(p.label),
      current: bool(p.current),
      checkouts: count(p.checkouts),
      sources: each(oneOf(CLOSED_SETS.projectSources))(p.sources),
      lastRecordAt: orNull(iso)(p.lastRecordAt),
    };
  };
  const excluded = record(body.excluded);
  return {
    v: one(body.v),
    store: oneOf(CLOSED_SETS.observedStores)(body.store),
    projects: each(entry)(body.projects),
    excluded: { missing: count(excluded.missing), temp: count(excluded.temp), notDoflow: count(excluded.notDoflow), unreadable: count(excluded.unreadable) },
    truncated: bool(body.truncated),
  };
}

/** IC-020. No session id, file, pid or path exists in the input; `harness` outside the registry reads `(other)`. */
function tree(value: unknown) {
  const body = record(value);
  const node = (item: unknown) => {
    const n = record(item);
    return {
      agentKey: key16(n.agentKey),
      kind: oneOf(CLOSED_SETS.agentKinds)(n.kind),
      harness: orNull(harness)(n.harness),
      model: orNull(label)(n.model),
      modelBasis: orNull(oneOf(CLOSED_SETS.modelBases))(n.modelBasis),
      label: orNull(label)(n.label),
      depth: count(n.depth),
      worktreeKey: key16(n.worktreeKey),
      startedAt: orNull(iso)(n.startedAt),
      lastRecordAt: orNull(iso)(n.lastRecordAt),
      liveness: oneOf(CLOSED_SETS.livenessStates)(n.liveness),
      ended: orNull((v) => {
        const end = record(v);
        return { at: iso(end.at), result: orNull(label)(end.result) };
      })(n.ended),
      transcript: ((t) => ({
        reader: orNull(id)(t.reader),
        linked: bool(t.linked),
        reason: orNull(oneOf(CLOSED_SETS.transcriptReasons))(t.reason),
      }))(record(n.transcript)),
    };
  };
  const edge = (item: unknown) => {
    const e = record(item);
    return { from: key16(e.from), to: key16(e.to), basis: oneOf(CLOSED_SETS.edgeBases)(e.basis) };
  };
  const limits = record(body.limits);
  return {
    v: one(body.v),
    projectKey: key16(body.projectKey),
    nodes: each(node)(body.nodes),
    edges: each(edge)(body.edges),
    limits: { nodes: count(limits.nodes), notChecked: count(limits.notChecked) },
    unreadable: count(body.unreadable),
  };
}

/** A token record: a count or null per field (unknown is never zero). */
const tokenCounts = (value: unknown) => {
  const t = record(value);
  return { input: orNull(count)(t.input), output: orNull(count)(t.output), cacheRead: orNull(count)(t.cacheRead), cacheWrite: orNull(count)(t.cacheWrite), reasoning: orNull(count)(t.reasoning) };
};

/**
 * IC-022. Text only on `reply` (4 KiB) and arguments only on `tool-call` (512 B), each masked again;
 * a tool result carries metadata only. Thinking, paths and ids are not fields of the input's copy.
 */
function transcript(value: unknown) {
  const body = record(value);
  const event = (item: unknown) => {
    const e = record(item);
    const kind = oneOf(CLOSED_SETS.eventKinds)(e.kind);
    return {
      seq: count(e.seq),
      at: orNull(iso)(e.at),
      kind,
      agentKey: key16(e.agentKey),
      model: orNull(label)(e.model),
      tool: orNull((v) => {
        const t = record(v);
        return {
          name: orNull(label)(t.name),
          callKey: orNull(key16)(t.callKey),
          status: orNull(oneOf(CLOSED_SETS.toolStatuses))(t.status),
          bytes: orNull(count)(t.bytes),
          durationMs: orNull(count)(t.durationMs),
        };
      })(e.tool),
      text: kind === 'reply' ? orNull(maskedText(TEXT_CAP_BYTES))(e.text) : e.text === null ? null : fail(),
      args: kind === 'tool-call' ? orNull(maskedText(ARGS_CAP_BYTES))(e.args) : e.args === null ? null : fail(),
      cut: bool(e.cut),
      tokens: orNull(tokenCounts)(e.tokens),
      record: orNull((v) => {
        const r = record(v);
        return { type: oneOf(CLOSED_SETS.recordTypes)(r.type), task: orNull(id)(r.task), result: orNull(label)(r.result) };
      })(e.record),
    };
  };
  const reader = record(body.reader);
  const linked = record(body.transcript);
  return {
    v: one(body.v),
    agentKey: key16(body.agentKey),
    harness: orNull(harness)(body.harness),
    reader: { id: orNull(id)(reader.id), status: oneOf(CLOSED_SETS.readerStatuses)(reader.status) },
    transcript: { linked: bool(linked.linked), reason: orNull(oneOf(CLOSED_SETS.transcriptReasons))(linked.reason) },
    events: each(event)(body.events),
    cursor: cursor(body.cursor),
    reset: bool(body.reset),
    eof: bool(body.eof),
    otherRecords: count(body.otherRecords),
    unparsable: count(body.unparsable),
    masked: count(body.masked),
    warnings: each(id)(body.warnings),
  };
}

/** IC-023. A value the harness does not record is null, never 0; a window outside 1..60 is refused. */
function traffic(value: unknown) {
  const body = record(value);
  const windowMin = count(body.windowMin);
  if (windowMin < 1 || windowMin > 60) fail();
  const agent = (item: unknown) => {
    const a = record(item);
    return {
      agentKey: key16(a.agentKey),
      harness: orNull(harness)(a.harness),
      model: orNull(label)(a.model),
      eventsPerMin: orNull(rate)(a.eventsPerMin),
      toolCalls: orNull(count)(a.toolCalls),
      toolErrors: orNull(count)(a.toolErrors),
      toolDurationMs: orNull((v) => {
        const d = record(v);
        return { p50: count(d.p50), max: count(d.max), n: count(d.n) };
      })(a.toolDurationMs),
      tokens: orNull(tokenCounts)(a.tokens),
      lastRecordAt: orNull(iso)(a.lastRecordAt),
    };
  };
  const model = (item: unknown) => {
    const m = record(item);
    return { model: label(m.model), agents: count(m.agents), eventsPerMin: orNull(rate)(m.eventsPerMin), toolCalls: orNull(rate)(m.toolCalls), tokens: orNull(tokenCounts)(m.tokens) };
  };
  const pair = (item: unknown) => {
    const p = record(item);
    return {
      a: key16(p.a),
      b: key16(p.b),
      basis: oneOf(CLOSED_SETS.pairBases)(p.basis),
      task: orNull(id)(p.task),
      tasks: orNull((v) => (Array.isArray(v) && v.length === 2 ? v.map((x) => id(x)) : fail()))(p.tasks),
    };
  };
  return {
    v: one(body.v),
    projectKey: key16(body.projectKey),
    windowMin,
    agents: each(agent)(body.agents),
    models: each(model)(body.models),
    pairs: each(pair)(body.pairs),
    notChecked: count(body.notChecked),
  };
}

// ---- 151 IC-007, IC-008: the Settings and Advice reads ----

type Anchors = { project: string[]; projectLayers: string[]; configHome: string[]; home: string[] };
type Context = { workflow?: unknown; exit?: number | null; anchors?: Anchors };
const ANCHOR_GROUPS = ['project', 'projectLayers', 'configHome', 'home'] as const;

/** The server's anchors (place.ts `anchorsOf`). A projector that places paths or text cannot run without them: a defect in the caller, so it throws. */
function anchorsIn(context: Context | undefined): Anchors {
  const anchors: any = context?.anchors;
  const valid = anchors !== null && typeof anchors === 'object'
    && ANCHOR_GROUPS.every((group) => Array.isArray(anchors[group]) && anchors[group].every((value: unknown) => typeof value === 'string'));
  if (!valid) throw new TypeError('this projector needs context.anchors (place.ts anchorsOf)');
  return anchors;
}

const mergeAnchors = (a: Anchors, b: Anchors): Anchors => ({
  project: [...new Set([...a.project, ...b.project])],
  projectLayers: [...new Set([...a.projectLayers, ...b.projectLayers])],
  configHome: [...new Set([...a.configHome, ...b.configHome])],
  home: [...new Set([...a.home, ...b.home])],
});

/** IC-007: a settings key, at most 96 characters (all 47 registry keys match). A key the mask would change is not one. */
const SETTING_KEY = /^[a-z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+){1,7}$/;
const isSettingKey = (value: unknown): value is string => typeof value === 'string' && value.length <= 96 && SETTING_KEY.test(value) && maskLite(value) === value;
const settingKey: Check<string> = (value) => (isSettingKey(value) ? value : fail());
/** 151 IC-005 `adviceKind` */
const ADVICE_KIND = /^[a-z][a-z0-9-]{0,31}$/;
const adviceKind: Check<string> = (value) => (typeof value === 'string' && ADVICE_KIND.test(value) ? value : fail());
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const dayMs = (value: string): number => Date.parse(`${value}T00:00:00Z`);
/** A calendar date: the pattern, and the same date back from the clock (no 2026-02-30). */
const date: Check<string> = (value) => {
  if (typeof value !== 'string' || !DATE.test(value)) return fail();
  const at = dayMs(value);
  return !Number.isNaN(at) && new Date(at).toISOString().slice(0, 10) === value ? value : fail();
};
const num: Check<number> = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : fail());
const ENV_NAME = /^DOFLOW_[A-Z0-9_]{1,64}$/;
/** IC-007 `env`: the variable name. The core prints `meta.env` as `null` or `{name, parse, direction}` (src/runtime/settings/registry.ts:327); only `name` is read. */
const envName: Check<string> = (value) => {
  const name = record(value).name;
  return typeof name === 'string' && ENV_NAME.test(name) ? name : fail();
};
/** IC-001 `ANSWER`, or the verb's own withheld word. An answer the second mask pass would change is withheld, as `label` is. */
const ANSWER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const answer: Check<string> = (value) => {
  if (typeof value !== 'string' || !(value === WITHHELD || ANSWER.test(value))) return fail();
  return maskLite(value) === value ? value : WITHHELD;
};
/** `PICK_ID`, src/runtime/advice/record.ts:115 */
const PICK_ID = /^adv-[0-9]{13}-[0-9a-f]{6}$/;
const pickId: Check<string> = (value) => (typeof value === 'string' && PICK_ID.test(value) ? value : fail());
const hex12: Check<string> = (value) => (typeof value === 'string' && HEAD12.test(value) ? value : fail());
/** IC-008: a miss reason that is not an id is counted in this one row. */
const OTHER_REASON = '(other)';

/** A path field: a non-empty string, placed (IC-006). */
const whereOf = (anchors: Anchors): Check<unknown> => (value) => (typeof value === 'string' && value !== '' ? placePath(value, anchors) : fail());

/** IC-007 `jsonValue` bounds. */
const JSON_TEXT_BYTES = 2048;
const JSON_ITEMS = 64;
const JSON_DEPTH = 4;
const JSON_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * IC-007 `jsonValue`: null, a boolean, a finite number, a string through `boundedText(2048)`, an array of
 * at most 64 values or an object of at most 64 keys matching `JSON_KEY`, nested at most 4 deep. A value
 * past a bound is `(withheld)` in its place; a missing value (undefined) is a contract mismatch.
 */
function jsonValue(anchors: Anchors): Check<unknown> {
  const text = boundedText(JSON_TEXT_BYTES, anchors);
  const walk = (value: unknown, depth: number): unknown => {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : WITHHELD;
    if (typeof value === 'string') return text(value);
    if (typeof value !== 'object') return fail();
    if (depth > JSON_DEPTH) return WITHHELD;
    if (Array.isArray(value)) return value.length > JSON_ITEMS ? WITHHELD : value.map((item) => walk(item, depth + 1));
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > JSON_ITEMS || !entries.every(([key]) => JSON_KEY.test(key) && maskLite(key) === key)) return WITHHELD;
    return Object.fromEntries(entries.map(([key, item]) => [key, walk(item, depth + 1)]));
  };
  return (value) => walk(value, 1);
}

/**
 * IC-007 `config-list` (input `config list --json`, src/runtime/settings/cli.ts:209 to :250). The body's
 * `configHome.dir`, `project.root` and `project.layersFrom` are read only to add anchors and are never
 * output; `failSafe` is the runner's data exit 1 (IC-005).
 */
function configList(value: unknown, context?: Context) {
  const body = record(value);
  one(body.schema);
  const home = record(body.configHome);
  const where = record(body.project);
  const own = anchorsOf({
    projectRoot: orNull(text)(where.root) ?? '',
    home: '',
    configHome: orNull(text)(home.dir),
    layersFrom: orNull(text)(where.layersFrom),
  });
  const anchors = mergeAnchors(anchorsIn(context), own);
  const place = whereOf(anchors);
  const json = jsonValue(anchors);
  const layer = oneOf(LAYERS);
  const scalar: Check<unknown> = (item) => (item !== null && typeof item === 'object' ? fail() : json(item));

  const file = (item: unknown) => {
    const f = record(item);
    return {
      layer: layer(f.layer),
      kind: oneOf(['settings', 'legacy'])(f.kind),
      legacyKind: orNull(id)(f.legacyKind),
      checkout: orNull(id)(f.checkout),
      status: oneOf(['absent', 'ok', 'invalid'])(f.status),
      code: orNull(oneOf(FILE_CODES))(f.code),
      offset: orNull(count)(f.offset),
      where: place(f.path),
    };
  };
  const candidate = (item: unknown) => {
    const c = record(item);
    return {
      layer: layer(c.layer),
      where: place(c.source),
      legacy: bool(c.legacy),
      checkout: orNull(id)(c.checkout),
      display: orNull(boundedText(256, anchors))(c.display),
      status: oneOf(CANDIDATE_STATUSES)(c.status),
      reason: orNull(boundedText(512, anchors))(c.reason),
      code: orNull(id)(c.code),
    };
  };
  const metaOf = (item: unknown) => {
    const m = record(item);
    return {
      type: id(m.type),
      values: orNull(each(scalar))(m.values),
      default: json(m.default),
      scope: oneOf(SCOPES)(m.scope),
      securityRelevant: bool(m.securityRelevant),
      env: orNull(envName)(m.env),
      description: boundedText(1024, anchors)(m.description),
    };
  };
  /** One resolution of `key`; a dual key's two must be the view they are filed under. */
  const viewOf = (key: string, expected: string | null) => (item: unknown) => {
    const r = record(item);
    if (r.key !== key) fail();
    const view = oneOf(['project', 'global'])(r.view);
    if (expected !== null && view !== expected) fail();
    const origin = record(r.origin);
    return {
      view,
      value: json(r.value),
      state: oneOf(['ok', 'invalid'])(r.state),
      explicit: bool(r.explicit),
      origin: {
        layer: layer(origin.layer),
        where: orNull(place)(origin.source),
        legacy: bool(origin.legacy),
        checkout: orNull(id)(origin.checkout),
        via: orNull(oneOf(VIA))(origin.via),
      },
      candidates: each(candidate)(r.candidates),
    };
  };
  // Registry order is the core's key order. A dual key (`storage.prune` today) is `{project, global}` with no `key`, as safeReport reads it (cli.ts:37).
  const keys = Object.entries(record(body.keys)).map(([key, raw]) => {
    settingKey(key);
    const entry = record(raw);
    const dual = !Object.hasOwn(entry, 'key') && Object.hasOwn(entry, 'project') && Object.hasOwn(entry, 'global');
    const views = dual ? [viewOf(key, 'project')(entry.project), viewOf(key, 'global')(entry.global)] : [viewOf(key, null)(entry)];
    return { key, views, meta: metaOf(record(dual ? entry.project : entry).meta) };
  });
  const error = (item: unknown) => {
    const e = record(item);
    return {
      key: orNull(settingKey)(e.key),
      layer: orNull(layer)(e.layer),
      where: place(e.source),
      code: id(e.code),
      reason: boundedText(512, anchors)(e.reason),
    };
  };
  /** A note's `key` (a legacy note's `field`) names the file's own key, which need not be a setting: it is kept only when it is one. */
  const noteKey = (n: Record<string, unknown>): string | null => {
    const raw = Object.hasOwn(n, 'key') ? n.key : Object.hasOwn(n, 'field') ? n.field : fail();
    if (raw === null) return null;
    return typeof raw === 'string' ? (isSettingKey(raw) ? raw : null) : fail();
  };
  /** A note's `source` may be null (`SettingsNote`, src/runtime/settings/resolve.ts:74); a file's, a candidate's and an error's may not (:62, :69, :73). */
  const note = (item: unknown) => {
    const n = record(item);
    return { code: id(n.code), key: noteKey(n), where: orNull(place)(n.source), text: boundedText(512, anchors)(n.text) };
  };
  return {
    v: 1,
    failSafe: context?.exit === 1,
    scope: oneOf(['project', 'global'])(body.scope),
    checkout: orNull(id)(where.checkout),
    files: each(file)(body.files),
    keys,
    errors: each(error)(body.errors),
    notes: each(note)(body.notes),
  };
}

/** IC-007 `config-schema` (input src/runtime/settings/config-write.ts:198 to :221): ranges and invariants only; presets, writable and locked are never read. */
function configSchema(value: unknown, context?: Context) {
  const anchors = anchorsIn(context);
  const body = record(value);
  one(body.schema);
  const range = (item: unknown) => {
    const k = record(item);
    return {
      key: settingKey(k.key),
      min: orNull(num)(k.min),
      max: orNull(num)(k.max),
      maxItems: orNull(count)(k.maxItems),
      maxLength: orNull(count)(k.maxLength),
      tiers: orNull(each(id))(k.tiers),
    };
  };
  const invariant = (item: unknown) => {
    const i = record(item);
    return { id: id(i.id), statement: boundedText(512, anchors)(i.statement), enforcedBy: boundedText(128, anchors)(i.enforcedBy) };
  };
  return { v: 1, ranges: each(range)(body.keys), invariants: each(invariant)(body.invariants) };
}

const windowOf = (value: unknown) => {
  const w = record(value);
  return { from: date(w.from), to: date(w.to), maxAgeDays: count(w.maxAgeDays) };
};

/** IC-008: each reason that is an id (and that the mask leaves as it is) as its own row, in the core's order; every other one counted in one `(other)` row. */
const missesByReason = (value: unknown) => {
  const rows: Array<{ reason: string; n: number }> = [];
  let other: number | null = null;
  for (const [reason, n] of Object.entries(record(value))) {
    const tally = count(n);
    if (ID.test(reason) && maskLite(reason) === reason) rows.push({ reason, n: tally });
    else other = (other ?? 0) + tally;
  }
  if (other !== null) rows.push({ reason: OTHER_REASON, n: other });
  return rows;
};

const pickCounts = (value: unknown) => {
  const n = record(value);
  return { picks: count(n.picks), misses: count(n.misses) };
};
const agreement = (value: unknown) => {
  const a = record(value);
  return { n: count(a.n), agree: count(a.agree) };
};
const changed = (value: unknown) => {
  const c = record(value);
  return { n: count(c.n), changed: count(c.changed) };
};
const displacement = (value: unknown) => {
  const d = record(value);
  return { n: count(d.n), mean: rate(d.mean) };
};
/** `{n, p50, p90, p95}`; the rerank and claim-support blocks print no `p90`, so there it is kept only when present. */
const percentiles = (p90Optional: boolean) => (value: unknown) => {
  const p = record(value);
  const n = count(p.n);
  const p50 = orNull(rate)(p.p50);
  const p95 = orNull(rate)(p.p95);
  return p90Optional && !Object.hasOwn(p, 'p90') ? { n, p50, p95 } : { n, p50, p90: orNull(rate)(p.p90), p95 };
};

/** IC-008 `advise-report` (input `buildReport`, src/runtime/advice/report.ts:210 to :259). `scope`, `illustrative` and `recorded.digests` are never read. */
function adviseReport(value: unknown, context?: Context) {
  const anchors = anchorsIn(context);
  const body = record(value);
  const kindRow = ([kind, item]: [string, unknown]) => {
    const k = record(item);
    return {
      kind: adviceKind(kind),
      n: pickCounts(k.n),
      missesByReason: missesByReason(k.missesByReason),
      agreeStatic: orNull(agreement)(k.agreeStatic),
      agreeOutcome: orNull(agreement)(k.agreeOutcome),
      elevated: orNull(count)(k.elevated),
      modes: orNull((v) => {
        const m = record(v);
        return { shadow: count(m.shadow), act: count(m.act), unrecorded: count(m.unrecorded) };
      })(k.modes),
      durationMs: orNull(percentiles(false))(k.durationMs),
      missDurationMs: orNull(percentiles(false))(k.missDurationMs),
    };
  };
  const arm = (item: unknown) => {
    const a = record(item);
    return { picks: count(a.picks), top1Changed: changed(a.top1Changed), meanRankDisplacement: orNull(displacement)(a.meanRankDisplacement) };
  };
  const threshold = (item: unknown) => {
    const t = record(item);
    return {
      field: oneOf(['confidenceBelow', 'expectedBelow'])(t.field),
      value: rate(t.value),
      wouldDrop: count(t.wouldDrop),
      ofCandidates: count(t.ofCandidates),
      top1WouldDrop: count(t.top1WouldDrop),
      ofPicks: count(t.ofPicks),
    };
  };
  const rerank = (item: unknown) => {
    const r = record(item);
    const arms = record(r.arms);
    const criteria = record(r.criteria);
    const recorded = record(criteria.recorded);
    const bySource = record(recorded.bySource);
    const wouldDrop = record(r.wouldDrop);
    return {
      n: pickCounts(r.n),
      withoutPayload: count(r.withoutPayload),
      missesByReason: missesByReason(r.missesByReason),
      top1Changed: changed(r.top1Changed),
      meanRankDisplacement: orNull(displacement)(r.meanRankDisplacement),
      firstStageMs: percentiles(true)(r.firstStageMs),
      arms: { choice: arm(arms.choice), ladder: arm(arms.ladder) },
      criteria: {
        source: orNull(oneOf(['registry', 'settings']))(criteria.source),
        digest: orNull(hex12)(criteria.digest),
        warning: orNull(boundedText(512, anchors))(criteria.warning),
        recorded: { n: count(recorded.n), bySource: { registry: count(bySource.registry), settings: count(bySource.settings), unrecorded: count(bySource.unrecorded) } },
      },
      wouldDrop: { picks: count(wouldDrop.picks), candidates: count(wouldDrop.candidates), thresholds: each(threshold)(wouldDrop.thresholds) },
    };
  };
  const relation = (item: unknown) => {
    const r = record(item);
    return { n: count(r.n), modelYes: count(r.modelYes), agree: count(r.agree) };
  };
  const claimSupport = (item: unknown) => {
    const c = record(item);
    const byRelation = record(c.byRelation);
    return {
      n: pickCounts(c.n),
      withoutPayload: count(c.withoutPayload),
      missesByReason: missesByReason(c.missesByReason),
      byRelation: { supports: relation(byRelation.supports), contradicts: relation(byRelation.contradicts) },
      durationMs: percentiles(true)(c.durationMs),
    };
  };
  const verdict = (item: unknown) => {
    const v = record(item);
    return {
      kind: adviceKind(v.kind),
      model: label(v.model),
      arm: orNull(id)(v.arm),
      result: orNull(id)(v.result),
      stale: bool(v.stale),
      reason: orNull(boundedText(256, anchors))(v.reason),
    };
  };
  return {
    v: 1,
    schema: one(body.schema),
    window: windowOf(body.window),
    unreadable: count(body.unreadable),
    kinds: Object.entries(record(body.kinds)).map(kindRow),
    // The core prints these two blocks only when their kind is shown (report.ts:254, :255).
    rerank: optional(rerank)(body.rerank),
    claimSupport: optional(claimSupport)(body.claimSupport),
    verdicts: each(verdict)(body.verdicts),
  };
}

/** IC-008 `advice-picks` (input IC-001): every field checked; `days` exactly the dates from `window.from` to `window.to`; `limits.shown` the picks listed. */
function advicePicks(value: unknown) {
  const body = record(value);
  const span = windowOf(body.window);
  const day = (item: unknown) => {
    const d = record(item);
    return {
      day: date(d.day),
      coverage: oneOf(['read', 'unknown'])(d.coverage),
      unreadableLines: count(d.unreadableLines),
      picks: Object.fromEntries(Object.entries(record(d.picks)).map(([kind, n]) => [adviceKind(kind), count(n)])),
    };
  };
  const days = each(day)(body.days);
  const start = dayMs(span.from);
  days.forEach((d, index) => {
    if (d.day !== new Date(start + index * DAY_MS).toISOString().slice(0, 10)) fail();
  });
  if (days.length === 0 || days[days.length - 1].day !== span.to) fail();
  const outcome = (item: unknown) => {
    const o = record(item);
    return { actual: answer(o.actual), at: iso(o.at), agree: orNull(bool)(o.agree) };
  };
  const pick = (item: unknown) => {
    const p = record(item);
    return {
      pickId: orNull(pickId)(p.pickId),
      kind: adviceKind(p.kind),
      at: iso(p.at),
      mode: oneOf(ADVICE_MODES)(p.mode),
      pick: answer(p.pick),
      static: orNull(answer)(p.static),
      agree: orNull(bool)(p.agree),
      outcome: orNull(outcome)(p.outcome),
    };
  };
  const picks = each(pick)(body.picks);
  const limits = record(body.limits);
  const shown = count(limits.shown);
  if (shown !== picks.length) fail();
  const stores = Object.fromEntries(Object.entries(record(body.stores)).map(([store, state]) => [id(store), oneOf(['read', 'absent', 'unreadable'])(state)]));
  return {
    v: one(body.v),
    window: span,
    kind: orNull(adviceKind)(body.kind),
    kinds: each(adviceKind)(body.kinds),
    stores,
    days,
    picks,
    limits: { shown, notShown: count(limits.notShown), skipped: count(limits.skipped) },
  };
}

/** `version` is the trimmed `--version` line, not JSON. */
const version = (value: unknown) => (isSemVer(value) ? value : fail());

// ---- 151 IC-009 to IC-011: the Follow-ups, Health and Workers reads ----

/** 151 IC-005 `fuId` (FU_ID, src/runtime/lifecycle/followup.ts:36) and `fuCursor` (CURSOR, src/runtime/verb-view.ts:114). */
const FU_ID = /^FU-[0-9a-hjkmnp-tv-z]{6}$/;
const FU_CURSOR = /^[0-9]{1,15}:[0-9]{8}T[0-9]{9}Z-[0-9a-hjkmnp-tv-z]{6}$/;
const fuId: Check<string> = (value) => (typeof value === 'string' && FU_ID.test(value) ? value : fail());
const fuCursor: Check<string> = (value) => (typeof value === 'string' && FU_CURSOR.test(value) ? value : fail());
/** IC-009 bounds: rows per follow-up list, history entries per record, intents and goals, nudges per goal, slugs per unbounded bucket. */
const FOLLOWUP_ROWS = 50;
const HISTORY_SHOWN = 50;
const OVERVIEW_SHOWN = 20;
const NUDGES_SHOWN = 10;
const BUCKET_SHOWN = 50;
/** IC-010 bounds: findings and warnings each, stores. */
const DOCTOR_ROWS = 100;
const STORES_SHOWN = 64;
/** IC-010 (DEC-036): a doctor status word; any other value reads as one fixed text. */
const DOCTOR_WORD = /^[A-Z][A-Z_]{1,23}$/;
const OTHER_WORD = '(other)';
const word: Check<string> = (value) => (typeof value !== 'string' ? fail() : DOCTOR_WORD.test(value) ? value : OTHER_WORD);
/** IC-011 `cellName` */
const CELL_NAME = /^[a-z][A-Za-z0-9]{0,31}$/;
const cellName: Check<string> = (value) => (typeof value === 'string' && CELL_NAME.test(value) ? value : fail());

/** The first `limit` entries of a list, each checked, and how many the list holds past them (never read). */
const firstOf = <T>(limit: number, check: Check<T>) => (value: unknown): { rows: T[]; notShown: number } => {
  if (!Array.isArray(value)) return fail();
  return { rows: value.slice(0, limit).map((item) => check(item)), notShown: Math.max(0, value.length - limit) };
};
/** The length of a list whose entries are not read. */
const lengthOf: Check<number> = (value) => (Array.isArray(value) ? value.length : fail());

/**
 * IC-009 `followups` (input `followup --action list --state <s> [--cursor <c>] --limit 25 --json`, the brief view,
 * src/runtime/lifecycle/cli.ts:189 to :200). A page past 50 items cannot be cut without the next cursor skipping the
 * cut items, so it is refused; conflicts and unreadable files keep their full count beside at most 50 rows (DEC-006).
 * `next` and `view` are never read.
 */
function followups(value: unknown, context?: Context) {
  const anchors = anchorsIn(context);
  const body = record(value);
  if (!Array.isArray(body.items) || body.items.length > FOLLOWUP_ROWS) fail();
  const item = (entry: unknown) => {
    const i = record(entry);
    return { id: fuId(i.id), statement: boundedText(1024, anchors)(i.statement), state: oneOf(FOLLOWUP_STATES)(i.state) };
  };
  const items = each(item)(body.items);
  const shown = count(body.shown);
  if (shown !== items.length) fail();
  const conflict = (entry: unknown) => {
    const c = record(entry);
    return { event: id(c.event), type: id(c.type), code: id(c.code), reason: boundedText(256, anchors)(c.reason) };
  };
  const reasons = record(body.unreadableReasons);
  const unreadableRow = (entry: unknown) => {
    const file = id(entry);
    return { file, reason: Object.hasOwn(reasons, file) ? orNull(boundedText(256, anchors))(reasons[file]) : null };
  };
  const conflicts = firstOf(FOLLOWUP_ROWS, conflict)(body.conflicts);
  const unreadable = firstOf(FOLLOWUP_ROWS, unreadableRow)(body.unreadable);
  return {
    v: 1,
    state: oneOf([...FOLLOWUP_STATES, 'all'])(body.state),
    count: count(body.count),
    shown,
    nextCursor: orNull(fuCursor)(body.nextCursor),
    items,
    conflicts: { n: conflicts.rows.length + conflicts.notShown, rows: conflicts.rows },
    unreadable: { n: unreadable.rows.length + unreadable.notShown, rows: unreadable.rows },
  };
}

/**
 * IC-009 `followup-record` (input the full view with `--ids <one id>`, the fold's record, src/runtime/lifecycle/fold.ts:66
 * to :80). `history` is the newest 50 in the core's order (oldest first) with no event id; `intent` is placed. No item is
 * `followup: null` (the route's 404). `bodyRef`, `bodyBytes`, `derived`, `promoted`, a source's other fields and `next`
 * are never read.
 */
function followupRecord(value: unknown, context?: Context) {
  const anchors = anchorsIn(context);
  const body = record(value);
  const items = Array.isArray(body.items) ? body.items : fail();
  if (items.length > 1) fail();
  if (items.length === 0) return { v: 1, followup: null };
  const f = record(items[0]);
  const source = record(f.source);
  const history = Array.isArray(f.history) ? f.history : fail();
  const kept = history.slice(-HISTORY_SHOWN);
  const entry = (item: unknown) => {
    const h = record(item);
    return { type: id(h.type), at: iso(h.at), by: label(h.by) };
  };
  return {
    v: 1,
    followup: {
      id: fuId(f.id),
      statement: boundedText(1024, anchors)(f.statement),
      // A `manual` source has neither field and a `run` source no feature (src/runtime/lifecycle/followup.ts:122 to :143).
      source: { kind: oneOf(SOURCE_KINDS)(source.kind), feature: optional(id)(source.feature), stage: optional(id)(source.stage) },
      state: oneOf(FOLLOWUP_STATES)(f.state),
      takenBy: orNull(id)(f.takenBy),
      intent: orNull(whereOf(anchors))(f.intent),
      fix: orNull(boundedText(1024, anchors))(f.fix),
      added: orNull(date)(f.added),
      excerpt: orNull(boundedText(2048, anchors))(f.excerpt),
      body: orNull(oneOf(['on-this-machine', 'not-on-this-machine']))(f.body),
      history: kept.map(entry),
      historyNotShown: history.length - kept.length,
    },
  };
}

/**
 * IC-009 `lifecycle-overview` (input `buildOverview`, src/runtime/lifecycle/overview.ts:200 to :254, the full view).
 * `next`, `failures`, `pending`, `reason`, `followups.items`, `unreadableReasons` and every conflict's text are never
 * read. A bucket is `{count, shown}`: the core's `featuresShown` for `finished` and `awaitingRelease`, else the first 50.
 */
function lifecycleOverview(value: unknown, context?: Context) {
  const anchors = anchorsIn(context);
  const body = record(value);
  const bucketOf = (list: unknown) => (Array.isArray(list) ? { count: list.length, shown: list.slice(0, BUCKET_SHOWN).map((slug) => id(slug)) } : fail());
  const buckets = (item: unknown) => {
    const b = record(item);
    return Object.fromEntries(FEATURE_BUCKETS.map((name) => [name, bucketOf(b[name])]));
  };
  const shownBucket = (item: unknown) => {
    const s = record(item);
    return { count: count(s.count), shown: each(id)(s.shown) };
  };
  const intent = (item: unknown) => {
    const i = record(item);
    return { where: whereOf(anchors)(i.path), items: each(fuId)(i.items) };
  };
  const goal = (item: unknown) => {
    const g = record(item);
    const items = record(g.items);
    const nudges = Array.isArray(g.nudges) ? g.nudges.slice(0, NUDGES_SHOWN).map((n) => boundedText(256, anchors)(n)) : fail();
    return {
      goal: id(g.goal),
      outcome: boundedText(512, anchors)(g.outcome),
      items: { met: count(items.met), total: count(items.total) },
      proposeDone: bool(g.proposeDone),
      features: buckets(g.features),
      nudges,
      // The core adds `conflicts` to a goal only when it has some (overview.ts:133).
      conflicts: g.conflicts === undefined ? 0 : lengthOf(g.conflicts),
    };
  };
  const features = record(body.features);
  const featuresShown = record(body.featuresShown);
  const intents = firstOf(OVERVIEW_SHOWN, intent)(body.intents);
  const goals = firstOf(OVERVIEW_SHOWN, goal)(body.goals);
  return {
    v: 1,
    mode: oneOf(['discovery', 'maintain'])(body.mode),
    releaseMode: oneOf(RELEASE_MODES)(body.releaseMode),
    integrationRef: orNull(label)(body.integrationRef),
    gitError: orNull(boundedText(256, anchors))(body.gitError),
    followupsOpen: count(record(body.followups).open),
    intents: intents.rows,
    intentsNotShown: intents.notShown,
    goals: goals.rows,
    goalsNotShown: goals.notShown,
    features: {
      finished: shownBucket(featuresShown.finished),
      awaitingRelease: shownBucket(featuresShown.awaitingRelease),
      inProgress: bucketOf(features.inProgress),
      unknown: bucketOf(features.unknown),
    },
    conflicts: lengthOf(body.conflicts),
    unreadable: lengthOf(body.unreadable),
    // The core prints both only when the integration branch is behind (overview.ts:247).
    integrationBehind: optional(count)(body.integrationBehind),
    note: optional(boundedText(256, anchors))(body.note),
  };
}

/**
 * IC-010 `doctor` (input `doctor --json`, exit 0 or 1, src/runtime/health.ts:965 to :993 and the async provider pass).
 * Built from the listed sections only: `identity`, `project`, `mcp`, `packages`, `transcripts`, `upkeepSwitch`,
 * `decisionModel`, `advice`, `settings`, `rolloutProfile`, `guidance`, `team`, `agentToolScope` and `primary` are never
 * read, nor `reach`, `probeCommand`, `binary`, a provider's `freshness`, or a capability's providers and description.
 */
function doctor(value: unknown, context?: Context) {
  const anchors = anchorsIn(context);
  const body = record(value);
  const summary = record(body.summary);
  const entry = (item: unknown) => {
    const e = record(item);
    return { kind: id(e.kind), subject: boundedText(256, anchors)(e.subject), detail: boundedText(1024, anchors)(e.detail) };
  };
  const harnessRow = (item: unknown) => {
    const h = record(item);
    return { id: harness(h.id), displayName: label(h.displayName), status: word(h.status) };
  };
  const tool = (item: unknown) => {
    const t = record(item);
    return { id: id(t.id), displayName: label(t.displayName), status: word(t.status), detail: boundedText(256, anchors)(t.detail) };
  };
  const capability = (item: unknown) => {
    const c = record(item);
    return { capability: id(c.capability), status: word(c.status), activeProvider: orNull(id)(c.activeProvider) };
  };
  // A provider with no binary has `present: null` (health.ts:364); one the async pass added has neither `present` nor `version` (:322 to :332, :1179).
  const provider = (item: unknown) => {
    const p = record(item);
    return {
      id: id(p.id),
      status: word(p.status),
      present: optional(bool)(p.present),
      answered: bool(p.answered),
      durationMs: orNull(count)(p.durationMs),
      version: optional(boundedText(128, anchors))(p.version),
    };
  };
  // `probeFreshness` (health.ts:194) prints the dates and `behindMs` only in the states that have them.
  const freshness = (item: unknown) => {
    const f = record(item);
    return {
      providerId: id(f.providerId),
      label: boundedText(64, anchors)(f.label),
      state: word(f.state),
      indexedAt: optional(iso)(f.indexedAt),
      newestSourceAt: optional(iso)(f.newestSourceAt),
      behindMs: optional(count)(f.behindMs),
      reason: optional(boundedText(512, anchors))(f.reason),
    };
  };
  const workerRow = (item: unknown) => {
    const r = record(item);
    const enabled = record(r.enabled);
    return {
      harness: harness(r.harness),
      enabled: { state: id(enabled.state), position: orNull(count)(enabled.position), layer: orNull(oneOf(LAYERS))(record(enabled.origin).layer) },
      eligible: bool(r.eligible),
      firstGap: orNull((v) => {
        const g = record(v);
        return { requirement: id(g.requirement), result: id(g.result), reason: optional(id)(g.reason) };
      })(r.firstGap),
    };
  };
  const poolRow = (item: unknown) => {
    const h = record(item);
    const billing = record(h.effectiveBilling);
    return {
      harness: harness(h.harness),
      installed: bool(h.installed),
      loginState: id(h.loginState),
      detectedMode: id(h.detectedMode),
      effectiveBilling: { value: id(billing.value), source: id(billing.source), asserted: optional(date)(billing.asserted) },
    };
  };
  const findings = firstOf(DOCTOR_ROWS, entry)(body.findings);
  const warnings = firstOf(DOCTOR_ROWS, entry)(body.warnings);
  const workers = record(body.workers);
  const pool = record(body.workerPool);
  return {
    v: 1,
    exit: context?.exit === 1 ? 1 : 0,
    summary: {
      probed: count(summary.probed),
      healthy: count(summary.healthy),
      unhealthy: count(summary.unhealthy),
      absent: count(summary.absent),
      unverified: count(summary.unverified),
    },
    findings: findings.rows,
    findingsNotShown: findings.notShown,
    warnings: warnings.rows,
    warningsNotShown: warnings.notShown,
    harnesses: each(harnessRow)(body.harnesses),
    externalTools: each(tool)(body.externalTools),
    capabilities: each(capability)(body.capabilities),
    providers: each(provider)(body.providers),
    freshness: each(freshness)(body.freshness),
    workers: { state: id(workers.state), rows: each(workerRow)(workers.rows) },
    workerPool: { state: id(pool.state), syncedAt: orNull(iso)(pool.syncedAt), harnesses: each(poolRow)(pool.harnesses) },
  };
}

/** A list's length, or null when the core did not print it. */
const tallyOf = (value: unknown): number | null => (value === undefined ? null : lengthOf(value));

/**
 * IC-010 `storage-report` (input `storage --action report --json`, src/runtime/storage/cli.ts:54 to :59 and
 * engine.ts:151). The core starts every row at 0 (engine.ts:151), so a printed 0 is a count only when the store was
 * read: a skipped store, a store whose own read failed (`failed` names the store) and every store of a stopped
 * (`partial`) pass read null for `entries`, `bytes`, `wouldPrune` and `protected`, as does a figure the core does not
 * print (FR-022). `root`, `location`, the `selected` and `failed` entries, `removed`, `mode` and `decidedBy` are never output.
 */
function storageReport(value: unknown, context?: Context) {
  const anchors = anchorsIn(context);
  const body = record(value);
  const partial = bool(body.partial);
  const setting = record(body.setting);
  const store = (item: unknown) => {
    const s = record(item);
    const storeId = id(s.id);
    if (typeof s.location !== 'string') fail();
    const skipped = optional(id)(s.skipped);
    const failed = tallyOf(s.failed);
    const ownFailure = Array.isArray(s.failed) && s.failed.some((f) => record(f).name === storeId);
    const figures = {
      entries: optional(count)(s.entries),
      bytes: optional(count)(s.bytes),
      wouldPrune: tallyOf(s.selected),
      protected: optional(count)(s.protected),
    };
    const counted = skipped === null && !ownFailure && !partial;
    return {
      id: storeId,
      where: placePath(s.location, anchors),
      bound: boundedText(256, anchors)(s.bound),
      setting: id(s.setting),
      ...(counted ? figures : { entries: null, bytes: null, wouldPrune: null, protected: null }),
      failed,
      skipped,
    };
  };
  const stores = firstOf(STORES_SHOWN, store)(body.stores);
  return {
    v: 1,
    partial,
    durationMs: rate(body.durationMs),
    setting: { project: id(setting.project), user: id(setting.user) },
    stores: stores.rows,
    storesNotShown: stores.notShown,
  };
}

/**
 * IC-011 `worker-matrix` (input IC-003). Every cell each group lists must be present for each harness, else the whole
 * body is refused. A harness id outside `CLOSED_SETS.harnessIds` is kept as its id, so a harness the registry gains
 * appears with no Console change (FR-018). Evidence stays text: no URL in it is parsed or checked (DEC-014).
 * `registryVersion`, a harness's other fields and a cell's other fields are never read.
 */
function workerMatrix(value: unknown, context?: Context) {
  const anchors = anchorsIn(context);
  const body = record(value);
  one(body.v);
  const listed = record(body.groups);
  const groups: Record<string, string[]> = Object.fromEntries(MATRIX_GROUPS.map((group) => [group, each(cellName)(listed[group])]));
  const cell = (item: unknown) => {
    const c = record(item);
    return {
      status: oneOf(MATRIX_STATUSES)(c.status),
      declared: bool(c.declared),
      evidence: each(boundedText(1024, anchors))(c.evidence),
      verification: orNull(boundedText(4096, anchors))(c.verification),
      verifiedOn: orNull(date)(c.verifiedOn),
      reason: orNull(boundedText(1024, anchors))(c.reason),
      fallback: orNull(id)(c.fallback),
      cut: bool(c.cut),
    };
  };
  const harnessEntry = (item: unknown) => {
    const h = record(item);
    const cells = record(h.cells);
    return {
      id: id(h.id),
      billing: orNull(id)(h.billing),
      profile: orNull(id)(h.profile),
      cells: Object.fromEntries(MATRIX_GROUPS.map((group) => {
        const given = record(cells[group]);
        return [group, Object.fromEntries(groups[group].map((name) => [name, Object.hasOwn(given, name) ? cell(given[name]) : fail()]))];
      })),
    };
  };
  const harnesses = each(harnessEntry)(body.harnesses);
  const counts = record(body.counts);
  const limits = record(body.limits);
  const shown = count(limits.shown);
  if (shown !== harnesses.length) fail();
  return {
    v: 1,
    groups,
    harnesses,
    counts: Object.fromEntries(MATRIX_GROUPS.map((group) => {
      const tally = record(counts[group]);
      return [group, Object.fromEntries(MATRIX_STATUSES.map((status) => [status, count(tally[status])]))];
    })),
    limits: { shown, notShown: count(limits.notShown), cellsNotShown: count(limits.cellsNotShown), cut: count(limits.cut) },
  };
}

// 152 IC-005: projectSessionsHistory
function projectSessionsHistory(value: unknown, context?: Context) {
  const anchors = anchorsIn(context);
  const body = record(value);
  if (body.v !== 1) fail();

  const win = record(body.window);
  const windowOut = {
    from: iso(win.from),
    to: iso(win.to),
    maxAgeDays: count(win.maxAgeDays),
  };

  const stageEntry = (s: unknown) => {
    const st = record(s);
    return {
      id: id(st.id),
      name: boundedText(128, anchors)(st.name),
      skill: orNull(id)(st.skill),
      status: id(st.status),
      outcome: id(st.outcome),
      durationMs: orNull(count)(st.durationMs),
    };
  };

  const sessionEntry = (s: unknown) => {
    const rec = record(s);
    const workers = record(rec.workers);
    const cost = record(rec.cost);
    const tokens = record(cost.tokens);
    const proj = rec.project;

    let placedProj: { anchor: string; rel: string };
    if (proj && typeof proj === 'object' && typeof (proj as any).anchor === 'string' && typeof (proj as any).rel === 'string') {
      placedProj = {
        anchor: boundedText(64, anchors)((proj as any).anchor),
        rel: boundedText(512, anchors)((proj as any).rel),
      };
    } else if (typeof proj === 'string' && proj !== '') {
      placedProj = placePath(proj, anchors);
    } else {
      placedProj = { anchor: '<project>', rel: '' };
    }

    return {
      slug: id(rec.slug),
      taskId: id(rec.taskId),
      taskClass: id(rec.taskClass),
      workflowName: boundedText(128, anchors)(rec.workflowName),
      harness: orNull(harness)(rec.harness),
      state: id(rec.state),
      startedAt: orNull(iso)(rec.startedAt),
      endedAt: orNull(iso)(rec.endedAt),
      durationMs: orNull(count)(rec.durationMs),
      stages: each(stageEntry)(rec.stages),
      workers: {
        count: count(workers.count),
        attempts: count(workers.attempts),
        retries: count(workers.retries),
        quotaStops: count(workers.quotaStops),
      },
      cost: {
        tokens: {
          input: orNull(count)(tokens.input),
          output: orNull(count)(tokens.output),
          total: orNull(count)(tokens.total),
        },
        models: each(label)(cost.models),
        telemetry: id(cost.telemetry),
      },
      expired: bool(rec.expired),
      project: placedProj,
    };
  };

  const sessions = each(sessionEntry)(body.sessions);
  const limits = record(body.limits);
  return {
    v: 1,
    window: windowOut,
    sessions,
    limits: {
      shown: count(limits.shown),
      notShown: count(limits.notShown),
      pruned: count(limits.pruned),
    },
  };
}

const PROJECTORS: Readonly<Record<string, (value: unknown, context?: any) => unknown>> = Object.freeze({
  list, status, timeline, attempts, workflow, capabilities, version,
  observed, slots, 'worker-status': workerStatus, roadmap,
  projects, tree, transcript, traffic,
  'worker-runs': workerRuns, 'worker-result': workerResult, 'worker-run-status': workerStatus, 'worker-log': workerLog,
  'config-list': configList, 'config-schema': configSchema, 'advise-report': adviseReport, 'advice-picks': advicePicks,
  followups, 'followup-record': followupRecord, 'lifecycle-overview': lifecycleOverview, doctor, 'storage-report': storageReport, 'worker-matrix': workerMatrix,
  'sessions-history': projectSessionsHistory,
});
const PROJECTOR_IDS: readonly string[] = Object.freeze(Object.keys(PROJECTORS));

/**
 * The projected body of a core output, or `core-contract-mismatch`. `status` takes
 * `{ workflow }`, the projected `workflow` body of the run's class. The 151 projectors take
 * `anchors` (place.ts `anchorsOf`) and `config-list` takes the runner's `exit` (IC-005). An unknown
 * shape id, or a placing projector called without anchors, is a defect in the caller and throws.
 */
function project(shapeId: string, value: unknown, context?: Context): Projected {
  if (!Object.hasOwn(PROJECTORS, shapeId)) throw new TypeError(`no projector for shape '${shapeId}'`);
  try {
    return { ok: true, body: PROJECTORS[shapeId](value, context) };
  } catch (error) {
    if (error instanceof Mismatch) return { ok: false, code: 'core-contract-mismatch' };
    throw error;
  }
}

module.exports = { ADVICE_MODES, CANDIDATE_STATUSES, CLOSED_SETS, FEATURE_BUCKETS, FILE_CODES, FOLLOWUP_STATES, LAYERS, MATRIX_GROUPS, MATRIX_STATUSES, OTHER_HARNESS,
  PROJECTOR_IDS, RELEASE_MODES, SCOPES, SOURCE_KINDS, VIA, WITHHELD, project, projectSessionsHistory };
