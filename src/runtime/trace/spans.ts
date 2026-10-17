'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveRunsLocation, normalizeRunRecord } = require('./ledger.ts');
const { SAFE_TOKEN } = require('./telemetry.ts');
const { finish } = require('./render.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

/**
 * `trace spans` (088 IC-011, FR-005, DD-5): spans projected offline from the records that already
 * exist under `<config>/state`: the run ledger (`runs/*.jsonl`), telemetry lines
 * (`runs/telemetry/*.jsonl`), 080 task-run records (`task-attempts/*.json`), orchestration records
 * (`orchestration/*.json`) and worker runs (`worker-runs/*.json`). There is no span store.
 *
 * A trace is one epoch segment of one 080 run: a `start` or `resume` history entry with a `traceId`
 * opens `[at, next resume or closing cancel)`. A record with a run identity joins the one segment
 * that holds it, or is a gap named by its locator: none holds it (`unmatched`) or more than one
 * does (`ambiguous`, e.g. one session identity under two worktrees). A segment without a trace id
 * (a run recorded before 088, or with telemetry off) holds its records as `ungrouped`, as do
 * records with no identity, grouped by `session`, else by UTC day.
 *
 * Read only: every input is read through `fsImpl` read calls, nothing is written. The output has
 * sorted keys and no wall-clock field, so the same stores give the same bytes. Attribute values are
 * identifiers or numbers only (SAFE_TOKEN), so free text, paths and commands in a record never
 * reach the output (NFR-004).
 *
 * Accepted ceiling: a history `cancel` entry does not say whether it cancelled the run or one
 * attempt. The last cancel of a segment closes it only when no pause follows it and the run was
 * resumed after it or is cancelled now; any other reading leaves the segment open to the next
 * resume, and a misread shows up as located `unmatched` gaps, never as a wrong join.
 */

const PARTITION = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const STORE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
const HEX16 = /^[0-9a-f]{16}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const WORKER_RUN_ID = /^w-[0-9a-f]{12}$/;
const RUN_KEY = /^[A-Za-z0-9._:-]+\/[A-Za-z0-9._:-]+\/[A-Za-z0-9._:-]+$/;
/** `--run`: a run key or a run id. */
const RUN_ARG = /^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9._:-]+){0,2}$/;
/** UTC only: a timestamp without `Z` would parse in the local zone and break byte equality. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const PRE_EVENTS = new Set(['PreToolUse', 'BeforeTool', 'tool_call']);
const POST_EVENTS = new Set(['PostToolUse', 'PostToolUseFailure']);
const LEDGER_ATTRS: Array<[string, string]> = [['verb', 'verb'], ['outcome', 'outcome'], ['capability', 'capability'],
  ['provider', 'provider'], ['stage', 'stage'], ['workflow', 'workflow'], ['taskClass', 'task_class'], ['exitCode', 'exit_code']];

let registryCache: any = null;
function telemetryKinds(): any {
  if (!registryCache) {
    try { registryCache = JSON.parse(nodeFs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'telemetry.json'), 'utf8')).kinds || {}; } catch { registryCache = {}; }
  }
  return registryCache;
}

const sha16 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
const str = (v: any): string | null => (typeof v === 'string' && v !== '' ? v : null);
const safe = (v: any): any => (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
  || (typeof v === 'string' && SAFE_TOKEN.test(v)) ? v : undefined);
const iso = (v: any): string | null => (typeof v === 'string' && ISO_UTC.test(v) && Number.isFinite(Date.parse(v)) ? v : null);
const msOf = (v: string | null): number | null => (v === null ? null : Date.parse(v));
const runKeyOf = (v: any): string | null => (typeof v === 'string' && RUN_KEY.test(v) ? v : null);

/** The allowlisted attributes of `source`, each an identifier or a number; anything else is left out. */
function pick(source: any, pairs: Array<[string, string]>): any {
  const out: any = {};
  for (const [from, to] of pairs) {
    const value = source && typeof source === 'object' ? safe(source[from]) : undefined;
    if (value !== undefined) out[to] = value;
  }
  return out;
}
const same = (keys: string[]): Array<[string, string]> => keys.map((k) => [k, k]);

