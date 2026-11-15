'use strict';

// Feature 161 IC-003 (D5-D8, FR-009): the `layers:<pk>` channel of `doflow events --follow`: one
// project, every checkout of it, in nine sections.
//
//   checkouts  [{worktreeKey, label, branch, main}]                          .git/worktrees, full pass
//   tree       the `fleet --action tree` body (buildTree)                     derived, <= 1 per 1000 ms
//   runs       the `orchestrate --action list` body, rows with `runKey`       orchestration stores
//   gates      <= 8 runs x <= 8 gate events {runKey, slug, taskId, gateId, name, state, at, by}
//   artifacts  <= 64 newest briefs, reports, envelopes, prompts, worker logs (artifacts.ts)
//   reviews    <= 16 features {worktreeKey, feature, state, counts?} (countFindings)
//   sessions   <= 16 sessions {sessionKey, harness, audit, denials}         session dirs, audit tails
//   traffic    the transcript stats body (computeStats)                       derived, <= 1 per 5000 ms
//   coverage   per registry harness, what is observed and why not (coverage.ts)          full pass
//
// The project is the child's project index's (`lookup`); a key it does not know after one refresh
// makes the channel `gone` (compute returns `gone: true`). Joins use exact keys only (D5): an audit
// line's agentKey is the tree's `sha16(<harness>:<session_id>:<agent_id>)` for claude and copilot,
// null for codex (its agent_id is not shown to equal the child session id, design R1) and for a
// session whose harness is not recorded. A gate's `by` is the timeline's (DEC-006).
//
// No git process per pass: every reader that lists checkouts gets the index's `replay` (or finds
// the checkout cache warmed from it); git runs only on an index refresh. `alive` (ps) runs at most
// MAX_CHECKS times per tree build, and tree builds are throttled. Read-only, no lock; results are
// raw (the envelope writer masks every string leaf) and carry no path.

const fs = require('node:fs');
const path = require('node:path');
const { sha16 } = require('../scaffold/fingerprint.ts');
const { maskBody } = require('../mask.ts');
const { cwdHash, stateDir } = require('../context/identity.ts');
const { observedSessions } = require('../context/primary.ts');
const { listCheckouts, clearCheckoutCache } = require('../checkouts.ts');
const { runEntriesAt, selectRunEntries } = require('../implementation-gate.ts');
const { listRunsResult, snapshotRun, timelineOf, RUN_STATES } = require('../workflow-orchestrator.ts');
const { countFindings } = require('../review/findings.ts');
const { buildTree } = require('../fleet/tree.ts');
const { computeStats } = require('../transcripts/stats.ts');
const { isSafeSlug } = require('../task-scope.ts');
const { isChannelId } = require('./channels.ts');
const { scanArtifacts, artifactDirs } = require('./artifacts.ts');
const { coverageBody, AUDIT } = require('./coverage.ts');
const { openConfined, readConfined } = require('./confined.ts');

type Env = Record<string, string | undefined>;
type SectionResult = { exit: number; json: any };

const SECTIONS: readonly string[] = Object.freeze(['checkouts', 'tree', 'runs', 'gates', 'artifacts', 'reviews', 'sessions', 'traffic', 'coverage']);
/** Derived from processes and transcripts: recomputed by the detector's 5 s pass too. */
const DERIVED: readonly string[] = Object.freeze(['tree', 'traffic']);
/** IC-003, IC-008: `tree` at most once per second, `traffic` once per 5 s; `gates` never throttled. */
const POLICIES = Object.freeze({ tree: Object.freeze({ throttleMs: 1000 }), traffic: Object.freeze({ throttleMs: 5000 }) });

const GATE_RUNS = 8;
const GATE_EVENTS = 8;
const GATE_NAME_CHARS = 200;

/**
 * 161 review 3: `text` masked whole, then cut to `max` characters. A cut that the envelope's own
 * masking would change (a `<masked>` cut short, a key whose value it cut) is cut shorter until it is
 * left as it is, so the framed text stays within `max` and never holds the front of a secret.
 */
function maskedCap(text: string, max: number): string {
  const masked = maskBody(text).text;
  let out = masked.slice(0, max);
  for (let cut = out.length; maskBody(out).text !== out; cut -= 1) out = masked.slice(0, cut - 1);
  return out;
}

