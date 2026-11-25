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
//   4. the body (the row's `bodyCap`: 4 KiB, 40 KiB for start-session, session-send and session-steer; one JSON object with exactly
//      the row's keys plus `v`, `requestId` and `projectKey`; the text rule of IC-009 or the prompt rule of 165 IC-004; else 400
//      usage, or 400 prompt-empty / prompt-too-long for a prompt or a message, the core's own ids);
//   5. idempotency (D12: `(actor, requestId)` for 10 min, 256 entries, least recently used out; a duplicate awaits
//      or replays the first answer, `replayed: true`, uncounted; another body under the same id is 409
//      request-reused);
//   6. the limits (D11: per actor 6 a minute and 30 an hour, per Console 20 a minute; 429 action-rate-limited with
//      `Retry-After` in whole seconds until the oldest counted attempt leaves its window; counted on the log's
//      aggregated `rate-limited` line per actor). The three session actions (170 R-5) are not counted here once a request reaches the core:
//      the core's limits are theirs. A start's hourly limit is the core's too (`start-rate-limited`); the Console holds no limit of its
//      own for either and maps the core's refusal to 429 with `Retry-After` from its `retryAfterSeconds`;
//   7. the queue (one attempt in flight, four waiting, FIFO; else 429 action-busy, `Retry-After: 2`).
// A request the server refuses before the wrappers (403 forbidden-origin, 415 unsupported-media) has no actor: it is counted
// on the `summary` line of its reason with actor kind `none`, one line a minute per reason, whoever sent it.
// A refusal at 2 to 5 counts against the actor's own windows (never the Console's, so one actor's refusals cannot
// block another's actions) and, once they are full, is 429 action-rate-limited instead (162 review 1), for the session actions too
// (170 review A-03): nothing else limits a request that never reaches the core. Every refusal
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
// its length. A prompt (165 IC-004) or a message (170: `session-send`, `session-steer`) is normalized by its own rule, passed only as
// the write shape's stdin parameter, and logged only as its length; it is in no reply and no error. The three session actions (170 IC-001,
// IC-005) reply with the closed projection of the core's `{ok, replayed, message, turn, channel}` or its refusal (409, 429 with `Retry-After`,
// 404, 400, 403 by the core's own ids, and its words as the error's `message`). `GET /api/actions` (D13) says, for the asking session, which actions it may take and why not; an
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
/** 165 owner ruling C-4: the field kinds `field()` knows; a row's guard (actions-table.test.ts) checks every row's kinds against it. */
const FIELD_KINDS = Object.freeze(['id', 'slugOpt', 'runId', 'decision', 'revision', 'text', 'key16', 'harness', 'modelOpt', 'providerOpt', 'effortOpt', 'entry', 'prompt'] as const);
type Kind = typeof FIELD_KINDS[number];
type FieldRule = Readonly<{ kind: Kind, required: boolean }>;
type Current = Record<string, unknown> | null;
/**
 * What an attempt came to: the reply's status and code (null when applied), the log's outcome, the core's exit; `current`
 * only on a refusal by state (it may be null there), `ran` false when nothing was spawned.
 */
type Answer = { status: number, code: string | null, outcome: 'applied' | 'refused' | 'failed' | 'unknown' | 'replayed', exit: number | null,
  verb: string | null, current?: Current, result?: Record<string, unknown>, ran: boolean, runId?: string, errorId?: string,
  /** 170: the core's own words for a refusal of a session action, as the error body's `message`; `retryAfter` whole seconds, the 429's header. */
  message?: string, retryAfter?: number };
type Target = { slug: string | null, taskId: string | null, gateId: string | null, runId: string | null,
  worktreeKey?: string, harness?: string, model?: string };
type ActionSpec = Readonly<{
  id: string,
  shape: string,
  fields: Readonly<Record<string, FieldRule>>,
  textField: 'note' | 'reason' | null,
  /** 165 C-4: the field of kind `prompt`, which is the write shape's `stdin` parameter (170: `message` for a send or a steer); null for every other row. */
  promptField: 'prompt' | 'message' | null,
  /** 165 C-4: this row's body cap in bytes (162's BODY_CAP unless the row carries a prompt). */
  bodyCap: number,
  /** 170 R-5: true for a session action, which D11's windows do not count (the core's limits apply); false for every other row. */
  coreLimited: boolean,
  target(b: Body): Target,
  expect(b: Body): { revision: number } | null,
  params(b: Body, relay: string): Record<string, string>,
  outcome(result: any, b: Body): Answer,
}>;
type Actor = { kind: 'local', key: 'local', relay: 'console' }
  | { kind: 'device', key: string, relay: string, deviceId: string, scope: string, session: any };

