'use strict';

// IC-002 rule 7 / IC-003 / IC-014: the claude-stream-json-v1 parser against fixture files and edge cases.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const claude = require('../../src/runtime/worker/parsers/claude.ts');

const ID = 'claude-stream-json-v1';
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'worker-parsers', 'claude');
const LABEL = /^(synthetic|probe-[^\s]+-trimmed|captured-[^\s]+-trimmed)$/;

function fixture(name: string): string[] {
  return fs.readFileSync(path.join(FIXTURES, `${name}.jsonl`), 'utf8').split('\n').filter(Boolean);
}

function feed(lines: string[]) {
  const target = claude.create();
  for (const text of lines) target.line(text);
  return target;
}

const run = (events: any[]) => feed(events.map((event) => (typeof event === 'string' ? event : JSON.stringify(event)))).end();

const result = (over: any = {}) => ({
  type: 'result', subtype: 'success', is_error: false, result: 'ok', permission_denials: [],
  usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 500 }, ...over,
});

function assertReportShape(report: any) {
  assert.equal(report.parser, ID);
  assert.ok(['success', 'failure', 'denied', 'unparsed'].includes(report.status));
  assert.ok(report.reason === null || typeof report.reason === 'string');
  assert.ok(report.summary === null || typeof report.summary === 'string');
  assert.ok(Array.isArray(report.denials) && report.denials.length <= 20);
  assert.ok(Number.isInteger(report.deniedCount) && report.deniedCount >= report.denials.length);
  assert.ok(report.usage === null || (Number.isInteger(report.usage.tokens) && report.usage.tokens >= 0));
  assert.ok(Number.isInteger(report.ignoredLines) && report.ignoredLines >= 0);
}

test('the module exports its id and a factory', () => {
  assert.equal(claude.ID, ID);
  assert.equal(typeof claude.create, 'function');
});

test('fixture files carry a valid _fixture label, LF endings, no absolute path', () => {
  const names = fs.readdirSync(FIXTURES).filter((name: string) => name.endsWith('.jsonl'));
  assert.deepEqual(names.sort(), ['captured-usage-limit.jsonl', 'denied.jsonl', 'failure.jsonl', 'spawn.jsonl', 'success.jsonl', 'truncated.jsonl', 'unknown-events.jsonl']);
  const labels = new Set<string>();
  for (const name of names) {
    const raw = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
    assert.ok(!raw.includes('\r'), name);
    assert.ok(!/(^|[\s"'])(\/(Users|home|private|var|tmp)\/|[A-Za-z]:\\)/.test(raw), `${name} holds an absolute path`);
    for (const text of raw.split('\n').filter(Boolean)) {
      const event = JSON.parse(text);
      assert.match(event._fixture, LABEL, name);
      labels.add(event._fixture);
    }
  }
  // IC-014: one captured file from the C.1 live run (claude 2.1.311), the rest synthetic.
  assert.deepEqual([...labels].sort(), ['captured-2.1.311-trimmed', 'synthetic']);
});

test('captured fixture (claude 2.1.311, usage-limit run): the init event, then a result with is_error true', () => {
  const events = fixture('captured-usage-limit').map((text) => JSON.parse(text));
  const init = events.find((event) => event.subtype === 'init');
  // RK5: the read-only recipe left the model only the Read tool; --strict-mcp-config left no MCP server.
  assert.deepEqual(init.tools, ['Read']);
  assert.deepEqual(init.mcp_servers, []);
  assert.equal(init.permissionMode, 'plan');
  // The real stream reports subtype "success" with is_error true: only is_error === false is a success.
  const terminal = events.find((event) => event.type === 'result');
  assert.deepEqual([terminal.subtype, terminal.is_error], ['success', true]);
  const report = feed(fixture('captured-usage-limit')).end();
  assert.deepEqual(report, {
    parser: ID, status: 'failure', reason: null, summary: 'Usage limit reached (message text masked)',
    denials: [], deniedCount: 0, usage: { tokens: 0 }, ignoredLines: 4,
  });
});

test('success fixture: terminal success reports the result text and input+output tokens', () => {
  assert.deepEqual(feed(fixture('success')).end(), {
    parser: ID, status: 'success', reason: null, summary: 'Fixed slug.js', denials: [], deniedCount: 0,
    usage: { tokens: 42 }, ignoredLines: 2,
  });
});

test('failure fixture: a non-success subtype is a failure with the result text', () => {
  const report = feed(fixture('failure')).end();
  assert.deepEqual([report.status, report.reason, report.summary], ['failure', null, 'Stopped: turn limit reached']);
});

test('truncated fixture: no result event is unparsed no-result-event', () => {
  const report = feed(fixture('truncated')).end();
  assert.deepEqual([report.status, report.reason, report.summary, report.usage], ['unparsed', 'no-result-event', null, null]);
});

test('unknown-events fixture: unread events count as ignored and the result still decides', () => {
  const report = feed(fixture('unknown-events')).end();
  assert.deepEqual([report.status, report.summary, report.ignoredLines], ['success', 'Fixed slug.js', 5]);
});

test('spawn fixture: a Task tool_use defeats an otherwise successful run', () => {
  const report = feed(fixture('spawn')).end();
  assert.deepEqual([report.status, report.reason, report.summary], ['failure', 'spawn-observed', null]);
});

test('denied fixture: permission_denials give tool names and masked targets', () => {
  const report = feed(fixture('denied')).end();
  assert.equal(report.status, 'denied');
  assert.equal(report.reason, null);
  assert.equal(report.deniedCount, 2);
  assert.deepEqual(report.denials, [
    { action: 'Write', detail: 'slug.js' },
    { action: 'Bash', detail: 'node -e 1' },
  ]);
});

test('spawn signals: Agent tool_use, and subagent_stats.spawned > 0', () => {
  const agent = run([
    { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }, { type: 'tool_use', name: 'Agent' }] } },
    result(),
  ]);
  assert.deepEqual([agent.status, agent.reason], ['failure', 'spawn-observed']);
  const stats = run([result({ subagent_stats: { spawned: 1 } })]);
  assert.deepEqual([stats.status, stats.reason], ['failure', 'spawn-observed']);
  const none = run([
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }] } },
    result({ subagent_stats: { spawned: 0 } }),
  ]);
  assert.equal(none.status, 'success');
});

