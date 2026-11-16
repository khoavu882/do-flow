'use strict';

// Design §3.4 (S0-S4, the id pattern of S5): the `jsonl-field-map-v1` validator is pure and names a JSON location per error.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateFieldMap, FIELD_MAP_FORMAT, MAX_BYTES, MAX_RULES, MAX_TESTS, MAX_SEGMENTS, MAX_VALUES,
} = require('../../src/registry/field-map.ts');

function valid(): any {
  return {
    id: 'fake-run-v1',
    format: 'jsonl-field-map-v1',
    eventType: ['type'],
    missingTerminal: 'no-end',
    rules: [
      { when: [{ path: ['type'], equals: 'msg' }, { path: ['text'], is: 'string' }], then: { final: ['text'] } },
      { when: [{ path: ['type'], equals: 'done' }], then: { terminal: { outcome: 'completed' } } },
    ],
  };
}

function check(map: any): string[] {
  const errors: string[] = [];
  validateFieldMap(map, 'fieldMap', errors);
  return errors;
}

function clone(map: any): any { return JSON.parse(JSON.stringify(map)); }

test('a rule holding `regex` is refused at fieldMap.rules[0].then', () => {
  const map = valid();
  map.rules[0].then.regex = '^a';
  const errors = check(map);
  assert.ok(errors.some((e) => e.startsWith('fieldMap.rules[0].then: ') && e.includes('regex')), JSON.stringify(errors));
});

test('a valid map has no error, and the limits and grammar name are exported', () => {
  assert.deepEqual(check(valid()), []);
  assert.equal(FIELD_MAP_FORMAT, 'jsonl-field-map-v1');
  assert.deepEqual([MAX_BYTES, MAX_RULES, MAX_TESTS, MAX_SEGMENTS, MAX_VALUES], [16384, 32, 8, 8, 32]);
});

test('the location prefix is the one the caller passes', () => {
  const map = valid();
  map.format = 'other';
  const errors: string[] = [];
  validateFieldMap(map, 'workers[1].structuredOutput.fieldMap', errors);
  assert.ok(errors[0].startsWith('workers[1].structuredOutput.fieldMap.format: '), errors[0]);
});

test('S0: a non-object map, an unknown top-level key and a missing key are refused', () => {
  assert.ok(check(null)[0].startsWith('fieldMap: '));
  assert.ok(check([])[0].startsWith('fieldMap: '));
  const extra = valid(); extra.cost = true;
  assert.ok(check(extra).some((e) => e.startsWith('fieldMap: ') && e.includes("'cost'")));
  const missing = valid(); delete missing.missingTerminal;
  assert.ok(check(missing).some((e) => e.startsWith('fieldMap: ') && e.includes("missing key 'missingTerminal'")));
});

test('S0/S5: the id pattern, the format and finalFallback', () => {
  for (const id of ['Fake-v1', 'a-v1', 'fake-v0', 'fake-v01', 'fake', 'fake_run-v1', '1fake-v1', `a${'b'.repeat(48)}-v1`, 7]) {
    const map = valid(); map.id = id;
    assert.ok(check(map).some((e) => e.startsWith('fieldMap.id: ')), `id ${String(id)} accepted`);
  }
  for (const id of ['ab-v1', 'fake-run-v12', `a${'b'.repeat(47)}-v1`]) {
    const map = valid(); map.id = id;
    assert.deepEqual(check(map), [], id);
  }
  const fallback = valid(); fallback.finalFallback = 'last-message-file';
  assert.deepEqual(check(fallback), []);
  fallback.finalFallback = 'other';
  assert.ok(check(fallback).some((e) => e.startsWith('fieldMap.finalFallback: ')));
});

test('S0: missingTerminal reason pattern', () => {
  for (const reason of ['No-end', '', 'a'.repeat(41), '1a', 5]) {
    const map = valid(); map.missingTerminal = reason;
    assert.ok(check(map).some((e) => e.startsWith('fieldMap.missingTerminal: ')), String(reason));
  }
});

