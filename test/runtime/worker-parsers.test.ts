'use strict';

// IC-016, DEC-027: the worker parser table, doflow-jsonl-v1 and the unparsed fallback.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PARSERS, parserFor } = require('../../src/runtime/worker/parsers.ts');

const ID = 'doflow-jsonl-v1';

function run(lines: any) {
  const parser = PARSERS[ID].create();
  for (const line of lines) parser.line(typeof line === 'string' ? line : JSON.stringify(line));
  return parser.end();
}

test('the table registers doflow-jsonl-v1 and codex-exec-json-v1 as ordinary properties and parserFor returns them', () => {
  assert.deepEqual(Object.keys(PARSERS), [ID, 'codex-exec-json-v1']);
  assert.equal(parserFor('codex-exec-json-v1'), PARSERS['codex-exec-json-v1']);
  assert.equal(PARSERS[ID].id, ID);
  assert.equal(parserFor(ID), PARSERS[ID]);
});

test('a success result line gives a success report', () => {
  const report = run([{ type: 'usage', tokens: 12 }, { type: 'result', status: 'success', summary: 'done' }]);
  assert.deepEqual(report, {
    parser: ID, status: 'success', reason: null, summary: 'done',
    denials: [], deniedCount: 0, usage: { tokens: 12 }, ignoredLines: 0,
  });
});

test('a failure result line gives a failure report, and the last result wins', () => {
  const report = run([{ type: 'result', status: 'success', summary: 'first' }, { type: 'result', status: 'failure', summary: 'second' }]);
  assert.equal(report.status, 'failure');
  assert.equal(report.summary, 'second');
  assert.equal(report.reason, null);
});

test('no result line gives unparsed with reason no-result-line', () => {
  const report = run([{ type: 'usage', tokens: 3 }]);
  assert.equal(report.status, 'unparsed');
  assert.equal(report.reason, 'no-result-line');
  assert.equal(report.summary, null);
});

test('a denial followed by a success result is denied', () => {
  const report = run([
    { type: 'permission-denied', action: 'write', detail: 'src/a.ts' },
    { type: 'result', status: 'success', summary: 'all good' },
  ]);
  assert.equal(report.status, 'denied');
  assert.equal(report.deniedCount, 1);
  assert.deepEqual(report.denials, [{ action: 'write', detail: 'src/a.ts' }]);
  assert.equal(report.summary, 'all good');
});

test('25 denials keep 20 and count 25; detail is cut to 200 characters', () => {
  const lines: any = [];
  for (let i = 0; i < 25; i++) lines.push({ type: 'permission-denied', action: `a${i}`, detail: 'x'.repeat(300) });
  const report = run(lines);
  assert.equal(report.deniedCount, 25);
  assert.equal(report.denials.length, 20);
  assert.equal(report.denials[19].action, 'a19');
  assert.equal(report.denials[0].detail.length, 200);
});

test('a 3-byte character at the 2000-byte cut is not split', () => {
  const summary = 'a'.repeat(1999) + '€' + 'b'.repeat(10); // € is 3 bytes in UTF-8, at bytes 1999 to 2001
  const report = run([{ type: 'result', status: 'success', summary }]);
  assert.equal(report.summary, 'a'.repeat(1999));
  assert.ok(Buffer.byteLength(report.summary, 'utf8') <= 2000);
  assert.ok(!report.summary.includes('\uFFFD'));
});

test('a summary holding an sk- token is masked; action and detail are masked', () => {
  const secret = `sk-${'aB3dE5gH7jK9mN1pQ3sT5vW7'}`; // sk- plus 24 alphanumerics
  const report = run([
    { type: 'permission-denied', action: `use ${secret}`, detail: `token=${secret}` },
    { type: 'result', status: 'success', summary: `key is ${secret} here` },
  ]);
  assert.ok(!report.summary.includes(secret));
  assert.ok(report.summary.includes('<masked>'));
  assert.ok(!report.denials[0].action.includes(secret));
  assert.ok(!report.denials[0].detail.includes(secret));
});

test('a non-JSON line and a JSON line with no type are ignored', () => {
  const report = run(['not json', '{"status":"success","summary":"x"}', '[1,2]', { type: 'progress', note: 'hi' },
    { type: 'result', status: 'success', summary: 'ok' }]);
  assert.equal(report.ignoredLines, 4);
  assert.equal(report.status, 'success');
});

test('negative or non-integer usage is ignored; the last valid usage wins', () => {
  const report = run([{ type: 'usage', tokens: 5 }, { type: 'usage', tokens: -1 }, { type: 'usage', tokens: 1.5 },
    { type: 'result', status: 'success', summary: 'ok' }]);
  assert.deepEqual(report.usage, { tokens: 5 });
  assert.equal(report.ignoredLines, 2);
  assert.equal(run([{ type: 'usage', tokens: -4 }]).usage, null);
});

test('parserFor falls back to unparsed for a null or unknown id', () => {
  for (const [id, reason] of [[null, 'no-structured-output-declared'], [undefined, 'no-structured-output-declared'],
    ['nope-v9', 'parser-unknown'], ['toString', 'parser-unknown']]) {
    const parser = parserFor(id);
    assert.equal(parser.id, 'unparsed');
    const instance = parser.create();
    instance.line(JSON.stringify({ type: 'result', status: 'success', summary: 'ok' }));
    instance.line(JSON.stringify({ type: 'permission-denied', action: 'a', detail: 'd' }));
    assert.deepEqual(instance.end(), {
      parser: 'unparsed', status: 'unparsed', reason, summary: null,
      denials: [], deniedCount: 0, usage: null, ignoredLines: 2,
    });
  }
});

// S-2 (DEC-057): a line over the 4 MiB buffer reaches the parser as one oversize event.
test('a JSON-looking oversize line then a success result is unparsed, reason oversize-line', () => {
  const parser = PARSERS[ID].create();
  parser.oversize(true);
  parser.line(JSON.stringify({ type: 'result', status: 'success', summary: 'done' }));
  const report = parser.end();
  assert.equal(report.status, 'unparsed');
  assert.equal(report.reason, 'oversize-line');
  assert.equal(report.ignoredLines, 1);
});

test('a denial wins over a JSON-looking oversize line, before or after it', () => {
  for (const order of ['denial-first', 'oversize-first']) {
    const parser = PARSERS[ID].create();
    const denial = JSON.stringify({ type: 'permission-denied', action: 'write', detail: 'a.js' });
    if (order === 'denial-first') parser.line(denial);
    parser.oversize(true);
    if (order === 'oversize-first') parser.line(denial);
    parser.line(JSON.stringify({ type: 'result', status: 'success', summary: 'done' }));
    assert.equal(parser.end().status, 'denied', order);
  }
});

test('an oversize line that does not look like JSON is ignored, and the unparsed fallback accepts oversize', () => {
  const parser = PARSERS[ID].create();
  parser.oversize(false);
  parser.line(JSON.stringify({ type: 'result', status: 'success', summary: 'done' }));
  const report = parser.end();
  assert.equal(report.status, 'success');
  assert.equal(report.ignoredLines, 1);
  const fallback = parserFor(null).create();
  fallback.oversize(true);
  assert.equal(fallback.end().ignoredLines, 1);
});
