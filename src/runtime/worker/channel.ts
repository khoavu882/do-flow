'use strict';

// Row 170 (design sections 4.3, 5.2, 7, D6, D9): the pure core of a session's control channel. It compiles a
// descriptor's `controlChannel`, frames one message as one JSONL record, tracks the turn, correlates answers,
// admits a message under the D6 limits and refuses a harness command prefix (owner ruling R-4). No file, process or
// network access: the supervisor (T4), the verbs (T5), conform (T6) and the live section (T7) all read through here.

const { validateControlChannel } = require('../../registry/control-channel.ts');
const { compileTest, read } = require('./parsers/field-map.ts');
const { PROMPT_MAX } = require('./session-prompt.ts');

type Check = (event: any) => boolean;
type Template = Record<string, any>;
type Kind = 'first' | 'follow-up' | 'steer' | 'stop';
type Turn =
  | { observed: true; state: 'working' | 'waiting'; since: string; seq: number }
  | { observed: false; reason: string; since: string | null };
type Compiled = Readonly<{
  argv: readonly string[];
  commandPrefix: string | null;
  graceSeconds: number;
  parser: string | null;
  templates: Readonly<{ followUp: Template; steer: Template | null; stop: Template }>;
  working: Check;
  settled: Check;
  answer: Readonly<{ path: string[]; accepted: Check; refused: Check }> | null;
}>;
type LedgerEntry = { kind: string; by: string; at: string; outcome: string };
type Admission = { ok: true } | { ok: false; code: 'channel-busy' | 'actor-rate-limited'; retryAfterSeconds?: number };
type Framed = { ok: true; record: Buffer; bytes: number } | { ok: false; code: string };

/** D6, in one place: T5, T7, T8 and the docs read these numbers. Text caps are 165's `PROMPT_MAX`, not a copy. */
const CHANNEL_LIMITS = Object.freeze({
  messagesPerMinute: 6,
  messagesPerHour: 60,
  stopsPerMinute: 6,
  waiting: 4,
  textCodePoints: PROMPT_MAX.codePoints as number,
  textBytes: PROMPT_MAX.bytes as number,
  recordBytes: 64 * 1024,
});

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const COALESCE_MS = 250;
const TEXT = '{text}';
const ID = '{id}';
const ANSWER_ID = /^d-([1-9][0-9]{0,8})$/;

function all(tests: any[]): Check {
  const checks: Check[] = tests.map((test) => compileTest(test));
  return (event) => checks.every((check) => check(event));
}

/**
 * The compiled channel of a descriptor, or null when it declares none that is `supported` (or its entry no longer
 * validates, as a stored descriptor may not). The unverified phrases are a guard's concern, not a runtime one.
 */
function compileChannel(descriptor: any): Compiled | null {
  const entry = descriptor?.controlChannel;
  if (!entry || typeof entry !== 'object' || entry.status !== 'supported') return null;
  try {
    const errors: string[] = [];
    validateControlChannel(entry, 'controlChannel', errors);
    if (errors.some((error) => !error.startsWith('controlChannel.unverified'))) return null;
    return Object.freeze({
      argv: Object.freeze(entry.argv.slice()),
      commandPrefix: typeof entry.commandPrefix === 'string' ? entry.commandPrefix : null,
      graceSeconds: entry.close.graceSeconds,
      parser: typeof entry.parser === 'string' ? entry.parser : null,
      templates: Object.freeze({ followUp: entry.messages.followUp, steer: entry.messages.steer ?? null, stop: entry.messages.stop }),
      working: all(entry.turn.working),
      settled: all(entry.turn.settled),
      answer: entry.answer
        ? Object.freeze({ path: entry.answer.id.slice(), accepted: all(entry.answer.accepted), refused: all(entry.answer.refused) })
        : null,
    });
  } catch { return null; }
}

/** The row-173 seam: every person's text passes through here, identity in this row, before it is framed. */
function messageText(_kind: Kind, text: string): string { return text; }

function holdsText(template: Template): boolean {
  return Object.values(template).some((value) => value === TEXT || (value !== null && typeof value === 'object' && holdsText(value)));
}

function fill(template: Template, text: string, id: string): Template {
  const out: Template = {};
  for (const [key, value] of Object.entries(template)) {
    out[key] = value === TEXT ? text : value === ID ? id : value !== null && typeof value === 'object' ? fill(value, text, id) : value;
  }
  return out;
}

/** The person's text must be non-blank and within the 165 caps; null when it is. */
function textRefusal(text: unknown): 'prompt-empty' | 'prompt-too-long' | null {
  if (typeof text !== 'string' || text.trim() === '') return 'prompt-empty';
  if ([...text].length > CHANNEL_LIMITS.textCodePoints || Buffer.byteLength(text, 'utf8') > CHANNEL_LIMITS.textBytes) return 'prompt-too-long';
  return null;
}

