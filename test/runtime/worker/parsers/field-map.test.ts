'use strict';

// Design §3.3 and IC-001: the `jsonl-field-map-v1` interpreter. A map compiles to a frozen parser factory; the instance
// never throws on a line and ends with the fixed precedence of §3.3.

const test = require('node:test');
const assert = require('node:assert/strict');
const { compileFieldMap } = require('../../../../src/runtime/worker/parsers/field-map.ts');
const { MAX_BYTES } = require('../../../../src/registry/field-map.ts');

/** One rule per action, so every `end()` row can be reached on its own. */
function fakeMap(extra: any = {}): any {
  const type = (value: string) => ({ path: ['type'], equals: value });
  return {
    id: 'fake-run-v1',
    format: 'jsonl-field-map-v1',
    eventType: ['type'],
    missingTerminal: 'no-end',
    rules: [
      { when: [type('msg'), { path: ['text'], is: 'string' }], then: { final: ['text'] } },
      { when: [type('spawn')], then: { spawn: true } },
      { when: [type('deny')], then: { denial: { action: { literal: 'command' }, detail: { path: ['cmd'], as: 'text' } } } },
      { when: [type('done')], then: { terminal: { outcome: 'completed' }, usage: { tokens: { sum: [['usage', 'in'], ['usage', 'out']], require: 'any' } } } },
      { when: [type('strict')], then: { terminal: { outcome: 'completed' }, usage: { tokens: { sum: [['usage', 'in'], ['usage', 'out']], require: 'all' } } } },
      { when: [type('fail'), { path: ['error', 'message'], is: 'string' }], then: { terminal: { outcome: 'failed', summary: ['error', 'message'] } } },
      { when: [type('bare-fail')], then: { terminal: { outcome: 'failed' } } },
      { when: [type('error'), { path: ['message'], is: 'string' }], then: { streamError: ['message'] } },
    ],
    ...extra,
  };
}

function parserOf(map: any = fakeMap()): any { return compileFieldMap(map).create(); }

function feed(target: any, events: any[]): void {
  for (const event of events) target.line(typeof event === 'string' ? event : JSON.stringify(event));
}

function run(events: any[], map: any = fakeMap()): any {
  const target = parserOf(map);
  feed(target, events);
  return target.end();
}

const SECRET = `sk-${'aB3dE5gH7jK9mN1pQ3sT5vW7'}`;

test('a fake stream of final, then completed with usage, reports success with the summary masked and tokens summed', () => {
  const report = run([
    { type: 'msg', text: `key is ${SECRET} here` },
    { type: 'done', usage: { in: 3, out: 7 } },
  ]);
  assert.deepEqual(report, {
    parser: 'fake-run-v1', status: 'success', reason: null, summary: 'key is <masked> here', denials: [], deniedCount: 0,
    usage: { tokens: 10 }, ignoredLines: 0,
  });
  assert.ok(!('cost' in report.usage));
});

test('compileFieldMap returns a frozen {id, create} and an instance per create', () => {
  const factory = compileFieldMap(fakeMap());
  assert.ok(Object.isFrozen(factory));
  assert.equal(factory.id, 'fake-run-v1');
  const one = factory.create();
  const two = factory.create();
  assert.notEqual(one, two);
  one.line(JSON.stringify({ type: 'spawn' }));
  assert.equal(two.end().status, 'unparsed');
  assert.deepEqual(Object.keys(one).sort(), ['end', 'line', 'oversize']);
});

test('end precedence row 1: a denial wins over everything and carries no reason or summary', () => {
  const report = run([
    { type: 'deny', cmd: 'rm -rf' }, { type: 'spawn' }, { type: 'msg', text: 'x' }, { type: 'done' }, { type: 'error', message: 'boom' },
  ]);
  assert.deepEqual([report.status, report.reason, report.summary, report.deniedCount], ['denied', null, null, 1]);
  assert.deepEqual(report.denials, [{ action: 'command', detail: 'rm -rf' }]);
});

test('end precedence row 2: an oversize JSON-looking line is unparsed oversize-line, and a denial still wins', () => {
  const target = parserOf();
  feed(target, [{ type: 'msg', text: 'x' }, { type: 'done' }]);
  target.oversize(true);
  const report = target.end();
  assert.deepEqual([report.status, report.reason, report.summary, report.ignoredLines], ['unparsed', 'oversize-line', null, 1]);

  const denied = parserOf();
  denied.oversize(true);
  feed(denied, [{ type: 'deny', cmd: 'x' }]);
  assert.equal(denied.end().status, 'denied');

  const plain = parserOf();
  plain.oversize(false);
  feed(plain, [{ type: 'msg', text: 'ok' }, { type: 'done' }]);
  const kept = plain.end();
  assert.deepEqual([kept.status, kept.ignoredLines], ['success', 1]);
});