/** A span in the making: output fields plus where it is placed and what it may parent to. */
function item(kind: string, name: any, locator: string, { start = null, end = null, durationMs = null, basis = 'recorded', attrs = {}, place = { type: 'none' }, session = null, link = {} }: any = {}): any {
  let stop = end;
  let took = durationMs;
  if (start !== null && stop !== null) took = Math.max(0, (msOf(stop) as number) - (msOf(start) as number));
  else if (start !== null && Number.isInteger(took) && took >= 0) stop = new Date((msOf(start) as number) + took).toISOString();
  else took = null;
  return { kind, name: safe(name) ?? null, locator, start, end: stop, durationMs: took, basis, attrs, place, session: safe(session) ?? null, link };
}

// ── reading ─────────────────────────────────────────────────────────────────────────────────────

function listDir(fsImpl: any, dir: string, re: RegExp): string[] {
  try { return fsImpl.readdirSync(dir).filter((name: string) => re.test(name)).sort(); } catch { return []; }
}

/** Larger than any real partition or store; a bigger file is a gap, not a read. */
const MAX_STORE_BYTES = 64 * 1024 * 1024;

/**
 * The text of a regular file, or null for anything else. A store directory is the project's, but a
 * FIFO, socket, device, directory or symlink can be planted in it, and a plain read of a FIFO with no
 * writer blocks the verb forever. So: lstat and skip what is not a regular file; open
 * O_RDONLY|O_NOFOLLOW|O_NONBLOCK so a swap after the lstat fails instead of blocking or following;
 * fstat the descriptor and check size before reading it.
 */