test('S0: paths hold 1 to 8 segments of the allowed shape and never __proto__, prototype or constructor', () => {
  const cases: Array<[any, string]> = [
    [[], 'fieldMap.eventType'],
    [['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'], 'fieldMap.eventType'],
    [['__proto__'], 'fieldMap.eventType[0]'],
    [['prototype'], 'fieldMap.eventType[0]'],
    [['constructor'], 'fieldMap.eventType[0]'],
    [['1a'], 'fieldMap.eventType[0]'],
    [['a b'], 'fieldMap.eventType[0]'],
    [[`a${'b'.repeat(64)}`], 'fieldMap.eventType[0]'],
    [[5], 'fieldMap.eventType[0]'],
    ['type', 'fieldMap.eventType'],
  ];
  for (const [path, location] of cases) {
    const map = valid(); map.eventType = path;
    assert.ok(check(map).some((e) => e.startsWith(`${location}: `)), `${JSON.stringify(path)} -> ${JSON.stringify(check(map))}`);
  }
  const ok = valid(); ok.eventType = ['$a_b-c', 'B', '_x'];
  assert.deepEqual(check(ok).filter((e) => e.startsWith('fieldMap.eventType')), []);
});

test('S0: a __proto__ segment in a test path is refused at its segment', () => {
  const map = valid();
  map.rules[0].when[1].path = ['a', '__proto__'];
  assert.ok(check(map).some((e) => e.startsWith('fieldMap.rules[0].when[1].path[1]: ')));
});

test('S0: rule and test counts', () => {
  const none = valid(); none.rules = [];
  assert.ok(check(none).some((e) => e.startsWith('fieldMap.rules: ')));
  const many = valid(); many.rules = Array.from({ length: MAX_RULES + 1 }, () => clone(valid().rules[1]));
  assert.ok(check(many).some((e) => e.startsWith('fieldMap.rules: ')));
  const emptyWhen = valid(); emptyWhen.rules[1].when = [];
  assert.ok(check(emptyWhen).some((e) => e.startsWith('fieldMap.rules[1].when: ')));
  const wide = valid();
  wide.rules[1].when = [{ path: ['type'], equals: 'done' }, ...Array.from({ length: MAX_TESTS }, (_, i) => ({ path: [`k${i}`], is: 'present' }))];
  assert.ok(check(wide).some((e) => e.startsWith('fieldMap.rules[1].when: ')));
  // Distinct event types: identical completed rules would hide each other (A-4c).
  const completed = (i: number) => { const rule = clone(valid().rules[1]); rule.when[0].equals = `done-${i}`; return rule; };
  assert.deepEqual(check({ ...valid(), rules: [valid().rules[0], ...Array.from({ length: MAX_RULES - 1 }, (_, i) => completed(i))] }), []);
});

test('S0: a test holds one closed key set and one of equals, in, is', () => {
  const cases: Array<[any, string]> = [
    [{ path: ['x'] }, 'fieldMap.rules[1].when[1]'],
    [{ path: ['x'], equals: 1, is: 'number' }, 'fieldMap.rules[1].when[1]'],
    [{ path: ['x'], equals: 1, regex: 'a' }, 'fieldMap.rules[1].when[1]'],
    [{ equals: 1 }, 'fieldMap.rules[1].when[1]'],
    [{ path: ['x'], equals: { a: 1 } }, 'fieldMap.rules[1].when[1].equals'],
    [{ path: ['x'], equals: [1] }, 'fieldMap.rules[1].when[1].equals'],
    [{ path: ['x'], equals: Infinity }, 'fieldMap.rules[1].when[1].equals'],
    [{ path: ['x'], equals: 'a'.repeat(201) }, 'fieldMap.rules[1].when[1].equals'],
    [{ path: ['x'], in: [] }, 'fieldMap.rules[1].when[1].in'],
    [{ path: ['x'], in: ['a', 'a'] }, 'fieldMap.rules[1].when[1].in'],
    [{ path: ['x'], in: Array.from({ length: MAX_VALUES + 1 }, (_, i) => i) }, 'fieldMap.rules[1].when[1].in'],
    [{ path: ['x'], in: [{}] }, 'fieldMap.rules[1].when[1].in[0]'],
    [{ path: ['x'], is: 'date' }, 'fieldMap.rules[1].when[1].is'],
    [{ path: ['x'], contains: 'a' }, 'fieldMap.rules[1].when[1]'],
  ];
  for (const [testCase, location] of cases) {
    const map = valid(); map.rules[1].when.push(testCase);
    assert.ok(check(map).some((e) => e.startsWith(`${location}: `)), `${JSON.stringify(testCase)} -> ${JSON.stringify(check(map))}`);
  }
  for (const testCase of [
    { path: ['x'], equals: null }, { path: ['x'], equals: false }, { path: ['x'], equals: 0 }, { path: ['x'], equals: 'a'.repeat(200) },
    { path: ['x'], in: ['a', 1, null, true] }, ...['string', 'number', 'integer', 'count', 'boolean', 'object', 'array', 'null', 'present']
      .map((kind) => ({ path: ['x'], is: kind })),
  ]) {
    const map = valid(); map.rules[1].when.push(testCase);
    assert.deepEqual(check(map), [], JSON.stringify(testCase));
  }
});

