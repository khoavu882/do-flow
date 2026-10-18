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
 * (`orchestration/*.json`), worker runs (`worker-runs/*.json`) and 082 dispatch stores
 * (`dispatch/*.json`, read only for when a run ended). There is no span store.
 *
 * A trace is one epoch segment of one 080 run: a `start` or `resume` history entry with a `traceId`
 * opens `[at, next resume or closing cancel)`. The 080 store is per slug (`task-attempts/<slug>.json`)
 * and its run key is per session, so one session working on two slugs has two segments under one
 * run key; each segment carries its slug, the file stem (110). The 080 record itself has no
 * completion marker, so a segment also closes, inclusive, at the latest end among the activities it
 * owns that started inside it, once every one of them has ended: an orchestration run ends at its
 * last entry after `complete-run` or a `reject` gate decision; a dispatch run at `completedAt` when
 * `completed`, `endedAt` when `cancelled` (`blocked`, `resume-required` and `cancelling` can still
 * move on). A dispatch run owns the segments of its `run.slug`; an orchestration run those of its
 * `traceId`, else of its `featureSlug`; a record with neither, or a slug that owns no segment of the
 * run key, owns every segment of its `runKey` as before 110. A dispatch record whose `run`/`lineage`
 * disagree with its `runKey`, or with no end stamp, closes nothing.
 *
 * A worker run joins through its slug: `(slug, task, token)` -> that slug's attempt -> the attempt's
 * segment, else the segment of its slug and caller run key that holds its start. A record with a run
 * identity joins the one segment that holds it, or is a gap named by its locator: none holds it
 * (`unmatched`) or more than one does (`ambiguous`, e.g. one session identity under two worktrees).
 * Ids beat windows (110 F3): a hook line's `worker_run` follows that worker, a verify.run's
 * `dispatch_run` goes to that dispatch run's segment that holds it (T1). A line that more than one
 * segment holds joins one of them only through the single activity it fits, labelled
 * `attrs.join: "activity"` (T2): a hook line with an attempt fits the one worker whose identity and
 * lifetime match and that every hook line of its session resolves to; a `source: dispatch`
 * verify.run fits the one dispatch run of its identity whose window holds it, and whose task or slug
 * is the line's task when it names one. A line T2 cannot settle stays `ambiguous`, and a line one
 * segment holds joins it unlabelled, as before 110 (T3).
 * A line stamped to the whole second (doflow-run's ledger lines) is compared at that resolution:
 * the segment start is floored to its second, so the `dispatch start` line of the run's own start
 * second joins, and a second shared by two segments makes it `ambiguous`. A segment without a trace id
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
 * resume, and a misread shows up as located `unmatched` gaps, never as a wrong join. An activity
 * that began before a resume counts for the segment it began in only.
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
/** A timestamp with no fraction: true only to the whole second. */
const WHOLE_SECOND = /:\d{2}Z$/;
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
/** A store file's slug: `task-attempts/<slug>.json` -> `<slug>`. */
const stemOf = (file: string): string => path.basename(file, '.json');

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
    segments.push({ file, slug: stemOf(file), runKey, run: runId, lineage, index, traceId,
      traceLink: traceId && HEX32.test(entry.traceLink) ? entry.traceLink : null,
      epoch: entry ? (Number.isInteger(entry.epoch) ? entry.epoch : null) : 0, from, to: null as string | null, closeMs: null as number | null, opener: null as any, entries: [] as number[] });
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
      const it = item(opener ? 'run' : 'control', entry.action, `${file}#${runKey}/${i}`, {
        start, end: opener ? seg.to : start, attrs: pick(entry, same(['action', 'epoch'])), place: { type: 'segment', seg },
      });
      if (opener) seg.opener = it;
      items.push(it);
    }
  });
  return segments;
}

/** Whether `seg` holds `t`; `coarse` (a whole-second stamp) compares against the start's second. */
const holds = (seg: any, t: number | null, coarse = false): boolean => t !== null
  && (coarse ? Math.floor(seg.fromMs / 1000) * 1000 : seg.fromMs) <= t
  && (seg.toMs === null || t < seg.toMs) && (seg.closeMs === null || t <= seg.closeMs);

/**
 * The segments of `runKey` that a record owned by `traceId`, else by `slug`, belongs to (110 F2).
 * A trace id names its segment only. A slug that owns no segment of that run key (a store whose
 * slug names no 080 record there) and a record with neither keep every segment of the run key, as
 * before 110.
 */
function owned(segments: any[], runKey: string, { traceId = null, slug = null }: { traceId?: string | null; slug?: string | null } = {}): any[] {
  const keyed = segments.filter((seg) => seg.runKey === runKey);
  if (traceId) return keyed.filter((seg) => seg.traceId === traceId);
  const mine = slug ? keyed.filter((seg) => seg.slug === slug) : [];
  return mine.length ? mine : keyed;
}

