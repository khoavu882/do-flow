'use strict';

// IC-004 / IC-002 rule 7: `opencode-run-json-v1`. Event names and `step_finish.part.reason` are SOURCE
// (probe-oc-copilot.json P1b); `part.text`, `part.tool`, `part.tokens.*` and the `error` event shape
// are INFERENCE until a captured fixture confirms them. This parser reports no denial (IC-004), so
// there is no denied case, only a check that none is ever reported.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ID, create } = require('../../src/runtime/worker/parsers/opencode.ts');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'worker-parsers', 'opencode');
const LABEL = /^(synthetic|probe-[^\s"]+-trimmed|captured-[^\s"]+-trimmed)$/;

const finish = (reason: any = 'stop', tokens: any = { input: 1, output: 2 }) => ({ type: 'step_finish', part: { reason, tokens } });
const text = (value: any) => ({ type: 'text', part: { text: value } });
const tool = (name: any) => ({ type: 'tool_use', part: { tool: name, state: { status: 'completed' } } });

function run(events: any[]) {
  const target = create();
  for (const event of events) target.line(typeof event === 'string' ? event : JSON.stringify(event));
  return target.end();
}

function fixture(name: string) {
  const raw = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  const lines = raw.split('\n');
  assert.equal(lines.pop(), '', `${name} ends with one LF`);
  return lines;
}

test('ID is exported and reported', () => {
  assert.equal(ID, 'opencode-run-json-v1');
  assert.equal(run([]).parser, ID);
});

test('fixtures: labelled, LF only, JSON per line, no absolute path (synthetic ones are named)', () => {
  const files = fs.readdirSync(FIXTURES).filter((name: string) => name.endsWith('.jsonl'));
  for (const required of ['success', 'failure', 'truncated', 'unknown-events', 'spawn']) {
    assert.ok(files.includes(`${required}.jsonl`), `missing ${required}.jsonl`);
  }
  const synthetic: string[] = [];
  for (const name of files) {
    const raw = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
    assert.ok(!raw.includes('\r'), `${name} has CR`);
    assert.ok(!/(\/Users\/|\/home\/|[A-Za-z]:\\)/.test(raw), `${name} has an absolute path`);
    for (const row of fixture(name)) {
      const value = JSON.parse(row);
      assert.match(value._fixture, LABEL, `${name} label`);
      if (value._fixture === 'synthetic' && !synthetic.includes(name)) synthetic.push(name);
    }
  }
  if (synthetic.length) console.log(`# synthetic opencode fixtures (no captured file yet): ${synthetic.join(', ')}`);
});

test('success fixture: last stop step with the last text, tokens added across steps', () => {
  const report = run(fixture('success.jsonl'));
  assert.deepEqual(report, {
    parser: ID, status: 'success', reason: null, summary: 'The repository has three packages.',
    denials: [], deniedCount: 0, usage: { tokens: 300 }, ignoredLines: 3,
  });
});

test('failure fixture: a non-stop finish reason is a failure with reason finish-<reason>', () => {
  const report = run(fixture('failure.jsonl'));
  assert.deepEqual([report.status, report.reason, report.summary], ['failure', 'finish-length', 'Partial answer before the cut.']);
});

test('error fixture: an error event with no step_finish is a stream-error failure', () => {
  const report = run(fixture('error.jsonl'));
  assert.deepEqual([report.status, report.reason, report.summary], ['failure', 'stream-error', 'provider unavailable']);
});

test('error event accepts a top-level message; a non-string message is ignored', () => {
  const top = run([{ type: 'error', message: 'boom' }]);
  assert.deepEqual([top.status, top.reason, top.summary], ['failure', 'stream-error', 'boom']);
  const bad = run([{ type: 'error', error: { message: 7 }, message: { x: 1 } }]);
  assert.deepEqual([bad.status, bad.reason, bad.ignoredLines], ['unparsed', 'no-final-step', 1]);
});

test('a terminal step_finish is not undone by an earlier or later error event', () => {
  const report = run([{ type: 'error', message: 'retry' }, text('ok'), finish(), { type: 'error', message: 'late' }]);
  assert.deepEqual([report.status, report.summary], ['success', 'ok']);
});

test('truncated fixture: no step_finish is unparsed no-final-step', () => {
  const report = run(fixture('truncated.jsonl'));
  assert.deepEqual([report.status, report.reason, report.summary, report.usage], ['unparsed', 'no-final-step', null, null]);
});