test('S0: then is a non-empty closed subset with well-formed actions', () => {
  const cases: Array<[any, string]> = [
    [{}, 'fieldMap.rules[1].then'],
    [[], 'fieldMap.rules[1].then'],
    [{ spawn: false }, 'fieldMap.rules[1].then.spawn'],
    [{ denial: { action: { literal: 'command' } } }, 'fieldMap.rules[1].then.denial'],
    [{ denial: { action: { literal: 'Command' }, detail: { literal: 'x' } } }, 'fieldMap.rules[1].then.denial.action.literal'],
    [{ denial: { action: { literal: 'a'.repeat(65) }, detail: { literal: 'x' } } }, 'fieldMap.rules[1].then.denial.action.literal'],
    [{ denial: { action: { path: ['a'] }, detail: { literal: 'x' } } }, 'fieldMap.rules[1].then.denial.action'],
    [{ denial: { action: { path: ['a'], as: 'number' }, detail: { literal: 'x' } } }, 'fieldMap.rules[1].then.denial.action.as'],
    [{ usage: { tokens: { sum: [], require: 'any' } } }, 'fieldMap.rules[1].then.usage.tokens.sum'],
    [{ usage: { tokens: { sum: [['a'], ['b'], ['c'], ['d'], ['e']], require: 'any' } } }, 'fieldMap.rules[1].then.usage.tokens.sum'],
    [{ usage: { tokens: { sum: [['a']], require: 'some' } } }, 'fieldMap.rules[1].then.usage.tokens.require'],
    [{ usage: { tokens: { sum: [['a']] } } }, 'fieldMap.rules[1].then.usage.tokens'],
    [{ usage: { cost: { sum: [['a']], require: 'any' } } }, 'fieldMap.rules[1].then.usage'],
    [{ terminal: { outcome: 'cancelled' } }, 'fieldMap.rules[1].then.terminal.outcome'],
    [{ terminal: { outcome: 'completed', summary: ['a'] } }, 'fieldMap.rules[1].then.terminal.summary'],
    [{ terminal: { outcome: 'failed', extra: 1 } }, 'fieldMap.rules[1].then.terminal'],
    [{ final: 'text' }, 'fieldMap.rules[1].then.final'],
  ];
  for (const [then, location] of cases) {
    const map = valid(); map.rules[1].then = { ...(Array.isArray(then) ? {} : then) };
    if (Array.isArray(then)) map.rules[1].then = then;
    assert.ok(check(map).some((e) => e.startsWith(`${location}: `)), `${JSON.stringify(then)} -> ${JSON.stringify(check(map))}`);
  }
});

const size = (map: any): number => Buffer.byteLength(JSON.stringify(map));

/** A valid map padded with 200-char values to exactly `MAX_BYTES + extra` bytes. */
function paddedTo(extra: number): any {
  const map = valid();
  const wide = (seed: number) => Array.from({ length: MAX_VALUES }, (_, i) => `${seed}-${String(i).padStart(3, '0')}`.padEnd(200, 'x'));
  map.rules.push({ when: [{ path: ['type'], in: wide(1) }], then: { spawn: true } });
  map.rules.push({ when: [{ path: ['type'], in: wide(2) }], then: { spawn: true } });
  while (size(map) < MAX_BYTES - 250) map.rules.push({ when: [{ path: ['type'], equals: `p${map.rules.length}`.padEnd(100, 'y') }], then: { spawn: true } });
  const tail = { when: [{ path: ['type'], equals: 'z' }], then: { spawn: true } };
  map.rules.push(tail);
  tail.when[0].equals = 'z'.repeat(1 + (MAX_BYTES + extra - size(map)));
  return map;
}

test('S0: a map of exactly 16 KiB is accepted and one byte more is refused', () => {
  const exact = paddedTo(0);
  assert.equal(size(exact), MAX_BYTES);
  assert.ok(exact.rules.length <= MAX_RULES);
  assert.deepEqual(check(exact), []);
  const over = paddedTo(1);
  assert.equal(size(over), MAX_BYTES + 1);
  const errors = check(over);
  assert.ok(errors.some((e) => e.startsWith('fieldMap: ') && e.includes('16384')), JSON.stringify(errors));
});

