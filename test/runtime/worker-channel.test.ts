'use strict';

// Row 170 T3: the pure channel core (design 4.3, 5.2 steps 3-4, 7, D6, D9; owner ruling R-4).

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CHANNEL_LIMITS, compileChannel, messageText, frame, frameMessage, commandRefusal, idOf, answerOf, TurnTracker, admit, createTurnCoalescer,
} = require('../../src/runtime/worker/channel.ts');
const { PARSERS, parserOf } = require('../../src/runtime/worker/parsers.ts');
const { PROMPT_MAX } = require('../../src/runtime/worker/session-prompt.ts');

// A channel shaped like Pi's RPC mode (design 4.3): one follow-up record for the first prompt and later ones.
function piLike(extra: any = {}) {
  return {
    controlChannel: {
      status: 'supported', evidence: ['test'], verification: 'v', verifiedOn: '2026-11-17',
      argv: ['--mode', 'rpc'], framing: 'jsonl-lf', parser: 'pi-json-v1', commandPrefix: '/',
      messages: {
        followUp: { type: 'prompt', message: '{text}', streamingBehavior: 'followUp', id: '{id}' },
        steer: { type: 'steer', message: '{text}', id: '{id}' },
        stop: { type: 'abort', id: '{id}' },
      },
      turn: { working: [{ path: ['type'], equals: 'agent_start' }], settled: [{ path: ['type'], equals: 'agent_end' }] },
      answer: {
        id: ['id'],
        accepted: [{ path: ['type'], equals: 'response' }, { path: ['success'], equals: true }],
        refused: [{ path: ['type'], equals: 'response' }, { path: ['success'], equals: false }],
      },
      close: { stdinEof: 'exits', graceSeconds: 5 },
      unverified: ['everything: declared from docs only'],
      ...extra,
    },
  };
}

function channel(extra: any = {}) {
  const compiled = compileChannel(piLike(extra));
  assert.ok(compiled, 'the fixture compiles');
  return compiled;
}

test('compileChannel: null unless supported, null for an entry that no longer validates, frozen otherwise', () => {
  assert.equal(compileChannel({}), null);
  assert.equal(compileChannel(null), null);
  assert.equal(compileChannel({ controlChannel: { status: 'unknown', evidence: [], verification: 'v', verifiedOn: '2026-11-17', reason: 'r' } }), null);
  const broken: any = piLike();
  broken.controlChannel.turn.working = [{ path: ['type'] }];
  assert.equal(compileChannel(broken), null);
  const compiled = channel();
  assert.ok(Object.isFrozen(compiled));
  assert.deepEqual(compiled.argv, ['--mode', 'rpc']);
  assert.equal(compiled.commandPrefix, '/');
  assert.equal(compiled.graceSeconds, 5);
  assert.equal(compiled.parser, 'pi-json-v1');
  // a live-run record in place of `unverified` is the guard's rule, not a reason to drop the channel here
  const noUnverified: any = piLike();
  delete noUnverified.controlChannel.unverified;
  assert.ok(compileChannel(noUnverified));
});

test('frame: LF, CR, quote, U+2028 and a {text} literal give one LF-ended line that parses back to the same text', () => {
  const compiled = channel();
  const text = 'a\nb\rc"d e {text} {id} \\ \u0000 end';
  const framed = frame(compiled.templates.followUp, { text, id: 'd-7' });
  assert.equal(framed.ok, true);
  const raw: Buffer = framed.record;
  const str = raw.toString('utf8');
  assert.equal(str.endsWith('\n'), true);
  assert.equal(str.slice(0, -1).includes('\n'), false, 'one line');
  assert.equal(str.slice(0, -1).includes('\r'), false);
  assert.ok(str.includes(' '), 'U+2028 stays raw');
  assert.deepEqual(JSON.parse(str), { type: 'prompt', message: text, streamingBehavior: 'followUp', id: 'd-7' });
  assert.equal(framed.bytes, raw.length);
});