test('a partial last line is ignored, not thrown on', () => {
  const lines = fixture('truncated.jsonl');
  const report = run(lines.concat(JSON.stringify(finish()).slice(0, 30)));
  assert.deepEqual([report.status, report.reason, report.ignoredLines], ['unparsed', 'no-final-step', 3]);
});

test('a stream cut after an intermediate step (reason tool-calls) is a failure, not a success', () => {
  const lines = fixture('success.jsonl').slice(0, 3);
  const report = run(lines);
  assert.deepEqual([report.status, report.reason], ['failure', 'finish-tool-calls']);
});

test('unknown-events fixture: unread events are counted and do not change the outcome', () => {
  const report = run(fixture('unknown-events.jsonl'));
  assert.deepEqual([report.status, report.summary, report.ignoredLines], ['success', 'Answer.', 3]);
});

test('non-JSON lines, arrays, and objects without a string type are ignored', () => {
  const report = run(['not json', '[1]', '{"type":5}', '', 'null', finish(), text('x')]);
  assert.deepEqual([report.status, report.ignoredLines], ['success', 5]);
});

test('spawn fixture: a subagent tool before success is a spawn-observed failure with no summary', () => {
  const report = run(fixture('spawn.jsonl'));
  assert.deepEqual([report.status, report.reason, report.summary], ['failure', 'spawn-observed', null]);
});

test('spawn: task and subagent both count, also after the terminal step; other tools do not', () => {
  for (const name of ['task', 'subagent']) {
    const after = run([text('done'), finish(), tool(name)]);
    assert.deepEqual([after.status, after.reason], ['failure', 'spawn-observed'], name);
  }
  const other = run([tool('read'), tool(5), text('done'), finish()]);
  assert.deepEqual([other.status, other.ignoredLines], ['success', 2]);
});

test('precedence: oversize > spawn > terminal failure > success; denied is never reported', () => {
  const base = [tool('task'), text('done'), finish('length')];
  assert.equal(run(base).reason, 'spawn-observed');
  const target = create();
  for (const event of base) target.line(JSON.stringify(event));
  target.oversize(true);
  const report = target.end();
  assert.deepEqual([report.status, report.reason, report.summary], ['unparsed', 'oversize-line', null]);
  assert.deepEqual([report.denials, report.deniedCount], [[], 0]);
  assert.equal(run([text('done'), finish('length')]).status, 'failure');
});

test('oversize line: a JSON-looking one is unparsed oversize-line; a non-JSON one is only counted', () => {
  const json = create();
  json.line(JSON.stringify(text('done')));
  json.line(JSON.stringify(finish()));
  json.oversize(true);
  const jsonReport = json.end();
  assert.deepEqual([jsonReport.status, jsonReport.reason, jsonReport.summary], ['unparsed', 'oversize-line', null]);
  const plain = create();
  plain.line(JSON.stringify(text('done')));
  plain.line(JSON.stringify(finish()));
  plain.oversize(false);
  const plainReport = plain.end();
  assert.deepEqual([plainReport.status, plainReport.ignoredLines], ['success', 1]);
});

test('a trailing CR on every line is removed', () => {
  const target = create();
  target.line(`${JSON.stringify(text('crlf'))}\r`);
  target.line(`${JSON.stringify(finish())}\r`);
  const report = target.end();
  assert.deepEqual([report.status, report.summary, report.ignoredLines], ['success', 'crlf', 0]);
});

test('masking: a secret-shaped summary and finish reason are masked before they are kept or cut', () => {
  const secret = 'gh' + 'p_' + 'a1B2'.repeat(8);
  const ok = run([text(`token is ${secret}`), finish()]);
  assert.ok(!ok.summary.includes(secret));
  assert.match(ok.summary, /<masked>/);

  const bad = run([finish(`x-${secret}`)]);
  assert.equal(bad.status, 'failure');
  assert.ok(!bad.reason.includes(secret));
  assert.ok(!bad.reason.includes('a1B2a1B2'));

  const err = run([{ type: 'error', message: `Bearer ${'abcdefghijklmnop'}` }]);
  assert.equal(err.summary, 'Bearer <masked>');

  // A secret that straddles the 2000-byte cut is masked first, so no prefix survives.
  const long = run([text(`${'a '.repeat(995)}${secret}`), finish()]);
  assert.ok(!long.summary.includes('ghp_'));
});