test('end precedence row 3: a spawn is a failure spawn-observed even after a completed turn', () => {
  const report = run([{ type: 'msg', text: 'x' }, { type: 'done' }, { type: 'spawn' }, { type: 'fail', error: { message: 'no' } }]);
  assert.deepEqual([report.status, report.reason, report.summary], ['failure', 'spawn-observed', null]);
});

test('end precedence row 4: a failed terminal is a failure whose summary is the masked failure message', () => {
  const report = run([
    { type: 'msg', text: 'ignored' }, { type: 'error', message: 'later' },
    { type: 'fail', error: { message: `Authorization: Bearer abcdefghijklmnop` } },
  ]);
  assert.deepEqual([report.status, report.reason, report.summary], ['failure', null, 'Authorization: <masked>']);
  const bare = run([{ type: 'bare-fail' }]);
  assert.deepEqual([bare.status, bare.reason, bare.summary], ['failure', null, null]);
});

test('end precedence row 5: a completed terminal with a final reports success; the summary is body-masked and cut at 2000 bytes', () => {
  assert.equal(run([{ type: 'msg', text: 'Authorization: Bearer abcdefghijklmnop' }, { type: 'done' }]).summary, 'Authorization: <masked>');
  const long = run([{ type: 'msg', text: `${'a'.repeat(1999)}€${'b'.repeat(10)}` }, { type: 'done' }]);
  assert.equal(long.summary, 'a'.repeat(1999));
  assert.equal(long.status, 'success');
});

test('end precedence row 6: a completed terminal with no final is unparsed no-final-message', () => {
  const report = run([{ type: 'done' }, { type: 'error', message: 'x' }]);
  assert.deepEqual([report.status, report.reason, report.summary], ['unparsed', 'no-final-message', null]);
});

test('end precedence row 7: a stream error with no terminal is a failure stream-error with a masked summary', () => {
  const report = run([{ type: 'msg', text: 'x' }, { type: 'error', message: `token=${SECRET}` }]);
  assert.deepEqual([report.status, report.reason], ['failure', 'stream-error']);
  assert.ok(!report.summary.includes(SECRET));
});

test('end precedence row 8: otherwise unparsed with the map missingTerminal reason', () => {
  assert.deepEqual(((r) => [r.status, r.reason, r.summary])(run([])), ['unparsed', 'no-end', null]);
  assert.deepEqual(((r) => [r.status, r.reason])(run([{ type: 'msg', text: 'x' }])), ['unparsed', 'no-end']);
});

test('the last final, the last terminal and the last stream error win', () => {
  assert.equal(run([{ type: 'msg', text: 'one' }, { type: 'msg', text: 'two' }, { type: 'done' }]).summary, 'two');
  // a completed after a failed ends completed, and a failed after a completed ends failed
  assert.deepEqual(((r) => [r.status, r.summary])(run([{ type: 'fail', error: { message: 'bad' } }, { type: 'msg', text: 'ok' }, { type: 'done' }])), ['success', 'ok']);
  assert.deepEqual(((r) => [r.status, r.summary])(run([{ type: 'msg', text: 'ok' }, { type: 'done' }, { type: 'fail', error: { message: 'bad' } }])), ['failure', 'bad']);
  assert.equal(run([{ type: 'error', message: 'first' }, { type: 'error', message: 'second' }]).summary, 'second');
});

test('only the first matching rule applies to a line, and a line no rule matches is ignored', () => {
  const map = fakeMap();
  map.rules.unshift({ when: [{ path: ['type'], equals: 'msg' }], then: { spawn: true } });
  const report = run([{ type: 'msg', text: 'x' }, { type: 'unknown' }], map);
  assert.deepEqual([report.status, report.reason, report.ignoredLines], ['failure', 'spawn-observed', 1]);
});

test('ignoredLines counts text that is not JSON, JSON that is not an object, and an event type that is not a string', () => {
  const target = parserOf();
  feed(target, ['not JSON', '', '[1,2]', '7', 'null', '"str"', { type: 3 }, { type: null }, { nope: 1 }, { type: 'unmatched' }, '{"type":"msg","text":"x"}']);
  const report = target.end();
  assert.equal(report.ignoredLines, 10);
  assert.equal(report.reason, 'no-end');
});

