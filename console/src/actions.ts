'use strict';

// The Console's action routes (feature 162, IC-001, IC-002, IC-007, IC-009; D1, D5, D6, D11, D12, D13, D14). A
// person's decision is relayed to exactly one frozen argv shape (verb-runner.ts WRITE_SHAPES, through `runner.act`
// only); nothing a device cannot do reaches the runner; every attempt is logged (action-log.ts): one `begin` and one `end`
// line for an attempt that reaches the core, one aggregated `summary` line per code and actor a minute for one that does
// not; a log that cannot be written refuses the action.
//
// One route per ACTIONS row, `POST /api/actions/<id>` (D1), declared `action: true`, behind the wrappers of
// routes.ts. In order, an attempt is checked for:
//   1. the credential (the wrappers: 401, counted on the log's aggregated `unauthenticated` line per address);
//   2. the scope (LAN, the wrapper: `deviceMayUse`, else 403 phone-scope);
//   3. the transport (LAN: `deviceMayAct`, a `control` record paired natively over the native class, else 403
//      action-transport; loopback: the `local` session acts, behind server.ts's non-GET checks, D5);
//   4. the body (4 KiB, one JSON object with exactly the row's keys plus `v`, `requestId` and `projectKey`; the
//      text rule of IC-009; else 400 usage);
//   5. idempotency (D12: `(actor, requestId)` for 10 min, 256 entries, least recently used out; a duplicate awaits
//      or replays the first answer, `replayed: true`, uncounted; another body under the same id is 409
//      request-reused);
//   6. the limits (D11: per actor 6 a minute and 30 an hour, per Console 20 a minute; 429 action-rate-limited with
//      `Retry-After` in whole seconds until the oldest counted attempt leaves its window; counted on the log's
//      aggregated `rate-limited` line per actor);
//   7. the queue (one attempt in flight, four waiting, FIFO; else 429 action-busy, `Retry-After: 2`).
// A refusal at 2 to 5 counts against the actor's own windows (never the Console's, so one actor's refusals cannot
// block another's actions) and, once they are full, is 429 action-rate-limited instead (162 review 1). Every refusal
// at 2 to 7 is counted on the log's aggregated `summary` line for its code and actor, so a flood adds at most a few
// lines a minute and never rotates the `begin` and `end` lines of attempts that ran out of the log.
// Then `begin` is logged (fail closed: a line that cannot be written is 503 action-log-unwritable and nothing
// runs), `runner.act` runs the shape in the project named by `projectKey` (D14; an unknown key refreshes the
// runner's `projects` map once, past its cache but under its 5 s floor, and tries again before 404 project-not-found), and `end` is logged with the
// outcome (a failed `end` is said on stderr at most once a minute). The reply is a closed projection of the core's
// JSON (IC-002), or the IC-005 error body, with `current` on a refusal by state.
//
// The relay label is the actor's, never the body's: `console` for the loopback session, `device.d-<12 hex>` for a
// device (DEC-007). Free text (`note`, `reason`) is normalized here, passed as one argv element, and logged only as
// its length. `GET /api/actions` (D13) says, for the asking session, which actions it may take and why not; an
// action that answered 501 core-lacks-action is remembered as lacking until the Console restarts.
//
// Ceilings: the limits, the idempotency memo and the lacking set are in memory and die with the process; the
// queue holds one Console's writes (two Consoles on one machine queue separately; the core's lock and revision
// check order them). The idempotency key uses the insertion time for its 10 minutes.

const crypto = require('node:crypto');
const { errorReply, jsonReply, readBody } = require('./routes.ts');
const { ACTION_IDS, deviceMayAct } = require('./scopes.ts');
const { ID_MAX, PATTERNS } = require('./verb-runner.ts');
const { project: projectBody } = require('./project.ts');

type Reply = { status: number, headers?: Record<string, string>, body?: string | Uint8Array };
type Body = Record<string, any>;
type Kind = 'id' | 'slugOpt' | 'runId' | 'decision' | 'revision' | 'text';
type FieldRule = Readonly<{ kind: Kind, required: boolean }>;
type Current = Record<string, unknown> | null;
/**
 * What an attempt came to: the reply's status and code (null when applied), the log's outcome, the core's exit; `current`
 * only on a refusal by state (it may be null there), `ran` false when nothing was spawned.
 */
