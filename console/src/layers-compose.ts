'use strict';

// Layers composition (feature 161, IC-002, IC-003, IC-007): the members of the browser channels
// `machine` and `layers:<pk>`, built from the sections of the core channel of the same name. Each section
// is projected by a closed-field projector: only the fields IC-002 and IC-003 name leave, every string
// leaf passes `maskLite`, a free text is kept only within its cap, and a name that could be a place or a
// secret is withheld as project.ts's `label` does. The sections IC-003 shares with the core's `fleet` and `transcript --action stats` reads
// (`tree`, `traffic`, the `projects` body and the `orchestrate --action list` rows) go through the
// projectors of project.ts. `runs` rows gain `runKey` (key-shaped or null, plan DEC-010) and `skill`: the
// row's current stage joined to its skill through the runner's cached `workflow` shape (null when the
// run is at no stage, the class has no workflow read, or the stage is not in it).
//
// A member is `{status: 200, body: {v: 1, [projectKey,] sections}}`; each section is `{ok: true, data}`
// or `{ok: false, code}`: `core-error` (the section's producer exited non-zero), `core-contract-mismatch`
// (the projector refused it) or `section-missing` (the snapshot did not carry it). One failed section
// never fails the others.

const { project } = require('./project.ts');
const { maskLite } = require('./mask-lite.ts');

type SectionResult = { exit: number; json: unknown };
type Section = { ok: true; data: unknown } | { ok: false; code: string };
type Member = { status: number; body: unknown };
type WorkflowOf = (taskClass: string) => Promise<{ ok: boolean; json?: unknown }>;

/** IC-002: the sections of `machine`. */
const MACHINE_SECTIONS: readonly string[] = Object.freeze(['projects', 'activity']);
/** IC-003: the sections of `layers:<pk>`, in the order the member lists them. */
const LAYERS_SECTIONS: readonly string[] = Object.freeze(['checkouts', 'tree', 'runs', 'gates', 'artifacts', 'reviews', 'sessions', 'traffic', 'coverage']);
/** IC-003 artifact kinds (do-exec-paths.sh, dispatch/envelope.ts). */
const ARTIFACT_KINDS: readonly string[] = Object.freeze(['task-brief', 'task-brief-record', 'group-brief', 'group-brief-record', 'task-report', 'handoff', 'result',
  'spawn-prompt', 'worker-out', 'worker-err']);
const REVIEW_STATES: readonly string[] = Object.freeze(['absent', 'unreadable', 'invalid', 'ok']);
/** src/runtime/review/findings.ts `countFindings`, its number fields (`task` is the feature, already a field of the row). */
const REVIEW_COUNTS: readonly string[] = Object.freeze(['seats', 'seat_findings', 'converged', 'blocker', 'should_fix', 'note', 'open', 'fixed', 'refuted',
  'user_accepted', 'pre_existing', 'escaped', 'confirmed', 'plausible', 'unverified_blockers', 'bug_classes']);
const DECIDERS: readonly string[] = Object.freeze(['autopilot', 'person']);
const STORES: readonly string[] = Object.freeze(['absent', 'present']);
/** IC-003 and IC-002 bounds; a section past one breaks the contract. */
const BOUNDS = Object.freeze({ checkouts: 64, gates: 64, artifacts: 64, reviews: 16, sessions: 16, audit: 8, denials: 3, coverage: 32, activity: 16, activityGates: 8, harnesses: 32, unreadable: 32 });
/** IC-003: a denial reason, in characters, as the core caps it. */
const REASON_CHARS = 200;
/** A gate name is registry text; anything longer is not one. */
const NAME_CHARS = 200;

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const LABEL = /^[A-Za-z0-9 ._:/@-]{1,64}$/;
const PATH_LABEL = /^[/~]|^[A-Za-z]:[\\/]/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const KEY16 = /^[0-9a-f]{16}$/;
const RUN_ID = /^w-[0-9a-f]{12}$/;
const WITHHELD = '(withheld)';

class Mismatch extends Error {}
const fail = (): never => {
  throw new Mismatch();
};

type Check<T> = (value: unknown) => T;
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : fail();
const each = <T>(check: Check<T>, max: number): Check<T[]> => (value) => (Array.isArray(value) && value.length <= max ? value.map((item) => check(item)) : fail());
const orNull = <T>(check: Check<T>): Check<T | null> => (value) => (value === null ? null : check(value));
/** A field IC-003 marks optional (`task?`): absent reads as null. */
const optional = <T>(check: Check<T>): Check<T | null> => (value) => (value === undefined ? null : orNull(check)(value));
const oneOf = (set: readonly string[]): Check<string> => (value) => (typeof value === 'string' && set.includes(value) ? value : fail());
const id: Check<string> = (value) => (typeof value === 'string' && ID.test(value) && value.length <= 128 && maskLite(value) === value ? value : fail());
const key16: Check<string> = (value) => (typeof value === 'string' && KEY16.test(value) ? value : fail());
const iso: Check<string> = (value) => (typeof value === 'string' && ISO.test(value) && !Number.isNaN(Date.parse(value)) ? value : fail());
const count: Check<number> = (value) => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : fail());
const bool: Check<boolean> = (value) => (typeof value === 'boolean' ? value : fail());
const one: Check<1> = (value) => (value === 1 ? 1 : fail());
/** A name, never a place or a secret: project.ts's `label` rule. */
const label: Check<string> = (value) => (typeof value !== 'string' ? fail() : LABEL.test(value) && !PATH_LABEL.test(value) && maskLite(value) === value ? value : WITHHELD);
/** A free text of at most `max` characters, masked. */
const capped = (max: number): Check<string> => (value) => (typeof value === 'string' && value.length <= max ? maskLite(value) : fail());
/** `{observed: true}` or `{observed: false, reason}`. */
const observedOnly: Check<{ observed: true } | { observed: false; reason: string }> = (value) => {
  const v = record(value);
  return v.observed === true ? { observed: true } : v.observed === false ? { observed: false, reason: id(v.reason) } : fail();
};

