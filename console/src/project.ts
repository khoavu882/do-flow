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

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LABEL = /^[A-Za-z0-9 ._:/@-]{1,64}$/;
const WITHHELD = '(withheld)';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

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
});

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

/** IC-013: no reason text, evidence id, worktree, usage or trace. */
const attempt = (value: unknown) => {
  const entry = record(value);
  return {
    token: Number.isInteger(entry.token) && (entry.token as number) >= 1 ? (entry.token as number) : fail(),
    owner: label(entry.owner),
    mode: oneOf(CLOSED_SETS.attemptModes)(entry.mode),
    state: oneOf(CLOSED_SETS.attemptStates)(entry.state),
    startedAt: orNull(iso)(entry.startedAt),
    endedAt: orNull(iso)(entry.endedAt),
    result: orNull(oneOf(CLOSED_SETS.attemptResults))(entry.result),
  };
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

/** Dropped: files, acceptance, warnings, overlaps, run, advisory (and slug, defaults, readiness). */
function attempts(value: unknown) {
  const body = record(value);
  const graph = record(body.graph);
  return {
    revision: count(body.revision),
    graph: {
      digest: typeof graph.digest === 'string' && DIGEST.test(graph.digest) ? graph.digest : fail(),
      graphPlan: bool(graph.graphPlan),
      tasks: each(graphTask)(graph.tasks),
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

/** `version` is the trimmed `--version` line, not JSON. */
const version = (value: unknown) => (isSemVer(value) ? value : fail());

const PROJECTORS: Readonly<Record<string, (value: unknown, context?: any) => unknown>> = Object.freeze({
  list, status, timeline, attempts, workflow, capabilities, version,
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

module.exports = { CLOSED_SETS, PROJECTOR_IDS, WITHHELD, project };