test('a step into a value that is not a plain object reads as absent', () => {
  const map = fakeMap();
  map.rules.unshift({ when: [{ path: ['type'], equals: 'probe' }, { path: ['a', 'b'], is: 'string' }], then: { final: ['a', 'b'] } });
  const read = (event: any) => { const t = parserOf(map); feed(t, [event, { type: 'done' }]); return t.end(); };
  for (const absent of [{ a: 5 }, { a: 'str' }, { a: null }, { a: [{ b: 'x' }] }, { a: true }, {}]) {
    const report = read({ type: 'probe', ...absent });
    assert.deepEqual([report.status, report.ignoredLines], ['unparsed', 1], JSON.stringify(absent));
  }
  assert.equal(read({ type: 'probe', a: { b: 'deep' } }).summary, 'deep');
  // an inherited property is not an own value
  assert.equal(read({ type: 'probe', a: Object.create({ b: 'inherited' }) }).ignoredLines, 1);
});

test('a path with __proto__, prototype or constructor is refused at compile time', () => {
  for (const segment of ['__proto__', 'prototype', 'constructor']) {
    const map = fakeMap();
    map.rules[0].when[1].path = ['a', segment];
    assert.throws(() => compileFieldMap(map), (error: any) => error.message.startsWith('field-map-invalid: fieldMap.rules[0].when[1].path[1]: '));
  }
  // and a line that carries an own __proto__ key is read safely by a map that does not name it
  const target = parserOf();
  target.line('{"type":"msg","text":"safe","__proto__":{"text":"polluted"}}');
  target.line('{"type":"done"}');
  assert.equal(target.end().summary, 'safe');
  assert.equal(({} as any).text, undefined);
});

test('21 denials keep 20 and count 21; each is masked and the detail is cut at 200 characters', () => {
  const events = Array.from({ length: 21 }, (_, i) => ({ type: 'deny', cmd: `cmd-${i} Bearer supersecretvalue ${'x'.repeat(300)}` }));
  const report = run(events);
  assert.equal(report.deniedCount, 21);
  assert.equal(report.denials.length, 20);
  assert.equal(report.denials[0].action, 'command');
  assert.ok(report.denials.every((d: any) => Array.from(d.detail).length <= 200 && !d.detail.includes('supersecretvalue')));
  assert.ok(report.denials[0].detail.startsWith('cmd-0 '));
  // the report holds a copy: a later denial does not change it
  const target = parserOf();
  feed(target, [{ type: 'deny', cmd: 'a' }]);
  const first = target.end();
  feed(target, [{ type: 'deny', cmd: 'b' }]);
  assert.equal(first.denials.length, 1);
});

test('a denial action and detail are masked, and a path-valued action is read as text', () => {
  const map = fakeMap();
  map.rules[2].then.denial.action = { path: ['tool'], as: 'text' };
  const report = run([{ type: 'deny', tool: `use ${SECRET}`, cmd: `token=${SECRET}` }], map);
  assert.ok(!JSON.stringify(report.denials).includes(SECRET), JSON.stringify(report.denials));
  const number = run([{ type: 'deny', tool: 42, cmd: { a: 1 } }], map);
  assert.deepEqual(number.denials, [{ action: '42', detail: '[object Object]' }]);
  const missing = run([{ type: 'deny' }], map);
  assert.deepEqual(missing.denials, [{ action: '', detail: '' }]);
});

test('usage: any sums with null as 0, all needs every path, an invalid count is null, and the last one overwrites', () => {
  const usage = (events: any[]) => run(events).usage;
  assert.deepEqual(usage([{ type: 'done', usage: { in: 3, out: 7 } }]), { tokens: 10 });
  assert.deepEqual(usage([{ type: 'done', usage: { in: 3 } }]), { tokens: 3 });
  assert.deepEqual(usage([{ type: 'done', usage: { in: 0, out: 0 } }]), { tokens: 0 });
  assert.equal(usage([{ type: 'done', usage: { in: -1, out: 1.5 } }]), null);
  assert.deepEqual(usage([{ type: 'done', usage: { in: -1, out: 5, total: 400 } }]), { tokens: 5 });
  assert.equal(usage([{ type: 'done' }]), null);
  assert.equal(usage([{ type: 'done', usage: 'x' }]), null);
  assert.deepEqual(usage([{ type: 'strict', usage: { in: 3, out: 7 } }]), { tokens: 10 });
  assert.equal(usage([{ type: 'strict', usage: { in: 3 } }]), null);
  assert.equal(usage([{ type: 'strict', usage: { in: 3, out: '7' } }]), null);
  // like the codex code, a later turn with nothing valid overwrites an earlier total with null
  assert.equal(usage([{ type: 'done', usage: { in: 3, out: 7 } }, { type: 'done', usage: {} }]), null);
  assert.deepEqual(usage([{ type: 'done', usage: {} }, { type: 'done', usage: { in: 1, out: 1 } }]), { tokens: 2 });
});