test('frame: caps and blank text refuse; a stop record needs no text', () => {
  const compiled = channel();
  const follow = compiled.templates.followUp;
  assert.deepEqual(frame(follow, { text: 'x'.repeat(PROMPT_MAX.codePoints), id: 'd-1' }).ok, true);
  assert.deepEqual(frame(follow, { text: 'x'.repeat(PROMPT_MAX.codePoints + 1), id: 'd-1' }), { ok: false, code: 'prompt-too-long' });
  assert.deepEqual(frame(follow, { text: '\u{1F600}'.repeat(PROMPT_MAX.codePoints), id: 'd-1' }).ok, true, 'code points, not UTF-16 units');
  assert.deepEqual(frame(follow, { text: '', id: 'd-1' }), { ok: false, code: 'prompt-empty' });
  assert.deepEqual(frame(follow, { text: ' \n\t ', id: 'd-1' }), { ok: false, code: 'prompt-empty' });
  assert.deepEqual(frame(follow, { id: 'd-1' } as any), { ok: false, code: 'prompt-empty' });
  const stop = frame(compiled.templates.stop, { id: 'd-2' });
  assert.equal(stop.ok, true);
  assert.deepEqual(JSON.parse(stop.record.toString('utf8')), { type: 'abort', id: 'd-2' });
});

test('frame: a framed record over 64 KiB is refused prompt-too-long even when the text is within its cap', () => {
  // The widest grammar-valid template with the 8000 code point cap tops out near 65.1 KB, so this cap is a backstop
  // (as 165's byte cap is); frame itself takes any template, so a wider one shows it holds. 8000 NULs escape to 6 bytes each.
  const fat: any = {};
  for (let i = 0; i < 12; i += 1) {
    const inner: any = {};
    for (let j = 0; j < 8; j += 1) inner[`k${j}`] = 'z'.repeat(200);
    fat[`o${i}`] = inner;
  }
  fat.o11.k7 = '{text}';
  const text = '\u0000'.repeat(8000);
  const bytes = Buffer.byteLength(`${JSON.stringify({ ...fat, o11: { ...fat.o11, k7: text } })}\n`);
  assert.ok(bytes > CHANNEL_LIMITS.recordBytes, `the fixture record is ${bytes} bytes`);
  assert.deepEqual(frame(fat, { text }), { ok: false, code: 'prompt-too-long' });
  assert.equal(frame(fat, { text: 'short' }).ok, true);
  assert.equal(frame(fat, { text: '\u0000'.repeat(2000) }).ok, true);
});

test('CHANNEL_LIMITS: the D6 numbers, with 165 text caps by reference', () => {
  assert.deepEqual({ ...CHANNEL_LIMITS }, {
    messagesPerMinute: 6, messagesPerHour: 60, stopsPerMinute: 6, waiting: 4,
    textCodePoints: PROMPT_MAX.codePoints, textBytes: PROMPT_MAX.bytes, recordBytes: 65536,
  });
  assert.ok(Object.isFrozen(CHANNEL_LIMITS));
});

test('messageText is the identity every message passes through; frameMessage uses it before framing', () => {
  assert.equal(messageText('follow-up', 'hello'), 'hello');
  assert.equal(messageText('steer', ' x '), ' x ');
  const compiled = channel();
  const sent = frameMessage(compiled, 'first', { text: 'hello', id: 'd-1' });
  assert.equal(sent.ok, true);
  assert.equal(JSON.parse(sent.record.toString('utf8')).message, 'hello');
  assert.equal(JSON.parse(frameMessage(compiled, 'steer', { text: 'hi', id: 'd-2' }).record.toString('utf8')).type, 'steer');
  assert.equal(JSON.parse(frameMessage(compiled, 'stop', { id: 'd-3' }).record.toString('utf8')).type, 'abort');
});

test('frameMessage: refuses blank, over-cap and command-prefixed text, and a steer a descriptor does not declare', () => {
  const compiled = channel();
  assert.deepEqual(frameMessage(compiled, 'follow-up', { text: '  ', id: 'd-1' }), { ok: false, code: 'prompt-empty' });
  assert.deepEqual(frameMessage(compiled, 'follow-up', { text: 'x'.repeat(8001), id: 'd-1' }), { ok: false, code: 'prompt-too-long' });
  assert.deepEqual(frameMessage(compiled, 'first', { text: '/quit', id: 'd-1' }), { ok: false, code: 'command-not-allowed' });
  assert.deepEqual(frameMessage(compiled, 'steer', { text: '  /compact', id: 'd-1' }), { ok: false, code: 'command-not-allowed' });
  assert.equal(frameMessage(compiled, 'follow-up', { text: 'see /quit', id: 'd-1' }).ok, true);
  const noSteer: any = piLike();
  delete noSteer.controlChannel.messages.steer;
  assert.deepEqual(frameMessage(compileChannel(noSteer), 'steer', { text: 'x', id: 'd-1' }), { ok: false, code: 'no-steer' });
});

