'use strict';

// Feature 149 A.3: the events envelope (IC-002), channel grammar (IC-003) and masking and frame cap (IC-007).

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createEnvelopeWriter, newEpoch, maskJson, maskSections,
  ENVELOPE_VERSION, FRAME_TYPES, ERROR_CODES, RESET_REASONS, LINE_CAP_BYTES, ENVELOPE_ID, EPOCH_PATTERN,
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
  assert.deepEqual([...CHANNEL_KINDS], ['now', 'run', 'tasks', 'worker']);
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

  // `append` is in the type grammar only: no writer method produces it.
  assert.ok(FRAME_TYPES.includes('append'));
  assert.equal((writer as any).append, undefined);
  assert.deepEqual(Object.keys(writer).sort(), ['epoch', 'error', 'gone', 'needsSnapshot', 'patch', 'reset', 'snapshot']);
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

test('channels: the P1 grammar parses', () => {
  assert.deepEqual(parseChannel('now'), { ok: true, channel: { kind: 'now', name: 'now' } });
  assert.deepEqual(parseChannel('run:feat-a:A.3'), { ok: true, channel: { kind: 'run', name: 'run:feat-a:A.3', slug: 'feat-a', taskId: 'A.3' } });
  assert.deepEqual(parseChannel('run:149-console_v2.live:run-1'), { ok: true, channel: { kind: 'run', name: 'run:149-console_v2.live:run-1', slug: '149-console_v2.live', taskId: 'run-1' } });
  assert.deepEqual(parseChannel('tasks:feat-a'), { ok: true, channel: { kind: 'tasks', name: 'tasks:feat-a', slug: 'feat-a' } });
  assert.deepEqual(parseChannel('worker:w-0123456789ab'), { ok: true, channel: { kind: 'worker', name: 'worker:w-0123456789ab', runId: 'w-0123456789ab' } });
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
    ['worker:w-0123456789ab:out', 'refused-kind'],
    ['worker:w-0123456789ab:err', 'refused-kind'],
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