type Answer = { status: number, code: string | null, outcome: 'applied' | 'refused' | 'failed' | 'unknown', exit: number | null,
  verb: string | null, current?: Current, result?: Record<string, unknown>, ran: boolean };
type ActionSpec = Readonly<{
  id: string,
  shape: string,
  fields: Readonly<Record<string, FieldRule>>,
  textField: 'note' | 'reason' | null,
  target(b: Body): { slug: string | null, taskId: string | null, gateId: string | null, runId: string | null },
  expect(b: Body): { revision: number } | null,
  params(b: Body, relay: string): Record<string, string>,
  outcome(result: any, b: Body): Answer,
}>;
type Actor = { kind: 'local', key: 'local', relay: 'console' }
  | { kind: 'device', key: string, relay: string, deviceId: string, scope: string, session: any };

const BODY_CAP = 4096;
const TEXT_MAX = 500;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const LIMITS = Object.freeze({ actor: Object.freeze({ perMinute: 6, perHour: 30 }), console: Object.freeze({ perMinute: 20 }) });
const WAITING_MAX = 4;
const BUSY_RETRY_S = 2;
const MEMO_ENTRIES = 256;
const MEMO_MS = 10 * MINUTE_MS;
const FLUSH_EVERY_MS = MINUTE_MS;
const WARN_EVERY_MS = MINUTE_MS;
const REQUEST_ID = /^[A-Za-z0-9_-]{22}$/;
const DEVICE_ID = /^d-[0-9a-f]{12}$/;
/** IC-009: removed after NFC and the whitespace rule: C0, DEL and C1, zero-width and bidi controls, the BOM. */
const REMOVED = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const RUN_STATE = /^[A-Z][A-Z_]{0,31}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const NAME_MAX = 200;

/**
 * IC-009: NFC; `\r`, `\n` and `\t` become a space; the REMOVED characters go; runs of spaces collapse; trimmed. Null
 * for a string with a lone surrogate (it has no UTF-8 form to pass as argv).
 */
function normalizeText(raw: string): string | null {
  if (LONE_SURROGATE.test(raw)) return null;
  return raw.normalize('NFC').replace(/[\r\n\t]/g, ' ').replace(REMOVED, '').replace(/ {2,}/g, ' ').trim();
}

const codePoints = (text: string) => [...text].length;
const isId = (value: unknown): value is string => typeof value === 'string' && PATTERNS.id.test(value) && !value.includes('..');
/** 162 review 9: an id a body may name, at most ID_MAX characters, the bound the action log records in full. */
const isTarget = (value: unknown): value is string => isId(value) && value.length <= ID_MAX;
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** One field's value as the row takes it, or undefined when the rule refuses it. */
function field(rule: FieldRule, value: unknown): unknown {
  switch (rule.kind) {
    case 'id': return isTarget(value) ? value : undefined;
    case 'slugOpt': return value === null || isTarget(value) ? value : undefined;
    case 'runId': return typeof value === 'string' && PATTERNS.runId.test(value) ? value : undefined;
    case 'decision': return typeof value === 'string' && PATTERNS.decision.test(value) ? value : undefined;
    case 'revision': return object(value) && Object.keys(value).join() === 'revision' && Number.isSafeInteger(value.revision)
      && PATTERNS.revision.test(String(value.revision)) ? { revision: value.revision } : undefined;
    case 'text': {
      if (value === null && !rule.required) return '';
      if (typeof value !== 'string') return undefined;
      const text = normalizeText(value);
      if (text === null) return undefined;
      const length = codePoints(text);
      return length <= TEXT_MAX && (length >= 1 || !rule.required) ? text : undefined;
    }
    default: return undefined;
  }
}