/**
 * Closes each segment whose activities (the orchestration and dispatch runs it owns, started
 * inside it) have all ended, at the latest end among them, when that is inside the segment. One
 * activity still going keeps it open.
 * @param {Object[]} segments
 * @param {Array<{runKey: string, traceId: string|null, slug: string|null, startMs: number|null, ended: boolean, last: string|null}>} runs
 */
function closeEnded(segments: any[], runs: any[]): void {
  const scope = new Map(runs.map((o) => [o, new Set(owned(segments, o.runKey, o))]));
  for (const seg of segments) {
    const mine = runs.filter((o) => scope.get(o)!.has(seg) && holds(seg, o.startMs));
    if (!mine.length || !mine.every((o) => o.ended && o.last !== null)) continue;
    const last = mine.map((o) => o.last).sort((a, b) => (msOf(a) as number) - (msOf(b) as number)).pop();
    const lastMs = msOf(last) as number;
    if (lastMs < seg.fromMs || (seg.toMs !== null && lastMs >= seg.toMs)) continue;
    seg.closeMs = lastMs;
    seg.to = last;
    if (seg.opener) {
      seg.opener.end = last;
      seg.opener.durationMs = seg.opener.start === null ? null : Math.max(0, lastMs - (msOf(seg.opener.start) as number));
    }
  }
}

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
  const attemptOf = new Map<string, any>(); // `${slug}\n${task}\n${token}` -> the attempt's placement
  const workers: any[] = []; // each worker run with the identity and lifetime its hook lines match
  const dispatchRuns: any[] = []; // each 082 dispatch run tied to its run key

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
        const place = runKey ? { type: 'attempt', file, runKey, epoch: a.epoch } : { type: 'none' };
        if (runKey) attemptOf.set(`${stemOf(file)}\n${taskId}\n${token}`, place);
        items.push(item('attempt', taskId, `${file}#${runKey ?? '-'}/${taskId}/${token}`, {
          start: iso(a.startedAt), end: iso(a.finishedAt) ?? iso(a.endedAt) ?? iso(a.cancel?.at),
          attrs: { ...pick(a, same(['token', 'state', 'mode', 'result', 'epoch'])), ...pick({ task: taskId }, same(['task'])) },
          place,
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
      const end = iso(w.end?.at);
      const token = Number.isInteger(w.token) ? String(w.token) : null;
      const worker = item('worker', w.harness, `${file}#${runId}`, {
        start, end,
        attrs: { ...pick(w, same(['task', 'token', 'harness', 'phase'])), ...pick({ runId, endState: w.end?.state }, same(['runId', 'endState'])) },
        place: callerKey ? { type: 'worker', slug: stemOf(file), task: str(w.task), token, runKey: callerKey, at: msOf(start) } : { type: 'none' },
        link: { workerOf: { task: str(w.task), token } },
      });
      items.push(worker);
      const id = w.identity;
      workers.push({ item: worker, runId, run: str(id?.run), lineage: str(id?.lineage),
        attempt: id?.attempt === null || id?.attempt === undefined ? null : String(id.attempt), startMs: msOf(start), endMs: msOf(end) });
      if (callerKey && id && id.runSource === 'run-scoped' && str(id.run) && str(id.lineage)) aliases.push({ run: id.run, lineage: id.lineage, runKey: callerKey, worker });
    }
  }

  const activities: any[] = [];
  for (const { file, value } of readStores(fsImpl, stateDir, 'orchestration', gaps, 'orchestration')) {
    const runKey = runKeyOf(value.runKey);
    const history: any[] = Array.isArray(value.history) ? value.history : [];
    let stageStart = iso(value.startedAt) ?? iso(history[0]?.at);
    const ended = history.some((e) => e && (e.action === 'complete-run' || (e.action === 'decide-gate' && e.detail === 'reject')));
    const stamps = history.map((e) => (e && typeof e === 'object' ? iso(e.at) : null)).filter((a): a is string => a !== null);
    const last = stamps.sort((a, b) => (msOf(a) as number) - (msOf(b) as number)).pop() ?? null;
    if (runKey) {
      activities.push({ runKey, traceId: HEX32.test(value.traceId) ? value.traceId : null, slug: str(value.featureSlug), startMs: msOf(stageStart), ended, last });
    }
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

  for (const { file, value } of readStores(fsImpl, stateDir, 'dispatch', gaps, 'dispatch')) {
    const d = value.run && typeof value.run === 'object' ? value.run : null;
    const runKey = d ? runKeyOf(d.runKey) : null;
    if (!runKey) continue;
    const [, keyRun, keyLineage] = runKey.split('/');
    if ((d.run != null && d.run !== keyRun) || (d.lineage != null && d.lineage !== keyLineage)) continue; // not tied: no closer, no join
    const slug = str(d.slug) ?? stemOf(file);
    const startMs = msOf(iso(d.createdAt));
    const last = d.state === 'completed' ? iso(d.completedAt) : d.state === 'cancelled' ? iso(d.endedAt) : null;
    activities.push({ runKey, traceId: null, slug, startMs, ended: last !== null, last });
    const tasks = new Set(objects(value.dispatches).map(([, x]) => str(x.task)).filter((x) => x !== null));
    dispatchRuns.push({ id: str(d.dispatchRunId), slug, runKey, run: keyRun, lineage: keyLineage, startMs,
      endMs: msOf(iso(d.completedAt) ?? iso(d.endedAt)), tasks });
  }
  closeEnded(segments, activities);

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

  return assemble({ items, gaps, run, ctx: { segments, aliases, attemptOf, workers, dispatchRuns } });
}

/**
 * A ledger or telemetry line: placed by `(run, lineage)` when it carries both. The scope ids it
 * carries (110: hook `worker_run`, `role`, `session`; verify.run `dispatch_run`, `source`, `task`)
 * are kept for placement only, read defensively: absent is null.
 */
function identityItem(kind: string, name: any, locator: string, raw: any, opts: any): any {
  const run = str(raw.run);
  const lineage = str(raw.lineage);
  const attempt = raw.attempt === null || raw.attempt === undefined ? null : String(raw.attempt); // telemetry uint, ledger string
  const workerRun = typeof raw.worker_run === 'string' && WORKER_RUN_ID.test(raw.worker_run) ? raw.worker_run : null;
  return item(kind, name, locator, {
    ...opts,
    place: run && lineage ? { type: 'identity', run, lineage, at: msOf(opts.start) } : { type: 'none' },
    link: { ...(opts.link || {}), attempt,
      scope: { workerRun, dispatchRun: str(raw.dispatch_run), role: str(raw.role), session: str(raw.session), source: str(raw.source), task: str(raw.task) } },
  });
}

/** The segments that may hold `it`: one is a join, none `unmatched`, more `ambiguous`. */
function candidates(it: any, ctx: any): any[] {
  const { segments, aliases, attemptOf } = ctx;
  const p = it.place;
  const coarse = typeof it.start === 'string' && WHOLE_SECOND.test(it.start);
  const found = new Set<any>();
  const byAttempt = (a: any) => {
    for (const seg of segments) if (seg.file === a.file && seg.runKey === a.runKey && seg.epoch === a.epoch) found.add(seg);
  };
  if (p.type === 'identity') {
    const tiered = tiers(it, ctx, coarse);
    if (tiered) return tiered;
    for (const seg of segments) if (seg.run === p.run && seg.lineage === p.lineage && holds(seg, p.at, coarse)) found.add(seg);
    for (const alias of aliases) {
      if (alias.run !== p.run || alias.lineage !== p.lineage) continue;
      for (const seg of segments) {
        if (seg.runKey === alias.runKey && holds(seg, p.at, coarse)) { found.add(seg); it.link.viaWorker = alias.worker; }
      }
    }
    if (found.size > 1) return activity(it, ctx, [...found]);
  } else if (p.type === 'worker') {
    // F1: (slug, task, token) -> that slug's attempt -> its segment; else run key + window, same slug only.
    const a = p.task !== null && p.token !== null ? attemptOf.get(`${p.slug}\n${p.task}\n${p.token}`) : undefined;
    if (a) byAttempt(a);
    if (!found.size) for (const seg of segments) if (seg.slug === p.slug && seg.runKey === p.runKey && holds(seg, p.at, coarse)) found.add(seg);
  } else if (p.type === 'runKey') {
    for (const seg of segments) if (seg.runKey === p.runKey && holds(seg, p.at, coarse)) found.add(seg);
  } else if (p.type === 'attempt') {
    byAttempt(p);
  }
  return [...found];
}

/** Where a worker run is placed, computed once: hook lines that name or match it follow it. */
function placeOf(worker: any, ctx: any): any[] {
  if (!ctx.placed.has(worker)) ctx.placed.set(worker, worker.place.type === 'none' ? [] : candidates(worker, ctx));
  return ctx.placed.get(worker);
}

/** The segments of dispatch run `d` (its slug's, 110 F2) that hold `t`. */
const dispatchSegments = (d: any, t: number | null, coarse: boolean, ctx: any): any[] => owned(ctx.segments, d.runKey, { slug: d.slug }).filter((seg) => holds(seg, t, coarse));

/**
 * T1 (110 F3): an id the line carries beats any window. A hook's `worker_run` follows that worker to
 * its segment and parents to it; a verify.run's `dispatch_run` goes to the segment of that dispatch
 * run's slug that holds the line. An id that names no record read here leaves the line to T2/T3.
 */
function tiers(it: any, ctx: any, coarse: boolean): any[] | null {
  const s = it.link.scope;
  if (it.kind === 'hook' && s.workerRun) {
    const named = ctx.workers.filter((w: any) => w.runId === s.workerRun);
    if (named.length === 1) it.link.viaWorker = named[0].item;
    if (named.length) return [...new Set(named.flatMap((w: any) => placeOf(w.item, ctx)))];
  }
  if (it.kind === 'verify.run' && s.dispatchRun) {
    const named = ctx.dispatchRuns.filter((d: any) => d.id === s.dispatchRun);
    if (named.length) return [...new Set(named.flatMap((d: any) => dispatchSegments(d, it.place.at, coarse, ctx)))];
  }
  return null;
}

/**
 * T2 (110 F3), for a line T3 finds in more than one segment: it joins the one candidate of the
 * single activity it fits, labelled `join: activity` because the fit is inferred. A hook line with
 * an attempt (role worker or absent) fits the one worker whose identity and lifetime match it, and
 * only when every hook line of its session resolves to that same worker. A `source: dispatch`
 * verify.run fits the one dispatch run of its identity whose window holds it and, when it names a
 * task, has that task or slug. Anything else stays with its candidates (`ambiguous`).
 */
function activity(it: any, ctx: any, found: any[]): any[] {
  const s = it.link.scope;
  const coarse = typeof it.start === 'string' && WHOLE_SECOND.test(it.start);
  let segs: any[] = [];
  let via: any = null;
  if (it.kind === 'hook') {
    const w = s.resolved;
    if (!w || (s.session !== null && ctx.sessions.get(s.session) !== w)) return found;
    segs = placeOf(w.item, ctx);
    via = w.item;
  } else if (it.kind === 'verify.run' && s.source === 'dispatch') {
    const p = it.place;
    const fits = ctx.dispatchRuns.filter((d: any) => d.run === p.run && d.lineage === p.lineage && p.at !== null && d.startMs !== null
      && d.startMs <= p.at && (d.endMs === null || p.at <= d.endMs) && (s.task === null || d.tasks.has(s.task) || d.slug === s.task));
    if (fits.length !== 1) return found;
    segs = dispatchSegments(fits[0], p.at, coarse, ctx);
  } else return found;
  const pick = segs.filter((seg) => found.includes(seg));
  if (pick.length !== 1) return found;
  if (via) it.link.viaWorker = via;
  it.attrs = { ...it.attrs, join: 'activity' };
  return pick;
}

/**
 * The one worker each hook line resolves to (by its `worker_run`, else as the single worker whose
 * identity `{run, lineage, attempt}` and lifetime `[start, end.at]` hold it), and per session the
 * worker all its hook lines share, or null when any line resolves to none or to another worker.
 */
function resolveSessions(items: any[], ctx: any): void {
  ctx.sessions = new Map<string, any>();
  for (const it of items) {
    if (it.kind !== 'hook' || !it.link.scope) continue;
    const s = it.link.scope;
    const p = it.place;
    const t = msOf(it.start);
    let hits: any[] = s.workerRun ? ctx.workers.filter((w: any) => w.runId === s.workerRun) : [];
    if (!hits.length && p.type === 'identity' && it.link.attempt !== null && (s.role === null || s.role === 'worker') && t !== null) {
      hits = ctx.workers.filter((w: any) => w.run === p.run && w.lineage === p.lineage && w.attempt === it.link.attempt
        && w.startMs !== null && w.startMs <= t && (w.endMs === null || t <= w.endMs));
    }
    s.resolved = hits.length === 1 ? hits[0] : null;
    if (s.session === null) continue;
    const prior = ctx.sessions.has(s.session) ? ctx.sessions.get(s.session) : s.resolved;
    ctx.sessions.set(s.session, prior === s.resolved ? prior : null);
  }
}

function groupOf(it: any): string {
  if (it.session) return `session:${it.session}`;
  return `day:${it.start ? it.start.slice(0, 10) : 'undated'}`;
}

/** Placement, ids, parents and the sorted output. */
function assemble({ items, gaps, run, ctx }: any): any {
  const { segments } = ctx;
  ctx.placed = new Map<any, any[]>();
  resolveSessions(items, ctx);
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
      const found = it.kind === 'worker' ? placeOf(it, ctx) : candidates(it, ctx);
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