test('A-5: a usage part beyond the safe-integer range, or a sum that leaves it, makes usage null (the Pi parser\'s rule)', () => {
  const usage = (events: any[]) => run(events).usage;
  const SAFE = Number.MAX_SAFE_INTEGER;
  assert.deepEqual(usage([{ type: 'done', usage: { in: SAFE - 1, out: 1 } }]), { tokens: SAFE });
  assert.equal(usage([{ type: 'done', usage: { in: 2 ** 53, out: 1 } }]), null, 'a part over 2^53');
  assert.equal(usage([{ type: 'done', usage: { in: 1e300 } }]), null, 'a lone huge part');
  assert.equal(usage([{ type: 'strict', usage: { in: 2 ** 53, out: 0 } }]), null);
  assert.equal(usage([{ type: 'done', usage: { in: SAFE, out: 1 } }]), null, 'two safe parts whose sum is 2^53');
  assert.equal(usage([{ type: 'strict', usage: { in: SAFE, out: SAFE } }]), null);
});

test('a line with \\r endings parses and an escaped \\r inside a string is kept', () => {
  const target = parserOf();
  target.line('{"type":"msg","text":"a\\r"}\r');
  target.line('{"type":"done"}\r');
  const report = target.end();
  assert.deepEqual([report.status, report.summary, report.ignoredLines], ['success', 'a\r', 0]);
});

test('lastMessage exists only with finalFallback and fills a missing final from the file', () => {
  assert.equal('lastMessage' in parserOf(), false);
  const target = parserOf(fakeMap({ finalFallback: 'last-message-file' }));
  assert.equal(typeof target.lastMessage, 'function');
  feed(target, [{ type: 'done' }]);
  target.lastMessage('  from file  ');
  const report = target.end();
  assert.deepEqual([report.status, report.summary], ['success', '  from file  ']);

  const blank = parserOf(fakeMap({ finalFallback: 'last-message-file' }));
  feed(blank, [{ type: 'done' }]);
  blank.lastMessage('   \n');
  blank.lastMessage(undefined);
  assert.deepEqual(((r) => [r.status, r.reason])(blank.end()), ['unparsed', 'no-final-message']);

  const both = parserOf(fakeMap({ finalFallback: 'last-message-file' }));
  feed(both, [{ type: 'msg', text: 'stream' }, { type: 'done' }]);
  both.lastMessage('file');
  assert.equal(both.end().summary, 'stream');
  const late = parserOf(fakeMap({ finalFallback: 'last-message-file' }));
  late.lastMessage('first');
  late.lastMessage('second');
  feed(late, [{ type: 'done' }]);
  assert.equal(late.end().summary, 'second');
});

test('an invalid map throws field-map-invalid with the first error at compile time', () => {
  const map = fakeMap();
  map.rules[0].then.regex = 'a';
  assert.throws(() => compileFieldMap(map), (error: any) => error instanceof Error
    && error.message.startsWith('field-map-invalid: fieldMap.rules[0].then: ') && error.message.includes('regex'));
  assert.throws(() => compileFieldMap(null), /^Error: field-map-invalid: fieldMap: /);
});

test('compile refuses a map over 16 KiB', () => {
  const map = fakeMap();
  const wide = (seed: number) => Array.from({ length: 32 }, (_, i) => `${seed}-${i}`.padEnd(200, 'x'));
  map.rules.push({ when: [{ path: ['type'], in: wide(1) }], then: { spawn: true } }, { when: [{ path: ['type'], in: wide(2) }], then: { spawn: true } },
    { when: [{ path: ['type'], in: wide(3) }], then: { spawn: true } });
  assert.ok(Buffer.byteLength(JSON.stringify(map)) > MAX_BYTES);
  assert.throws(() => compileFieldMap(map), /^Error: field-map-invalid: fieldMap: .*16384/);
});