/** IC-002: the body of `spec` from `text`, normalized (text fields as IC-009 makes them, a null optional text as ''), or null. */
function parseBody(spec: ActionSpec, text: string | null): Body | null {
  let raw: unknown;
  try {
    raw = text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
  if (!object(raw)) return null;
  const keys = ['v', 'requestId', 'projectKey', ...Object.keys(spec.fields)];
  if (Object.keys(raw).sort().join() !== [...keys].sort().join()) return null;
  if (raw.v !== 1 || typeof raw.requestId !== 'string' || !REQUEST_ID.test(raw.requestId)
    || typeof raw.projectKey !== 'string' || !PATTERNS.key16.test(raw.projectKey)) return null;
  const body: Body = { v: 1, requestId: raw.requestId, projectKey: raw.projectKey };
  for (const [name, rule] of Object.entries(spec.fields)) {
    const value = field(rule, raw[name]);
    if (value === undefined) return null;
    body[name] = value;
  }
  return body;
}

/** The digest of a body as parsed (keys sorted), with the action id, so another action under the same id differs. */
function digestOf(action: string, body: Body): string {
  const canonical = JSON.stringify([action, Object.keys(body).sort().map((key) => [key, body[key]])]);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ---- IC-002 replies: the core's answer, projected ----

const answer = (status: number, code: string | null, outcome: Answer['outcome'], exit: number | null, verb: string | null, extra: Partial<Answer> = {}): Answer =>
  ({ status, code, outcome, exit, verb, ran: true, ...extra });
/** A body the contract cannot project: 502 core-contract-mismatch. An exit 0 still applied (the core said so); an exit 1 refused. */
const mismatch = (shape: string, exit: number): Answer => answer(502, 'core-contract-mismatch', exit === 0 ? 'applied' : 'refused', exit, shape);

/** `current` for a run: `{state, revision, awaitingGate}` from the core's snapshot, null for none, undefined when it does not project. */
function runCurrent(snapshot: unknown): Current | undefined {
  if (snapshot === null) return null;
  if (!object(snapshot) || typeof snapshot.state !== 'string' || !RUN_STATE.test(snapshot.state)
    || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) return undefined;
  const gate = snapshot.awaitingGate;
  if (gate !== null && !(object(gate) && isId(gate.gateId) && typeof gate.name === 'string' && gate.name.length <= NAME_MAX)) return undefined;
  return { state: snapshot.state, revision: snapshot.revision, awaitingGate: gate === null ? null : { gateId: gate.gateId, name: gate.name } };
}

/** IC-002 `result` for a run, or null when the snapshot does not project. `featureSlug` is the core's when it says one, else the body's. */
function runResult(snapshot: unknown, slug: string | null): Record<string, unknown> | null {
  const current = runCurrent(snapshot);
  if (!current || !object(snapshot) || !isId(snapshot.taskId)) return null;
  const node = snapshot.current;
  if (node !== null && !(object(node) && isId(node.type) && isId(node.id))) return null;
  const featureSlug = Object.hasOwn(snapshot, 'featureSlug') ? snapshot.featureSlug : slug;
  if (featureSlug !== null && !isId(featureSlug)) return null;
  return { taskId: snapshot.taskId, featureSlug, state: current.state, revision: current.revision, awaitingGate: current.awaitingGate,
    current: node === null ? null : { type: node.type, id: node.id } };
}

/** IC-002: the core's refusal ids of decide-gate and close, and what each is to the caller. */
const RUN_REFUSALS: Readonly<Record<string, readonly [number, string, boolean]>> = Object.freeze({
  'no-run': [404, 'run-not-found', false],
  'stale-revision': [409, 'stale', true],
  'not-awaiting-gate': [409, 'stale', true],
  'gate-mismatch': [409, 'stale', true],
  'run-terminal': [409, 'stale', true],
  'concurrent-update': [409, 'stale', true],
  'lock-lost': [409, 'stale', true],
  'ambiguous-run': [409, 'ambiguous-run', false],
  'other-feature': [409, 'ambiguous-run', false],
});

/** IC-002: a runner failure (no JSON data) as an answer. */
function failureAnswer(shape: string, result: any): Answer {
  if (result.reason === 'old-core') return answer(501, 'core-lacks-action', 'failed', result.exit, shape);
  switch (result.code) {
    case 'timeout': return answer(504, 'action-timeout', 'unknown', null, shape);
    case 'core-unreachable': return answer(503, 'core-unreachable', 'failed', null, shape, { ran: false });
    case 'project-not-found': return answer(404, 'project-not-found', 'refused', null, shape, { ran: false });
    // Only a body the runner's own pattern refused, which this module's checks make unreachable.
    case 'usage': if (result.exit === null) return answer(400, 'usage', 'refused', null, shape, { ran: false });
      break;
    default:
  }
  // An exit 0 or 1 whose stdout is not one JSON object; an exit 0 may have applied.
  if (result.reason === 'not-json') return answer(502, 'core-contract-mismatch', result.exit === 0 ? 'unknown' : 'failed', result.exit, shape);
  return answer(502, 'core-error', 'failed', typeof result.exit === 'number' ? result.exit : null, shape);
}

/** decide-gate and close: the snapshot on exit 0, `{v:1, ok:false, error, current}` on exit 1 (IC-004). */
function runOutcome(shape: string) {
  return (result: any, body: Body): Answer => {
    if (!result.ok) return failureAnswer(shape, result);
    const json = result.json;
    if (result.exit === 0) {
      const projected = runResult(json, body.slug);
      return projected ? answer(200, null, 'applied', 0, shape, { result: projected }) : mismatch(shape, 0);
    }
    if (json.ok !== false || typeof json.error !== 'string' || !Object.hasOwn(RUN_REFUSALS, json.error)) return mismatch(shape, 1);
    const [status, code, withCurrent] = RUN_REFUSALS[json.error];
    const current = runCurrent(json.current ?? null);
    if (current === undefined) return mismatch(shape, 1);
    return answer(status, code, 'refused', 1, shape, withCurrent ? { current } : {});
  };
}

const ATTEMPT_DISPOSITION = /^[a-z][a-z-]{0,31}$/;
const CLEANUP_STATUS = ['verified', 'survivors', 'unknown'];
const END_STATES = ['exited', 'timed-out', 'cancelled'];

/** worker cancel: `{disposition:'cancelled', ...}` on exit 0, `{disposition:'refused', reason, ...}` on exit 1 (IC-021). */
function cancelOutcome(shape: string) {
  return (result: any): Answer => {
    if (!result.ok) return failureAnswer(shape, result);
    const json = result.json;
    if (result.exit === 0) {
      const attempt = json.attemptCancel;
      if (json.disposition !== 'cancelled' || typeof json.runId !== 'string' || !PATTERNS.runId.test(json.runId) || !END_STATES.includes(json.endState)
        || !object(json.cleanup) || !CLEANUP_STATUS.includes(json.cleanup.status)
        || !object(attempt) || typeof attempt.disposition !== 'string' || !ATTEMPT_DISPOSITION.test(attempt.disposition)
        || !(attempt.reason === null || attempt.reason === undefined || isId(attempt.reason))) return mismatch(shape, 0);
      return answer(200, null, 'applied', 0, shape, { result: {
        runId: json.runId, endState: json.endState, cleanup: { status: json.cleanup.status },
        attemptCancel: { disposition: attempt.disposition, reason: attempt.reason ?? null },
      } });
    }
    if (json.disposition !== 'refused') return mismatch(shape, 1);
    switch (json.reason) {
      case 'unknown-run': return answer(404, 'run-not-found', 'refused', 1, shape);
      case 'run-ended':
        return answer(409, 'stale', 'refused', 1, shape, { current: { state: 'ended', endState: END_STATES.includes(json.endState) ? json.endState : null } });
      case 'cancel-in-progress':
        if (typeof json.requestedAt !== 'string' || !ISO.test(json.requestedAt)) return mismatch(shape, 1);
        return answer(409, 'cancel-in-progress', 'refused', 1, shape, { current: { state: 'cancelling', requestedAt: json.requestedAt } });
      default: return mismatch(shape, 1);
    }
  };
}

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
};

const rule = (kind: Kind, required = true): FieldRule => ({ kind, required });
const slugParam = (b: Body) => (b.slug === null ? {} : { slug: b.slug as string });
const noteParam = (b: Body) => (b.note === '' ? {} : { note: b.note as string });

/** IC-001: the three actions. A fourth is one row here, one WRITE_SHAPES entry, one ACTION_IDS id and one words entry (IC-012). */
const ACTIONS: readonly ActionSpec[] = deepFreeze([
  {
    id: 'decide-gate',
    shape: 'decide-gate',
    fields: { slug: rule('slugOpt'), taskId: rule('id'), gateId: rule('id'), decision: rule('decision'), note: rule('text', false), expect: rule('revision') },
    textField: 'note',
    target: (b: Body) => ({ slug: b.slug, taskId: b.taskId, gateId: b.gateId, runId: null }),
    expect: (b: Body) => ({ revision: b.expect.revision }),
    params: (b: Body, relay: string) => ({ projectKey: b.projectKey, taskId: b.taskId, ...slugParam(b), gate: b.gateId, decision: b.decision,
      revision: String(b.expect.revision), relay, ...noteParam(b) }),
    outcome: runOutcome('decide-gate'),
  },
  {
    id: 'close-run',
    shape: 'close-run',
    fields: { slug: rule('slugOpt'), taskId: rule('id'), note: rule('text'), expect: rule('revision') },
    textField: 'note',
    target: (b: Body) => ({ slug: b.slug, taskId: b.taskId, gateId: null, runId: null }),
    expect: (b: Body) => ({ revision: b.expect.revision }),
    params: (b: Body, relay: string) => ({ projectKey: b.projectKey, taskId: b.taskId, ...slugParam(b), revision: String(b.expect.revision), relay, note: b.note }),
    outcome: runOutcome('close-run'),
  },
  {
    id: 'cancel-worker',
    shape: 'cancel-worker',
    fields: { slug: rule('id'), runId: rule('runId'), reason: rule('text') },
    textField: 'reason',
    target: (b: Body) => ({ slug: b.slug, taskId: null, gateId: null, runId: b.runId }),
    expect: () => null,
    // The write shape's free-text parameter is `note`; it is passed after `--reason`.
    params: (b: Body, relay: string) => ({ projectKey: b.projectKey, slug: b.slug, runId: b.runId, relay, note: b.reason }),
    outcome: cancelOutcome('cancel-worker'),
  },
] as ActionSpec[]);

// ---- the actor ----

/**
 * The actor of an authenticated request: the loopback session (no client class: loopback mode) or a paired device;
 * null for anything else, which never acts.
 */
function actorOf(ctx: any): Actor | null {
  const session = ctx.session;
  if (!session) return null;
  if (ctx.clientClass === undefined && session.scope === 'local') return { kind: 'local', key: 'local', relay: 'console' };
  if (typeof session.deviceId === 'string' && DEVICE_ID.test(session.deviceId)) {
    return { kind: 'device', key: session.deviceId, relay: `device.${session.deviceId}`, deviceId: session.deviceId, scope: session.scope, session };
  }
  return null;
}

const transportOf = (ctx: any): 'loopback' | 'native' | 'browser' => (ctx.clientClass === undefined ? 'loopback' : ctx.clientClass);
const addressOf = (ctx: any): string | null => (ctx.req && ctx.req.socket && typeof ctx.req.socket.remoteAddress === 'string' ? ctx.req.socket.remoteAddress : null);
/** The log's `actor` for a request whose session is `session` (null: not authenticated). */
function logActor(ctx: any, session: any) {
  const transport = transportOf(ctx);
  if (!session) return { kind: 'unknown', deviceId: null, scope: null, transport };
  if (session.scope === 'local') return { kind: 'local', deviceId: null, scope: 'local', transport };
  return { kind: 'device', deviceId: session.deviceId, scope: session.scope, transport };
}

const withHeader = (reply: Reply, name: string, value: string): Reply => ({ ...reply, headers: { ...reply.headers, [name]: value } });

// ---- the limits, the queue and the memo ----

/** D11's sliding windows. `admit` counts an attempt and answers 0, or answers the whole seconds to wait and counts nothing. */
function createLimits() {
  const actors = new Map<string, number[]>();
  let all: number[] = [];
  const waitFor = (oldest: number, windowMs: number, t: number) => Math.max(1, Math.ceil((oldest + windowMs - t) / 1000));
  return {
    /** `shared` false (a refusal): only the actor's own windows are checked and counted, never the Console's. */
    admit(key: string, t: number, shared = true): number {
      const mine = (actors.get(key) ?? []).filter((at) => t - at < HOUR_MS);
      all = all.filter((at) => t - at < MINUTE_MS);
      const minute = mine.filter((at) => t - at < MINUTE_MS);
      let wait = 0;
      if (minute.length >= LIMITS.actor.perMinute) wait = Math.max(wait, waitFor(minute[0], MINUTE_MS, t));
      if (mine.length >= LIMITS.actor.perHour) wait = Math.max(wait, waitFor(mine[0], HOUR_MS, t));
      if (shared && all.length >= LIMITS.console.perMinute) wait = Math.max(wait, waitFor(all[0], MINUTE_MS, t));
      if (wait === 0) {
        mine.push(t);
        if (shared) all.push(t);
      }
      if (mine.length) actors.set(key, mine);
      else actors.delete(key);
      return wait;
    },
  };
}

/** One attempt in flight, WAITING_MAX waiting, first in first out; `reserve` is null when full. */
function createQueue() {
  let running = false;
  const waiting: Array<() => void> = [];
  return {
    reserve(): { ready: Promise<void>, release: () => void } | null {
      if (running && waiting.length >= WAITING_MAX) return null;
      let ready: Promise<void>;
      if (!running) {
        running = true;
        ready = Promise.resolve();
      } else {
        ready = new Promise<void>((resolve) => waiting.push(resolve));
      }
      let released = false;
      return {
        ready,
        release: () => {
          if (released) return;
          released = true;
          const next = waiting.shift();
          if (next) next();
          else running = false;
        },
      };
    },
  };
}

type Memo = { digest: string, settled: Promise<Answer>, at: number };

/** D12: `(actor, requestId)` to the first attempt's digest and answer, MEMO_ENTRIES at most, least recently used out, MEMO_MS each. */
function createMemo() {
  const entries = new Map<string, Memo>();
  return {
    get(key: string, t: number): Memo | undefined {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key);
      if (t - entry.at >= MEMO_MS) return undefined;
      entries.set(key, entry);
      return entry;
    },
    set(key: string, entry: Memo) {
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > MEMO_ENTRIES) entries.delete(entries.keys().next().value as string);
    },
    delete(key: string) { entries.delete(key); },
  };
}

