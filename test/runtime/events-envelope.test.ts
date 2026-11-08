'use strict';

// Feature 149 A.3: the events envelope (IC-002), channel grammar (IC-003) and masking and frame cap (IC-007).

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createEnvelopeWriter, newEpoch, maskJson, maskSections,
  ENVELOPE_VERSION, FRAME_TYPES, ERROR_CODES, RESET_REASONS, LINE_CAP_BYTES, ENVELOPE_ID, EPOCH_PATTERN, LOG_ID,
} = require('../../src/runtime/events/envelope.ts');
const { parseChannel, parseChannelList, isChannelId, CHANNEL_LIMIT, CHANNEL_KINDS } = require('../../src/runtime/events/channels.ts');
const { ID_PATTERN } = require('../../src/runtime/context/identity.ts');

const T0 = Date.UTC(2026, 10, 7, 12, 0, 0, 0);
const EPOCH = '3f9a0c12';
const RUN = 'run:feat-a:A.3';

function fixedWriter(epoch = EPOCH) {
  let tick = 0;
  return createEnvelopeWriter({ epoch, clock: () => T0 + (tick++) });
}

const parse = (lines: string[]) => lines.map((line) => {
  assert.ok(line.endsWith('\n'), 'every envelope ends in a newline');
  assert.equal(line.indexOf('\n'), line.length - 1, 'no raw newline inside an envelope');
  return JSON.parse(line);
});

const nOf = (id: string) => Number(id.split('-')[1]);
const bytes = (line: string) => Buffer.byteLength(line, 'utf8');

