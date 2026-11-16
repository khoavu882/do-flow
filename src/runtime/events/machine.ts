'use strict';

// Feature 161 D9 (IC-002): the `machine` channel of `doflow events --follow`, sections `projects`
// and `activity`.
//
//   projects  the `fleet --action projects` body without `root`, from the child's project index
//   activity  for the first ACTIVITY_PROJECTS projects in `projects` order: open and awaiting
//             orchestration runs, the newest awaiting gates, open worker runs, started sessions (open, then the newest ended)
//             (165: the newest 8 and a count), observed sessions
//             and their harnesses, and the stores that failed to read
//
// Live from watch events and the 1 s pass: the index sources mark both sections, each shown
// project's orchestration stores, worker-run store and the session directories mark `activity`
// only. `activity` is throttled to one recompute per ACTIVITY_THROTTLE_MS (the session store moves
// on every hook write); the trailing run keeps the last change. When the shown projects or their
// store directories change, `sourcesKey()` changes and the command swaps the detector's sources.
//
// Every read is the existing reader's (`runEntriesAt`/`selectRunEntries`/`snapshotRun`, `readRuns`,
// `observedSessions`), read-only and with no process: `observedSessions` lists checkouts through the
// index's `replay`, so git runs only on an index refresh. Results are raw; masking is the writer's,
// and no path is in them.

const path = require('node:path');
const fs = require('node:fs');
const { runEntriesAt, selectRunEntries } = require('../implementation-gate.ts');
const { snapshotRun, RUN_STATES } = require('../workflow-orchestrator.ts');
const { readRuns } = require('../worker/run-store.ts');
const { observedSessions } = require('../context/primary.ts');
const { isSafeSlug } = require('../task-scope.ts');
const { isChannelId } = require('./channels.ts');
const { gateName } = require('./layers.ts');
const { createProjectsIndex } = require('./projects-index.ts');

type Env = Record<string, string | undefined>;
type SectionResult = { exit: number; json: any };

/** IC-002, IC-008: the projects `activity` summarizes, and the awaiting gates listed per project. */
const ACTIVITY_PROJECTS = 16;
const GATE_LIMIT = 8;
/** 165 D8: the started sessions listed per project. */
const STARTED_LIMIT = 8;
/** At most one `activity` recompute per this many ms (leading and trailing, detector.ts). */
const ACTIVITY_THROTTLE_MS = 1000;

const SECTIONS: readonly string[] = Object.freeze(['projects', 'activity']);
const JSON_RECORD = /\.json$/;
const SESSION_ENTRY = /^[A-Za-z0-9]/;

/** The store names `unreadable` reports (`core/registry/storage.json` ids). */
const STORE_ORCHESTRATION = 'task-orchestration';
const STORE_WORKER_RUNS = 'worker-runs';
const STORE_SESSIONS = 'session-dirs';

interface MachineContext {
  cwd: string;
  env?: Env;
  /** The child's project index (shared with `layers`, `file`, `transcript`); one is made when absent. */
  index?: any;
  /** The detector's watch counts, for `activity.limits`. */
  counts?: () => { watched: number; fingerprintOnly: number };
}