function record(template: Template, text: string, id: string | null): Framed {
  const bytes = Buffer.from(`${JSON.stringify(fill(template, text, id ?? ''))}\n`, 'utf8');
  if (bytes.length > CHANNEL_LIMITS.recordBytes) return { ok: false, code: 'prompt-too-long' };
  return { ok: true, record: bytes, bytes: bytes.length };
}

/**
 * One record: `JSON.stringify` of the template with each whole-string placeholder replaced, then LF (design 4.3).
 * A template holding `{text}` refuses blank text (`prompt-empty`) and over-cap text (`prompt-too-long`); a record over
 * 64 KiB is refused `prompt-too-long`. A `stop` template holds no text, so `text` is ignored for it.
 */
function frame(template: Template, vars: { text?: string; id?: string | null }): Framed {
  const text = vars?.text;
  if (holdsText(template)) {
    const refused = textRefusal(text);
    if (refused) return { ok: false, code: refused };
  }
  return record(template, typeof text === 'string' ? text : '', vars?.id ?? null);
}

/** R-4: `command-not-allowed` when the descriptor declares a command prefix and the text starts with it (after leading whitespace). */
function commandRefusal(compiled: Compiled, text: string): 'command-not-allowed' | null {
  const prefix = compiled?.commandPrefix;
  if (!prefix || typeof text !== 'string') return null;
  return text.trimStart().startsWith(prefix) ? 'command-not-allowed' : null;
}

/**
 * The path every message takes to a record: `first` and `follow-up` use the follow-up template, `steer` its own
 * (`no-steer` when the descriptor has none), `stop` the stop template. The caps and the command prefix apply to the
 * person's text; `messageText` runs after them, so a later frame cannot push a person's text over a cap unseen.
 */
function frameMessage(compiled: Compiled, kind: Kind, vars: { text?: string; id?: string | null }): Framed {
  if (kind === 'stop') return record(compiled.templates.stop, '', vars?.id ?? null);
  const template = kind === 'steer' ? compiled.templates.steer : compiled.templates.followUp;
  if (!template) return { ok: false, code: 'no-steer' };
  const refused = textRefusal(vars?.text) ?? commandRefusal(compiled, vars.text as string);
  if (refused) return { ok: false, code: refused };
  return record(template, messageText(kind, vars.text as string), vars?.id ?? null);
}

/** The id placeholder value of ledger entry `seq`, read back by `answerOf`. */
function idOf(seq: number): string { return `d-${seq}`; }

/** `{ seq, answer }` when the event carries an answer id `d-<seq>` and one of the answer test lists matches; else null. */
function answerOf(compiled: Compiled, event: any): { seq: number; answer: 'accepted' | 'refused' } | null {
  const answer = compiled?.answer;
  if (!answer) return null;
  const found = read(event, answer.path);
  if (!found.present || typeof found.value !== 'string') return null;
  const match = ANSWER_ID.exec(found.value);
  if (!match) return null;
  const seq = Number(match[1]);
  if (answer.accepted(event)) return { seq, answer: 'accepted' };
  if (answer.refused(event)) return { seq, answer: 'refused' };
  return null;
}

/**
 * Design section 7. Starts not observed (`no-event-yet`); a `working` event is working, a `settled` event waiting, with
 * `since` and a `seq` that rises once per observed transition. An answer `refused` while still `no-event-yet` reads as
 * `message-refused`. Nothing else infers a state.
 */
class TurnTracker {
  private current: Turn = { observed: false, reason: 'no-event-yet', since: null };
  private seq = 0;
  private readonly compiled: Compiled;
  private readonly now: () => number;
  constructor(compiled: Compiled, now: () => number = Date.now) { this.compiled = compiled; this.now = now; }

  get turn(): Turn { return { ...this.current } as Turn; }

  /** Feeds one parsed stdout event; `changed` says the turn changed, `answer` is its answer correlation, if any. */
  feed(event: any): { changed: boolean; answer: { seq: number; answer: 'accepted' | 'refused' } | null } {
    const answer = answerOf(this.compiled, event);
    const next = this.compiled.settled(event) ? 'waiting' : this.compiled.working(event) ? 'working' : null;
    if (next !== null) {
      if (this.current.observed && this.current.state === next) return { changed: false, answer };
      this.seq += 1;
      this.current = { observed: true, state: next, since: new Date(this.now()).toISOString(), seq: this.seq };
      return { changed: true, answer };
    }
    if (answer?.answer === 'refused' && !this.current.observed && this.current.reason === 'no-event-yet') {
      this.current = { observed: false, reason: 'message-refused', since: new Date(this.now()).toISOString() };
      return { changed: true, answer };
    }
    return { changed: false, answer };
  }
}