test('S0: a map that cannot be serialized is refused, never thrown', () => {
  const map: any = valid();
  map.self = map;
  assert.doesNotThrow(() => check(map));
  assert.ok(check(map).length > 0);
});

test('S1: final, terminal.summary and streamError each need an is:string test on the same path in the same rule', () => {
  const finalMap = valid(); finalMap.rules[0].when = [{ path: ['type'], equals: 'msg' }];
  assert.ok(check(finalMap).some((e) => e.startsWith('fieldMap.rules[0].then.final: ')));
  const wrongPath = valid(); wrongPath.rules[0].when[1].path = ['other'];
  assert.ok(check(wrongPath).some((e) => e.startsWith('fieldMap.rules[0].then.final: ')));
  const wrongKind = valid(); wrongKind.rules[0].when[1] = { path: ['text'], is: 'present' };
  assert.ok(check(wrongKind).some((e) => e.startsWith('fieldMap.rules[0].then.final: ')));

  const summary = valid();
  summary.rules.push({ when: [{ path: ['type'], equals: 'fail' }], then: { terminal: { outcome: 'failed', summary: ['error', 'message'] } } });
  assert.ok(check(summary).some((e) => e.startsWith('fieldMap.rules[2].then.terminal.summary: ')));
  summary.rules[2].when.push({ path: ['error', 'message'], is: 'string' });
  assert.deepEqual(check(summary), []);

  const streamError = valid();
  streamError.rules.push({ when: [{ path: ['type'], equals: 'error' }], then: { streamError: ['message'] } });
  assert.ok(check(streamError).some((e) => e.startsWith('fieldMap.rules[2].then.streamError: ')));
  streamError.rules[2].when.push({ path: ['message'], is: 'string' });
  assert.deepEqual(check(streamError), []);

  // a guard in another rule does not count
  const elsewhere = valid();
  elsewhere.rules.push({ when: [{ path: ['type'], equals: 'error' }, { path: ['text'], is: 'string' }], then: { spawn: true } });
  elsewhere.rules[0].when = [{ path: ['type'], equals: 'msg' }];
  assert.ok(check(elsewhere).some((e) => e.startsWith('fieldMap.rules[0].then.final: ')));
});

test('S2: every rule needs an equals or in test on eventType', () => {
  const none = valid(); none.rules[1].when = [{ path: ['x'], is: 'present' }];
  assert.ok(check(none).some((e) => e.startsWith('fieldMap.rules[1].when: ')));
  const isOnly = valid(); isOnly.rules[1].when = [{ path: ['type'], is: 'string' }];
  assert.ok(check(isOnly).some((e) => e.startsWith('fieldMap.rules[1].when: ')));
  const viaIn = valid(); viaIn.rules[1].when = [{ path: ['type'], in: ['done', 'end'] }];
  assert.deepEqual(check(viaIn), []);
  const deepEvent = valid(); deepEvent.eventType = ['meta', 'kind'];
  assert.ok(check(deepEvent).some((e) => e.startsWith('fieldMap.rules[0].when: ')));
});

test('S3: a completed terminal and a final source are both required', () => {
  const noCompleted = valid(); noCompleted.rules[1].then = { terminal: { outcome: 'failed' } };
  assert.ok(check(noCompleted).some((e) => e.startsWith('fieldMap.rules: ') && e.includes('completed')));
  const noFinal = valid(); noFinal.rules = [noFinal.rules[1]];
  assert.ok(check(noFinal).some((e) => e.startsWith('fieldMap.rules: ') && e.includes('final')));
  noFinal.finalFallback = 'last-message-file';
  assert.deepEqual(check(noFinal), []);
});