/** A gate's display name: a non-empty string name masked and capped to GATE_NAME_CHARS, else the gate id (shared with the `machine` channel). */
function gateName(name: unknown, gateId: string): string {
  return typeof name === 'string' && name !== '' ? maskedCap(name, GATE_NAME_CHARS) : gateId;
}
const REVIEW_LIMIT = 16;
const SESSION_LIMIT = 16;
const AUDIT_RECENT = 8;
const DENIAL_RECENT = 3;
const DENIAL_REASON_CHARS = 200;
/** The tail of an audit log read per recompute. Ceiling: counts cover the last 256 KiB (about 1500 lines). */
const AUDIT_TAIL_BYTES = 256 * 1024;
/** A tail is fingerprinted by the 250 ms log pass while its file changed in the last 10 minutes. */
const TAIL_ACTIVE_MS = 10 * 60 * 1000;

const JSON_RECORD = /\.json$/;
const SESSION_ENTRY = /^[A-Za-z0-9]/;
const SESSION_DIR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const KEY16 = /^[0-9a-f]{16}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const AUDIT_FILE = 'subagent-audit.log';
const DENIAL_FILE = 'permission-audit.log';
/** The harnesses whose audit `agent_id` is the tree's subagent id (`tree.ts`: claude files, copilot children). */
const AUDIT_JOINS: readonly string[] = Object.freeze(['claude', 'copilot']);

interface LayersContext {
  cwd: string;
  env?: Env;
  /** The child's project index (projects-index.ts), shared with `machine`, `file` and `transcript`. */
  index: any;
  /** Seams for tests: the process check of tree builds, and the file system. */
  alive?: any;
  fsImpl?: any;
}
interface Entry { projectKey: string; main: string; checkouts: string[] }

function parsed(value: any): any {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}
const ok = (json: any): SectionResult => ({ exit: 0, json: parsed(json) });
const failed = (error: string): SectionResult => ({ exit: 1, json: { v: 1, error } });
const isoAt = (value: unknown): string | null => (typeof value === 'string' && ISO.test(value) && Number.isFinite(Date.parse(value)) ? value : null);
const runKeyOf = (value: unknown): string | null => {
  const parts = typeof value === 'string' ? value.split('/') : [];
  return parts.length === 3 && KEY16.test(parts[0]) && ID.test(parts[1]) && ID.test(parts[2]) ? (value as string) : null;
};
const byTimeDesc = (a: string | null, b: string | null): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : Date.parse(b) - Date.parse(a));

// ── sections ─────────────────────────────────────────────────────────────────────────────────────

function checkoutsSection(entry: Entry, replay: any): SectionResult {
  const listed = listCheckouts({ cwd: entry.main, exec: replay });
  if (!listed.ok) return failed('cannot-list-checkouts');
  return ok(listed.entries.filter((e: any) => !e.sandbox).map((e: any) => ({
    worktreeKey: cwdHash(e.path), label: path.basename(e.path), branch: typeof e.branch === 'string' ? e.branch : null, main: e.path === listed.main,
  })));
}