test('commandRefusal (R-4): "/x" and "  /x" refused, "a /x" allowed, no prefix allows everything, no rewrite', () => {
  const compiled = channel();
  assert.equal(commandRefusal(compiled, '/x'), 'command-not-allowed');
  assert.equal(commandRefusal(compiled, '  /x'), 'command-not-allowed');
  assert.equal(commandRefusal(compiled, '\n\t/x'), 'command-not-allowed');
  assert.equal(commandRefusal(compiled, 'a /x'), null);
  assert.equal(commandRefusal(compiled, ''), null);
  const bare: any = piLike();
  delete bare.controlChannel.commandPrefix;
  const free = compileChannel(bare);
  assert.equal(free.commandPrefix, null);
  assert.equal(commandRefusal(free, '/x'), null);
  assert.equal(commandRefusal(free, '  /x'), null);
  const multi = channel({ commandPrefix: '::' });
  assert.equal(commandRefusal(multi, ' ::x'), 'command-not-allowed');
  assert.equal(commandRefusal(multi, ':x'), null);
});

const T0 = Date.parse('2026-11-17T10:00:00.000Z');

test('TurnTracker: not observed -> working -> waiting -> working, one seq per transition, none for a repeat', () => {
  let clock = T0;
  const tracker = new TurnTracker(channel(), () => clock);
  assert.deepEqual(tracker.turn, { observed: false, reason: 'no-event-yet', since: null });
  assert.deepEqual(tracker.feed({ type: 'noise' }), { changed: false, answer: null });
  assert.equal(tracker.turn.observed, false);

  clock += 1000;
  assert.equal(tracker.feed({ type: 'agent_start' }).changed, true);
  assert.deepEqual(tracker.turn, { observed: true, state: 'working', since: new Date(clock).toISOString(), seq: 1 });
  clock += 1000;
  assert.equal(tracker.feed({ type: 'agent_start' }).changed, false, 'the same state again is no transition');
  assert.equal(tracker.turn.seq, 1);
  assert.equal(tracker.turn.since, new Date(T0 + 1000).toISOString());

  clock += 1000;
  tracker.feed({ type: 'agent_end' });
  assert.deepEqual(tracker.turn, { observed: true, state: 'waiting', since: new Date(clock).toISOString(), seq: 2 });
  clock += 1000;
  tracker.feed({ type: 'agent_start' });
  assert.deepEqual(tracker.turn, { observed: true, state: 'working', since: new Date(clock).toISOString(), seq: 3 });
});

test('TurnTracker: a refused answer before any event reads message-refused, once; later events still observe', () => {
  let clock = T0;
  const tracker = new TurnTracker(channel(), () => clock);
  const refused = tracker.feed({ type: 'response', id: 'd-1', success: false });
  assert.deepEqual(refused, { changed: true, answer: { seq: 1, answer: 'refused' } });
  assert.deepEqual(tracker.turn, { observed: false, reason: 'message-refused', since: new Date(T0).toISOString() });
  clock += 500;
  assert.equal(tracker.feed({ type: 'response', id: 'd-2', success: false }).changed, false);
  assert.equal(tracker.turn.since, new Date(T0).toISOString());
  tracker.feed({ type: 'agent_start' });
  assert.equal(tracker.turn.observed, true);

  // an accepted answer never changes the turn, and a refusal once observed does not unobserve it
  const second = new TurnTracker(channel(), () => clock);
  assert.deepEqual(second.feed({ type: 'response', id: 'd-1', success: true }), { changed: false, answer: { seq: 1, answer: 'accepted' } });
  assert.equal(second.turn.observed === false && second.turn.reason, 'no-event-yet');
  second.feed({ type: 'agent_start' });
  assert.equal(second.feed({ type: 'response', id: 'd-3', success: false }).changed, false);
  assert.equal(second.turn.observed, true);
});

test('answerOf: d-<seq> with a matching test list; anything else is null', () => {
  const compiled = channel();
  assert.equal(idOf(12), 'd-12');
  assert.deepEqual(answerOf(compiled, { type: 'response', id: 'd-12', success: true }), { seq: 12, answer: 'accepted' });
  assert.deepEqual(answerOf(compiled, { type: 'response', id: 'd-3', success: false }), { seq: 3, answer: 'refused' });
  assert.equal(answerOf(compiled, { type: 'response', id: 'x-3', success: true }), null);
  assert.equal(answerOf(compiled, { type: 'response', id: 'd-0', success: true }), null);
  assert.equal(answerOf(compiled, { type: 'response', id: 'd-3x', success: true }), null);
  assert.equal(answerOf(compiled, { type: 'response', id: 7, success: true }), null);
  assert.equal(answerOf(compiled, { type: 'response', success: true }), null);
  assert.equal(answerOf(compiled, { type: 'response', id: 'd-3', success: 'yes' }), null);
  assert.equal(answerOf(compiled, 'text'), null);
  const bare: any = piLike();
  delete bare.controlChannel.answer;
  for (const kind of ['followUp', 'steer', 'stop']) delete bare.controlChannel.messages[kind].id;
  assert.equal(answerOf(compileChannel(bare), { type: 'response', id: 'd-1', success: true }), null);
});