test('a spawn line after the terminal result still defeats success', () => {
  const report = run([result(), { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Task' }] } }]);
  assert.deepEqual([report.status, report.reason], ['failure', 'spawn-observed']);
});

test('fail closed: success needs subtype success and is_error === false', () => {
  for (const over of [{ is_error: true }, { is_error: undefined }, { is_error: 'false' }, { subtype: 'error_during_execution' }, { subtype: undefined }]) {
    const report = run([result(over)]);
    assert.equal(report.status, 'failure', JSON.stringify(over));
  }
  const noMessage = run([result({ result: undefined })]);
  assert.deepEqual([noMessage.status, noMessage.reason], ['unparsed', 'no-final-message']);
  const blank = run([result({ result: ' \n ' })]);
  assert.deepEqual([blank.status, blank.reason], ['unparsed', 'no-final-message']);
  const failureNoText = run([result({ is_error: true, result: 42 })]);
  assert.deepEqual([failureNoText.status, failureNoText.summary], ['failure', null]);
});

test('precedence: denied beats oversize, spawn, failure and success', () => {
  const target = feed([
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Task' }] } }),
    JSON.stringify(result({ permission_denials: [{ tool_name: 'Write', tool_input: { file_path: 'a' } }] })),
  ]);
  target.oversize(true);
  assert.deepEqual([target.end().status, target.end().reason], ['denied', null]);
});

test('precedence: oversize beats spawn and success; spawn beats terminal failure', () => {
  const oversized = feed([JSON.stringify(result())]);
  oversized.oversize(true);
  assert.deepEqual([oversized.end().status, oversized.end().reason], ['unparsed', 'oversize-line']);
  const bothSignals = feed([JSON.stringify(result({ subagent_stats: { spawned: 2 } }))]);
  bothSignals.oversize(true);
  assert.equal(bothSignals.end().reason, 'oversize-line');
  const spawnVsFailure = run([result({ is_error: true, subagent_stats: { spawned: 1 } })]);
  assert.deepEqual([spawnVsFailure.status, spawnVsFailure.reason], ['failure', 'spawn-observed']);
});

test('an oversize line that does not look like JSON is only ignored', () => {
  const target = feed([JSON.stringify(result())]);
  target.oversize(false);
  const report = target.end();
  assert.deepEqual([report.status, report.ignoredLines], ['success', 1]);
});

test('a trailing carriage return is removed before parsing', () => {
  const report = feed([`${JSON.stringify(result({ result: 'crlf' }))}\r`]).end();
  assert.deepEqual([report.status, report.summary, report.ignoredLines], ['success', 'crlf', 0]);
});

test('usage is null unless input and output are both non-negative integers; cache counts are not added', () => {
  assert.deepEqual(run([result()]).usage, { tokens: 7 });
  for (const usage of [undefined, { input_tokens: 3 }, { input_tokens: -1, output_tokens: 2 }, { input_tokens: 1.5, output_tokens: 2 }, { input_tokens: '3', output_tokens: 4 }]) {
    assert.equal(run([result({ usage })]).usage, null, JSON.stringify(usage));
  }
});

test('denials are capped at 20 stored, counted in full, masked and cut to 200 characters', () => {
  const secret = ['sk', 'ant', 'api03', 'A'.repeat(40)].join('-');
  const entries = Array.from({ length: 25 }, (_, i) => ({
    tool_name: 'Bash', tool_input: { command: `run-${i} Authorization: Bearer ${secret} ${'x'.repeat(400)}` },
  }));
  const report = run([result({ permission_denials: entries })]);
  assert.equal(report.status, 'denied');
  assert.equal(report.deniedCount, 25);
  assert.equal(report.denials.length, 20);
  assert.ok(report.denials[0].detail.length <= 200);
  assert.ok(!JSON.stringify(report).includes(secret));
  assert.match(report.denials[0].detail, /<masked>/);
});

test('a long tool_name is masked and cut to 200 characters like the detail', () => {
  const secret = ['sk', 'ant', 'api03', 'A'.repeat(40)].join('-');
  const report = run([result({ permission_denials: [{ tool_name: 'T'.repeat(60000) }, { tool_name: `${secret} ${'y'.repeat(400)}` }] })]);
  assert.equal(report.deniedCount, 2);
  assert.equal(report.denials[0].action.length, 200);
  assert.ok(report.denials[1].action.length <= 200);
  assert.ok(!JSON.stringify(report).includes(secret));
});

test('a denial entry without a readable tool name or target still counts', () => {
  const report = run([result({ permission_denials: [null, 'x', { tool_name: 7 }, { tool_name: 'Edit', tool_input: { file_path: 9 } }] })]);
  assert.equal(report.deniedCount, 4);
  assert.deepEqual(report.denials.map((d: any) => d.action), ['unknown', 'unknown', 'unknown', 'Edit']);
  assert.ok(report.denials.every((d: any) => d.detail === ''));
});

test('file_path is preferred over command as the denial target', () => {
  const report = run([result({ permission_denials: [{ tool_name: 'X', tool_input: { file_path: 'f.txt', command: 'c' } }] })]);
  assert.equal(report.denials[0].detail, 'f.txt');
});

test('masking: a secret-shaped string never reaches the summary or a denial', () => {
  const token = ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
  const header = `Authorization: Bearer ${token}`;
  const ok = run([result({ result: `done ${header}` })]);
  assert.equal(ok.status, 'success');
  assert.ok(!ok.summary.includes(token));
  assert.match(ok.summary, /<masked>/);
  const failed = run([result({ is_error: true, result: header })]);
  assert.ok(!JSON.stringify(failed).includes(token));
  const denied = run([result({ permission_denials: [{ tool_name: `Tool ${header}`, tool_input: { command: `curl -H '${header}'` } }] })]);
  assert.ok(!JSON.stringify(denied).includes(token));
});

test('the summary is masked first and cut second to 2000 bytes', () => {
  const token = ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
  const text = `${'a'.repeat(1990)} Authorization: Bearer ${token}`;
  const report = run([result({ result: text })]);
  assert.ok(Buffer.byteLength(report.summary, 'utf8') <= 2000);
  assert.ok(!report.summary.includes(token.slice(0, 8)));
  const wide = run([result({ result: '€'.repeat(1000) })]);
  assert.ok(Buffer.byteLength(wide.summary, 'utf8') <= 2000);
  assert.ok(!wide.summary.includes('\ufffd'));
});

test('a later result event replaces the earlier one', () => {
  const report = run([result({ result: 'first' }), result({ result: 'second' })]);
  assert.deepEqual([report.status, report.summary], ['success', 'second']);
});

test('generated input: random lines never throw and always give a valid report', () => {
  let seed = 0x2f6e2b1;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const pieces = ['{', '}', '[', ']', '"type"', '"result"', '"assistant"', ':', ',', 'null', 'true', '-1', '1e999', '"', '\\', '\r', '\u0000', '€', '"permission_denials"', '"message"', '"content"', '"tool_use"', '"Task"', '"name"', '"usage"'];
  const values: any[] = [null, undefined, 1, 'x', [], {}, { type: 1 }, { type: 'result', permission_denials: 'x', usage: 5, subagent_stats: 'x' },
    { type: 'result', permission_denials: [[], 1, { tool_input: null }] }, { type: 'assistant', message: { content: 'x' } },
    { type: 'assistant', message: { content: [null, 1, { type: 'tool_use' }] } }];
  for (let round = 0; round < 300; round++) {
    const target = claude.create();
    for (let i = 0; i < 12; i++) {
      const pick = next() % 3;
      if (pick === 0) {
        let text = '';
        for (let n = next() % 10; n > 0; n--) text += pieces[next() % pieces.length];
        target.line(text);
      } else if (pick === 1) {
        target.line(JSON.stringify(values[next() % values.length]) as string);
      } else {
        target.line(values[next() % values.length] as any);
      }
      if (next() % 11 === 0) target.oversize(next() % 2 === 0);
    }
    assertReportShape(target.end());
  }
});