function assertEnvelope(env: any, ch: string, type: string) {
  assert.deepEqual(Object.keys(env), ['v', 'ch', 'id', 'type', 'at', 'data']);
  assert.equal(env.v, 1);
  assert.equal(env.ch, ch);
  assert.match(env.id, ENVELOPE_ID);
  assert.equal(env.type, type);
  assert.ok(FRAME_TYPES.includes(env.type));
  assert.match(env.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
}

test('exported constants match IC-002 and IC-007', () => {
  assert.equal(ENVELOPE_VERSION, 1);
  assert.deepEqual([...FRAME_TYPES], ['snapshot', 'patch', 'append', 'reset', 'error', 'gone']);
  assert.deepEqual([...ERROR_CODES], ['unsupported-version', 'store-unreadable', 'producer-failed', 'too-many-channels']);
  assert.deepEqual([...RESET_REASONS], ['frame-cap', 'replaced']);
  assert.equal(LINE_CAP_BYTES, 262144);
  assert.equal(CHANNEL_LIMIT, 64);
  assert.deepEqual([...CHANNEL_KINDS], ['now', 'run', 'tasks', 'worker', 'log']);
  assert.ok(Object.isFrozen(FRAME_TYPES) && Object.isFrozen(ERROR_CODES) && Object.isFrozen(RESET_REASONS));
});

test('id grammar: accepts <8 hex>-<n>, refuses other forms', () => {
  for (const id of ['3f9a0c12-1', '00000000-17', 'ffffffff-9999999999999999']) assert.match(id, ENVELOPE_ID);
  for (const id of ['3f9a0c12-0', '3f9a0c12-01', '3F9A0C12-1', '3f9a0c1-1', '3f9a0c12-', '3f9a0c12-10000000000000000', '3f9a0c12_1']) {
    assert.doesNotMatch(id, ENVELOPE_ID, id);
  }
});

test('epoch: random 8 lowercase hex, injectable, refused when malformed', () => {
  const minted = new Set(Array.from({ length: 20 }, () => newEpoch()));
  for (const epoch of minted) assert.match(epoch, EPOCH_PATTERN);
  assert.ok(minted.size > 1, 'epochs are random');
  assert.match(createEnvelopeWriter().epoch, EPOCH_PATTERN);
  assert.equal(createEnvelopeWriter({ epoch: EPOCH }).epoch, EPOCH);
  for (const epoch of ['3F9A0C12', '3f9a0c1', '3f9a0c123', 'zzzzzzzz']) assert.throws(() => createEnvelopeWriter({ epoch }), TypeError);
  assert.throws(() => createEnvelopeWriter({ clock: 5 as any }), TypeError);
});

test('n starts at 1 per channel and rises by one with every frame on that channel', () => {
  const writer = fixedWriter();
  const section = { status: { exit: 0, json: { phase: 'running' } } };
  const frames = parse([
    ...writer.snapshot(RUN, section),
    ...writer.snapshot('now', { list: { exit: 0, json: [] } }),
    ...writer.patch(RUN, { status: { exit: 0, json: { phase: 'ended' } } }),
    ...writer.error(RUN, 'store-unreadable'),
    ...writer.snapshot(RUN, section),
    ...writer.patch('now', { list: { exit: 0, json: [1] } }),
    ...writer.reset(RUN, 'replaced'),
    ...writer.snapshot(RUN, section),
    ...writer.gone(RUN),
  ]);
  for (const env of frames) assert.equal(env.id.split('-')[0], EPOCH);
  assert.deepEqual(frames.filter((env) => env.ch === RUN).map((env) => nOf(env.id)), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(frames.filter((env) => env.ch === 'now').map((env) => nOf(env.id)), [1, 2]);
  // `at` is the injected clock, ISO-8601 UTC with milliseconds.
  assert.equal(frames[0].at, '2026-11-07T12:00:00.000Z');
  assert.equal(frames[1].at, '2026-11-07T12:00:00.001Z');
});

test('every emitted type carries its IC-002 data shape', () => {
  const writer = fixedWriter();
  const [snap] = parse(writer.snapshot(RUN, { status: { exit: 0, json: { a: 1 } }, timeline: { exit: 1, json: null } }));
  assertEnvelope(snap, RUN, 'snapshot');
  assert.deepEqual(snap.data, { sections: { status: { exit: 0, json: { a: 1 } }, timeline: { exit: 1, json: null } } });

  const [patch] = parse(writer.patch(RUN, { status: { exit: 0, json: { a: 2 } } }, ['timeline']));
  assertEnvelope(patch, RUN, 'patch');
  assert.deepEqual(patch.data, { sections: { status: { exit: 0, json: { a: 2 } } }, removed: ['timeline'] });

  const [onlyRemoved] = parse(writer.patch(RUN, {}, ['status']));
  assert.deepEqual(onlyRemoved.data, { sections: {}, removed: ['status'] });
  assert.deepEqual(writer.patch(RUN, {}), [], 'nothing changed: no line and no n spent');

  for (const reason of RESET_REASONS) {
    writer.snapshot(RUN, {});
    const [reset] = parse(writer.reset(RUN, reason));
    assertEnvelope(reset, RUN, 'reset');
    assert.deepEqual(reset.data, { reason });
  }
  for (const code of ERROR_CODES) {
    const [error] = parse(writer.error(RUN, code));
    assertEnvelope(error, RUN, 'error');
    assert.deepEqual(error.data, { code });
  }
  const [gone] = parse(writer.gone('tasks:feat-a'));
  assertEnvelope(gone, 'tasks:feat-a', 'gone');
  assert.deepEqual(gone.data, {});

  // `append` is the log frame (IC-007): the writer has `append` and `logSnapshot`, and `append` stays in the type grammar.
  assert.ok(FRAME_TYPES.includes('append'));
  assert.equal(typeof (writer as any).append, 'function');
  assert.deepEqual(Object.keys(writer).sort(), ['append', 'epoch', 'error', 'gone', 'logSnapshot', 'needsSnapshot', 'patch', 'reset', 'snapshot']);
});

test('order: a channel owes a snapshot first and after reset, error or gone', () => {
  const writer = fixedWriter();
  const section = { status: { exit: 0, json: {} } };
  assert.equal(writer.needsSnapshot(RUN), true);
  assert.throws(() => writer.patch(RUN, section), /owes a snapshot/);
  writer.snapshot(RUN, section);
  assert.equal(writer.needsSnapshot(RUN), false);
  writer.patch(RUN, section);
  for (const close of [() => writer.reset(RUN, 'replaced'), () => writer.error(RUN, 'producer-failed'), () => writer.gone(RUN)]) {
    close();
    assert.equal(writer.needsSnapshot(RUN), true);
    assert.throws(() => writer.patch(RUN, section), /owes a snapshot/);
    writer.snapshot(RUN, section);
  }
});

test('the writer refuses malformed input', () => {
  const writer = fixedWriter();
  assert.throws(() => writer.snapshot('worker:w-0123456789ab:out', {}), TypeError);
  assert.throws(() => writer.snapshot(RUN, { status: { exit: 256, json: null } }), TypeError);
  assert.throws(() => writer.snapshot(RUN, { status: { exit: 1.5, json: null } }), TypeError);
  assert.throws(() => writer.snapshot(RUN, { status: 'x' } as any), TypeError);
  assert.throws(() => writer.snapshot(RUN, [] as any), TypeError);
  assert.throws(() => writer.reset(RUN, 'core-reset'), TypeError);
  assert.throws(() => writer.error(RUN, 'events-down'), TypeError);
  writer.snapshot(RUN, {});
  assert.throws(() => writer.patch(RUN, { status: { exit: 0, json: 1 } }, ['status']), TypeError);
  assert.throws(() => writer.patch(RUN, {}, [''] as any), TypeError);
  // An absent json becomes null.
  const [env] = parse(writer.snapshot(RUN, { status: { exit: 0 } as any }));
  assert.deepEqual(env.data.sections.status, { exit: 0, json: null });
});

test('masking: secret, email, IP and absolute paths in section json are masked; keys stay', () => {
  const home = process.env.HOME;
  process.env.HOME = '/home/test';
  try {
    const secret = `ghp_${'A1b2C3d4E5f6G7h8I9j0'.repeat(2)}`;
    const planted = {
      'alice@example.com': `token in ${secret} here`,
      '10.1.2.3': ['mail bob@example.org now', 'host 192.168.10.20 up'],
      '/Users/example/notes.txt': { nested: { path: '/Users/example/notes.txt', mine: '/home/test/project/plan.md' } },
      count: 3,
      flag: true,
      none: null,
    };
    const writer = fixedWriter();
    const lines = writer.snapshot('now', { list: { exit: 0, json: planted } });
    const text = lines.join('');
    for (const value of [secret, 'bob@example.org', '192.168.10.20', '"/Users/example/notes.txt"', '/home/test/']) {
      if (value === '"/Users/example/notes.txt"') {
        // The key keeps the path; the value does not.
        assert.equal(text.split(value).length - 1, 1, 'the path survives only as a key');
      } else {
        assert.ok(!text.includes(value), `${value} is masked`);
      }
    }
    const [env] = parse(lines);
    const json = env.data.sections.list.json;
    assert.deepEqual(Object.keys(json), ['alice@example.com', '10.1.2.3', '/Users/example/notes.txt', 'count', 'flag', 'none']);
    assert.equal(json['alice@example.com'], 'token in <masked> here');
    assert.deepEqual(json['10.1.2.3'], ['mail <email> now', 'host <ip> up']);
    assert.deepEqual(json['/Users/example/notes.txt'], { nested: { path: '/Users/<masked>/notes.txt', mine: '~/project/plan.md' } });
    assert.equal(json.count, 3);
    assert.equal(json.flag, true);
    assert.equal(json.none, null);
    // Masking returns new values and leaves the input alone.
    assert.equal(planted['alice@example.com'], `token in ${secret} here`);
  } finally {
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
  }
});

test('maskJson keeps a __proto__ key as an own key; maskSections is what the writer frames', () => {
  const value = JSON.parse('{"__proto__": {"ip": "10.0.0.1"}}');
  const masked: any = maskJson(value);
  assert.deepEqual(Object.keys(masked), ['__proto__']);
  assert.equal(JSON.stringify(masked), '{"__proto__":{"ip":"<ip>"}}');
  const sections = maskSections({ list: { exit: 0, json: 'carol@example.net' } });
  assert.equal(JSON.stringify(sections), '{"list":{"exit":0,"json":"<email>"}}');
});

/** A section whose framed JSON is about `kib` KiB. */
const big = (kib: number, mark: string) => ({ exit: 0, json: { mark, text: 'x'.repeat(kib * 1024) } });

test('a snapshot over the cap is split by whole sections: snapshot then patches, more on all but the last', () => {
  const writer = fixedWriter();
  const sections: Record<string, any> = {};
  for (let i = 0; i < 7; i += 1) sections[`s${i}`] = big(100, `m${i}`);
  const lines = writer.snapshot(RUN, sections);
  const frames = parse(lines);
  assert.ok(frames.length >= 3, `split into ${frames.length} frames`);
  for (const line of lines) assert.ok(bytes(line) <= LINE_CAP_BYTES, `line of ${bytes(line)} bytes`);
  assert.equal(frames[0].type, 'snapshot');
  for (const env of frames.slice(1)) assert.equal(env.type, 'patch');
  frames.forEach((env, index) => {
    if (index < frames.length - 1) assert.equal(env.data.more, true);
    else assert.equal('more' in env.data, false);
  });
  assert.deepEqual(frames.map((env) => nOf(env.id)), frames.map((_env, index) => index + 1));
  assert.equal(new Set(frames.map((env) => env.at)).size, 1, 'one emission, one clock read');
  // Every section arrives once, whole and in order.
  const seen = frames.flatMap((env) => Object.keys(env.data.sections));
  assert.deepEqual(seen, Object.keys(sections));
  for (const env of frames) for (const [name, result] of Object.entries<any>(env.data.sections)) assert.deepEqual(result, sections[name]);
  // As many whole sections as fit: the next section would not have fit in a non-last frame.
  for (let i = 0; i < frames.length - 1; i += 1) {
    const nextName = Object.keys(frames[i + 1].data.sections)[0];
    const grown = { ...frames[i], data: { ...frames[i].data, sections: { ...frames[i].data.sections, [nextName]: sections[nextName] } } };
    assert.ok(bytes(`${JSON.stringify(grown)}\n`) > LINE_CAP_BYTES);
  }
  assert.equal(writer.needsSnapshot(RUN), false);
});

test('a patch over the cap is split the same way, removed rides in the first frame', () => {
  const writer = fixedWriter();
  writer.snapshot(RUN, { status: { exit: 0, json: {} } });
  const changed = { a: big(150, 'a'), b: big(150, 'b'), c: big(150, 'c') };
  const lines = writer.patch(RUN, changed, ['status']);
  const frames = parse(lines);
  assert.equal(frames.length, 3);
  for (const line of lines) assert.ok(bytes(line) <= LINE_CAP_BYTES);
  assert.deepEqual(frames.map((env) => env.type), ['patch', 'patch', 'patch']);
  assert.deepEqual(frames.map((env) => env.data.more), [true, true, undefined]);
  assert.deepEqual(frames.map((env) => env.data.removed), [['status'], undefined, undefined]);
  assert.deepEqual(frames.map((env) => Object.keys(env.data.sections)), [['a'], ['b'], ['c']]);
  assert.deepEqual(frames.map((env) => nOf(env.id)), [2, 3, 4]);
});

test('a frame at exactly the cap is sent whole; one byte more splits it', () => {
  const fits = (writer: any, pad: number) => writer.snapshot(RUN, { a: { exit: 0, json: 'x'.repeat(pad) }, b: { exit: 0, json: 'y' } });
  const probe = parse(fits(fixedWriter(), 0))[0];
  const overhead = bytes(`${JSON.stringify(probe)}\n`);
  const exact = fits(fixedWriter(), LINE_CAP_BYTES - overhead);
  assert.equal(exact.length, 1);
  assert.equal(bytes(exact[0]), LINE_CAP_BYTES);
  const over = fits(fixedWriter(), LINE_CAP_BYTES - overhead + 1);
  assert.equal(over.length, 2);
  for (const line of over) assert.ok(bytes(line) <= LINE_CAP_BYTES);
});

test('a single section that alone exceeds the cap yields reset frame-cap for that channel only', () => {
  const writer = fixedWriter();
  const huge = { small: { exit: 0, json: 1 }, huge: big(300, 'h') };
  const frames = parse(writer.snapshot(RUN, huge));
  assert.equal(frames.length, 1);
  assertEnvelope(frames[0], RUN, 'reset');
  assert.deepEqual(frames[0].data, { reason: 'frame-cap' });
  assert.equal(nOf(frames[0].id), 1);
  assert.equal(writer.needsSnapshot(RUN), true);
  // Another channel goes on.
  const [now] = parse(writer.snapshot('now', { list: { exit: 0, json: [] } }));
  assert.equal(now.type, 'snapshot');
  assert.equal(nOf(now.id), 1);
  // A later snapshot that fits is sent; a later oversize patch resets again.
  const [snap] = parse(writer.snapshot(RUN, { small: { exit: 0, json: 2 } }));
  assert.equal(snap.type, 'snapshot');
  assert.equal(nOf(snap.id), 2);
  const [reset] = parse(writer.patch(RUN, { huge: big(300, 'h2') }));
  assert.deepEqual([reset.type, reset.data, nOf(reset.id)], ['reset', { reason: 'frame-cap' }, 3]);
  assert.equal(writer.needsSnapshot(RUN), true);
});

test('the cap counts UTF-8 bytes, not characters', () => {
  const writer = fixedWriter();
  const lines = writer.snapshot(RUN, { a: { exit: 0, json: '\u00e9'.repeat(100000) }, b: { exit: 0, json: '\u00e9'.repeat(100000) } });
  assert.equal(lines.length, 2, '200000 two-byte characters do not fit one line');
  for (const line of lines) assert.ok(bytes(line) <= LINE_CAP_BYTES);
});

// Feature 150 A.2 (IC-007): log channel frames.

const OUT = 'worker:w-0123456789ab:out';
const ERR = 'worker:w-0123456789ab:err';
const INO = '8812345';
const logParts = (id: string) => id.split(':').map(Number);
const openSnap = (from: number, to: number, pieces: any[], extra: Record<string, unknown> = {}) => ({ log: 'open', ino: INO, from, to, pieces, phase: 'running', end: null, ...extra });
const appendOf = (from: number, to: number, pieces: any[], extra: Record<string, unknown> = {}) => ({ from, to, pieces, phase: 'running', end: null, ...extra });

test('log id grammar: <ino>:<offset>:<n>:<ms> with a rising n; other kinds keep <epoch>-<n>', () => {
  assert.equal(LOG_ID.source, '^[0-9]{1,20}:[0-9]{1,16}:[1-9][0-9]{0,15}:[0-9]{1,16}$');
  for (const id of ['0:0:1:0', '8812345:4096:3:1762581600000', `${'9'.repeat(20)}:${'9'.repeat(16)}:${'9'.repeat(16)}:${'9'.repeat(16)}`]) assert.match(id, LOG_ID);
  for (const id of ['8812345:4096:0:1', '8812345:4096:01:1', '8812345:4096:3', '8812345:-1:3:1', `${'9'.repeat(21)}:0:1:0`, '3f9a0c12-1']) assert.doesNotMatch(id, LOG_ID, id);

  const writer = fixedWriter();
  const frames = parse([
    ...writer.logSnapshot(OUT, { log: 'waiting', ino: null, from: 0, to: 0, pieces: [], phase: 'starting', end: null }),
    ...writer.snapshot('now', { list: { exit: 0, json: [] } }),
    ...writer.logSnapshot(OUT, openSnap(0, 10, [{ at: 0, text: 'compiling' }])),
    ...writer.append(OUT, appendOf(10, 23, [{ at: 10, text: 'tests passed' }])),
    ...writer.append(OUT, appendOf(23, 23, [], { phase: 'ended', end: { capped: false } })),
    ...writer.reset(OUT, 'replaced'),
    ...writer.logSnapshot(OUT, openSnap(0, 5, [{ at: 0, text: 'next' }])),
    ...writer.error(OUT, 'unsupported-version'),
    ...writer.logSnapshot(ERR, openSnap(0, 4, [{ at: 0, text: 'err' }])),
    ...writer.gone(ERR),
  ]);
  const log = frames.filter((env) => env.ch !== 'now');
  for (const env of log) {
    assert.deepEqual(Object.keys(env), ['v', 'ch', 'id', 'type', 'at', 'data']);
    assert.match(env.id, LOG_ID);
    assert.doesNotMatch(env.id, ENVELOPE_ID);
    assert.ok(FRAME_TYPES.includes(env.type) && env.type !== 'patch');
    // `ms` is the injected clock at emit, and `at` the same instant.
    assert.equal(new Date(logParts(env.id)[3]).toISOString(), env.at);
  }
  const out = log.filter((env) => env.ch === OUT);
  assert.deepEqual(out.map((env) => env.type), ['snapshot', 'snapshot', 'append', 'append', 'reset', 'snapshot', 'error']);
  assert.deepEqual(out.map((env) => logParts(env.id)[2]), [1, 2, 3, 4, 5, 6, 7], 'n rises by one per frame');
  // `ino` is 0 while there is no file; `offset` is the frame's `to`, and the last `to` for reset and error.
  assert.deepEqual(out.map((env) => env.id.split(':').slice(0, 2).join(':')), ['0:0', `${INO}:10`, `${INO}:23`, `${INO}:23`, `${INO}:23`, `${INO}:5`, `${INO}:5`]);
  const err = log.filter((env) => env.ch === ERR);
  assert.deepEqual(err.map((env) => [env.type, env.id.split(':').slice(0, 3).join(':')]), [['snapshot', `${INO}:4:1`], ['gone', `${INO}:4:2`]]);
  // The section channel keeps its own counter and the <epoch>-<n> id.
  const [now] = frames.filter((env) => env.ch === 'now');
  assert.equal(now.id, `${EPOCH}-1`);

  // IC-007 data shapes, in field order.
  assert.deepEqual(Object.keys(out[0].data), ['log', 'ino', 'from', 'to', 'pieces', 'phase', 'end']);
  assert.deepEqual(out[0].data, { log: 'waiting', ino: null, from: 0, to: 0, pieces: [], phase: 'starting', end: null });
  assert.deepEqual(out[1].data, { log: 'open', ino: INO, from: 0, to: 10, pieces: [{ at: 0, text: 'compiling' }], phase: 'running', end: null });
  assert.deepEqual(Object.keys(out[2].data), ['from', 'to', 'pieces', 'phase', 'end']);
  assert.deepEqual(out[2].data, { from: 10, to: 23, pieces: [{ at: 10, text: 'tests passed' }], phase: 'running', end: null });
  assert.deepEqual(out[3].data, { from: 23, to: 23, pieces: [], phase: 'ended', end: { capped: false } });
  assert.deepEqual(out[4].data, { reason: 'replaced' });
  assert.deepEqual(out[6].data, { code: 'unsupported-version' });
  assert.deepEqual(err[1].data, {});
  // A cut piece keeps its marker.
  const cutWriter = fixedWriter();
  const [cut] = parse(cutWriter.logSnapshot(OUT, openSnap(0, 32768, [{ at: 0, text: 'x'.repeat(10), cut: true }])));
  assert.deepEqual(cut.data.pieces, [{ at: 0, text: 'x'.repeat(10), cut: true }]);
});

test('log order: a log channel owes a logSnapshot first and after reset, error or gone; append continues from the last to', () => {
  const writer = fixedWriter();
  assert.equal(writer.needsSnapshot(OUT), true);
  assert.throws(() => writer.append(OUT, appendOf(0, 0, [])), /owes a snapshot/);
  writer.logSnapshot(OUT, openSnap(0, 3, [{ at: 0, text: 'ab' }]));
  assert.equal(writer.needsSnapshot(OUT), false);
  assert.throws(() => writer.append(OUT, appendOf(2, 5, [{ at: 2, text: 'c' }])), /last to 3/);
  writer.append(OUT, appendOf(3, 5, [{ at: 3, text: 'c' }]));
  for (const close of [() => writer.reset(OUT, 'replaced'), () => writer.error(OUT, 'store-unreadable'), () => writer.gone(OUT)]) {
    close();
    assert.equal(writer.needsSnapshot(OUT), true);
    assert.throws(() => writer.append(OUT, appendOf(5, 5, [])), /owes a snapshot/);
    writer.logSnapshot(OUT, openSnap(0, 5, [{ at: 0, text: 'abcd' }]));
  }
});

test('log channels only: append and logSnapshot refuse any other channel; sections refuse a log channel', () => {
  const writer = fixedWriter();
  for (const ch of ['run:feat-a:t', 'now', 'tasks:feat-a', 'worker:w-0123456789ab', 'worker:w-0123456789ab:last', 'worker:w-0123456789AB:out', 'worker:w-0123456789ab:out:x']) {
    assert.throws(() => writer.logSnapshot(ch, openSnap(0, 0, [], { log: 'waiting', ino: null })), TypeError, ch);
    assert.throws(() => writer.append(ch, appendOf(0, 0, [])), TypeError, ch);
  }
  // The section channel used above is untouched and still owes its first snapshot.
  assert.equal(writer.needsSnapshot('run:feat-a:t'), true);
  for (const ch of [OUT, ERR]) {
    assert.throws(() => writer.snapshot(ch, {}), TypeError, ch);
    assert.throws(() => writer.patch(ch, {}), TypeError, ch);
  }
});

test('log data is checked: malformed state, range or pieces are refused', () => {
  const writer = fixedWriter();
  const bad: any[] = [
    { log: 'gone', ino: null, from: 0, to: 0, pieces: [], phase: 'running', end: null },
    { log: 'waiting', ino: INO, from: 0, to: 0, pieces: [], phase: 'running', end: null },
    { log: 'none', ino: null, from: 0, to: 4, pieces: [{ at: 0, text: 'x' }], phase: 'ended', end: { capped: null } },
    openSnap(0, 4, [{ at: 0, text: 'x' }], { ino: 8812345 }),
    openSnap(0, 4, [{ at: 0, text: 'x' }], { ino: 'abc' }),
    openSnap(4, 0, []),
    openSnap(0, 4, []),
    openSnap(0, 0, [{ at: 0, text: 'x' }]),
    openSnap(0, 9, [{ at: 1, text: 'x' }]),
    openSnap(0, 9, [{ at: 0, text: 'x' }, { at: 0, text: 'y' }]),
    openSnap(0, 9, [{ at: 0, text: 'x' }, { at: 9, text: 'y' }]),
    openSnap(0, 9, [{ at: 0, text: 5 }]),
    openSnap(0, 9, [{ at: 0, text: 'x', cut: false }]),
    openSnap(0, 9, [{ at: 0.5, text: 'x' }]),
    openSnap(0, 4, [{ at: 0, text: 'x' }], { phase: 'done' }),
    openSnap(0, 4, [{ at: 0, text: 'x' }], { end: { capped: true } }),
    openSnap(0, 4, [{ at: 0, text: 'x' }], { phase: 'ended', end: null }),
    openSnap(0, 4, [{ at: 0, text: 'x' }], { phase: 'ended', end: { capped: 'yes' } }),
    null,
  ];
  for (const data of bad) assert.throws(() => writer.logSnapshot(OUT, data), TypeError, JSON.stringify(data));
  assert.equal(writer.needsSnapshot(OUT), true, 'a refused snapshot opens nothing');
  const [none] = parse(writer.logSnapshot(OUT, { log: 'none', ino: null, from: 0, to: 0, pieces: [], phase: 'ended', end: { capped: null } }));
  assert.deepEqual([none.id.split(':').slice(0, 3).join(':'), none.data.log, none.data.end], ['0:0:1', 'none', { capped: null }]);
  assert.deepEqual(parse(writer.logSnapshot(ERR, { log: 'waiting', ino: null, from: 0, to: 0, pieces: [], phase: null, end: null }))[0].data.phase, null);
});

/** `count` pieces of `kib` KiB each, laid out from byte `start`, each `kib * 1024 + 1` bytes (a line and its newline). */
const bigPieces = (count: number, kib: number, start = 0) => Array.from({ length: count }, (_v, i) => ({ at: start + i * (kib * 1024 + 1), text: `${i}`.repeat(kib * 1024) }));

test('an append over the cap is split at piece boundaries into consecutive appends, each from the previous to', () => {
  const writer = fixedWriter();
  writer.logSnapshot(OUT, openSnap(0, 7, [{ at: 0, text: 'start' }]));
  const pieces = bigPieces(5, 100, 7);
  const to = 7 + 5 * (100 * 1024 + 1);
  const lines = writer.append(OUT, appendOf(7, to, pieces));
  const frames = parse(lines);
  assert.ok(frames.length >= 2, `split into ${frames.length} frames`);
  for (const line of lines) assert.ok(bytes(line) <= LINE_CAP_BYTES, `line of ${bytes(line)} bytes`);
  assert.deepEqual(frames.map((env) => env.type), frames.map(() => 'append'));
  assert.equal(frames[0].data.from, 7);
  assert.equal(frames[frames.length - 1].data.to, to);
  for (let i = 1; i < frames.length; i += 1) {
    assert.equal(frames[i].data.from, frames[i - 1].data.to, 'each from equals the previous to');
    assert.equal(frames[i].data.from, frames[i].data.pieces[0].at, 'a split falls on a piece boundary');
  }
  for (const env of frames) {
    assert.deepEqual(Object.keys(env.data), ['from', 'to', 'pieces', 'phase', 'end']);
    assert.equal(logParts(env.id)[1], env.data.to, 'the id offset is the frame to');
    assert.equal(env.id.split(':')[0], INO);
  }
  assert.deepEqual(frames.map((env) => logParts(env.id)[2]), frames.map((_env, i) => i + 2), 'n rises across the split');
  assert.equal(new Set(frames.map((env) => env.at)).size, 1, 'one emission, one clock read');
  // Every piece arrives once, whole and in order.
  assert.deepEqual(frames.flatMap((env) => env.data.pieces), pieces);
  // As many pieces as fit: the next piece would not have fit in a frame that is not the last.
  for (let i = 0; i < frames.length - 1; i += 1) {
    const next = frames[i + 1].data.pieces[0];
    const grown = { ...frames[i], data: { ...frames[i].data, pieces: [...frames[i].data.pieces, next] } };
    assert.ok(bytes(`${JSON.stringify(grown)}\n`) > LINE_CAP_BYTES);
  }
  // The next append continues from the last to.
  const [after] = parse(writer.append(OUT, appendOf(to, to + 3, [{ at: to, text: 'ok' }])));
  assert.equal(after.data.from, to);
});

test('a log snapshot over the cap drops pieces from its front; a piece too big for any append resets frame-cap', () => {
  const writer = fixedWriter();
  const pieces = bigPieces(5, 100);
  const to = 5 * (100 * 1024 + 1);
  const lines = writer.logSnapshot(OUT, openSnap(0, to, pieces));
  assert.equal(lines.length, 1);
  assert.ok(bytes(lines[0]) <= LINE_CAP_BYTES);
  const [snap] = parse(lines);
  const kept = snap.data.pieces;
  assert.ok(kept.length >= 1 && kept.length < pieces.length);
  assert.deepEqual(kept, pieces.slice(pieces.length - kept.length), 'the newest pieces are kept');
  assert.equal(snap.data.from, kept[0].at, 'from moves to the first kept piece');
  assert.equal(snap.data.to, to);
  const dropped = pieces[pieces.length - kept.length - 1];
  const grown = { ...snap, data: { ...snap.data, from: dropped.at, pieces: [dropped, ...kept] } };
  assert.ok(bytes(`${JSON.stringify(grown)}\n`) > LINE_CAP_BYTES, 'only what does not fit is dropped');

  const huge = [{ at: to, text: 'h'.repeat(300 * 1024) }];
  const [reset] = parse(writer.append(OUT, appendOf(to, to + 300 * 1024 + 1, huge)));
  assert.deepEqual([reset.type, reset.data], ['reset', { reason: 'frame-cap' }]);
  assert.deepEqual(logParts(reset.id).slice(0, 3), [Number(INO), to, 2], 'the reset carries the last to');
  assert.equal(writer.needsSnapshot(OUT), true);
});

test('masking: secret, email, IP and absolute paths in log piece text are masked again', () => {
  const home = process.env.HOME;
  process.env.HOME = '/home/test';
  try {
    const secret = `ghp_${'A1b2C3d4E5f6G7h8I9j0'.repeat(2)}`;
    const texts = [`token ${secret} here`, 'mail bob@example.org now', 'host 192.168.10.20 up', 'read /Users/example/notes.txt and /home/test/project/plan.md'];
    const pieces = texts.map((text, i) => ({ at: i * 100, text }));
    const writer = fixedWriter();
    const lines = [
      ...writer.logSnapshot(OUT, openSnap(0, 400, pieces)),
      ...writer.append(OUT, appendOf(400, 800, pieces.map((piece) => ({ ...piece, at: piece.at + 400 })))),
    ];
    const text = lines.join('');
    for (const value of [secret, 'bob@example.org', '192.168.10.20', '/Users/example/', '/home/test/']) assert.ok(!text.includes(value), `${value} is masked`);
    const expected = ['token <masked> here', 'mail <email> now', 'host <ip> up', 'read /Users/<masked>/notes.txt and ~/project/plan.md'];
    for (const env of parse(lines)) assert.deepEqual(env.data.pieces.map((piece: any) => piece.text), expected);
    assert.equal(pieces[0].text, `token ${secret} here`, 'the input is left alone');
  } finally {
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
  }
});

test('channels: the P1 grammar parses', () => {
  assert.deepEqual(parseChannel('now'), { ok: true, channel: { kind: 'now', name: 'now' } });
  assert.deepEqual(parseChannel('run:feat-a:A.3'), { ok: true, channel: { kind: 'run', name: 'run:feat-a:A.3', slug: 'feat-a', taskId: 'A.3' } });
  assert.deepEqual(parseChannel('run:149-console_v2.live:run-1'), { ok: true, channel: { kind: 'run', name: 'run:149-console_v2.live:run-1', slug: '149-console_v2.live', taskId: 'run-1' } });
  assert.deepEqual(parseChannel('tasks:feat-a'), { ok: true, channel: { kind: 'tasks', name: 'tasks:feat-a', slug: 'feat-a' } });
  assert.deepEqual(parseChannel('worker:w-0123456789ab'), { ok: true, channel: { kind: 'worker', name: 'worker:w-0123456789ab', runId: 'w-0123456789ab' } });
});

test('channels: 150 IC-006 worker out and err parse as log channels; every other stream is malformed', () => {
  assert.deepEqual(parseChannel('worker:w-0123456789ab:out'), { ok: true, channel: { kind: 'log', name: 'worker:w-0123456789ab:out', runId: 'w-0123456789ab', stream: 'out' } });
  assert.deepEqual(parseChannel('worker:w-0123456789ab:err'), { ok: true, channel: { kind: 'log', name: 'worker:w-0123456789ab:err', runId: 'w-0123456789ab', stream: 'err' } });
  for (const text of ['worker:w-0123456789ab:last', 'worker:w-0123456789ab:x', 'worker:w-0123456789ab:OUT', 'worker:w-0123456789ab:', 'worker:w-0123456789ab:out.log']) {
    const result = parseChannel(text);
    assert.deepEqual([result.ok, result.code], [false, 'malformed'], text);
    assert.match(result.reason, /only out and err are worker output channels/, text);
  }
  // A bad run id is still the run id's reason, whatever the stream.
  assert.doesNotMatch(parseChannel('worker:w-0123456789AB:out').reason, /only out and err/);
  // The 64-channel bound counts log channels like any other.
  const logs = Array.from({ length: 32 }, (_v, i) => `worker:w-${i.toString(16).padStart(12, '0')}:out,worker:w-${i.toString(16).padStart(12, '0')}:err`).join(',');
  assert.equal(parseChannelList(logs).ok, true);
  assert.equal(parseChannelList(`${logs},now`).code, 'too-many-channels');
});

test('channels: the id uses the core length bound of ID_PATTERN', () => {
  const longest = `a${'.'.repeat(54)}b`;
  assert.equal(longest.length, 56);
  assert.ok(ID_PATTERN.test('a'.repeat(56)) && !ID_PATTERN.test('a'.repeat(57)), 'the core bound is 56');
  assert.ok(isChannelId('a'.repeat(56)));
  assert.ok(isChannelId(longest));
  assert.ok(!isChannelId('a'.repeat(57)));
  assert.equal(parseChannel(`tasks:${'a'.repeat(57)}`).ok, false);
  for (const bad of ['', '.a', '-a', '_a', 'a b', 'a/b', 'a:b', 'é', 'a\n']) assert.ok(!isChannelId(bad), JSON.stringify(bad));
});

test('channels: every refused kind and malformed form is refused with a reason', () => {
  const cases: Array<[string, string]> = [
    ['worker:w-0123456789ab:last', 'malformed'],
    ['worker:w-0123456789ab:x', 'malformed'],
    ['transcript:abc', 'refused-kind'],
    ['transcript', 'refused-kind'],
    ['followups', 'refused-kind'],
    ['advice', 'refused-kind'],
    ['fleet:project-a', 'refused-kind'],
    ['fleet', 'refused-kind'],
    ['sessions', 'unknown-kind'],
    ['NOW', 'unknown-kind'],
    ['now:x', 'malformed'],
    ['run:feat-a', 'malformed'],
    ['run:feat-a:A.3:x', 'malformed'],
    ['run::A.3', 'malformed'],
    ['run:.x:A.3', 'malformed'],
    ['tasks:', 'malformed'],
    ['tasks:a:b', 'malformed'],
    ['worker:w-0123456789AB', 'malformed'],
    ['worker:w-0123456789a', 'malformed'],
    ['worker:feat-a', 'malformed'],
    ['worker:w-0123456789ab:log', 'malformed'],
    ['', 'malformed'],
  ];
  for (const [text, code] of cases) {
    const result = parseChannel(text);
    assert.equal(result.ok, false, text);
    assert.equal(result.code, code, text);
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0);
  }
  for (const value of [undefined, null, 5, ['now']]) assert.equal(parseChannel(value).ok, false);
});

test('channel list: comma-separated, distinct, at most 64', () => {
  const ok = parseChannelList('now,tasks:feat-a,run:feat-a:A.3');
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.channels.map((ch: any) => ch.name), ['now', 'tasks:feat-a', 'run:feat-a:A.3']);
  const sixtyFour = Array.from({ length: 64 }, (_v, i) => `tasks:f${i}`).join(',');
  assert.equal(parseChannelList(sixtyFour).ok, true);
  const sixtyFive = parseChannelList(`${sixtyFour},now`);
  assert.deepEqual([sixtyFive.ok, sixtyFive.code], [false, 'too-many-channels']);
  assert.equal(parseChannelList('now,now').code, 'duplicate');
  assert.equal(parseChannelList('now,,tasks:a').code, 'malformed');
  assert.equal(parseChannelList('now,advice').code, 'refused-kind');
  assert.equal(parseChannelList('').ok, false);
  assert.equal(parseChannelList(undefined).ok, false);
});