function ledger(entries: Array<[string, string, number]>, by = 'alice', outcome = 'written') {
  return entries.map(([kind, who, agoMs], i) => ({ seq: i + 1, kind, by: who || by, at: new Date(T0 - agoMs).toISOString(), outcome }));
}

test('admit: the 7th message in a minute is refused with retryAfterSeconds; follow-up and steer count together', () => {
  const six = ledger([['follow-up', '', 50000], ['steer', '', 40000], ['follow-up', '', 30000], ['steer', '', 20000], ['follow-up', '', 10000], ['follow-up', '', 5000]]);
  const refused = admit(six, 'alice', 'follow-up', T0);
  assert.deepEqual(refused, { ok: false, code: 'actor-rate-limited', retryAfterSeconds: 10 });
  assert.deepEqual(admit(six, 'alice', 'steer', T0), refused);
  assert.deepEqual(admit(six, 'alice', 'follow-up', T0 + 10000), { ok: true }, 'the oldest left its minute');
  assert.deepEqual(admit(six.slice(1), 'alice', 'follow-up', T0), { ok: true }, 'five in the minute');
  assert.deepEqual(admit(six, 'bob', 'follow-up', T0), { ok: true }, 'another actor has its own budget');
  assert.deepEqual(admit(six.map((e: any) => ({ ...e, outcome: 'refused' })), 'alice', 'follow-up', T0), { ok: true }, 'a refused entry costs nothing');
  assert.deepEqual(admit(six.map((e: any) => ({ ...e, kind: 'first' })), 'alice', 'follow-up', T0), { ok: true }, 'the starter\'s first prompt counts toward nothing');
  assert.deepEqual(admit([], 'alice', 'follow-up', T0), { ok: true });
});

test('admit: the 61st message in an hour is refused with the wait until the oldest leaves the hour', () => {
  const sixty = ledger(Array.from({ length: 60 }, (_, i) => ['follow-up', '', 3000000 + i * 10000] as [string, string, number]));
  // oldest is 3590000 ms ago: leaves the hour in 10 s
  const refused = admit(sixty, 'alice', 'steer', T0);
  assert.deepEqual(refused, { ok: false, code: 'actor-rate-limited', retryAfterSeconds: 10 });
  assert.deepEqual(admit(sixty.slice(1), 'alice', 'follow-up', T0), { ok: true }, '59 in the hour');
  // 60 in the hour and 6 in the minute: both windows must open, so the longer wait (the hour's oldest, 3530 s ago) is reported
  const mixed = ledger([...Array.from({ length: 54 }, (_, i) => ['follow-up', '', 3000000 + i * 10000] as [string, string, number]), ...Array.from({ length: 6 }, (_, i) => ['follow-up', '', 55000 - i * 1000] as [string, string, number])]);
  assert.deepEqual(admit(mixed, 'alice', 'follow-up', T0), { ok: false, code: 'actor-rate-limited', retryAfterSeconds: 70 });
});

test('admit: the 7th stop in a minute is refused; stops do not spend the message budget and vice versa', () => {
  const stops = ledger(Array.from({ length: 6 }, (_, i) => ['stop', '', 50000 - i * 5000] as [string, string, number]));
  assert.deepEqual(admit(stops, 'alice', 'stop', T0), { ok: false, code: 'actor-rate-limited', retryAfterSeconds: 10 });
  assert.deepEqual(admit(stops.slice(1), 'alice', 'stop', T0), { ok: true });
  assert.deepEqual(admit(stops, 'alice', 'follow-up', T0), { ok: true });
  const messages = ledger(Array.from({ length: 6 }, (_, i) => ['follow-up', '', 50000 - i * 5000] as [string, string, number]));
  assert.deepEqual(admit(messages, 'alice', 'stop', T0), { ok: true });
});