// ---- the routes ----

type Options = { runner: any, log: any, now?: () => number, warn?: (line: string) => void };

/**
 * The action routes over `runner` (its `act`, and its `projects` read for one refresh) and `log` (action-log.ts; null
 * when the environment has no config home: then every action is 503 action-log-unwritable). `warn` gets one stderr
 * line at most once a minute when a line other than `begin` cannot be written. `stop()` ends the idle flush and
 * writes every pending aggregated line.
 */
function createActions({ runner, log, now = Date.now, warn = () => {} }: Options) {
  const limits = createLimits();
  const queue = createQueue();
  const memo = createMemo();
  const lacking = new Set<string>();
  let warnedAt = -Infinity;
  const quietly = async (write: () => Promise<unknown>) => {
    try {
      await write();
    } catch (error: any) {
      const t = now();
      if (t - warnedAt < WARN_EVERY_MS) return;
      warnedAt = t;
      warn(`action log not written: ${error && error.reason ? error.reason : 'error'}`);
    }
  };
  // The aggregated lines of a quiet minute are written by this tick, not only by a later attempt.
  const idle = log ? setInterval(() => { quietly(() => log.flush(false)); }, FLUSH_EVERY_MS) : null;
  if (idle && typeof idle.unref === 'function') idle.unref();

  /** 429 action-rate-limited, counted on the actor's aggregated `rate-limited` line. */
  async function rateLimited(key: string, base: Record<string, unknown>, wait: number): Promise<Reply> {
    if (log) await quietly(() => log.summary('rate-limited', key, base));
    return withHeader(errorReply(429, 'action-rate-limited'), 'Retry-After', String(wait));
  }

  /**
   * A refusal before any spawn (162 review 1): counted against the actor's own windows unless `counted` already (then a full
   * window answers 429 instead), and on the aggregated `summary` line of its code and actor, never a line of its own.
   */
  async function refuse(key: string, base: Record<string, unknown>, status: number, code: string, options: { counted?: boolean, headers?: Record<string, string> } = {}): Promise<Reply> {
    if (!options.counted) {
      const wait = limits.admit(key, now(), false);
      if (wait > 0) return rateLimited(key, base, wait);
    }
    if (log) await quietly(() => log.summary(code, key, base));
    let reply = errorReply(status, code);
    for (const [name, value] of Object.entries(options.headers ?? {})) reply = withHeader(reply, name, value);
    return reply;
  }

  function replyOf(spec: ActionSpec, body: Body, actor: Actor, done: Answer, replayed: boolean): Reply {
    if (done.status === 200) return jsonReply(200, { v: 1, action: spec.id, requestId: body.requestId, outcome: 'applied', replayed, by: actor.relay, result: done.result });
    const reply = errorReply(done.status, done.code as string, done.verb, done.exit);
    if (done.current === undefined && !replayed) return reply;
    // 162 review 11: a replayed error says so, with the first reply's status and `current`.
    return jsonReply(done.status, { ...JSON.parse(String(reply.body)), ...(done.current === undefined ? {} : { current: done.current }), ...(replayed ? { replayed: true } : {}) });
  }

  /** begin, act (one projects refresh for an unknown key), end. */
  async function attempt(spec: ActionSpec, body: Body, actor: Actor, fields: Record<string, unknown>): Promise<Answer> {
    const started = now();
    try {
      await log.begin(fields);
    } catch {
      return answer(503, 'action-log-unwritable', 'failed', null, null, { ran: false });
    }
    const params = spec.params(body, actor.relay);
    let result = await runner.act(spec.shape, params);
    if (!result.ok && result.code === 'project-not-found') {
      // 162 review 10: past the 10 s cache, so a project registered seconds ago is found; the runner's 5 s floor
      // (verb-runner.ts `projects`) keeps this to one spawn per 5 s for the whole Console, whoever asks.
      await runner.run('projects', {}, { fresh: true });
      result = await runner.act(spec.shape, params);
    }
    const done = spec.outcome(result, body);
    if (done.code === 'core-lacks-action') lacking.add(spec.id);
    const current = done.current ? { state: done.current.state, revision: done.current.revision ?? null } : null;
    await quietly(() => log.end({ ...fields, outcome: done.outcome, code: done.code, current, exit: done.exit, ms: Math.max(0, now() - started) }));
    return done;
  }

  function actionRoute(spec: ActionSpec) {
    const path = `/api/actions/${spec.id}`;
    const baseOf = (ctx: any, session: any) => ({ actor: logActor(ctx, session), address: addressOf(ctx), action: spec.id });
    /** The limits' and the summary's key: the actor's, else the address of a session that is neither. */
    const keyOf = (ctx: any, session: any) => actorOf({ ...ctx, session })?.key ?? `address:${addressOf(ctx) ?? 'unknown'}`;
    return {
      method: 'POST' as const,
      path,
      action: true as const,
      refused: (ctx: any, session: any, code: string) => refuse(keyOf(ctx, session), baseOf(ctx, session), 403, code),
      unauthenticated: async (ctx: any) => {
        if (!log) return;
        const base = baseOf(ctx, null);
        await quietly(() => log.summary('unauthenticated', base.address ?? 'unknown', base));
      },
      handler: async (ctx: any): Promise<Reply> => {
        const actor = actorOf(ctx);
        const base = baseOf(ctx, ctx.session);
        const key = keyOf(ctx, ctx.session);
        if (actor === null || (actor.kind === 'device' && !deviceMayAct(actor.session, ctx.clientClass))) return refuse(key, base, 403, 'action-transport');
        if (!log) return errorReply(503, 'action-log-unwritable');
        const body = parseBody(spec, await readBody(ctx.req, BODY_CAP));
        if (body === null) return refuse(key, base, 400, 'usage');
        const fields = {
          ...base, id: body.requestId, project: body.projectKey, target: spec.target(body), expect: spec.expect(body),
          input: { decision: body.decision ?? null, textChars: spec.textField === null ? null : codePoints(body[spec.textField]) },
        };
        const memoKey = `${actor.key}\n${body.requestId}`;
        const digest = digestOf(spec.id, body);
        const seen = memo.get(memoKey, now());
        if (seen) {
          if (seen.digest !== digest) return refuse(key, base, 409, 'request-reused');
          const first = await seen.settled;
          await quietly(() => log.end({ ...fields, outcome: 'replayed', code: first.code, exit: first.exit }));
          return replyOf(spec, body, actor, first, true);
        }
        const wait = limits.admit(actor.key, now());
        if (wait > 0) return rateLimited(key, base, wait);
        const slot = queue.reserve();
        if (slot === null) return refuse(key, base, 429, 'action-busy', { counted: true, headers: { 'Retry-After': String(BUSY_RETRY_S) } });
        const settled = slot.ready.then(() => attempt(spec, body, actor, fields)).finally(slot.release);
        memo.set(memoKey, { digest, settled, at: now() });
        const done = await settled;
        // Nothing ran (no begin line, no spawn): the same request may be tried again.
        if (!done.ran) memo.delete(memoKey);
        return replyOf(spec, body, actor, done, false);
      },
    };
  }

  /**
   * 162 DEC-015: the Console's own project, `{ projectKey, label }`: the `fleet --action projects` entry the core marks `current`
   * (the one routes.ts's transcript read uses; the runner's cached `projects` read), its label as project.ts projects it. Null when
   * no entry is current, or the listing cannot be read or projected: the page then draws no run-page action.
   */
  async function ownProject(): Promise<{ projectKey: string, label: string } | null> {
    const listed = await runner.run('projects', {});
    if (!listed.ok) return null;
    const projected = projectBody('projects', listed.json);
    if (!projected.ok) return null;
    const own = projected.body.projects.find((entry: any) => entry.current === true);
    return own ? { projectKey: own.projectKey, label: own.label } : null;
  }

  /** IC-002 `GET /api/actions`: what the asking session may do, and why not. */
  const listRoute = {
    method: 'GET' as const,
    path: '/api/actions',
    handler: async (ctx: any): Promise<Reply> => {
      const actor = actorOf(ctx);
      const view = actor !== null && actor.kind === 'device'
        ? { kind: 'device', deviceId: actor.deviceId, scope: actor.scope, transport: transportOf(ctx) }
        : { kind: 'local', transport: 'loopback' };
      // 162 review 2: a log that is absent or cannot be written refuses every POST (503), so no action is offered.
      const logOk = log !== null && await log.writable();
      const reasonOf = (spec: ActionSpec): string | null => {
        if (actor === null) return 'action-transport';
        if (actor.kind === 'device') {
          if (actor.scope !== 'control') return 'phone-scope';
          if (!deviceMayAct(actor.session, ctx.clientClass)) return 'action-transport';
        }
        if (!logOk) return 'action-log-unwritable';
        return lacking.has(spec.id) ? 'core-lacks-action' : null;
      };
      return jsonReply(200, {
        v: 1,
        actor: view,
        actions: ACTIONS.map((spec) => {
          const reason = reasonOf(spec);
          return { id: spec.id, allowed: reason === null, reason };
        }),
        project: await ownProject(),
        textMax: TEXT_MAX,
        limits: LIMITS,
      });
    },
  };

  const routes = Object.freeze([listRoute, ...ACTIONS.map(actionRoute)]);
  return {
    routes,
    async stop() {
      if (idle) clearInterval(idle);
      if (log) await quietly(() => log.flush(true));
    },
  };
}

module.exports = { ACTIONS, ACTION_IDS, BODY_CAP, LIMITS, TEXT_MAX, createActions, normalizeText, parseBody };