function parsed(value: any): any {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Open and awaiting runs and the newest awaiting gates over a project's checkouts, as `orchestrate --action list` selects them. */
function orchestrationActivity(entry: { main: string; checkouts: string[] }): { runs: { open: number; awaiting: number }; gates: any[]; unreadable: boolean } {
  const all = [...runEntriesAt(entry.main, 'current'), ...entry.checkouts.filter((c) => c !== entry.main).flatMap((c) => runEntriesAt(c, 'other'))];
  const runs = { open: 0, awaiting: 0 };
  const gates: any[] = [];
  let unreadable = false;
  for (const e of selectRunEntries(all)) {
    const record = e.record;
    const stem = path.basename(e.file, '.json');
    if (e.error || !record || typeof record !== 'object' || Array.isArray(record) || record.version !== 1
      || !RUN_STATES.includes(record.state) || record.taskId !== stem || !isChannelId(stem)) { unreadable = true; continue; }
    let snapshot: any;
    try { snapshot = snapshotRun(record); } catch { unreadable = true; continue; }
    if (snapshot.state === 'RUNNING' || snapshot.state === 'AWAITING_GATE') runs.open += 1;
    if (snapshot.state !== 'AWAITING_GATE') continue;
    runs.awaiting += 1;
    const gate = snapshot.awaitingGate;
    if (!gate || !isChannelId(gate.gateId)) continue;
    gates.push({
      slug: typeof e.slug === 'string' && isSafeSlug(e.slug) ? e.slug : null,
      taskId: stem,
      gateId: gate.gateId,
      name: gateName(gate.name, gate.gateId),
      recordAt: isoOrNull(record.updatedAt),
      revision: record.revision || 0,
    });
  }
  const time = (g: any) => (g.recordAt === null ? -Infinity : Date.parse(g.recordAt));
  gates.sort((a, b) => time(b) - time(a) || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  return { runs, gates: gates.slice(0, GATE_LIMIT), unreadable };
}

/**
 * Worker runs whose phase is not `ended`, over the project's worker-run store (the lifecycle root is the main checkout).
 * 165 D8: a run of kind `main-session` is a started session, not a worker run, and is never in `open`. 165 review B-4: the
 * started list is every open one and then the newest ended ones (by `createdAt`) up to STARTED_LIMIT, newest `createdAt` first
 * (then run id), each with `end` (`{state, at}`, null while open); `startedCount` counts every started session the store holds.
 */
function workerActivity(main: string): { open: number; started: any[]; startedCount: number; unreadable: boolean } {
  const dir = path.join(main, '.doflow', 'state', 'worker-runs');
  let names: string[];
  try { names = fs.readdirSync(dir).filter((name: string) => JSON_RECORD.test(name) && isSafeSlug(name.slice(0, -'.json'.length))).sort(); } catch { return { open: 0, started: [], startedCount: 0, unreadable: false }; }
  let open = 0;
  let unreadable = false;
  const live: any[] = [];
  const ended: any[] = [];
  for (const name of names) {
    try {
      for (const run of Object.values(readRuns(path.join(dir, name))) as any[]) {
        if (!run) continue;
        const done = run.phase === 'ended';
        if (run.kind !== 'main-session') { if (!done) open += 1; continue; }
        const end = done && run.end && typeof run.end.state === 'string' ? { state: run.end.state, at: isoOrNull(run.end.at) } : null;
        (done ? ended : live).push({
          runId: run.runId ?? null, harness: run.harness ?? null, model: run.binding?.model ?? null, phase: run.phase, startedBy: run.startedBy ?? null,
          worktreeKey: run.project?.worktreeKey ?? null, createdAt: isoOrNull(run.createdAt), end,
        });
      }
    } catch { unreadable = true; }
  }
  const time = (r: any) => (r.createdAt === null ? -Infinity : Date.parse(r.createdAt));
  const newest = (a: any, b: any) => time(b) - time(a) || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0);
  const kept = live.sort(newest).slice(0, STARTED_LIMIT);
  const started = [...kept, ...ended.sort(newest).slice(0, STARTED_LIMIT - kept.length)].sort(newest);
  return { open, started, startedCount: live.length + ended.length, unreadable };
}

/** `primary --action observed`'s sessions of the project, with the checkout list replayed from the index. */
function sessionActivity(main: string, env: Env, index: any): { observed: number; harnesses: string[]; unreadable: boolean } {
  let answer: any;
  try { answer = observedSessions({ env, cwd: main, exec: index.replay, now: () => index.now() }); } catch { answer = { ok: false }; }
  if (!answer || !answer.ok) return { observed: 0, harnesses: [], unreadable: true };
  const sessions: any[] = Array.isArray(answer.body.sessions) ? answer.body.sessions : [];
  const harnesses = [...new Set(sessions.map((s) => s.harness).filter((h) => typeof h === 'string'))].sort() as string[];
  return { observed: sessions.length, harnesses, unreadable: false };
}

/**
 * The IC-002 catalogue entry of the `machine` channel, in the shape `channelSpec` returns, plus
 * `sourcesKey()`. Ceiling: an `activity` recompute reads every session directory once per shown
 * project (16 × at most 2000 directories), which is why it is throttled.
 * @param {MachineContext} ctx
 */
function machineSpec(ctx: MachineContext): any {
  if (!ctx || typeof ctx.cwd !== 'string' || ctx.cwd === '') throw new TypeError('a section context needs a cwd');
  const env: Env = ctx.env ?? process.env;
  const index = ctx.index ?? createProjectsIndex({ env, cwd: ctx.cwd });
  const counts = typeof ctx.counts === 'function' ? ctx.counts : () => ({ watched: 0, fingerprintOnly: 0 });
  let emitted = -1;

  function shown(): any[] {
    return index.entries().slice(0, ACTIVITY_PROJECTS);
  }

  function sources(): any {
    // Required here: sections.ts requires this module, so its exports are complete only once loaded.
    const { orchestrationDirs } = require('./sections.ts');
    const directories: any[] = index.sources().map((d: any) => ({ ...d, sections: [...SECTIONS] }));
    for (const entry of shown()) {
      for (const root of entry.checkouts) for (const d of orchestrationDirs(root)) directories.push({ ...d, sections: ['activity'] });
      directories.push({ path: path.join(entry.main, '.doflow', 'state', 'worker-runs'), match: JSON_RECORD, sections: ['activity'] });
    }
    const sessions = index.sessionsDir();
    if (sessions !== null) directories.push({ path: sessions, match: SESSION_ENTRY, sections: ['activity'] });
    return { directories, files: [], derived: [], primary: null, policies: { activity: { throttleMs: ACTIVITY_THROTTLE_MS } } };
  }

  function activity(): any {
    const listed = index.body();
    const total = listed.ok ? listed.body.projects.length : 0;
    const items = shown().map((entry) => {
      const orchestration = orchestrationActivity(entry);
      const workers = workerActivity(entry.main);
      const sessions = sessionActivity(entry.main, env, index);
      const unreadable = [
        ...(orchestration.unreadable ? [STORE_ORCHESTRATION] : []),
        ...(workers.unreadable ? [STORE_WORKER_RUNS] : []),
        ...(sessions.unreadable ? [STORE_SESSIONS] : []),
      ];
      return {
        projectKey: entry.projectKey,
        runs: orchestration.runs,
        gates: orchestration.gates,
        workers: { open: workers.open },
        started: workers.started,
        startedCount: workers.startedCount,
        sessions: { observed: sessions.observed, harnesses: sessions.harnesses },
        unreadable,
      };
    });
    const { watched, fingerprintOnly } = counts();
    return { v: 1, limits: { projects: ACTIVITY_PROJECTS, notShown: Math.max(0, total - ACTIVITY_PROJECTS), watched, fingerprintOnly }, items };
  }

  async function compute(only?: readonly string[]): Promise<{ sections: Record<string, SectionResult> }> {
    const names = new Set<string>(only === undefined ? SECTIONS : []);
    for (const name of only ?? []) {
      if (!SECTIONS.includes(name)) throw new TypeError(`'${name}' is not a section of a machine channel`);
      names.add(name);
    }
    index.ensure(only === undefined); // a full recompute (the 30 s pass, a new sub) may refresh the index
    if (index.generation() !== emitted) { names.add('projects'); names.add('activity'); }
    const sections: Record<string, SectionResult> = {};
    if (names.has('projects')) {
      const listed = index.body();
      if (!listed.ok) throw new Error(`the project index failed: ${listed.error}`); // IC-002: the channel's producer-failed
      sections.projects = { exit: 0, json: parsed(listed.body) };
      emitted = index.generation();
    }
    if (names.has('activity')) sections.activity = { exit: 0, json: parsed(activity()) };
    return { sections };
  }

  return {
    channel: { kind: 'machine', name: 'machine' },
    derived: [],
    sectionNames: () => [...SECTIONS],
    isDerived: () => false,
    sources,
    sourcesKey: () => JSON.stringify(sources().directories.map((d: any) => [d.path, d.match ? String(d.match) : '', d.sections ?? []])),
    compute,
  };
}

module.exports = { machineSpec, ACTIVITY_PROJECTS, GATE_LIMIT, STARTED_LIMIT, ACTIVITY_THROTTLE_MS, SECTIONS };