/** Decided, skipped and awaiting gates of the newest GATE_RUNS runs that have any, each run's newest GATE_EVENTS. */
function gatesSection(entry: Entry): SectionResult {
  const all = [...runEntriesAt(entry.main, 'current'), ...entry.checkouts.filter((c) => c !== entry.main).flatMap((c) => runEntriesAt(c, 'other'))];
  const runs: Array<{ updatedAt: string | null; taskId: string; events: any[] }> = [];
  for (const e of selectRunEntries(all)) {
    const record = e.record;
    const stem = path.basename(e.file, '.json');
    if (e.error || !record || typeof record !== 'object' || Array.isArray(record) || record.version !== 1
      || !RUN_STATES.includes(record.state) || record.taskId !== stem || !isChannelId(stem)) continue;
    const slug = typeof e.slug === 'string' && isSafeSlug(e.slug) ? e.slug : null;
    const program: any[] = Array.isArray(record.program) ? record.program : [];
    const nameOf = (gateId: string): string => gateName(program.find((n) => n && n.type === 'gate' && n.id === gateId)?.name, gateId);
    const runKey = runKeyOf(record.runKey);
    const row = (gateId: string, state: string, at: string | null, by: string | null) => ({ runKey, slug, taskId: stem, gateId, name: nameOf(gateId), state, at, by });
    const events: any[] = [];
    let timeline: any;
    let snapshot: any;
    try { timeline = timelineOf(record, stem, slug); snapshot = snapshotRun(record); } catch { continue; }
    for (const ev of timeline.events) {
      if (ev.node === null) continue;
      if (ev.action === 'decide-gate' && ev.decision !== null) events.push(row(ev.node, ev.decision === 'approve' ? 'approved' : 'rejected', ev.at, ev.by));
      else if (ev.action === 'skip-gate') events.push(row(ev.node, 'skipped', ev.at, null));
    }
    const awaiting = snapshot.awaitingGate;
    if (awaiting && typeof awaiting.gateId === 'string' && ID.test(awaiting.gateId)) events.push(row(awaiting.gateId, 'awaiting', isoAt(record.updatedAt), null));
    if (events.length === 0) continue;
    events.sort((a, b) => byTimeDesc(a.at, b.at));
    runs.push({ updatedAt: isoAt(record.updatedAt), taskId: stem, events: events.slice(0, GATE_EVENTS) });
  }
  runs.sort((a, b) => byTimeDesc(a.updatedAt, b.updatedAt) || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  return ok(runs.slice(0, GATE_RUNS).flatMap((r) => r.events));
}

/**
 * The review record of a feature directory: absent, unreadable (`review` not a real directory, the
 * record not a regular file, or not JSON), invalid, or its counts.
 */
function reviewOf(checkout: string, dir: string, fsImpl: any): { state: string; counts?: any } {
  const file = path.join(dir, 'review', 'findings.json');
  let st: any;
  try {
    if (!fsImpl.lstatSync(path.join(dir, 'review')).isDirectory()) return { state: 'unreadable' };
    st = fsImpl.lstatSync(file);
  } catch (error: any) { return { state: error && error.code === 'ENOENT' ? 'absent' : 'unreadable' }; }
  if (!st.isFile()) return { state: 'unreadable' };
  let doc: any;
  try { doc = JSON.parse((readConfined(checkout, file, fsImpl) as Buffer).toString('utf8')); } catch { return { state: 'unreadable' }; }
  let counts: any;
  try { counts = countFindings(doc); } catch { counts = null; }
  if (counts === null) return { state: 'invalid' };
  return { state: 'ok', counts };
}

/** The REVIEW_LIMIT features most recently touched (the feature directory or its findings), each checkout's. */
function reviewsSection(entry: Entry, fsImpl: any): SectionResult {
  const rows: Array<{ ms: number; row: any }> = [];
  for (const checkout of entry.checkouts) {
    const base = path.join(checkout, 'agent-docs', 'doflow');
    let names: string[] = [];
    try {
      // Neither `agent-docs` nor `agent-docs/doflow` may be a link.
      if (fsImpl.lstatSync(path.dirname(base)).isDirectory() && fsImpl.lstatSync(base).isDirectory()) names = fsImpl.readdirSync(base).map(String).sort();
    } catch { /* no features */ }
    for (const feature of names) {
      if (!isSafeSlug(feature) || !ID.test(feature)) continue;
      const dir = path.join(base, feature);
      let ms: number;
      try { const st = fsImpl.lstatSync(dir); if (!st.isDirectory()) continue; ms = st.mtimeMs; } catch { continue; }
      const file = path.join(dir, 'review', 'findings.json');
      try { ms = Math.max(ms, fsImpl.lstatSync(file).mtimeMs); } catch { /* absent */ }
      rows.push({ ms, row: { worktreeKey: cwdHash(checkout), feature, ...reviewOf(checkout, dir, fsImpl) } });
    }
  }
  rows.sort((a, b) => b.ms - a.ms || (a.row.feature < b.row.feature ? -1 : a.row.feature > b.row.feature ? 1 : 0));
  return ok(rows.slice(0, REVIEW_LIMIT).map((r) => r.row));
}

/**
 * The last AUDIT_TAIL_BYTES of a regular file below `root` as whole lines, or null when it is absent or
 * not a regular file (opened through `confined.ts`, so a link swapped in before the open is refused).
 */
function tailLines(root: string, file: string, fsImpl: any): string[] | null {
  try {
    const fd = openConfined(root, file, fsImpl);
    try {
      const st = fsImpl.fstatSync(fd);
      const start = Math.max(0, st.size - AUDIT_TAIL_BYTES);
      const buf = Buffer.alloc(st.size - start);
      const n = fsImpl.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.subarray(0, n).toString('utf8').split('\n');
      if (start > 0) lines.shift(); // the first line was cut
      return lines.filter((line) => line.trim() !== '');
    } finally { fsImpl.closeSync(fd); }
  } catch {
    return null;
  }
}

const jsonLine = (line: string): any => {
  try { const doc = JSON.parse(line); return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : null; } catch { return null; }
};
const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** A `subagent-audit.log`: start and stop counts, the ids still open, and the newest AUDIT_RECENT lines with their tree agentKey. */
function auditOf(root: string, file: string, harness: string | null, fsImpl: any): any {
  const lines = tailLines(root, file, fsImpl);
  if (lines === null) {
    if (harness !== null && AUDIT.subagents.includes(harness)) return { observed: true, open: 0, started: 0, stopped: 0, recent: [] };
    return { observed: false, reason: harness === null ? 'harness-not-recorded' : 'no-audit-hook' };
  }
  const recent: any[] = [];
  const open = new Set<string>();
  let started = 0;
  let stopped = 0;
  for (const line of lines) {
    const doc = jsonLine(line);
    const at = doc ? isoAt(doc.timestamp) : null;
    const kind = doc && typeof doc.event === 'string' ? doc.event.replace(/[_\s-]/g, '').toLowerCase() : '';
    if (at === null || (kind !== 'subagentstart' && kind !== 'subagentstop')) continue;
    const agentId = text(doc.agent_id);
    const sessionId = text(doc.session_id);
    if (kind === 'subagentstart') { started += 1; if (agentId) open.add(agentId); } else { stopped += 1; if (agentId) open.delete(agentId); }
    const joins = harness !== null && AUDIT_JOINS.includes(harness) && agentId !== null && sessionId !== null;
    recent.push({ at, event: kind === 'subagentstart' ? 'SubagentStart' : 'SubagentStop', agentType: text(doc.agent_type), agentKey: joins ? sha16(`${harness}:${sessionId}:${agentId}`) : null });
  }
  return { observed: true, open: open.size, started, stopped, recent: recent.slice(-AUDIT_RECENT).reverse() };
}

/** A `permission-audit.log` (D8, "permission refused"): the count and the newest DENIAL_RECENT. */
function denialsOf(root: string, file: string, harness: string | null, fsImpl: any): any {
  const lines = tailLines(root, file, fsImpl);
  if (lines === null) {
    if (harness !== null && AUDIT.permissions.includes(harness)) return { observed: true, count: 0, recent: [] };
    return { observed: false, reason: 'no-harness-record' };
  }
  const recent: any[] = [];
  for (const line of lines) {
    const doc = jsonLine(line);
    const at = doc ? isoAt(doc.timestamp) : null;
    if (at === null) continue;
    recent.push({ at, tool: typeof doc.tool_name === 'string' ? doc.tool_name : '', reason: typeof doc.reason === 'string' ? maskedCap(doc.reason, DENIAL_REASON_CHARS) : '' });
  }
  return { observed: true, count: recent.length, recent: recent.slice(-DENIAL_RECENT).reverse() };
}

/** The project's SESSION_LIMIT newest hook sessions (observedSessions order) with the directory each one's id names. */
type Shown = { ok: boolean; root: string | null; sessions: Array<{ s: any; dir: string | null }> };

function shownSessions(entry: Entry, env: Env, index: any, fsImpl: any): Shown {
  const root = stateDir(env);
  let answer: any;
  try { answer = observedSessions({ env, cwd: entry.main, exec: index.replay, now: () => index.now(), fsImpl }); } catch { answer = { ok: false }; }
  if (!answer || !answer.ok) return { ok: false, root, sessions: [] };
  const dirs = new Map<string, string>();
  if (root !== null) {
    try { for (const name of fsImpl.readdirSync(path.join(root, 'sessions')).map(String)) if (SESSION_DIR.test(name)) dirs.set(sha16(name), path.join(root, 'sessions', name)); } catch { /* none */ }
  }
  const sessions = (answer.body.sessions as any[]).filter((s) => s.kind === 'hook').slice(0, SESSION_LIMIT);
  return { ok: true, root, sessions: sessions.map((s) => ({ s, dir: dirs.get(s.sessionKey) ?? null })) };
}

function sessionsSection(shown: Shown, fsImpl: any): SectionResult {
  if (!shown.ok) return failed('cannot-list-checkouts');
  const root = shown.root as string; // a session directory is only found under the state home
  return ok(shown.sessions.map(({ s, dir }) => {
    const harness = typeof s.harness === 'string' ? s.harness : null;
    return {
      sessionKey: s.sessionKey,
      harness,
      audit: dir === null ? { observed: false, reason: 'no-session-dir' } : auditOf(root, path.join(dir, AUDIT_FILE), harness, fsImpl),
      denials: dir === null ? { observed: false, reason: 'no-session-dir' } : denialsOf(root, path.join(dir, DENIAL_FILE), harness, fsImpl),
    };
  }));
}

// ── the spec ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The IC-003 catalogue entry of a `layers:<pk>` channel, in the shape `channelSpec` returns, plus
 * `sourcesKey()` and `artifact(fileKey)` (IC-004: the file of a key the last `artifacts` listed,
 * `{path, kind}`, or null; for the `file:` lane, inside the core only).
 * `compute(only?)` returns `{sections}`, or `{sections: {}, gone: true}` when the project index does
 * not know the key after a refresh (IC-001).
 * @param {{kind: 'layers', name: string, projectKey: string}} channel
 * @param {LayersContext} ctx
 */
function layersSpec(channel: { kind: 'layers'; name: string; projectKey: string }, ctx: LayersContext): any {
  if (!ctx || typeof ctx.cwd !== 'string' || ctx.cwd === '') throw new TypeError('a section context needs a cwd');
  if (!ctx.index) throw new TypeError('a layers channel needs the project index');
  const env: Env = ctx.env ?? process.env;
  const index = ctx.index;
  const fsImpl = ctx.fsImpl ?? fs;
  const alive = ctx.alive;
  let entry: Entry | null = null;
  let looked = false;
  let sessionDirs: string[] = [];
  let files = new Map<string, { path: string; kind: string }>();

  function current(): Entry | null {
    if (!looked) { entry = index.lookup(channel.projectKey); looked = true; }
    return entry;
  }

  function sources(): any {
    const e = current();
    if (e === null) return { directories: [], files: [], derived: [], primary: null, tails: [], policies: {} };
    const { orchestrationDirs } = require('./sections.ts'); // sections.ts requires this module: read its export at call time
    const directories: any[] = [{ path: path.join(e.main, '.git', 'worktrees'), match: /^[^.]/ }];
    for (const root of e.checkouts) {
      for (const d of orchestrationDirs(root)) directories.push({ ...d, sections: ['runs', 'gates'] });
      for (const store of ['worker-runs', 'task-attempts', 'dispatch']) directories.push({ path: path.join(root, '.doflow', 'state', store), match: JSON_RECORD, sections: ['tree'] });
    }
    const dirs = artifactDirs(e.checkouts, fsImpl);
    for (const d of dirs.features) directories.push({ path: d, match: /^[^.]/, sections: ['artifacts', 'reviews'] });
    for (const d of dirs.featureDirs) directories.push({ path: d, match: /^(?:exec|review)$/, sections: ['artifacts', 'reviews'] });
    for (const d of dirs.exec) directories.push({ path: d, match: /^(?:task|group)-/, sections: ['artifacts'] });
    for (const d of dirs.featureDirs) directories.push({ path: path.join(d, 'review'), match: /^findings\.json$/, sections: ['reviews'] });
    for (const d of dirs.state) directories.push({ path: d, match: /\.(?:handoff\.json|result\.json|prompt\.txt|out\.log|err\.log)$/, sections: ['artifacts'] });
    const sessions = index.sessionsDir();
    if (sessions !== null) directories.push({ path: sessions, match: SESSION_ENTRY, sections: ['tree', 'sessions'] });
    const tails: any[] = [];
    for (const dir of sessionDirs) {
      directories.push({ path: dir, match: /^(?:subagent|permission)-audit\.log$/, sections: ['sessions'] });
      for (const name of [AUDIT_FILE, DENIAL_FILE]) {
        const file = path.join(dir, name);
        tails.push({ path: file, sections: ['sessions'], active: () => { try { return index.now() - fsImpl.statSync(file).mtimeMs < TAIL_ACTIVE_MS; } catch { return false; } } });
      }
    }
    return { directories, files: [], derived: [...DERIVED], primary: null, tails, policies: POLICIES };
  }

  async function compute(only?: readonly string[]): Promise<{ sections: Record<string, SectionResult>; gone?: true }> {
    const names = new Set<string>(only === undefined ? SECTIONS : []);
    for (const name of only ?? []) {
      if (!SECTIONS.includes(name)) throw new TypeError(`'${name}' is not a section of a layers channel`);
      names.add(name);
    }
    if (only === undefined) index.ensure(true); // a full recompute (the 30 s pass, a new sub) may refresh the index
    entry = index.lookup(channel.projectKey);
    looked = true;
    if (entry === null) return { sections: {}, gone: true };
    const e: Entry = entry;
    // Every reader that lists the main checkout's worktrees finds them in the cache, from the index.
    clearCheckoutCache();
    listCheckouts({ cwd: e.main, exec: index.replay });
    const replay = index.replay;
    const sections: Record<string, SectionResult> = {};
    if (names.has('checkouts')) sections.checkouts = checkoutsSection(e, replay);
    if (names.has('tree')) {
      const built = buildTree({ env, cwd: e.main, exec: replay, now: () => index.now(), ...(alive ? { alive } : {}), ...(fsImpl !== fs ? { fsImpl } : {}) });
      sections.tree = built.ok ? ok(built.body) : failed(built.error);
    }
    if (names.has('runs')) {
      const listed = listRunsResult({ stateRoot: e.main });
      sections.runs = { exit: listed.exit, json: parsed(listed.json) };
    }
    if (names.has('gates')) sections.gates = gatesSection(e);
    if (names.has('artifacts')) {
      const scan = scanArtifacts(e.checkouts, fsImpl);
      files = scan.files;
      sections.artifacts = ok(scan.items);
    }
    if (names.has('reviews')) sections.reviews = reviewsSection(e, fsImpl);
    if (names.has('sessions') || only === undefined) {
      const shown = shownSessions(e, env, index, fsImpl);
      sessionDirs = shown.sessions.map((x) => x.dir).filter((d): d is string => d !== null);
      if (names.has('sessions')) sections.sessions = sessionsSection(shown, fsImpl);
    }
    if (names.has('traffic')) {
      const stats = computeStats({ env, cwd: e.main, exec: replay, now: () => index.now(), ...(alive ? { alive } : {}), ...(fsImpl !== fs ? { fsImpl } : {}) });
      sections.traffic = stats.ok ? ok(stats.body) : failed(stats.error);
    }
    if (names.has('coverage')) sections.coverage = ok(coverageBody());
    return { sections };
  }

  return {
    channel,
    derived: DERIVED,
    sectionNames: () => [...SECTIONS],
    isDerived: (name: string) => DERIVED.includes(name),
    sources,
    sourcesKey: () => {
      const s = sources();
      return JSON.stringify([s.directories.map((d: any) => [d.path, d.match ? String(d.match) : '', d.sections ?? []]), s.tails.map((t: any) => t.path)]);
    },
    compute,
    artifact: (fileKey: string) => files.get(fileKey) ?? null,
  };
}

module.exports = { layersSpec, gateName, SECTIONS, DERIVED, POLICIES, GATE_RUNS, GATE_EVENTS, REVIEW_LIMIT, SESSION_LIMIT };