/** A run key `<worktreeKey16>/<run>/<lineage>`, else null (plan DEC-010: no exact-key join, never a guess). */
const runKeyOf = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const parts = value.split('/');
  return parts.length === 3 && KEY16.test(parts[0]) && ID.test(parts[1]) && ID.test(parts[2]) && maskLite(value) === value ? value : null;
};

/** The project.ts projector `shapeId` as a check: its refusal is this section's mismatch. */
const viaProject = (shapeId: string): Check<any> => (value) => {
  const projected = project(shapeId, value);
  return projected.ok ? projected.body : fail();
};

// ---- IC-002 machine ----

function activity(value: unknown) {
  const body = record(value);
  const limits = record(body.limits);
  const item = (entry: unknown) => {
    const a = record(entry);
    const runs = record(a.runs);
    const workers = record(a.workers);
    const sessions = record(a.sessions);
    const gate = (g: unknown) => {
      const e = record(g);
      return { slug: orNull(id)(e.slug), taskId: id(e.taskId), gateId: id(e.gateId), name: capped(NAME_CHARS)(e.name), recordAt: orNull(iso)(e.recordAt) };
    };
    return {
      projectKey: key16(a.projectKey),
      runs: { open: count(runs.open), awaiting: count(runs.awaiting) },
      gates: each(gate, BOUNDS.activityGates)(a.gates),
      workers: { open: count(workers.open) },
      sessions: { observed: count(sessions.observed), harnesses: each(id, BOUNDS.harnesses)(sessions.harnesses) },
      unreadable: each(id, BOUNDS.unreadable)(a.unreadable),
    };
  };
  return {
    v: one(body.v),
    limits: { projects: count(limits.projects), notShown: count(limits.notShown), watched: count(limits.watched), fingerprintOnly: count(limits.fingerprintOnly) },
    items: each(item, BOUNDS.activity)(body.items),
  };
}

const MACHINE_PROJECTORS: Readonly<Record<string, Check<unknown>>> = Object.freeze({ projects: viaProject('projects'), activity });

// ---- IC-003 layers ----

function checkouts(value: unknown) {
  const entry = (item: unknown) => {
    const c = record(item);
    return { worktreeKey: key16(c.worktreeKey), label: label(c.label), branch: orNull(label)(c.branch), main: bool(c.main) };
  };
  return each(entry, BOUNDS.checkouts)(value);
}

/** `orchestrate --action list` rows through project.ts, with each row's `runKey`; `skill` is joined afterwards. */
function runs(value: unknown) {
  const body = record(value);
  const projected = viaProject('list')(body);
  const raw = body.runs as unknown[];
  return { ...projected, runs: projected.runs.map((row: any, i: number) => ({ ...row, runKey: runKeyOf(record(raw[i]).runKey) })) };
}

function gates(value: unknown) {
  const entry = (item: unknown) => {
    const g = record(item);
    return {
      runKey: runKeyOf(g.runKey), slug: orNull(id)(g.slug), taskId: id(g.taskId), gateId: id(g.gateId), name: capped(NAME_CHARS)(g.name), state: id(g.state),
      at: orNull(iso)(g.at), by: orNull(oneOf(DECIDERS))(g.by),
    };
  };
  return each(entry, BOUNDS.gates)(value);
}

function artifacts(value: unknown) {
  const entry = (item: unknown) => {
    const a = record(item);
    return {
      fileKey: key16(a.fileKey), kind: oneOf(ARTIFACT_KINDS)(a.kind), worktreeKey: key16(a.worktreeKey), feature: orNull(id)(a.feature),
      task: optional(id)(a.task), group: optional(id)(a.group), dispatchId: optional(id)(a.dispatchId),
      runId: optional((v) => (typeof v === 'string' && RUN_ID.test(v) ? v : fail()))(a.runId),
      bytes: count(a.bytes), at: iso(a.at),
    };
  };
  return each(entry, BOUNDS.artifacts)(value);
}