function readRegular(fsImpl: any, file: string): string | null {
  try {
    if (!fsImpl.lstatSync(file).isFile()) return null;
    const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = nodeFs.constants;
    const fd = fsImpl.openSync(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    try {
      const stat = fsImpl.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_STORE_BYTES) return null;
      return fsImpl.readFileSync(fd, 'utf8');
    } finally {
      fsImpl.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Each line of each partition as `{ locator, value }`, or a gap when it does not parse. */
function readLines(fsImpl: any, dir: string, rel: string, gaps: any[], kind: string): any[] {
  const out: any[] = [];
  for (const name of listDir(fsImpl, dir, PARTITION)) {
    const file = `${rel}/${name}`;
    const text = readRegular(fsImpl, path.join(dir, name));
    if (text === null) { gaps.push({ locator: file, reason: 'unparseable', kind }); continue; }
    text.split('\n').forEach((line, index) => {
      if (line.trim() === '') return;
      const locator = `${file}:${index + 1}`;
      try { out.push({ locator, value: JSON.parse(line) }); } catch { gaps.push({ locator, reason: 'unparseable', kind }); }
    });
  }
  return out;
}

/** Each JSON store file of a directory as `{ file, value }`, or a gap when it does not parse. */
function readStores(fsImpl: any, stateDir: string, rel: string, gaps: any[], kind: string): any[] {
  const out: any[] = [];
  for (const name of listDir(fsImpl, path.join(stateDir, rel), STORE_FILE)) {
    const file = `${rel}/${name}`;
    try {
      const text = readRegular(fsImpl, path.join(stateDir, rel, name));
      if (text === null) throw new Error('not a readable regular file');
      const value = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      out.push({ file, value });
    } catch { gaps.push({ locator: file, reason: 'unparseable', kind }); }
  }
  return out;
}

const objects = (v: any): Array<[string, any]> => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.entries(v).filter(([, x]) => x && typeof x === 'object' && !Array.isArray(x)) as Array<[string, any]> : []);

// ── 080 segments ────────────────────────────────────────────────────────────────────────────────

/** The run's epoch segments and one item per history entry, placed in its segment by index. */
function segmentsOf(file: string, runKey: string, run: any, items: any[]): any[] {
  const history: any[] = Array.isArray(run.history) ? run.history : [];
  const [, runId, lineage] = runKey.split('/');
  const segments: any[] = [];
  const open = (entry: any, index: number) => {
    const traceId = entry && HEX32.test(entry.traceId) ? entry.traceId : null;
    const from = entry ? iso(entry.at) : iso(run.createdAt);
    segments.push({ file, runKey, run: runId, lineage, index, traceId,
      traceLink: traceId && HEX32.test(entry.traceLink) ? entry.traceLink : null,
      epoch: entry ? (Number.isInteger(entry.epoch) ? entry.epoch : null) : 0, from, to: null as string | null, entries: [] as number[] });
  };
  history.forEach((entry, index) => {
    const opens = entry && (entry.action === 'start' || entry.action === 'resume');
    if (opens) open(entry, index);
    else if (!segments.length) open(null, -1); // records before any start: one untraced segment from createdAt
    segments[segments.length - 1].entries.push(index);
  });
  segments.forEach((seg, n) => {
    const next = segments[n + 1];
    seg.to = next ? next.from : null;
    const cancels = seg.entries.filter((i: number) => history[i]?.action === 'cancel');
    const last = cancels[cancels.length - 1];
    const pausedAfter = seg.entries.some((i: number) => i > last && history[i]?.action === 'pause');
    if (last !== undefined && !pausedAfter && (next || run.control === 'cancelled')) seg.to = iso(history[last].at) ?? seg.to;
    seg.fromMs = seg.from === null ? -Infinity : msOf(seg.from);
    seg.toMs = seg.to === null ? null : msOf(seg.to);
    for (const i of seg.entries) {
      const entry = history[i] || {};
      const start = iso(entry.at);
      const opener = i === seg.index;
      items.push(item(opener ? 'run' : 'control', entry.action, `${file}#${runKey}/${i}`, {
        start, end: opener ? seg.to : start, attrs: pick(entry, same(['action', 'epoch'])), place: { type: 'segment', seg },
      }));
    }
  });
  return segments;
}

const holds = (seg: any, t: number | null): boolean => t !== null && seg.fromMs <= t && (seg.toMs === null || t < seg.toMs);

// ── the projection ──────────────────────────────────────────────────────────────────────────────

/**
 * The spans view of the stores under `stateDir`. Pure over what it reads.
 * @param {Object} options
 * @param {string} options.stateDir `<config>/state`
 * @param {string|null} [options.run] keep the traces of this run key, else of this run id
 * @param {Object} [options.fsImpl=fs] read calls only
 * @returns {{v: 1, traces: Object[], ungrouped: Object[], gaps: Object[]}}
 */
function buildSpans({ stateDir, run = null, fsImpl = nodeFs }: any): any {
  const gaps: any[] = [];
  const items: any[] = [];
  const segments: any[] = [];
  const aliases: any[] = []; // run-scoped worker identities -> the caller's run key

  for (const { file, value } of readStores(fsImpl, stateDir, 'task-attempts', gaps, 'task-run')) {
    const runs = objects(value.runs);
    for (const [key, rec] of runs) {
      const runKey = runKeyOf(rec.runKey) === key ? key : null;
      if (runKey) segments.push(...segmentsOf(file, runKey, rec, items));
    }
    for (const [taskId, entry] of objects(value.tasks)) {
      (Array.isArray(entry.attempts) ? entry.attempts : []).forEach((a: any, n: number) => {
        if (!a || typeof a !== 'object') return;
        const runKey = runKeyOf(a.runKey);
        const token = Number.isInteger(a.token) ? a.token : n + 1;
        items.push(item('attempt', taskId, `${file}#${runKey ?? '-'}/${taskId}/${token}`, {
          start: iso(a.startedAt), end: iso(a.finishedAt) ?? iso(a.endedAt) ?? iso(a.cancel?.at),
          attrs: { ...pick(a, same(['token', 'state', 'mode', 'result', 'epoch'])), ...pick({ task: taskId }, same(['task'])) },
          place: runKey ? { type: 'attempt', file, runKey, epoch: a.epoch } : { type: 'none' },
          link: { attemptOf: { task: taskId, token: String(token) } },
        }));
      });
    }
  }

  for (const { file, value } of readStores(fsImpl, stateDir, 'worker-runs', gaps, 'worker')) {
    for (const [runId, w] of objects(value.runs)) {
      if (!WORKER_RUN_ID.test(runId)) continue;
      const start = iso(w.startedAt) ?? iso(w.createdAt);
      const callerKey = runKeyOf(w.caller?.runKey);
      const worker = item('worker', w.harness, `${file}#${runId}`, {
        start, end: iso(w.end?.at),
        attrs: { ...pick(w, same(['task', 'token', 'harness', 'phase'])), ...pick({ runId, endState: w.end?.state }, same(['runId', 'endState'])) },
        place: callerKey ? { type: 'runKey', runKey: callerKey, at: msOf(start) } : { type: 'none' },
        link: { workerOf: { task: str(w.task), token: Number.isInteger(w.token) ? String(w.token) : null } },
      });
      items.push(worker);
      const id = w.identity;
      if (callerKey && id && id.runSource === 'run-scoped' && str(id.run) && str(id.lineage)) aliases.push({ run: id.run, lineage: id.lineage, runKey: callerKey, worker });
    }
  }

  for (const { file, value } of readStores(fsImpl, stateDir, 'orchestration', gaps, 'orchestration')) {
    const runKey = runKeyOf(value.runKey);
    const history: any[] = Array.isArray(value.history) ? value.history : [];
    let stageStart = iso(value.startedAt) ?? iso(history[0]?.at);
    history.forEach((entry, i) => {
      if (!entry || typeof entry !== 'object') return;
      const at = iso(entry.at);
      const place = runKey ? { type: 'runKey', runKey, at: msOf(at) } : { type: 'none' };
      const attrs = pick(entry, same(['action', 'node', 'outcome', 'executionStatus']));
      const locator = `${file}#${runKey ?? '-'}/${i}`;
      if (entry.action === 'complete-stage') {
        items.push(item('stage', entry.node, locator, { start: stageStart, end: at, basis: 'derived', attrs, place }));
        stageStart = at;
      } else {
        items.push(item('orchestration', entry.action, locator, { start: at, end: at, attrs, place }));
      }
    });
  }

  const runsDir = path.join(stateDir, 'runs');
  for (const { locator, value } of readLines(fsImpl, runsDir, 'runs', gaps, 'ledger')) {
    const rec = normalizeRunRecord(value);
    if (!rec) { gaps.push({ locator, reason: 'unparseable', kind: 'ledger' }); continue; }
    const start = iso(rec.timestamp);
    items.push(identityItem('ledger', rec.verb, locator, value, {
      start, durationMs: rec.durationMs ?? null, attrs: pick(rec, LEDGER_ATTRS), session: rec.session,
    }));
  }
  const kinds = telemetryKinds();
  for (const { locator, value } of readLines(fsImpl, path.join(runsDir, 'telemetry'), 'runs/telemetry', gaps, 'telemetry')) {
    const kind = value && typeof value === 'object' && !Array.isArray(value) ? value.kind : null;
    if (typeof kind !== 'string' || !Object.hasOwn(kinds, kind)) { gaps.push({ locator, reason: 'unparseable', kind: 'telemetry' }); continue; }
    const fields = Object.keys(kinds[kind].fields || {});
    items.push(identityItem(kind, value.policy ?? value.tier ?? kind, locator, value, {
      start: iso(value.timestamp), durationMs: value.duration_ms ?? null, attrs: pick(value, same(fields)), session: value.session,
      link: { verifyId: HEX16.test(value.verify_id) ? value.verify_id : null, event: str(value.event), toolCall: str(value.tool_call_id) },
    }));
  }

  return assemble({ items, segments, aliases, gaps, run });
}

/** A ledger or telemetry line: placed by `(run, lineage)` when it carries both. */
function identityItem(kind: string, name: any, locator: string, raw: any, opts: any): any {
  const run = str(raw.run);
  const lineage = str(raw.lineage);
  const attempt = raw.attempt === null || raw.attempt === undefined ? null : String(raw.attempt); // telemetry uint, ledger string
  return item(kind, name, locator, {
    ...opts,
    place: run && lineage ? { type: 'identity', run, lineage, at: msOf(opts.start) } : { type: 'none' },
    link: { ...(opts.link || {}), attempt },
  });
}

/** The segments that may hold `it`: one is a join, none `unmatched`, more `ambiguous`. */
function candidates(it: any, segments: any[], aliases: any[]): any[] {
  const p = it.place;
  const found = new Set<any>();
  if (p.type === 'identity') {
    for (const seg of segments) if (seg.run === p.run && seg.lineage === p.lineage && holds(seg, p.at)) found.add(seg);
    for (const alias of aliases) {
      if (alias.run !== p.run || alias.lineage !== p.lineage) continue;
      for (const seg of segments) {
        if (seg.runKey === alias.runKey && holds(seg, p.at)) { found.add(seg); it.link.viaWorker = alias.worker; }
      }
    }
  } else if (p.type === 'runKey') {
    for (const seg of segments) if (seg.runKey === p.runKey && holds(seg, p.at)) found.add(seg);
  } else if (p.type === 'attempt') {
    for (const seg of segments) if (seg.file === p.file && seg.runKey === p.runKey && seg.epoch === p.epoch) found.add(seg);
  }
  return [...found];
}

function groupOf(it: any): string {
  if (it.session) return `session:${it.session}`;
  return `day:${it.start ? it.start.slice(0, 10) : 'undated'}`;
}

/** Placement, ids, parents and the sorted output. */
function assemble({ items, segments, aliases, gaps, run }: any): any {
  const traces = new Map<any, any[]>();
  for (const seg of segments) if (seg.traceId) traces.set(seg, []);
  const ungrouped = new Map<string, any[]>();
  const loose = (it: any) => {
    const g = groupOf(it);
    if (!ungrouped.has(g)) ungrouped.set(g, []);
    ungrouped.get(g)!.push(it);
  };
  const identityGaps: any[] = [];
  for (const it of items) {
    let target: any = null;
    if (it.place.type === 'segment') target = it.place.seg;
    else if (it.place.type !== 'none') {
      const found = candidates(it, segments, aliases);
      if (found.length !== 1) {
        const p = it.place;
        const [, keyRun, keyLineage] = p.runKey ? p.runKey.split('/') : [];
        identityGaps.push({ locator: it.locator, reason: found.length ? 'ambiguous' : 'unmatched', kind: it.kind,
          runKey: p.runKey ?? null, run: p.run ?? keyRun ?? null, lineage: p.lineage ?? keyLineage ?? null });
        continue;
      }
      target = found[0];
    }
    if (target && target.traceId) traces.get(target)!.push(it);
    else loose(it);
  }

  const out = (list: any[], base: string, root: any) => {
    for (const it of list) it.spanId = sha16(base + it.locator);
    link(list, root);
    return list.sort(byStart).map((it) => ({
      spanId: it.spanId, parentSpanId: it.parentSpanId, kind: it.kind, name: it.name, start: it.start, end: it.end,
      durationMs: it.durationMs, basis: it.basis, locator: it.locator, attrs: it.attrs,
    }));
  };
  let traceList = [...traces.entries()].map(([seg, list]) => {
    const root = list.find((it) => it.kind === 'run' && it.locator === `${seg.file}#${seg.runKey}/${seg.index}`) || null;
    return { traceId: seg.traceId, traceLink: seg.traceLink, runKey: seg.runKey, epoch: seg.epoch, window: { from: seg.from, to: seg.to },
      spans: out(list, seg.traceId, root), fromMs: seg.fromMs };
  }).sort((a, b) => a.fromMs - b.fromMs || cmp(a.traceId, b.traceId) || cmp(a.runKey, b.runKey))
    .map(({ fromMs, ...trace }) => trace);
  let groupList = [...ungrouped.entries()].sort(([a], [b]) => cmp(a, b))
    .map(([group, list]) => ({ group, label: 'ungrouped', spans: out(list, group, null) }));
  let gapList = [...gaps.map((g: any) => ({ ...g, runKey: null, run: null, lineage: null })), ...identityGaps];

  if (run !== null && run !== undefined) {
    const byKey = traceList.some((tr) => tr.runKey === run);
    const identity = byKey ? run.split('/').slice(1).join('/') : null;
    traceList = traceList.filter((tr) => (byKey ? tr.runKey === run : tr.runKey.split('/')[1] === run));
    groupList = [];
    gapList = gapList.filter((g) => g.reason === 'unparseable'
      || (byKey ? g.runKey === run || `${g.run}/${g.lineage}` === identity : g.run === run));
  }
  gapList = gapList.map(({ locator, reason, kind }) => ({ locator, reason, kind }))
    .sort((a, b) => cmp(a.locator, b.locator) || cmp(a.reason, b.reason));
  return { v: 1, traces: traceList, ungrouped: groupList, gaps: gapList };
}

const cmp = (a: any, b: any): number => (a < b ? -1 : a > b ? 1 : 0);
function byStart(a: any, b: any): number {
  const x = a.start === null ? Infinity : msOf(a.start) as number;
  const y = b.start === null ? Infinity : msOf(b.start) as number;
  return x - y || cmp(a.spanId, b.spanId);
}

/** Parents inside one trace or group, and pre/post hook pairs folded into `test` spans (IC-005). */
function link(list: any[], root: any): void {
  const verifyRuns = new Map<string, any>();
  for (const it of list) if (it.kind === 'verify.run' && it.link.verifyId) verifyRuns.set(it.link.verifyId, it);
  const attempts = list.filter((it) => it.kind === 'attempt');
  const within = (a: any, it: any) => {
    const t = msOf(it.start);
    return t !== null && a.start !== null && (msOf(a.start) as number) <= t && (a.end === null || t <= (msOf(a.end) as number));
  };
  // Pairing first, by time, so a post line meets the latest pre line before it.
  const pre = new Map<string, any>();
  for (const it of [...list].sort(byStart)) {
    if (it.kind !== 'hook' || !it.session || !it.link.toolCall) continue;
    const key = `${it.session}\n${it.link.toolCall}`;
    if (PRE_EVENTS.has(it.link.event)) pre.set(key, it);
    else if (POST_EVENTS.has(it.link.event) && pre.has(key)) {
      const opener = pre.get(key);
      pre.delete(key);
      const end = it.start;
      it.kind = 'test';
      it.name = 'test';
      it.start = opener.start;
      it.end = end;
      it.durationMs = Math.max(0, (msOf(end) as number) - (msOf(opener.start) as number));
      it.basis = 'derived';
      it.attrs = { ...it.attrs, status: it.link.event === 'PostToolUseFailure' ? 'fail' : 'pass' };
    }
  }
  for (const it of list) {
    let parent: any = null;
    if ((it.kind === 'verify.tier' || it.kind === 'verify.check') && verifyRuns.has(it.link.verifyId)) parent = verifyRuns.get(it.link.verifyId);
    else if (it.link.viaWorker && list.includes(it.link.viaWorker)) parent = it.link.viaWorker;
    else if (it.link.attempt !== undefined && it.link.attempt !== null) {
      const hits = attempts.filter((a) => a.link.attemptOf.token === it.link.attempt && within(a, it));
      if (hits.length === 1) parent = hits[0];
    } else if (it.link.workerOf) {
      const hits = attempts.filter((a) => a.link.attemptOf.task === it.link.workerOf.task && a.link.attemptOf.token === it.link.workerOf.token);
      if (hits.length === 1) parent = hits[0];
    }
    if (!parent && root && it !== root) parent = root;
    it.parentSpanId = parent && parent !== it ? parent.spanId : null;
  }
}

// ── the verb ────────────────────────────────────────────────────────────────────────────────────

/**
 * The spans view for a project, resolving `<config>` the way the ledger views do.
 * @param {Object} options
 * @param {string} [options.projectRoot] where to walk up from for `.doflow` (default: cwd)
 * @param {string|null} [options.run]
 * @param {boolean} [options.global=false]
 * @param {Object} [options.env=process.env]
 * @param {Object} [options.fsImpl=fs]
 * @param {string} [options.homeDir]
 */
function projectSpans({ projectRoot, run = null, global = false, env = process.env, fsImpl = nodeFs, homeDir }: any = {}): any {
  const location = resolveRunsLocation({ start: projectRoot, global, env, fsImpl, ...(homeDir ? { homeDir } : {}) });
  return buildSpans({ stateDir: path.dirname(location.dir), run, fsImpl });
}

/** Object keys sorted at every level, so the JSON form is the same bytes for the same stores. */
function sorted(value: any): any {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sorted(value[k])]));
  return value;
}