test('the summary is cut to 2000 bytes and the reason to 40 characters', () => {
  const report = run([text('é'.repeat(3000)), finish('r'.repeat(100))]);
  assert.ok(Buffer.byteLength(report.summary, 'utf8') <= 2000);
  assert.equal(report.reason.length, 40);
  assert.ok(report.reason.startsWith('finish-rrr'));
});

test('only the last non-empty text is kept; empty or non-string text is ignored', () => {
  const report = run([text('first'), text('   '), text(5), text('last'), text(''), finish()]);
  assert.deepEqual([report.status, report.summary, report.ignoredLines], ['success', 'last', 3]);
});

test('stop with no text is unparsed no-final-message', () => {
  const report = run([finish()]);
  assert.deepEqual([report.status, report.reason, report.summary], ['unparsed', 'no-final-message', null]);
});

test('fail closed: the last step_finish decides; an unreadable reason never defaults to success', () => {
  const unreadable = run([text('ok'), finish(), { type: 'step_finish', part: {} }]);
  assert.deepEqual([unreadable.status, unreadable.reason], ['unparsed', 'no-final-step']);
  const noPart = run([text('ok'), { type: 'step_finish' }]);
  assert.deepEqual([noPart.status, noPart.reason], ['unparsed', 'no-final-step']);
  const laterFail = run([text('ok'), finish(), finish('error')]);
  assert.deepEqual([laterFail.status, laterFail.reason], ['failure', 'finish-error']);
});

test('usage: sum of input and output over every step; null unless every step states both validly', () => {
  assert.deepEqual(run([text('x'), finish('tool-calls', { input: 1, output: 2 }), finish('stop', { input: 10, output: 20, reasoning: 99, cache: { read: 5 } })]).usage, { tokens: 33 });
  for (const tokens of [null, {}, { input: 1 }, { input: -1, output: 2 }, { input: 1.5, output: 2 }, { input: '1', output: 2 }]) {
    assert.equal(run([text('x'), finish('stop', tokens)]).usage, null, String(JSON.stringify(tokens)));
  }
  assert.equal(run([text('x'), finish('tool-calls', {}), finish()]).usage, null);
  assert.equal(run([text('x')]).usage, null);
});

test('generated input: random lines never throw and always give a valid report', () => {
  let seed = 1234567;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (items: any[]) => items[Math.floor(next() * items.length)];
  const types = ['step_start', 'step_finish', 'text', 'tool_use', 'error', 'x', 5, null];
  const values: any[] = [null, 1, -1, 1.5, 'stop', 'task', '', '\r', {}, [], { input: 1, output: 1 }, { reason: 'stop' }, { text: 'a' }, { tool: 'task' }, 'Bearer abcdefghijklmnop'];
  const raw = ['', 'null', '[', '{"type":', '{"type":"text"', '\u0000', 'x'.repeat(5000), '{"type":"step_finish","part":null}'];
  for (let run_ = 0; run_ < 200; run_++) {
    const target = create();
    for (let i = 0; i < 20; i++) {
      const roll = next();
      if (roll < 0.15) target.line(pick(raw));
      else if (roll < 0.2) target.oversize(next() < 0.5);
      else if (roll < 0.25) target.line(undefined as any);
      else {
        target.line(JSON.stringify({ type: pick(types), part: pick(values) ?? { reason: pick(values), text: pick(values), tool: pick(values), tokens: pick(values) }, error: pick(values), message: pick(values) }));
      }
    }
    const report = target.end();
    assert.equal(report.parser, ID);
    assert.ok(['success', 'failure', 'unparsed'].includes(report.status));
    assert.ok(report.reason === null || typeof report.reason === 'string');
    assert.ok(report.summary === null || (typeof report.summary === 'string' && Buffer.byteLength(report.summary) <= 2000));
    assert.deepEqual([report.denials, report.deniedCount], [[], 0]);
    assert.ok(report.usage === null || (Number.isInteger(report.usage.tokens) && report.usage.tokens >= 0));
    assert.ok(Number.isInteger(report.ignoredLines) && report.ignoredLines >= 0);
    if (report.status === 'success') assert.equal(typeof report.summary, 'string');
  }
});
