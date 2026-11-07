'use strict';

// IC-002 rule 7 / IC-005 / IC-014: copilot-json-v1 decisions, precedence, masking, bounds, fixtures.
// Every fixture under test/fixtures/worker-parsers/copilot/ is `synthetic` until a live run is cited.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const copilot = require('../../src/runtime/worker/parsers/copilot.ts');

const ID = 'copilot-json-v1';
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'worker-parsers', 'copilot');
const LABEL = /^(synthetic|probe-[\w.-]+-trimmed|captured-[\w.-]+-trimmed)$/;

function parser() {
  return copilot.create();
}

function line(target: any, event: any) {
  target.line(typeof event === 'string' ? event : JSON.stringify(event));
}

function run(events: any[]) {
  const target = parser();
  for (const event of events) line(target, event);
  return target.end();
}

function fixture(name: string) {
  const target = parser();
  const raw = fs.readFileSync(path.join(FIXTURES, `${name}.jsonl`), 'utf8');
  for (const text of raw.split('\n')) if (text) target.line(text);
  return target.end();
}

const message = (content: any) => ({ type: 'assistant.message', data: { content } });
const result = (exitCode: any, extra: any = {}) => ({ type: 'result', sessionId: 's1', exitCode, ...extra });
const denied = (toolName: any = 'create', args: any = { path: 'a.txt' }) => deniedRaw(toolName, args);
const deniedRaw = (toolName: any, args: any) => ({
  type: 'tool.execution_complete',
  data: { toolName, success: false, error: { code: 'denied', message: 'refused' }, arguments: args },
});
const secret = () => 'Bearer ' + 'abcdefghijklmnop'; // built at runtime: no secret-shaped literal in the file

test('module exports the id and a factory that returns the IC-001 instance', () => {
  assert.equal(copilot.ID, ID);
  const target = parser();
  assert.deepEqual(Object.keys(target).sort(), ['end', 'line', 'oversize']);
  assert.deepEqual(parser().end(), {
    parser: ID, status: 'unparsed', reason: 'no-result-event', summary: null, denials: [], deniedCount: 0,
    usage: null, ignoredLines: 0,
  });
});

