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
});

/** IC-022: the byte caps of the two text fields, re-checked here after the second masking pass (IC-024). */
const TEXT_CAP_BYTES = 4096;
const ARGS_CAP_BYTES = 512;
/** IC-022: a transcript cursor, `<inode>:<byteOffset>:<recordSeq>:<recordAtMs>`. */
const CURSOR = /^[0-9]+:[0-9]+:[0-9]+:[0-9]+$/;

type Check<T> = (value: unknown) => T;
type Projected = { ok: true; body: any } | { ok: false; code: 'core-contract-mismatch' };

class Mismatch extends Error {}
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
const label: Check<string> = (value) => (typeof value !== 'string' ? fail() : LABEL.test(value) ? value : WITHHELD);
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

/**
 * IC-018 d: one worker run's state and the process check. Dropped: identity, process, report, output,
 * edit, isolation, cleanup, cancel, verified, withheld and the rest. The core's answer for an attempt
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

/** `version` is the trimmed `--version` line, not JSON. */
const version = (value: unknown) => (isSemVer(value) ? value : fail());

const PROJECTORS: Readonly<Record<string, (value: unknown, context?: any) => unknown>> = Object.freeze({
  list, status, timeline, attempts, workflow, capabilities, version,
  observed, slots, 'worker-status': workerStatus, roadmap,
  projects, tree, transcript, traffic,
});
const PROJECTOR_IDS: readonly string[] = Object.freeze(Object.keys(PROJECTORS));

/**
 * The projected body of a core output, or `core-contract-mismatch`. `status` takes
 * `{ workflow }`, the projected `workflow` body of the run's class. An unknown shape id is a defect
 * in the caller and throws.
 */
function project(shapeId: string, value: unknown, context?: { workflow?: unknown }): Projected {
  if (!Object.hasOwn(PROJECTORS, shapeId)) throw new TypeError(`no projector for shape '${shapeId}'`);
  try {
    return { ok: true, body: PROJECTORS[shapeId](value, context) };
  } catch (error) {
    if (error instanceof Mismatch) return { ok: false, code: 'core-contract-mismatch' };
    throw error;
  }
}

module.exports = { CLOSED_SETS, OTHER_HARNESS, PROJECTOR_IDS, WITHHELD, project };