/**
 * `doflow trace spans [--run <runKey|run>] [--json] [<project>]`. Exit 0 answered, 2 usage.
 * @param {Object} options
 * @param {string[]} [options.positional] the arguments after `spans`: at most the project root
 */
function handleTraceSpans({ positional = [], run, json = false, global = false, env = process.env, fsImpl = nodeFs }: any = {}): number {
  const usage = (detail: string) => {
    if (json) console.log(JSON.stringify({ error: 'usage', detail }));
    else console.error(`doflow trace spans: ${detail}`);
    return finish(2);
  };
  if (positional.length > 1) return usage('usage: trace spans [--run <runKey|run>] [--json] [<project>]');
  if (run !== undefined && run !== null && (typeof run !== 'string' || !RUN_ARG.test(run))) return usage('--run expects a run key (<hash>/<run>/<lineage>) or a run id');
  const view = projectSpans({ projectRoot: global ? undefined : path.resolve(positional[0] || '.'), run: run ?? null, global, env, fsImpl });
  if (json) {
    console.log(JSON.stringify(sorted(view), null, 2));
    return finish(0);
  }
  for (const tr of view.traces) {
    console.log(`trace ${tr.traceId} ${tr.runKey} epoch ${tr.epoch} ${tr.window.from} .. ${tr.window.to ?? 'open'} spans ${tr.spans.length}${tr.traceLink ? ` link ${tr.traceLink}` : ''}`);
  }
  console.log(`ungrouped: ${view.ungrouped.length} group(s), ${view.ungrouped.reduce((n: number, g: any) => n + g.spans.length, 0)} span(s)`);
  const count = (reason: string) => view.gaps.filter((g: any) => g.reason === reason).length;
  console.log(`gaps: ${view.gaps.length} (unmatched ${count('unmatched')}, ambiguous ${count('ambiguous')}, unparseable ${count('unparseable')})`);
  return finish(0);
}

module.exports = { buildSpans, projectSpans, handleTraceSpans };