test('S4: two tests on one path that exclude each other are refused', () => {
  const cases: Array<[any[], string]> = [
    [[{ path: ['x'], equals: 'a' }, { path: ['x'], equals: 'b' }], 'fieldMap.rules[1].when[2]'],
    [[{ path: ['x'], equals: 'a' }, { path: ['x'], in: ['b', 'c'] }], 'fieldMap.rules[1].when[2]'],
    [[{ path: ['x'], in: ['b', 'c'] }, { path: ['x'], equals: 'a' }], 'fieldMap.rules[1].when[2]'],
    [[{ path: ['x'], in: ['a', 'b'] }, { path: ['x'], in: ['c'] }], 'fieldMap.rules[1].when[2]'],
    [[{ path: ['x'], is: 'string' }, { path: ['x'], is: 'number' }], 'fieldMap.rules[1].when[2]'],
    [[{ path: ['x'], is: 'count' }, { path: ['x'], is: 'string' }], 'fieldMap.rules[1].when[2]'],
    [[{ path: ['x'], is: 'object' }, { path: ['x'], is: 'array' }], 'fieldMap.rules[1].when[2]'],
    [[{ path: ['x'], is: 'null' }, { path: ['x'], is: 'present' }, { path: ['x'], is: 'boolean' }], 'fieldMap.rules[1].when[3]'],
    [[{ path: ['x'], equals: 'a' }, { path: ['x'], is: 'number' }], 'fieldMap.rules[1].when[2]'],
    [[{ path: ['x'], in: ['a', true] }, { path: ['x'], is: 'number' }], 'fieldMap.rules[1].when[2]'],
  ];
  for (const [tests, location] of cases) {
    const map = valid(); map.rules[1].when.push(...tests);
    assert.ok(check(map).some((e) => e.startsWith(`${location}: `)), `${JSON.stringify(tests)} -> ${JSON.stringify(check(map))}`);
  }
});

test('S4: compatible tests on one path are accepted', () => {
  const groups: any[][] = [
    [{ path: ['x'], equals: 'a' }, { path: ['x'], in: ['a', 'b'] }, { path: ['x'], is: 'string' }],
    [{ path: ['x'], is: 'integer' }, { path: ['x'], is: 'count' }, { path: ['x'], is: 'number' }, { path: ['x'], is: 'present' }],
    [{ path: ['x'], in: ['a', 'b'] }, { path: ['x'], in: ['b', 'c'] }],
    [{ path: ['x'], equals: 3 }, { path: ['x'], is: 'integer' }],
    [{ path: ['x'], equals: null }, { path: ['x'], is: 'null' }],
  ];
  for (const tests of groups) {
    const map = valid(); map.rules[1].when.push(...tests);
    assert.deepEqual(check(map), [], JSON.stringify(tests));
  }
});

test('S4: a test reading through a path another test pins to a non-object is refused (prefix conflict)', () => {
  const cases: Array<[any[], string]> = [
    [[{ path: ['a'], is: 'string' }, { path: ['a', 'b'], is: 'present' }], 'fieldMap.rules[1].when[2]'],
    [[{ path: ['a', 'b'], is: 'present' }, { path: ['a'], equals: 'x' }], 'fieldMap.rules[1].when[1]'],
    [[{ path: ['a'], in: ['x'] }, { path: ['a', 'b', 'c'], equals: 1 }], 'fieldMap.rules[1].when[2]'],
    [[{ path: ['a'], is: 'null' }, { path: ['a', 'b'], is: 'null' }], 'fieldMap.rules[1].when[2]'],
    [[{ path: ['a'], is: 'array' }, { path: ['a', 'b'], is: 'present' }], 'fieldMap.rules[1].when[2]'],
  ];
  for (const [tests, location] of cases) {
    const map = valid(); map.rules[1].when.push(...tests);
    assert.ok(check(map).some((e) => e.startsWith(`${location}: `) && e.includes('prefix')), `${JSON.stringify(tests)} -> ${JSON.stringify(check(map))}`);
  }
  for (const tests of [
    [{ path: ['a'], is: 'object' }, { path: ['a', 'b'], is: 'string' }],
    [{ path: ['a'], is: 'present' }, { path: ['a', 'b'], is: 'string' }],
    [{ path: ['a', 'b'], is: 'string' }, { path: ['a', 'c'], equals: 'x' }],
  ]) {
    const map = valid(); map.rules[1].when.push(...tests);
    assert.deepEqual(check(map), [], JSON.stringify(tests));
  }
});

test('validateFieldMap does not mutate the map and accepts a frozen one', () => {
  const map = valid();
  const before = JSON.stringify(map);
  const deep = (value: any): any => { if (value && typeof value === 'object') { Object.values(value).forEach(deep); Object.freeze(value); } return value; };
  assert.deepEqual(check(deep(map)), []);
  assert.equal(JSON.stringify(map), before);
});