function reviews(value: unknown) {
  const entry = (item: unknown) => {
    const r = record(item);
    const state = oneOf(REVIEW_STATES)(r.state);
    const counts = optional((v) => {
      const c = record(v);
      const out: Record<string, number | null> = { rounds: optional(count)(c.rounds) };
      for (const name of REVIEW_COUNTS) out[name] = count(c[name]);
      return out;
    })(r.counts);
    return { worktreeKey: key16(r.worktreeKey), feature: id(r.feature), state, counts };
  };
  return each(entry, BOUNDS.reviews)(value);
}

function sessions(value: unknown) {
  const auditOf = (value: unknown) => {
    const a = record(value);
    if (a.observed === false) return { observed: false, reason: id(a.reason) };
    if (a.observed !== true) return fail();
    const line = (item: unknown) => {
      const l = record(item);
      return { at: iso(l.at), event: id(l.event), agentType: orNull(label)(l.agentType), agentKey: orNull(key16)(l.agentKey) };
    };
    return { observed: true, open: count(a.open), started: count(a.started), stopped: count(a.stopped), recent: each(line, BOUNDS.audit)(a.recent) };
  };
  const denialsOf = (value: unknown) => {
    const d = record(value);
    if (d.observed === false) return { observed: false, reason: id(d.reason) };
    if (d.observed !== true) return fail();
    const line = (item: unknown) => {
      const l = record(item);
      return { at: iso(l.at), tool: label(l.tool), reason: capped(REASON_CHARS)(l.reason) };
    };
    return { observed: true, count: count(d.count), recent: each(line, BOUNDS.denials)(d.recent) };
  };
  const entry = (item: unknown) => {
    const s = record(item);
    return { sessionKey: key16(s.sessionKey), harness: id(s.harness), audit: auditOf(s.audit), denials: denialsOf(s.denials) };
  };
  return each(entry, BOUNDS.sessions)(value);
}

function coverage(value: unknown) {
  const entry = (item: unknown) => {
    const c = record(item);
    return {
      harness: id(c.harness), main: observedOnly(c.main), subagents: observedOnly(c.subagents), transcript: observedOnly(c.transcript),
      permissions: observedOnly(c.permissions), questions: observedOnly(c.questions),
    };
  };
  return each(entry, BOUNDS.coverage)(value);
}

const LAYERS_PROJECTORS: Readonly<Record<string, Check<unknown>>> = Object.freeze({
  checkouts, tree: viaProject('tree'), runs, gates, artifacts, reviews, sessions, traffic: viaProject('traffic'), coverage,
});

// ---- members ----

/** One section's result through its projector. */
function sectionOf(sections: ReadonlyMap<string, SectionResult>, name: string, check: Check<unknown>): Section {
  const result = sections.get(name);
  if (result === undefined) return { ok: false, code: 'section-missing' };
  if (result.exit !== 0 || result.json === null) return { ok: false, code: 'core-error' };
  try {
    return { ok: true, data: check(result.json) };
  } catch (error) {
    if (error instanceof Mismatch) return { ok: false, code: 'core-contract-mismatch' };
    throw error;
  }
}

/** IC-002: the `machine` member. */
function composeMachine(sections: ReadonlyMap<string, SectionResult>): Member {
  const out: Record<string, Section> = {};
  for (const name of MACHINE_SECTIONS) out[name] = sectionOf(sections, name, MACHINE_PROJECTORS[name]);
  return { status: 200, body: { v: 1, sections: out } };
}

/**
 * IC-003, IC-007: the `layers` member of project `projectKey`. `workflowOf(taskClass)` is the runner's
 * cached `workflow` read; it runs once per distinct class of a run at a stage.
 */
async function composeLayers(projectKey: string, sections: ReadonlyMap<string, SectionResult>, workflowOf: WorkflowOf): Promise<Member> {
  const out: Record<string, Section> = {};
  for (const name of LAYERS_SECTIONS) out[name] = sectionOf(sections, name, LAYERS_PROJECTORS[name]);
  const runSection = out.runs;
  if (runSection.ok) {
    const data = runSection.data as { runs: any[] };
    const classes = [...new Set(data.runs.filter((row) => row.current !== null && row.current.type === 'stage').map((row) => row.taskClass as string))];
    const stagesOf = new Map<string, Map<string, string>>();
    await Promise.all(classes.map(async (taskClass) => {
      let answer: { ok: boolean; json?: unknown } | null = null;
      try {
        answer = await workflowOf(taskClass);
      } catch {
        answer = null;
      }
      const projected = answer !== null && answer.ok ? project('workflow', answer.json) : null;
      if (projected === null || !projected.ok || projected.body.taskClass !== taskClass) return;
      stagesOf.set(taskClass, new Map(projected.body.stages.map((stage: any) => [stage.id, stage.skill])));
    }));
    const joined = data.runs.map((row) => ({
      ...row,
      skill: row.current !== null && row.current.type === 'stage' ? (stagesOf.get(row.taskClass)?.get(row.current.id) ?? null) : null,
    }));
    out.runs = { ok: true, data: { ...data, runs: joined } };
  }
  return { status: 200, body: { v: 1, projectKey, sections: out } };
}

module.exports = { ARTIFACT_KINDS, LAYERS_SECTIONS, MACHINE_SECTIONS, composeLayers, composeMachine };