test('fixtures: every line is LF-terminated JSON with a _fixture label, no absolute path, no secret', () => {
  const files = fs.readdirSync(FIXTURES).filter((name: string) => name.endsWith('.jsonl')).sort();
  assert.deepEqual(files.map((name: string) => name.replace(/\.jsonl$/, '')),
    ['denied', 'failure', 'spawn', 'success', 'truncated', 'unknown-events']);
  const labels = new Set<string>();
  for (const name of files) {
    const raw = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
    assert.ok(raw.endsWith('\n') && !raw.includes('\r'), `${name}: LF endings`);
    assert.ok(!/(?:^|["\s])(?:\/Users|\/home|[A-Za-z]:\\)/.test(raw), `${name}: absolute path`);
    for (const text of raw.split('\n').filter(Boolean)) {
      const event = JSON.parse(text);
      assert.match(event._fixture, LABEL, `${name}: _fixture label`);
      labels.add(event._fixture);
      assert.ok(!/Bearer|api[_-]?key|token["']?\s*[:=]\s*["'][A-Za-z0-9]{16,}/i.test(text), `${name}: secret-shaped`);
    }
  }
  // Names the provenance (IC-014): while every fixture is synthetic, no captured file exists yet.
  assert.deepEqual([...labels], ['synthetic']);
});

test('fixture success: last non-empty assistant.message is the summary; usage needs both token fields', () => {
  assert.deepEqual(fixture('success'), {
    parser: ID, status: 'success', reason: null, summary: 'The repository ships a CLI installer.',
    denials: [], deniedCount: 0, usage: { tokens: 150 }, ignoredLines: 9,
  });
});

test('fixture failure: a non-zero exitCode is a failure that keeps the masked last message', () => {
  const report = fixture('failure');
  assert.deepEqual([report.status, report.reason, report.summary, report.usage],
    ['failure', null, 'I could not finish the task.', null]);
});

test('fixture truncated: no result event is unparsed with no-result-event', () => {
  const report = fixture('truncated');
  assert.deepEqual([report.status, report.reason, report.summary], ['unparsed', 'no-result-event', null]);
});

test('fixture unknown-events: unread event types only add to ignoredLines', () => {
  const report = fixture('unknown-events');
  assert.deepEqual([report.status, report.summary, report.ignoredLines], ['success', 'Done.', 5]);
});

test('fixture spawn: subagent.started followed by exitCode 0 is a spawn-observed failure with no summary', () => {
  const report = fixture('spawn');
  assert.deepEqual([report.status, report.reason, report.summary], ['failure', 'spawn-observed', null]);
});

test('fixture denied: tool.execution_complete with error.code denied is a denial; success does not hide it', () => {
  const report = fixture('denied');
  assert.equal(report.status, 'denied');
  assert.equal(report.reason, null);
  assert.equal(report.deniedCount, 1);
  assert.deepEqual(report.denials, [{ action: 'create', detail: '' }]);
});

test('denial rules: only success=false with error.code "denied" counts; other failures are ignored', () => {
  const report = run([
    { type: 'tool.execution_complete', data: { toolName: 'x', success: false, error: { code: 'failed' } } },
    { type: 'tool.execution_complete', data: { toolName: 'x', success: true, error: { code: 'denied' } } },
    { type: 'tool.execution_complete', data: { toolName: 'x', error: { code: 'denied' } } },
    { type: 'tool.execution_complete', data: { toolName: 'x', success: false, error: 'denied' } },
    { type: 'tool.execution_complete' },
    message('done'), result(0),
  ]);
  assert.deepEqual([report.status, report.deniedCount, report.ignoredLines], ['success', 0, 5]);
});

test('a denial without toolName or target uses a placeholder action and an empty detail; arguments, when present, give the target', () => {
  const report = run([deniedRaw(undefined, undefined)]);
  assert.deepEqual(report.denials, [{ action: 'tool', detail: '' }]);
  const command = run([deniedRaw('shell', { command: 'rm -rf build' })]);
  assert.deepEqual(command.denials, [{ action: 'shell', detail: 'rm -rf build' }]);
  const typed = run([deniedRaw('shell', { command: 42, path: ['x'] })]);
  assert.deepEqual(typed.denials, [{ action: 'shell', detail: '' }]);
});

test('denials are masked, cut to 200 characters, and capped at 20 stored while all are counted', () => {
  const target = parser();
  for (let i = 0; i < 25; i++) line(target, denied(`tool-${i}`, { command: `run ${secret()} ${'x'.repeat(300)}` }));
  const report = target.end();
  assert.equal(report.status, 'denied');
  assert.equal(report.deniedCount, 25);
  assert.equal(report.denials.length, 20);
  assert.ok(report.denials[0].detail.length <= 200);
  assert.match(report.denials[0].detail, /<masked>/);
  assert.ok(!report.denials[0].detail.includes('abcdefghijklmnop'));
  const action = run([denied(`name ${secret()}`)]).denials[0].action;
  assert.ok(!action.includes('abcdefghijklmnop'));
});

test('precedence: denied beats success, oversize and spawn', () => {
  const success = run([message('done'), denied(), result(0)]);
  assert.deepEqual([success.status, success.reason, success.summary], ['denied', null, null]);

  const target = parser();
  target.oversize(true);
  line(target, { type: 'subagent.started', data: {} });
  line(target, denied());
  assert.equal(target.end().status, 'denied');
});

test('precedence: a denial after the terminal result still wins', () => {
  assert.equal(run([message('done'), result(0), denied()]).status, 'denied');
});

test('precedence: oversize beats spawn and success; spawn beats success and failure', () => {
  const oversize = parser();
  line(oversize, message('done'));
  line(oversize, result(0));
  oversize.oversize(true);
  assert.deepEqual([oversize.end().status, oversize.end().reason], ['unparsed', 'oversize-line']);

  const both = parser();
  line(both, { type: 'subagent.started', data: {} });
  both.oversize(true);
  assert.equal(both.end().reason, 'oversize-line');

  const spawnFailure = run([{ type: 'subagent.started' }, message('x'), result(2)]);
  assert.deepEqual([spawnFailure.status, spawnFailure.reason, spawnFailure.summary], ['failure', 'spawn-observed', null]);
});

test('a spawn after the terminal result undoes success', () => {
  const report = run([message('done'), result(0), { type: 'subagent.started', data: {} }]);
  assert.deepEqual([report.status, report.reason], ['failure', 'spawn-observed']);
});

test('a non-spawn line after the terminal result does not undo it', () => {
  const report = run([message('first'), result(0), message('second'), 'garbage', { type: 'session.shutdown' }]);
  assert.equal(report.status, 'success');
  assert.equal(report.ignoredLines, 2);
  const failed = run([message('x'), result(1), 'garbage']);
  assert.equal(failed.status, 'failure');
});

test('oversize: a non-JSON oversize line is only counted; a JSON-looking one is unparsed', () => {
  const plain = parser();
  line(plain, message('done'));
  line(plain, result(0));
  plain.oversize(false);
  const plainReport = plain.end();
  assert.deepEqual([plainReport.status, plainReport.ignoredLines], ['success', 1]);

  const json = parser();
  json.oversize(true);
  assert.deepEqual([json.end().status, json.end().reason, json.end().ignoredLines], ['unparsed', 'oversize-line', 1]);
});

test('fail closed: a result whose exitCode is not an integer is not a terminal signal', () => {
  for (const exitCode of ['0', null, undefined, 0.5, true, [0], {}, NaN]) {
    const report = run([message('done'), result(exitCode)]);
    assert.deepEqual([report.status, report.reason], ['unparsed', 'no-result-event'], String(exitCode));
    assert.equal(report.ignoredLines, 1);
  }
});

test('fail closed: exitCode 0 without a non-empty final message is unparsed with no-final-message', () => {
  for (const events of [[result(0)], [message(''), message('  \n'), result(0)], [message(7), result(0)]]) {
    const report = run(events);
    assert.deepEqual([report.status, report.reason, report.summary], ['unparsed', 'no-final-message', null]);
  }
});

test('an empty assistant.message does not displace an earlier final message', () => {
  assert.equal(run([message('answer'), message(''), result(0)]).summary, 'answer');
});

test('failure: any other integer exitCode, including a negative one, with no message gives a null summary', () => {
  for (const exitCode of [1, 2, 127, -1]) {
    const report = run([result(exitCode)]);
    assert.deepEqual([report.status, report.reason, report.summary], ['failure', null, null], String(exitCode));
  }
});

test('trailing \\r is stripped before parsing', () => {
  const target = parser();
  target.line(`${JSON.stringify(message('crlf answer'))}\r`);
  target.line(`${JSON.stringify(result(0))}\r`);
  const report = target.end();
  assert.deepEqual([report.status, report.summary, report.ignoredLines], ['success', 'crlf answer', 0]);
});

test('masking: the summary is body-masked and nothing else from the stream is retained', () => {
  const report = run([
    { type: 'assistant.reasoning', data: { content: `reasoning ${secret()}` } },
    { type: 'user.message', data: { content: `prompt ${secret()}` } },
    message(`Authorization: ${secret()}`),
    result(0),
  ]);
  assert.equal(report.summary, 'Authorization: <masked>');
  const serialised = JSON.stringify(report);
  assert.ok(!serialised.includes('abcdefghijklmnop'));
  assert.ok(!serialised.includes('reasoning'));
  assert.ok(!serialised.includes('prompt'));
});

test('summary is cut at 2000 UTF-8 bytes after masking, without splitting a character', () => {
  const long = run([message(`${'a'.repeat(1999)}€${'b'.repeat(10)}`), result(0)]);
  assert.equal(long.summary, 'a'.repeat(1999));
  assert.ok(!long.summary.includes('\uFFFD'));

  const boundary = run([message(`${'a'.repeat(1970)} ${secret()}`), result(0)]);
  assert.ok(boundary.summary.endsWith('Bearer <masked>'));
  assert.ok(!boundary.summary.includes('abcdefghijklmnop'));
});

test('usage: sums integer input and output tokens; any other shape is null; premiumRequests is not tokens', () => {
  const tokens = (usage: any) => run([message('ok'), result(0, { usage })]).usage;
  assert.deepEqual(tokens({ inputTokens: 3, outputTokens: 4, cacheReadTokens: 100 }), { tokens: 7 });
  assert.deepEqual(tokens({ input_tokens: 5, output_tokens: 6 }), { tokens: 11 });
  assert.deepEqual(tokens({ inputTokens: 0, outputTokens: 0 }), { tokens: 0 });
  assert.equal(tokens({ premiumRequests: 3 }), null);
  assert.equal(tokens({ inputTokens: 3 }), null);
  assert.equal(tokens({ inputTokens: 3, outputTokens: -1 }), null);
  assert.equal(tokens({ inputTokens: 3, outputTokens: 1.5 }), null);
  assert.equal(tokens({ inputTokens: '3', outputTokens: '4' }), null);
  assert.equal(tokens(null), null);
  assert.equal(tokens(undefined), null);
});

test('unconsumed and malformed lines increase ignoredLines', () => {
  const target = parser();
  for (const text of ['', 'not JSON', '[1]', 'null', '"s"', '{"type":3}', '{"data":{}}']) target.line(text);
  line(target, { type: 'assistant.message_delta', data: { deltaContent: 'x' } });
  line(target, { type: 'assistant.message', data: {} });
  line(target, { type: 'assistant.message' });
  const report = target.end();
  assert.equal(report.ignoredLines, 10);
  assert.deepEqual([report.status, report.reason], ['unparsed', 'no-result-event']);
});

test('non-string input never throws', () => {
  const target = parser();
  for (const value of [undefined, null, 5, {}, [], Symbol.iterator.description]) target.line(value as any);
  assert.equal(target.end().status, 'unparsed');
});

test('generated input: random lines never throw and the report shape stays valid', () => {
  let seed = 0x9e3779b9;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const pick = (items: any[]) => items[Math.floor(next() * items.length)];
  const types = ['result', 'assistant.message', 'tool.execution_complete', 'subagent.started', 'session.start', 7, null];
  const values = () => pick([undefined, null, 0, 1, -1, 1.5, NaN, '', 'denied', 'x'.repeat(50), true, false, [], {}, [1], { code: 'denied' },
    { content: 'text' }, { success: false, error: { code: 'denied' } }, { inputTokens: 1, outputTokens: 2 }]);
  const randomEvent = () => {
    const event: any = { type: pick(types), data: values(), exitCode: values(), usage: values() };
    if (next() < 0.3) delete event.data;
    return JSON.stringify(event);
  };
  const randomText = () => {
    const length = Math.floor(next() * 40);
    let text = '';
    for (let i = 0; i < length; i++) text += String.fromCharCode(Math.floor(next() * 0x250));
    return pick([text, `${text}\r`, `{${text}`, `"${text}"`]);
  };
  for (let round = 0; round < 300; round++) {
    const target = parser();
    const count = 1 + Math.floor(next() * 12);
    for (let i = 0; i < count; i++) {
      target.line(next() < 0.6 ? randomEvent() : randomText());
      if (next() < 0.05) target.oversize(next() < 0.5);
    }
    const report = target.end();
    assert.equal(report.parser, ID);
    assert.ok(['success', 'failure', 'denied', 'unparsed'].includes(report.status));
    assert.ok(report.reason === null || typeof report.reason === 'string');
    assert.ok(report.summary === null || (typeof report.summary === 'string' && Buffer.byteLength(report.summary) <= 2000));
    assert.ok(Array.isArray(report.denials) && report.denials.length <= 20 && report.denials.length <= report.deniedCount);
    assert.ok(Number.isInteger(report.deniedCount) && report.deniedCount >= 0);
    assert.ok(report.usage === null || (Number.isInteger(report.usage.tokens) && report.usage.tokens >= 0));
    assert.ok(Number.isInteger(report.ignoredLines) && report.ignoredLines >= 0);
    assert.equal(report.status === 'denied', report.deniedCount > 0);
    if (report.status === 'success') assert.ok(report.summary !== null && report.reason === null);
  }
});