test('admit: the 5th waiting message is channel-busy (no retryAfterSeconds); a stop is never refused for it', () => {
  assert.deepEqual(admit([], 'alice', 'follow-up', T0, 3), { ok: true });
  assert.deepEqual(admit([], 'alice', 'follow-up', T0, 4), { ok: false, code: 'channel-busy' });
  assert.deepEqual(admit([], 'alice', 'steer', T0, 9), { ok: false, code: 'channel-busy' });
  assert.deepEqual(admit([], 'alice', 'stop', T0, 4), { ok: true });
  assert.deepEqual(admit([], 'alice', 'stop', T0, 99), { ok: true });
  // busy is reported before the rate: the person can do something about it at once
  const six = ledger(Array.from({ length: 6 }, (_, i) => ['follow-up', '', 50000 - i * 5000] as [string, string, number]));
  assert.equal((admit(six, 'alice', 'follow-up', T0, 4) as any).code, 'channel-busy');
});

function fakeClock() {
  const state: any = { now: 0, timers: [] as any[], next: 1 };
  state.setTimer = (fn: () => void, ms: number) => { const timer = { id: state.next++, at: state.now + ms, fn }; state.timers.push(timer); return timer.id; };
  state.clearTimer = (id: number) => { state.timers = state.timers.filter((timer: any) => timer.id !== id); };
  state.advance = (ms: number) => {
    const end = state.now + ms;
    for (;;) {
      const due = state.timers.filter((timer: any) => timer.at <= end).sort((a: any, b: any) => a.at - b.at)[0];
      if (!due) break;
      state.timers = state.timers.filter((timer: any) => timer !== due);
      state.now = due.at;
      due.fn();
    }
    state.now = end;
  };
  return state;
}

const turnAt = (seq: number) => ({ observed: true, state: seq % 2 ? 'working' : 'waiting', since: 'x', seq });

test('coalescer: the first write is immediate, a burst writes only its last state once the interval ends', () => {
  const clock = fakeClock();
  const writes: any[] = [];
  const coalescer = createTurnCoalescer((turn: any) => writes.push([clock.now, turn.seq]), { now: () => clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  coalescer.push(turnAt(1));
  assert.deepEqual(writes, [[0, 1]]);
  clock.advance(10); coalescer.push(turnAt(2));
  clock.advance(10); coalescer.push(turnAt(3));
  clock.advance(10); coalescer.push(turnAt(4));
  assert.deepEqual(writes, [[0, 1]], 'inside 250 ms nothing more is written');
  clock.advance(219);
  assert.deepEqual(writes, [[0, 1]]);
  clock.advance(1);
  assert.deepEqual(writes, [[0, 1], [250, 4]], 'the trailing write carries the last state');
  clock.advance(1000);
  assert.deepEqual(writes, [[0, 1], [250, 4]], 'nothing pending, nothing written');
  coalescer.push(turnAt(5));
  assert.deepEqual(writes[2], [1250, 5], 'after a quiet spell the next write is immediate');
});

test('coalescer: at most one write per 250 ms under a steady stream, the last state never lost, flush writes now', () => {
  const clock = fakeClock();
  const writes: any[] = [];
  const coalescer = createTurnCoalescer((turn: any) => writes.push([clock.now, turn.seq]), { now: () => clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  for (let seq = 1; seq <= 100; seq += 1) { coalescer.push(turnAt(seq)); clock.advance(10); }
  clock.advance(250);
  assert.equal(writes[writes.length - 1][1], 100, 'the last state is written');
  for (let i = 1; i < writes.length; i += 1) assert.ok(writes[i][0] - writes[i - 1][0] >= 250, `gap ${writes[i][0] - writes[i - 1][0]}`);
  assert.ok(writes.length <= 6, `${writes.length} writes for 1 s of events`);

  const before = writes.length;
  coalescer.push(turnAt(101));
  coalescer.push(turnAt(102));
  assert.equal(writes.length, before + 1, 'the first of the pair writes at once');
  coalescer.flush();
  assert.equal(writes.length, before + 2);
  assert.equal(writes[writes.length - 1][1], 102);
  clock.advance(1000);
  assert.equal(writes.length, before + 2, 'flush cancelled the timer; no double write');
  coalescer.flush();
  assert.equal(writes.length, before + 2, 'flush of nothing writes nothing');
});

test('parserOf(descriptor, "channel") resolves the channel parser the way main resolves mainSession.parser', () => {
  const descriptor: any = { ...piLike(), mainSession: { parser: 'doflow-jsonl-v1' }, structuredOutput: { parser: 'codex-exec-json-v1' } };
  assert.equal(parserOf(descriptor, 'channel'), PARSERS['pi-json-v1']);
  assert.equal(parserOf(descriptor, 'main'), PARSERS['doflow-jsonl-v1']);
  assert.equal(parserOf(descriptor, 'structured'), PARSERS['codex-exec-json-v1']);
  assert.equal(parserOf(descriptor, 'channel').create().end().parser, 'pi-json-v1');
});