const BODY_CAP = 4096;
/** 165 IC-004: a start's body: a prompt of 32 KiB and its JSON escapes. */
const START_BODY_CAP = 40960;
/** 170 IC-005: a send's or a steer's body: a message of 32 KiB and its JSON escapes, as a start's. */
const MESSAGE_BODY_CAP = START_BODY_CAP;
/**
 * 165 IC-001: the prompt bounds after the prompt rule, the core's PROMPT_MAX (src/runtime/worker/session-prompt.ts); 170: a message's
 * bounds are the same two numbers (channel.ts CHANNEL_LIMITS). This mirrors the core's value only to answer a too-long text before a spawn;
 * the core re-checks it and its answer is the one that counts.
 */
const PROMPT_MAX = Object.freeze({ codePoints: 8000, bytes: 32768 });
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
/** start-session carries its id as a CLI flag value, which the CLI refuses when it begins with `-`: this row's id begins with a letter or digit. */
const START_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{21}$/;
/** The actions whose request id is a CLI flag value (the core's own pattern): start-session (165) and the three session actions (170). */
const FLAG_ID_ACTIONS: readonly string[] = Object.freeze(['start-session', 'session-send', 'session-steer', 'session-stop']);
const DEVICE_ID = /^d-[0-9a-f]{12}$/;
/** IC-009: removed after NFC and the whitespace rule: C0, DEL and C1, zero-width and bidi controls, the BOM. */
const REMOVED = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;
/**
 * 165 IC-004: what the prompt rule removes, the core's STRIPPED (src/runtime/worker/session-prompt.ts): C0 but tab and LF (CR is
 * mapped to LF before), DEL and C1, the ALM, LRM and RLM marks and the bidi embeddings, overrides and isolates.
 */
const PROMPT_REMOVED = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
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

/**
 * 165 IC-004, distinct from normalizeText: line breaks are kept (CRLF and CR become LF), the PROMPT_REMOVED characters go, nothing
 * is collapsed or trimmed. Null for a NUL or a lone surrogate (usage): neither is a prompt the core can take on stdin.
 */
function normalizePrompt(raw: string): string | null {
  if (raw.includes('\u0000') || LONE_SURROGATE.test(raw)) return null;
  return raw.replace(/\r\n?/g, '\n').replace(PROMPT_REMOVED, '');
}