test('A-4a: an equals or in test on the event type path with a non-string value is refused at its location', () => {
  const equals = valid();
  equals.rules[1].when[0] = { path: ['type'], equals: 7 };
  assert.ok(check(equals).some((e) => e.startsWith('fieldMap.rules[1].when[0].equals: ') && e.includes('string')), JSON.stringify(check(equals)));
  const list = valid();
  list.rules[1].when[0] = { path: ['type'], in: ['done', null] };
  assert.ok(check(list).some((e) => e.startsWith('fieldMap.rules[1].when[0].in[1]: ') && e.includes('string')), JSON.stringify(check(list)));
  // A non-string on any other path is fine.
  const other = valid();
  other.rules[0].when.push({ path: ['n'], equals: 7 });
  assert.deepEqual(check(other), []);
});

test('A-4b: a completed rule that also sets spawn is refused at its then.spawn', () => {
  const map = valid();
  map.rules[1].then.spawn = true;
  assert.ok(check(map).some((e) => e.startsWith('fieldMap.rules[1].then.spawn: ') && e.includes('completed')), JSON.stringify(check(map)));
  const failed = valid();
  failed.rules.push({ when: [{ path: ['type'], equals: 'x' }], then: { spawn: true, terminal: { outcome: 'failed' } } });
  assert.deepEqual(check(failed), []);
});

test('A-4c: a completed rule hidden by an earlier rule with the same or a wider test is refused, and an undecidable pair is accepted', () => {
  const hidden = (earlier: any[], later: any[]) => {
    const map = valid();
    map.finalFallback = 'last-message-file';
    map.rules = [{ when: earlier, then: { spawn: true } }, { when: later, then: { terminal: { outcome: 'completed' } } }];
    return check(map);
  };
  const type = (value: string) => ({ path: ['type'], equals: value });
  const shadow = (errors: string[]) => errors.some((e) => e.startsWith('fieldMap.rules[1].when: ') && e.includes('rules[0]'));
  assert.ok(shadow(hidden([type('done')], [type('done')])), 'the same equals');
  assert.ok(shadow(hidden([{ path: ['type'], in: ['done', 'end'] }], [type('done')])), 'in holds the later equals');
  assert.ok(shadow(hidden([{ path: ['type'], in: ['done', 'end'] }], [{ path: ['type'], in: ['end'] }])), 'in holds the later in');
  assert.ok(shadow(hidden([type('done'), { path: ['x'], is: 'string' }], [type('done'), { path: ['x'], equals: 'a' }])), 'an is kind the later value satisfies');
  assert.ok(shadow(hidden([type('done'), { path: ['x'], is: 'present' }], [type('done'), { path: ['x'], is: 'count' }])), 'present on a path the later rule tests');
  assert.ok(shadow(hidden([type('done'), { path: ['x'], is: 'number' }], [type('done'), { path: ['x'], is: 'integer' }])), 'a wider is kind');
  // Not decidable from the pair, or not hidden: accepted.
  assert.deepEqual(hidden([type('done'), { path: ['x'], equals: 'a' }], [type('done')]), [], 'the earlier rule needs a test the later one lacks');
  assert.deepEqual(hidden([type('done')], [type('end')]), [], 'a different value');
  assert.deepEqual(hidden([type('done'), { path: ['x'], is: 'integer' }], [type('done'), { path: ['x'], is: 'number' }]), [], 'a narrower earlier kind');
  assert.deepEqual(hidden([{ path: ['type'], in: ['done'] }], [{ path: ['type'], in: ['done', 'end'] }]), [], 'a wider later in');
  // A rule that does not complete is not checked.
  const map = valid();
  map.finalFallback = 'last-message-file';
  map.rules = [{ when: [type('done')], then: { spawn: true } }, { when: [type('done')], then: { terminal: { outcome: 'failed' } } }, valid().rules[1]];
  map.rules[2].when = [type('stop')];
  assert.deepEqual(check(map), []);
});

test('B3: a non-finite number in an equals or in test is refused at its location', () => {
  const equals = valid();
  equals.rules[0].when.push({ path: ['n'], equals: JSON.parse('1e400') });
  assert.ok(check(equals).some((e) => e.startsWith('fieldMap.rules[0].when[2].equals: ') && e.includes('finite')), JSON.stringify(check(equals)));
  const list = valid();
  list.rules[0].when.push({ path: ['n'], in: [1, -JSON.parse('1e400')] });
  assert.ok(check(list).some((e) => e.startsWith('fieldMap.rules[0].when[2].in[1]: ') && e.includes('finite')), JSON.stringify(check(list)));
});