/** The oldest-first counted entries of `actor` of `kinds` written inside `windowMs` of `now`; their ms stamps. */
function stamps(ledger: readonly LedgerEntry[], actor: string, kinds: string[], windowMs: number, now: number): number[] {
  const out: number[] = [];
  for (const entry of ledger ?? []) {
    if (entry?.by !== actor || entry.outcome !== 'written' || !kinds.includes(entry.kind)) continue;
    const at = Date.parse(entry.at);
    if (Number.isFinite(at) && at > now - windowMs && at <= now) out.push(at);
  }
  return out.sort((a, b) => a - b);
}

/** Seconds until the entry that must age out for one more to fit has left its window; at least 1. */
function retryAfter(found: number[], limit: number, windowMs: number, now: number): number {
  return Math.max(1, Math.ceil((found[found.length - limit] + windowMs - now) / 1000));
}

/**
 * D6, exact at the supervisor and pre-checked by the verb. Counted per actor from the ledger entries that were
 * written: follow-ups and steers together 6 a minute and 60 an hour, stops 6 a minute. `waiting` is the number of
 * messages queued and not yet written (the spool files); a fifth is `channel-busy`, never for a stop. A `first` entry
 * (the starter's prompt) counts toward nothing.
 */
function admit(ledger: readonly LedgerEntry[], actor: string, kind: 'follow-up' | 'steer' | 'stop', now: number, waiting: number = 0): Admission {
  if (kind === 'stop') {
    const minute = stamps(ledger, actor, ['stop'], MINUTE_MS, now);
    return minute.length >= CHANNEL_LIMITS.stopsPerMinute
      ? { ok: false, code: 'actor-rate-limited', retryAfterSeconds: retryAfter(minute, CHANNEL_LIMITS.stopsPerMinute, MINUTE_MS, now) }
      : { ok: true };
  }
  if (waiting >= CHANNEL_LIMITS.waiting) return { ok: false, code: 'channel-busy' };
  const kinds = ['follow-up', 'steer'];
  const hour = stamps(ledger, actor, kinds, HOUR_MS, now);
  const minute = hour.filter((at) => at > now - MINUTE_MS);
  const waits: number[] = [];
  if (minute.length >= CHANNEL_LIMITS.messagesPerMinute) waits.push(retryAfter(minute, CHANNEL_LIMITS.messagesPerMinute, MINUTE_MS, now));
  if (hour.length >= CHANNEL_LIMITS.messagesPerHour) waits.push(retryAfter(hour, CHANNEL_LIMITS.messagesPerHour, HOUR_MS, now));
  return waits.length > 0 ? { ok: false, code: 'actor-rate-limited', retryAfterSeconds: Math.max(...waits) } : { ok: true };
}

type Timer = { handle: any };

/**
 * D9: turn writes at most once per 250 ms. The first `push` after a quiet spell writes at once; a push inside the
 * interval keeps only the newest turn and writes it when the interval ends (trailing), so the last state is never
 * lost. `flush()` writes a pending turn now (call it before the run record closes). `write` must not throw: it runs
 * from a timer. The clock and timers are injectable.
 */
function createTurnCoalescer(
  write: (turn: Turn) => void,
  opts: { intervalMs?: number; now?: () => number; setTimer?: (fn: () => void, ms: number) => any; clearTimer?: (handle: any) => void } = {},
): { push(turn: Turn): void; flush(): void } {
  const intervalMs = opts.intervalMs ?? COALESCE_MS;
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? setTimeout;
  const clearTimer = opts.clearTimer ?? clearTimeout;
  let lastWrite = -Infinity;
  let pending: Turn | null = null;
  const timer: Timer = { handle: null };

  function emit(): void {
    if (timer.handle !== null) { clearTimer(timer.handle); timer.handle = null; }
    if (pending === null) return;
    const turn = pending;
    pending = null;
    lastWrite = now();
    write(turn);
  }

  return {
    push(turn: Turn): void {
      pending = turn;
      const wait = lastWrite + intervalMs - now();
      if (wait <= 0) { emit(); return; }
      if (timer.handle === null) timer.handle = setTimer(() => { timer.handle = null; emit(); }, wait);
    },
    flush: emit,
  };
}

module.exports = {
  CHANNEL_LIMITS, compileChannel, messageText, frame, frameMessage, commandRefusal, idOf, answerOf, TurnTracker, admit, createTurnCoalescer,
};