const codePoints = (text: string) => [...text].length;
const isId = (value: unknown): value is string => typeof value === 'string' && PATTERNS.id.test(value) && !value.includes('..');
/** 162 review 9: an id a body may name, at most ID_MAX characters, the bound the action log records in full. */
const isTarget = (value: unknown): value is string => isId(value) && value.length <= ID_MAX;
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A value a rule refuses with an id of its own (a prompt's), not usage. */
class Refused {
  code: string;
  constructor(code: string) { this.code = code; }
}

/** One field's value as the row takes it, undefined when the rule refuses it (usage), or a Refused with its own id. */
function field(rule: FieldRule, value: unknown): unknown {
  switch (rule.kind) {
    case 'key16': return typeof value === 'string' && PATTERNS.key16.test(value) ? value : undefined;
    case 'harness': return typeof value === 'string' && PATTERNS.harness.test(value) ? value : undefined;
    case 'modelOpt': return value === null || (typeof value === 'string' && PATTERNS.model.test(value)) ? value : undefined;
    // 169: null is none bound; the patterns are the core's PROVIDER_RE and EFFORT_RE.
    case 'providerOpt': return value === null || (typeof value === 'string' && PATTERNS.provider.test(value)) ? value : undefined;
    case 'effortOpt': return value === null || (typeof value === 'string' && PATTERNS.effort.test(value)) ? value : undefined;
    case 'entry': return typeof value === 'string' && PATTERNS.entry.test(value) ? value : undefined;
    case 'prompt': {
      if (typeof value !== 'string') return undefined;
      const text = normalizePrompt(value);
      if (text === null) return undefined;
      // The core's rules and ids (IC-001 step 5): blank is empty; the bounds hold after the rule.
      if (text.trim() === '') return new Refused('prompt-empty');
      if (codePoints(text) > PROMPT_MAX.codePoints || Buffer.byteLength(text, 'utf8') > PROMPT_MAX.bytes) return new Refused('prompt-too-long');
      return text;
    }
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

/**
 * IC-002: the body of `spec` from `text`, normalized (text fields as IC-009 makes them, a null optional text as '', a prompt as
 * 165 IC-004 makes it), or the refusal id: `usage`, or a prompt's own id once every other field holds.
 */
function readBodyOf(spec: ActionSpec, text: string | null): { body: Body } | { code: string } {
  const usage = { code: 'usage' };
  let raw: unknown;
  try {
    raw = text === null ? null : JSON.parse(text);
  } catch {
    return usage;
  }
  if (!object(raw)) return usage;
  const keys = ['v', 'requestId', 'projectKey', ...Object.keys(spec.fields)];
  if (Object.keys(raw).sort().join() !== [...keys].sort().join()) return usage;
  if (raw.v !== 1 || typeof raw.requestId !== 'string' || !(FLAG_ID_ACTIONS.includes(spec.id) ? START_REQUEST_ID : REQUEST_ID).test(raw.requestId)
    || typeof raw.projectKey !== 'string' || !PATTERNS.key16.test(raw.projectKey)) return usage;
  const body: Body = { v: 1, requestId: raw.requestId, projectKey: raw.projectKey };
  let refused: Refused | null = null;
  for (const [name, rule] of Object.entries(spec.fields)) {
    const value = field(rule, raw[name]);
    if (value === undefined) return usage;
    if (value instanceof Refused) refused = refused ?? value;
    else body[name] = value;
  }
  return refused ? { code: refused.code } : { body };
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

// ---- 165 IC-004: start-session's reply ----

const START_PHASES = ['starting', 'running', 'cancelling', 'ended'];
const MODEL_SOURCES = ['orchestrator', 'frontier', 'standard', 'light', 'observed', 'default'];
/** IC-001 step 6 / design §9.2: why a harness cannot start here. */
const NOT_STARTABLE = ['not-listed', 'no-main-session-shape', 'not-installed', 'logged-out'];
const STARTED_BY = /^(?:manual|console|device\.d-[0-9a-f]{12})$/;
const MODELS_MAX = 50;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const runIdOrNull = (value: unknown) => (typeof value === 'string' && PATTERNS.runId.test(value) ? value : null);

const UNREADABLE_REASONS = ['proc-entry', 'proc-list', 'ps-failed', 'no-uid', 'platform'];
const PROC_FILE = /^\/proc(\/[0-9]+(\/[a-z]+)?)?$/;
const ERRNO = /^E[A-Z0-9]{1,15}$/;
const PROC_STATE = /^[A-Za-z]$/;
const COMMAND_NAME = /^[A-Za-z0-9._+@-]{1,64}$/;
/** The core's process-table blocker, closed; undefined when it does not project. A command name outside a plain file-name shape is null. */
function unreadableBlocker(u: any): Record<string, unknown> | undefined {
  const orNull = (value: unknown, ok: (v: any) => boolean) => value === null || ok(value);
  if (!object(u) || !UNREADABLE_REASONS.includes(u.reason as string) || !orNull(u.pid, (v) => Number.isSafeInteger(v) && v > 0)
    || !orNull(u.file, (v) => typeof v === 'string' && PROC_FILE.test(v)) || !orNull(u.errno, (v) => typeof v === 'string' && ERRNO.test(v))
    || !(u.state === undefined || orNull(u.state, (v) => typeof v === 'string' && PROC_STATE.test(v)))
    || !(u.threads === undefined || orNull(u.threads, count))) return undefined;
  return {
    reason: u.reason, pid: u.pid, file: u.file, errno: u.errno,
    ...(u.state === undefined ? {} : { state: u.state }), ...(u.threads === undefined ? {} : { threads: u.threads }),
    ...(u.command === undefined ? {} : { command: typeof u.command === 'string' && COMMAND_NAME.test(u.command) ? u.command : null }),
  };
}

/** `current` projectors of the core's start refusals; undefined when the core's value does not project. */
const START_CURRENT: Readonly<Record<string, (c: any) => Current | undefined>> = Object.freeze({
  run: (c: any) => (object(c) && typeof c.runId === 'string' && PATTERNS.runId.test(c.runId) ? { runId: c.runId } : undefined),
  // A-1: checkout-busy-unknown adds `unreadable`, the process-table blocker, when the core read one; a core without it gives `{runId}`.
  runUnknown: (c: any) => {
    const run = START_CURRENT.run(c);
    if (run === undefined || c.unreadable === undefined) return run;
    const blocker = unreadableBlocker(c.unreadable);
    return blocker === undefined ? undefined : { ...run, unreadable: blocker };
  },
  // nested-start: the id is the environment's DOFLOW_STARTED_RUN, which the core does not check.
  nested: (c: any) => (object(c) ? { runId: runIdOrNull(c.runId) } : undefined),
  open: (c: any) => (object(c) && count(c.open) && count(c.max) ? { open: c.open, max: c.max } : undefined),
  // 170 R-5: the core's hourly limit of an actor's starts; `retryAfterSeconds` is the 429's `Retry-After` too.
  rate: (c: any) => (object(c) && count(c.started) && count(c.max) && Number.isSafeInteger(c.retryAfterSeconds) && c.retryAfterSeconds >= 1 && c.retryAfterSeconds <= RETRY_AFTER_MAX
    ? { started: c.started, max: c.max, retryAfterSeconds: c.retryAfterSeconds } : undefined),
  // 165 review A-3: `slug` is null when the core cannot read the dispatch records; its `reason` then says so.
  dispatch: (c: any) => (object(c) && (isId(c.slug) || (c.slug === null && isId(c.reason))) && (c.dispatchId === undefined || c.dispatchId === null || isId(c.dispatchId))
    && (c.driverPid === undefined || Number.isSafeInteger(c.driverPid)) && (c.reason === undefined || isId(c.reason))
    ? { slug: c.slug, dispatchId: c.dispatchId ?? null, driverPid: c.driverPid ?? null, reason: c.reason ?? null } : undefined),
  harness: (c: any) => (object(c) && typeof c.harness === 'string' && PATTERNS.harness.test(c.harness) && NOT_STARTABLE.includes(c.reason)
    ? { harness: c.harness, reason: c.reason } : undefined),
  // 169 IC-007: the entries as the core offers them, without their checks: `{ model, provider, effort, source }`.
  models: (c: any) => {
    if (!object(c) || typeof c.harness !== 'string' || !PATTERNS.harness.test(c.harness) || !Array.isArray(c.models) || c.models.length > MODELS_MAX) return undefined;
    const part = (value: unknown, re: RegExp) => value === null || (typeof value === 'string' && re.test(value));
    const models = c.models.map((m: any) => (object(m) && part(m.model, PATTERNS.model) && part(m.provider, PATTERNS.provider) && part(m.effort, PATTERNS.effort) && MODEL_SOURCES.includes(m.source)
      ? { model: m.model, provider: m.provider, effort: m.effort, source: m.source } : null));
    return models.includes(null) ? undefined : { harness: c.harness, models };
  },
});

/**
 * IC-004: the core's start refusal ids (IC-001), their status and code here, and the projector of the `current` the core gives
 * with them (null: none is passed). The two project checks are this Console's `project-not-found`: its map and the core's cwd disagree.
 */
const START_REFUSALS: Readonly<Record<string, readonly [number, string, string | null]>> = Object.freeze({
  'unknown-worktree': [400, 'unknown-worktree', null],
  'worktree-gone': [400, 'worktree-gone', null],
  'prompt-empty': [400, 'prompt-empty', null],
  'prompt-nul': [400, 'prompt-nul', null],
  'prompt-too-long': [400, 'prompt-too-long', null],
  'prompt-leading-dash': [400, 'prompt-leading-dash', null],
  'prompt-leading-at': [400, 'prompt-leading-at', null],
  'model-not-offered': [400, 'model-not-offered', 'models'],
  'checkout-busy': [409, 'checkout-busy', 'run'],
  'checkout-busy-unknown': [409, 'checkout-busy-unknown', 'runUnknown'],
  'dispatch-running': [409, 'dispatch-running', 'dispatch'],
  'harness-not-startable': [409, 'harness-not-startable', 'harness'],
  'nested-start': [409, 'nested-start', 'nested'],
  'actor-limit': [429, 'actor-limit', 'open'],
  'start-rate-limited': [429, 'start-rate-limited', 'rate'],
  'machine-limit': [429, 'machine-limit', 'open'],
  'project-mismatch': [404, 'project-not-found', null],
  'project-not-indexed': [404, 'project-not-found', null],
});

/** IC-001's `run` of a start or a replay, closed; null when it does not project. Its Layers address is rebuilt and must agree. */
function startRun(run: unknown, projectKey: string): Record<string, unknown> | null {
  if (!object(run) || typeof run.runId !== 'string' || !PATTERNS.runId.test(run.runId) || run.kind !== 'main-session' || !START_PHASES.includes(run.phase)
    || typeof run.harness !== 'string' || !PATTERNS.harness.test(run.harness)
    || !(run.model === null || (typeof run.model === 'string' && PATTERNS.model.test(run.model))) || !MODEL_SOURCES.includes(run.modelSource)
    || !(run.worktreeKey === null || (typeof run.worktreeKey === 'string' && PATTERNS.key16.test(run.worktreeKey)))
    || !(run.startedBy === null || (typeof run.startedBy === 'string' && STARTED_BY.test(run.startedBy)))
    || typeof run.createdAt !== 'string' || !ISO.test(run.createdAt) || typeof run.agentKey !== 'string' || !PATTERNS.key16.test(run.agentKey)
    || run.layers !== `/layers/${projectKey}/agent/${run.agentKey}`
    || !object(run.files) || typeof run.files.out !== 'string' || !PATTERNS.key16.test(run.files.out) || typeof run.files.err !== 'string' || !PATTERNS.key16.test(run.files.err)) return null;
  const projected: Record<string, unknown> = {
    runId: run.runId, kind: run.kind, phase: run.phase, harness: run.harness, model: run.model, modelSource: run.modelSource, worktreeKey: run.worktreeKey,
    startedBy: run.startedBy, createdAt: run.createdAt, agentKey: run.agentKey, layers: run.layers, files: { out: run.files.out, err: run.files.err },
  };
  if (run.end !== undefined) {
    if (!object(run.end) || !END_STATES.includes(run.end.state) || typeof run.end.at !== 'string' || !ISO.test(run.end.at)) return null;
    projected.end = { state: run.end.state, at: run.end.at };
  }
  return projected;
}

/**
 * start-session (IC-001, IC-004): `{ok:true, replayed, run}` on exit 0 (200 for a start and for the core's replay, which the log
 * records as `replayed`), `{ok:false, code, message, current?}` on exit 1 by START_REFUSALS. FR-016: an exit 2 `usage` (or none) is an older
 * core without the action, since every flag passed the runner's own patterns first: 501 core-lacks-action. Any other `error` id on an
 * exit 2 (the core's `store-unreadable`) is the core's own failure: 502 core-error carrying the id (165 F1).
 */
function startOutcome(shape: string) {
  return (result: any, body: Body): Answer => {
    if (!result.ok) {
      if (result.code === 'usage' && result.exit === 2) {
        return result.errorId === undefined || result.errorId === 'usage'
          ? answer(501, 'core-lacks-action', 'failed', 2, shape)
          : answer(502, 'core-error', 'failed', 2, shape, { errorId: result.errorId });
      }
      return failureAnswer(shape, result);
    }
    const json = result.json;
    if (result.exit === 0) {
      const run = json.ok === true && typeof json.replayed === 'boolean' ? startRun(json.run, body.projectKey) : null;
      if (run === null) return mismatch(shape, 0);
      return answer(200, null, json.replayed ? 'replayed' : 'applied', 0, shape, { result: { replayed: json.replayed, run }, runId: run.runId as string });
    }
    if (json.ok !== false || typeof json.code !== 'string' || !Object.hasOwn(START_REFUSALS, json.code)) return mismatch(shape, 1);
    const [status, code, projector] = START_REFUSALS[json.code];
    if (projector === null) return answer(status, code, 'refused', 1, shape);
    const current = START_CURRENT[projector](json.current);
    if (current === undefined) return mismatch(shape, 1);
    return answer(status, code, 'refused', 1, shape, { current, ...(status === 429 && current !== null && typeof current.retryAfterSeconds === 'number' ? { retryAfter: current.retryAfterSeconds } : {}) });
  };
}

// ---- 170 IC-001, IC-005: the reply of session-send, session-steer and session-stop ----

const TOKEN = /^[a-z][a-z0-9:_-]{0,63}$/;
const MESSAGE_KINDS = ['follow-up', 'steer', 'stop'];
/** An `ok: true` reply says `written` or `pending` (the verb waited 2 s and the file still waits); a refused or failed entry is `ok: false`. */
const MESSAGE_STATES = ['written', 'pending'];
const MESSAGE_ANSWERS = ['accepted', 'refused'];
/** The core's words for a refusal: one line of at most 300 characters, no control character, and none that looks like a path. */
const CORE_WORDS = /^[^\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]{1,300}$/;
const CORE_PATH = /(?:^|[\s(])(?:\/|~\/|[A-Za-z]:\\)/;
const RETRY_AFTER_MAX = 86_400;
const isIso = (value: unknown): value is string => typeof value === 'string' && ISO.test(value);

/** IC-002's `Turn`, closed; undefined when it does not project. */
function turnOf(turn: any): Record<string, unknown> | undefined {
  if (!object(turn)) return undefined;
  if (turn.observed === true) {
    return (turn.state === 'working' || turn.state === 'waiting') && isIso(turn.since) && count(turn.seq)
      ? { observed: true, state: turn.state, since: turn.since, seq: turn.seq } : undefined;
  }
  return turn.observed === false && typeof turn.reason === 'string' && TOKEN.test(turn.reason) && (turn.since === null || isIso(turn.since))
    ? { observed: false, reason: turn.reason, since: turn.since } : undefined;
}

/** IC-001's `ok: true` reply, closed; null when it does not project. */
function sessionResult(json: any): Record<string, unknown> | null {
  const m = json.message;
  const turn = turnOf(json.turn);
  if (typeof json.replayed !== 'boolean' || turn === undefined || (json.channel !== 'open' && json.channel !== 'closed') || !object(m)
    || !(m.seq === null || count(m.seq)) || !MESSAGE_KINDS.includes(m.kind) || !MESSAGE_STATES.includes(m.state)
    || !(m.answer === null || MESSAGE_ANSWERS.includes(m.answer)) || !isIso(m.at) || !count(m.bytes)) return null;
  return { replayed: json.replayed, message: { seq: m.seq, kind: m.kind, state: m.state, answer: m.answer, at: m.at, bytes: m.bytes }, turn, channel: json.channel };
}

/**
 * IC-001's `current` of a refusal, closed: the run id, the turn, a reason and the seconds to wait, each only when the core gave it.
 * `nested-send` carries the environment's DOFLOW_STARTED_RUN, which the core does not check: it is left out when it is no run id.
 * Null for none; undefined when a part the core gave does not project.
 */
function sessionCurrent(c: unknown, code: string): Current | undefined {
  if (c === undefined || c === null) return null;
  if (!object(c)) return undefined;
  const current: Record<string, unknown> = {};
  if (c.runId !== undefined) {
    if (typeof c.runId === 'string' && PATTERNS.runId.test(c.runId)) current.runId = c.runId;
    else if (code !== 'nested-send') return undefined;
  }
  if (c.turn !== undefined) {
    const turn = turnOf(c.turn);
    if (turn === undefined) return undefined;
    current.turn = turn;
  }
  if (c.reason !== undefined) {
    if (typeof c.reason !== 'string' || !TOKEN.test(c.reason)) return undefined;
    current.reason = c.reason;
  }
  if (c.retryAfterSeconds !== undefined) {
    if (!Number.isSafeInteger(c.retryAfterSeconds) || c.retryAfterSeconds < 1 || c.retryAfterSeconds > RETRY_AFTER_MAX) return undefined;
    current.retryAfterSeconds = c.retryAfterSeconds;
  }
  return Object.keys(current).length === 0 ? null : current;
}

/** IC-001/IC-005: the core's refusal ids of a send, a steer and a stop, and the status each is here. The core's id is the Console's. */
const SESSION_REFUSALS: Readonly<Record<string, number>> = Object.freeze({
  'no-channel': 409, 'no-steer': 409, 'channel-closed': 409, 'not-working': 409, 'channel-busy': 409, 'run-ended': 409,
  'started-without-channel': 409, 'stdin-stalled': 409, 'write-failed': 409,
  'actor-rate-limited': 429,
  'unknown-run': 404, 'not-a-session': 404,
  'prompt-empty': 400, 'prompt-too-long': 400, 'command-not-allowed': 400,
  'nested-send': 403, 'sender-in-run': 403,
});
/** A delivery that failed (not a refusal by a rule): the log says `failed`. */
const SESSION_FAILURES = ['stdin-stalled', 'write-failed'];

/**
 * send, steer and stop (IC-001): `{ok:true, replayed, message, turn, channel}` on exit 0, `{ok:false, code, message, current?}` on exit 1 by
 * SESSION_REFUSALS; the project checks are this Console's `project-not-found`, as start's. An exit 2 `usage` is an older core without the
 * action (501), as start's. The core's words ride as the error body's `message`, and `retryAfterSeconds` as the 429's `Retry-After`.
 */
function sessionOutcome(shape: string) {
  return (result: any): Answer => {
    if (!result.ok) {
      if (result.code === 'usage' && result.exit === 2) {
        return result.errorId === undefined || result.errorId === 'usage'
          ? answer(501, 'core-lacks-action', 'failed', 2, shape)
          : answer(502, 'core-error', 'failed', 2, shape, { errorId: result.errorId });
      }
      return failureAnswer(shape, result);
    }
    const json = result.json;
    if (result.exit === 0) {
      const projected = json.ok === true ? sessionResult(json) : null;
      if (projected === null) return mismatch(shape, 0);
      return answer(200, null, projected.replayed ? 'replayed' : 'applied', 0, shape, { result: projected });
    }
    if (json.ok !== false || typeof json.code !== 'string') return mismatch(shape, 1);
    if (json.code === 'project-mismatch' || json.code === 'project-not-indexed') return answer(404, 'project-not-found', 'refused', 1, shape);
    if (!Object.hasOwn(SESSION_REFUSALS, json.code)) return mismatch(shape, 1);
    const current = sessionCurrent(json.current, json.code);
    if (current === undefined) return mismatch(shape, 1);
    const words = typeof json.message === 'string' && CORE_WORDS.test(json.message) && !CORE_PATH.test(json.message) ? json.message : undefined;
    const retry = current === null ? undefined : current.retryAfterSeconds;
    return answer(SESSION_REFUSALS[json.code], json.code, SESSION_FAILURES.includes(json.code) ? 'failed' : 'refused', 1, shape, {
      ...(current === null ? {} : { current }), ...(words === undefined ? {} : { message: words }),
      ...(json.code === 'actor-rate-limited' && typeof retry === 'number' ? { retryAfter: retry } : {}),
    });
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

/**
 * IC-001: the actions. Another is one row here, one WRITE_SHAPES entry, one ACTION_IDS id and one words entry (IC-012); one that
 * carries a prompt (165 owner ruling C-4) also needs its field kind (`prompt`), its row's `promptField` and `bodyCap`, and the
 * runner's `stdin` parameter on its write shape, named like the `promptField` (actions-table.test.ts checks all of it).
 */
const ACTIONS: readonly ActionSpec[] = deepFreeze([
  {
    id: 'decide-gate',
    shape: 'decide-gate',
    fields: { slug: rule('slugOpt'), taskId: rule('id'), gateId: rule('id'), decision: rule('decision'), note: rule('text', false), expect: rule('revision') },
    textField: 'note',
    promptField: null,
    bodyCap: BODY_CAP,
    coreLimited: false,
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
    promptField: null,
    bodyCap: BODY_CAP,
    coreLimited: false,
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
    promptField: null,
    bodyCap: BODY_CAP,
    coreLimited: false,
    target: (b: Body) => ({ slug: b.slug, taskId: null, gateId: null, runId: b.runId }),
    expect: () => null,
    // The write shape's free-text parameter is `note`; it is passed after `--reason`.
    params: (b: Body, relay: string) => ({ projectKey: b.projectKey, slug: b.slug, runId: b.runId, relay, note: b.reason }),
    outcome: cancelOutcome('cancel-worker'),
  },
  {
    // 165 IC-004. The relay label is the actor's; the prompt is the write shape's stdin; a null model, provider or effort leaves its flag out.
    id: 'start-session',
    shape: 'start-session',
    fields: { worktreeKey: rule('key16'), harness: rule('harness'), model: rule('modelOpt'), provider: rule('providerOpt'), effort: rule('effortOpt'), entry: rule('entry'), prompt: rule('prompt') },
    textField: null,
    promptField: 'prompt',
    bodyCap: START_BODY_CAP,
    coreLimited: false,
    target: (b: Body) => ({ slug: null, taskId: null, gateId: null, runId: null, worktreeKey: b.worktreeKey, harness: b.harness, model: b.model ?? 'default' }),
    expect: () => null,
    params: (b: Body, relay: string) => ({ projectKey: b.projectKey, worktreeKey: b.worktreeKey, harness: b.harness, ...(b.model === null ? {} : { model: b.model as string }),
      ...(b.provider === null ? {} : { provider: b.provider as string }), ...(b.effort === null ? {} : { effort: b.effort as string }), entry: b.entry, relay, requestId: b.requestId, prompt: b.prompt }),
    outcome: startOutcome('start-session'),
  },
  // 170 IC-005. The run id is the target; the message is the write shape's stdin, in no argv, reply or log line; the core's limits apply.
  ...['session-send', 'session-steer'].map((id) => ({
    id,
    shape: id,
    fields: { runId: rule('runId'), message: rule('prompt') },
    textField: null,
    promptField: 'message',
    bodyCap: MESSAGE_BODY_CAP,
    coreLimited: true,
    target: (b: Body) => ({ slug: null, taskId: null, gateId: null, runId: b.runId }),
    expect: () => null,
    params: (b: Body, relay: string) => ({ projectKey: b.projectKey, runId: b.runId, relay, requestId: b.requestId, message: b.message }),
    outcome: sessionOutcome(id),
  })),
  {
    id: 'session-stop',
    shape: 'session-stop',
    fields: { runId: rule('runId') },
    textField: null,
    promptField: null,
    bodyCap: BODY_CAP,
    coreLimited: true,
    target: (b: Body) => ({ slug: null, taskId: null, gateId: null, runId: b.runId }),
    expect: () => null,
    params: (b: Body, relay: string) => ({ projectKey: b.projectKey, runId: b.runId, relay, requestId: b.requestId }),
    outcome: sessionOutcome('session-stop'),
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

/** 170 review A-07: a 200 whose message the core answered `pending` (written to the spool, not yet taken by the harness). */
const isPendingMessage = (done: Answer): boolean => done.status === 200 && (done.result?.message as { state?: unknown } | null | undefined)?.state === 'pending';

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
   * A refusal before any spawn (162 review 1): counted against the actor's own windows (a full window answers 429 instead), for every action, a
   * session action too (170 review A-03), unless `counted` says the attempt was admitted already; and on the aggregated `summary` line of its code and actor, never a line of its own.
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

  /** 170: a 429 from the core's own limit says when to come back, in whole seconds. */
  const withRetry = (reply: Reply, done: Answer): Reply => (done.retryAfter === undefined ? reply : withHeader(reply, 'Retry-After', String(done.retryAfter)));

  function replyOf(spec: ActionSpec, body: Body, actor: Actor, done: Answer, replayed: boolean): Reply {
    if (done.status === 200) return jsonReply(200, { v: 1, action: spec.id, requestId: body.requestId, outcome: done.outcome === 'replayed' ? 'replayed' : 'applied', replayed, by: actor.relay, result: done.result });
    const reply = errorReply(done.status, done.code as string, done.verb, done.exit);
    if (done.current === undefined && done.errorId === undefined && done.message === undefined && !replayed) return withRetry(reply, done);
    // 162 review 11: a replayed error says so, with the first reply's status and `current`. 165 F1: a core error says which id. 170: and its words.
    const plain = JSON.parse(String(reply.body));
    if (done.errorId !== undefined) plain.error.id = done.errorId;
    if (done.message !== undefined) plain.error.message = done.message;
    return withRetry(jsonReply(done.status, { ...plain, ...(done.current === undefined ? {} : { current: done.current }), ...(replayed ? { replayed: true } : {}) }), done);
  }

  /** begin, act (one projects refresh for an unknown key), end. */
  async function attempt(spec: ActionSpec, body: Body, actor: Actor, fields: Record<string, any>): Promise<Answer> {
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
    // 165 FR-010: a start's end line names the run it started (or replayed).
    const target = done.runId === undefined ? fields.target : { ...fields.target, runId: done.runId };
    await quietly(() => log.end({ ...fields, target, outcome: done.outcome, code: done.code, current, exit: done.exit, ms: Math.max(0, now() - started) }));
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
      // A refusal of server.ts before any actor exists: counted on the one line a minute of its reason, whoever sent it.
      refusedEarly: async (code: string) => {
        if (log) await quietly(() => log.summary(code as 'forbidden-origin' | 'unsupported-media', 'none', { actor: { kind: 'none' } }));
      },
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
        const read = readBodyOf(spec, await readBody(ctx.req, spec.bodyCap));
        if ('code' in read) return refuse(key, base, 400, read.code);
        const body = read.body;
        const free = spec.textField ?? spec.promptField;
        const fields = {
          ...base, id: body.requestId, project: body.projectKey, target: spec.target(body), expect: spec.expect(body),
          input: { decision: body.decision ?? null, textBytes: free === null ? null : Buffer.byteLength(body[free] as string, 'utf8'), entry: body.entry ?? null },
        };
        const memoKey = `${actor.key}\n${body.requestId}`;
        const digest = digestOf(spec.id, body);
        const seen = memo.get(memoKey, now());
        if (seen) {
          if (seen.digest !== digest) return refuse(key, base, 409, 'request-reused');
          const first = await seen.settled;
          // 170 review A-07: a message the core answered `pending` (still in the spool) is not a final answer. The same request id goes to
          // the core again, which replays what became of it; the memo then holds that answer.
          if (!isPendingMessage(first)) {
            await quietly(() => log.end({ ...fields, outcome: 'replayed', code: first.code, exit: first.exit }));
            return replyOf(spec, body, actor, first, true);
          }
          if (memo.get(memoKey, now()) === seen) memo.delete(memoKey);
        }
        if (!spec.coreLimited) {
          const wait = limits.admit(actor.key, now());
          if (wait > 0) return rateLimited(key, base, wait);
        }
        const slot = queue.reserve();
        if (slot === null) {
          return refuse(key, base, 429, 'action-busy', { counted: true, headers: { 'Retry-After': String(BUSY_RETRY_S) } });
        }
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

module.exports = { ACTIONS, ACTION_IDS, BODY_CAP, FIELD_KINDS, LIMITS, PROMPT_MAX, START_BODY_CAP, TEXT_MAX, createActions, normalizePrompt, normalizeText };