test('each static refusal reaches compile with its JSON location', () => {
  const cases: Array<[(map: any) => void, string]> = [
    [(m) => { m.rules[0].when = [{ path: ['type'], equals: 'msg' }]; }, 'fieldMap.rules[0].then.final: '],
    [(m) => { m.rules[1].when = [{ path: ['x'], is: 'present' }]; }, 'fieldMap.rules[1].when: '],
    [(m) => { m.rules = m.rules.filter((r: any) => !r.then.terminal || r.then.terminal.outcome !== 'completed'); }, 'fieldMap.rules: '],
    [(m) => { m.rules[1].when.push({ path: ['type'], equals: 'other' }); }, 'fieldMap.rules[1].when[1]: '],
  ];
  for (const [mutate, prefix] of cases) {
    const map = fakeMap();
    mutate(map);
    assert.throws(() => compileFieldMap(map), (error: any) => error.message.startsWith(`field-map-invalid: ${prefix}`), prefix);
  }
});

/** mulberry32: a small deterministic PRNG, so a failure reproduces. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomValue(next: () => number, depth: number): any {
  const pick = Math.floor(next() * (depth > 3 ? 5 : 7));
  if (pick === 0) return null;
  if (pick === 1) return next() < 0.5;
  if (pick === 2) return Math.floor(next() * 2000) - 1000 + (next() < 0.3 ? 0.5 : 0);
  if (pick === 3) return ['msg', 'done', 'fail', 'error', 'deny', 'spawn', 'text', ''][Math.floor(next() * 8)];
  if (pick === 4) return 'é€😀\u0000\\"'.repeat(Math.floor(next() * 3));
  if (pick === 5) return Array.from({ length: Math.floor(next() * 3) }, () => randomValue(next, depth + 1));
  const keys = ['type', 'text', 'cmd', 'usage', 'in', 'out', 'error', 'message', '__proto__', 'constructor'];
  const out: any = {};
  for (let i = 0; i < Math.floor(next() * 5); i++) Object.defineProperty(out, keys[Math.floor(next() * keys.length)], { value: randomValue(next, depth + 1), enumerable: true, configurable: true, writable: true });
  return out;
}

test('line() never throws on 1,000 seeded random strings, valid-looking JSON events included', () => {
  const next = prng(171);
  const alphabet = '{}[]":,\\ntrue\r\u0000é€😀 0123456789.-eE';
  const target = parserOf(fakeMap({ finalFallback: 'last-message-file' }));
  let lines = 0;
  for (let i = 0; i < 1000; i++) {
    let text: string;
    const mode = i % 4;
    if (mode === 0) text = Array.from({ length: Math.floor(next() * 80) }, () => alphabet[Math.floor(next() * alphabet.length)]).join('');
    else if (mode === 1) text = JSON.stringify(randomValue(next, 0));
    else if (mode === 2) text = JSON.stringify({ type: ['msg', 'done', 'strict', 'fail', 'bare-fail', 'error', 'deny', 'spawn'][Math.floor(next() * 8)], text: randomValue(next, 1), cmd: randomValue(next, 1), usage: randomValue(next, 1), error: randomValue(next, 1), message: randomValue(next, 1) });
    else { const whole = JSON.stringify({ type: 'msg', text: 'x', usage: { in: 1 } }); text = whole.slice(0, Math.floor(next() * whole.length)); }
    assert.doesNotThrow(() => { target.line(text); lines++; }, text);
    if (i % 250 === 0) target.oversize(next() < 0.5);
  }
  assert.equal(lines, 1000);
  for (const odd of [undefined, null, 5, {}, [], Symbol('s')] as any[]) assert.doesNotThrow(() => target.line(odd));
  assert.doesNotThrow(() => target.lastMessage(undefined));
  const report = target.end();
  assert.equal(report.parser, 'fake-run-v1');
  assert.ok(['success', 'failure', 'denied', 'unparsed'].includes(report.status));
  assert.ok(report.denials.length <= 20 && report.deniedCount >= report.denials.length);
});

// ---------------------------------------------------------------------------------------------------------------
// The design §3.5 codex map, written here as a fixture. T4 commits the real map into harnesses.json.

function codexMap(): any {
  const type = (value: string) => ({ path: ['type'], equals: value });
  return {
    id: 'codex-exec-json-v1',
    format: 'jsonl-field-map-v1',
    eventType: ['type'],
    missingTerminal: 'no-turn-end',
    finalFallback: 'last-message-file',
    rules: [
      { when: [type('item.completed'), { path: ['item', 'type'], equals: 'agent_message' }, { path: ['item', 'text'], is: 'string' }], then: { final: ['item', 'text'] } },
      { when: [{ path: ['type'], in: ['item.started', 'item.updated', 'item.completed'] }, { path: ['item', 'type'], equals: 'collab_tool_call' }, { path: ['item', 'tool'], equals: 'spawn_agent' }], then: { spawn: true } },
      { when: [type('item.completed'), { path: ['item', 'type'], equals: 'command_execution' }, { path: ['item', 'status'], equals: 'declined' }], then: { denial: { action: { literal: 'command' }, detail: { path: ['item', 'command'], as: 'text' } } } },
      { when: [type('turn.completed')], then: { terminal: { outcome: 'completed' }, usage: { tokens: { sum: [['usage', 'input_tokens'], ['usage', 'output_tokens']], require: 'any' } } } },
      { when: [type('turn.failed'), { path: ['error', 'message'], is: 'string' }], then: { terminal: { outcome: 'failed', summary: ['error', 'message'] } } },
      { when: [type('error'), { path: ['message'], is: 'string' }], then: { streamError: ['message'] } },
    ],
  };
}

test('the design 3.5 codex map compiles and reads codex-shaped streams', () => {
  const codex = (events: any[], withFile?: string) => {
    const target = compileFieldMap(codexMap()).create();
    feed(target, events);
    if (withFile !== undefined) target.lastMessage(withFile);
    return target.end();
  };

  const ok = codex([
    { type: 'thread.started', thread_id: 't' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'first' } },
    { type: 'item.completed', item: { type: 'agent_message', text: `Authorization: Bearer abcdefghijklmnop` } },
    { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 7, total_tokens: 400 } },
  ]);
  assert.deepEqual(ok, {
    parser: 'codex-exec-json-v1', status: 'success', reason: null, summary: 'Authorization: <masked>', denials: [], deniedCount: 0,
    usage: { tokens: 10 }, ignoredLines: 1,
  });

  assert.deepEqual(((r) => [r.status, r.reason, r.summary])(codex([{ type: 'turn.failed', error: { message: 'model gone' } }])), ['failure', null, 'model gone']);
  assert.deepEqual(((r) => [r.status, r.reason, r.summary])(codex([{ type: 'error', message: 'stream broke' }])), ['failure', 'stream-error', 'stream broke']);
  assert.deepEqual(((r) => [r.status, r.reason])(codex([{ type: 'item.updated', item: { type: 'collab_tool_call', tool: 'spawn_agent' } }, { type: 'turn.completed' }])), ['failure', 'spawn-observed']);
  assert.deepEqual(((r) => [r.status, r.reason])(codex([{ type: 'item.started', item: { type: 'agent_message', text: 'not consumed' } }, { type: 'turn.completed' }])), ['unparsed', 'no-final-message']);
  assert.deepEqual(((r) => [r.status, r.reason])(codex([])), ['unparsed', 'no-turn-end']);
  assert.deepEqual(((r) => [r.status, r.summary, r.usage])(codex([{ type: 'turn.completed', usage: { input_tokens: 1.5, output_tokens: -2 } }], 'from the file')), ['success', 'from the file', null]);

  const denied = codex([{ type: 'item.completed', item: { type: 'command_execution', status: 'declined', command: `rm Bearer supersecretvalue ${'x'.repeat(300)}` } }, { type: 'turn.completed' }]);
  assert.equal(denied.status, 'denied');
  assert.equal(denied.deniedCount, 1);
  assert.equal(denied.denials[0].action, 'command');
  assert.ok(!denied.denials[0].detail.includes('supersecretvalue') && Array.from(denied.denials[0].detail).length <= 200);
  // a declined command whose `command` is absent keeps the denial with an empty detail
  assert.deepEqual(codex([{ type: 'item.completed', item: { type: 'command_execution', status: 'declined' } }]).denials, [{ action: 'command', detail: '' }]);
  // a non-string agent message text falls through every rule and is ignored
  assert.equal(codex([{ type: 'item.completed', item: { type: 'agent_message', text: 5 } }]).ignoredLines, 1);
});
