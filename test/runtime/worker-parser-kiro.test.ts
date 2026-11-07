'use strict';

// IC-002 rule 7, IC-006, IC-014: kiro-stream-json-v1. Every fixture is `synthetic`: shaped from the
// event names and `runFinished` fields in probe-kiro-pi.json P1b. The `tool_call` name path
// (`data.update.title`) is INFERENCE, so the spawn fixtures are synthetic until a live capture
// (IC-012) confirms or corrects it. No `captured` fixture exists yet, and this test names that.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const kiro = require('../../src/runtime/worker/parsers/kiro.ts');

const ID = 'kiro-stream-json-v1';
const DIR = path.join(__dirname, '..', 'fixtures', 'worker-parsers', 'kiro');
const LABELS = ['synthetic', 'probe-3.0.0-trimmed', 'captured-3.0.0-trimmed'];

const fixture = (name: string): string[] => fs.readFileSync(path.join(DIR, `${name}.jsonl`), 'utf8').split('\n').filter(Boolean);

function run(lines: any[]) {
  const parser = kiro.create();
  for (const line of lines) parser.line(typeof line === 'string' ? line : JSON.stringify(line));
  return parser.end();
}

const finished = (data: any = {}) => ({
  type: 'runFinished', data: { sessionId: 's1', status: 'success', stopReason: 'end_turn', finalText: 'done', ...data },
});
const toolCall = (title: string) => ({ type: 'sessionUpdate', data: { update: { sessionUpdate: 'tool_call', title } } });

/** A secret-shaped string, built at runtime so no literal one sits in the repo. */
const secret = () => 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0' + 'kLmNoP';

function assertShape(report: any) {
  assert.equal(report.parser, ID);
  assert.ok(['success', 'failure', 'denied', 'unparsed'].includes(report.status));
  assert.ok(report.reason === null || typeof report.reason === 'string');
  assert.ok(report.summary === null || typeof report.summary === 'string');
  assert.ok(Array.isArray(report.denials));
  assert.equal(typeof report.deniedCount, 'number');
  assert.ok(report.usage === null || Number.isInteger(report.usage.tokens));
  assert.ok(Number.isInteger(report.ignoredLines) && report.ignoredLines >= 0);
}

test('the module exports its id and a factory', () => {
  assert.equal(kiro.ID, ID);
  assert.equal(typeof kiro.create, 'function');
  assert.deepEqual(Object.keys(kiro.create()).sort(), ['end', 'line', 'oversize']);
});

test('fixtures: LF endings, a known label on every line, no absolute path, no secret shape', () => {
  const names = fs.readdirSync(DIR).filter((n: string) => n.endsWith('.jsonl'));
  assert.deepEqual(names.sort(), ['failure.jsonl', 'permission-text.jsonl', 'spawn.jsonl', 'success.jsonl', 'truncated.jsonl', 'unknown-events.jsonl']);
  for (const name of names) {
    const raw = fs.readFileSync(path.join(DIR, name), 'utf8');
    assert.ok(!raw.includes('\r'), `${name}: CR`);
    assert.ok(raw.endsWith('\n'), `${name}: final LF`);
    assert.ok(!/(?:^|[\s"])(?:\/(?:Users|home|tmp|var)\/|[A-Za-z]:\\)/.test(raw), `${name}: absolute path`);
    assert.ok(!/(?:gh[pousr]_|sk-|AKIA|eyJ)[A-Za-z0-9_-]{8,}/.test(raw), `${name}: secret shape`);
    for (const line of raw.split('\n').filter(Boolean)) assert.ok(LABELS.includes(JSON.parse(line)._fixture), `${name}: label`);
  }
  const captured = names.filter((n: string) => fs.readFileSync(path.join(DIR, n), 'utf8').includes('"captured-'));
  // Names the gap: with no live-run record cited yet, synthetic files are accepted (IC-014).
  assert.deepEqual(captured, [], 'a captured fixture now exists: extend this test to parse it');
});

test('success: runFinished with status success, stopReason end_turn and finalText', () => {
  const report = run(fixture('success'));
  assert.deepEqual(report, {
    parser: ID, status: 'success', reason: null, summary: 'I could not create the file: no write tool is available.',
    denials: [], deniedCount: 0, usage: null, ignoredLines: 4,
  });
});

test('error terminal: any other status is a failure and carries finalText', () => {
  const report = run(fixture('failure'));
  assert.equal(report.status, 'failure');
  assert.equal(report.reason, null);
  assert.equal(report.summary, 'The model provider rejected the request.');
  assert.equal(run([finished({ status: 'error', finalText: undefined })]).summary, null);
  assert.equal(run([finished({ status: 'error', finalText: 7 })]).summary, null);
});

test('a success that did not stop on end_turn fails closed', () => {
  for (const stopReason of ['max_tokens', 'cancelled', undefined, 3]) {
    const report = run([finished({ stopReason })]);
    assert.equal(report.status, 'failure', String(stopReason));
    assert.equal(report.summary, 'done');
  }
});

test('truncated stream: no runFinished is unparsed with no-run-finished', () => {
  const report = run(fixture('truncated'));
  assert.equal(report.status, 'unparsed');
  assert.equal(report.reason, 'no-run-finished');
  assert.equal(report.summary, null);
  assert.equal(run([]).reason, 'no-run-finished');
});

test('a runFinished with no readable status never defaults to success', () => {
  for (const data of [{}, { status: 1, stopReason: 'end_turn', finalText: 'x' }, null, 'success']) {
    const report = run([{ type: 'runFinished', data }]);
    assert.equal(report.status, 'unparsed');
    assert.equal(report.reason, 'no-run-finished');
  }
});

test('success with no final message is unparsed with no-final-message', () => {
  for (const finalText of [undefined, '', '   \n', 5, null]) {
    const report = run([finished({ finalText })]);
    assert.equal(report.status, 'unparsed', String(finalText));
    assert.equal(report.reason, 'no-final-message');
    assert.equal(report.summary, null);
  }
});

test('unknown event types are ignored and counted, and the run still succeeds', () => {
  const report = run(fixture('unknown-events'));
  assert.equal(report.status, 'success');
  assert.equal(report.summary, 'done');
  assert.equal(report.ignoredLines, 5);
  const noise = run(['not json', '[1]', '"x"', '{"no":"type"}', '{"type":3}', '', finished()]);
  assert.equal(noise.status, 'success');
  assert.equal(noise.ignoredLines, 6);
});

test('a spawn signal followed by success is a failure with spawn-observed', () => {
  const report = run(fixture('spawn'));
  assert.equal(report.status, 'failure');
  assert.equal(report.reason, 'spawn-observed');
  assert.equal(report.summary, null);
});

test('a spawn after the terminal event still counts; a plain tool call does not', () => {
  assert.equal(run([finished(), toolCall('subagent_helper')]).reason, 'spawn-observed');
  assert.equal(run([toolCall('fs_read'), toolCall('read'), finished()]).status, 'success');
  assert.equal(run([{ type: 'sessionUpdate', data: { update: { sessionUpdate: 'tool_call_update', title: 'subagent_x' } } }, finished()]).status, 'success');
  // The alternative field paths the INFERENCE allows.
  assert.equal(run([{ type: 'sessionUpdate', data: { sessionUpdate: 'tool_call', name: 'subagent_y' } }, finished()]).reason, 'spawn-observed');
});

test('precedence: a spawn beats success, an oversize JSON line beats a spawn', () => {
  const parser = kiro.create();
  parser.line(JSON.stringify(toolCall('subagent_a')));
  parser.line(JSON.stringify(finished()));
  assert.equal(parser.end().reason, 'spawn-observed');
  parser.oversize(true);
  const report = parser.end();
  assert.equal(report.status, 'unparsed');
  assert.equal(report.reason, 'oversize-line');
});

test('oversize: a JSON-looking line is unparsed, a non-JSON one is only counted', () => {
  const json = kiro.create();
  json.line(JSON.stringify(finished()));
  json.oversize(true);
  const report = json.end();
  assert.equal(report.status, 'unparsed');
  assert.equal(report.reason, 'oversize-line');
  assert.equal(report.ignoredLines, 1);

  const plain = kiro.create();
  plain.line(JSON.stringify(finished()));
  plain.oversize(false);
  assert.equal(plain.end().status, 'success');
  assert.equal(plain.end().ignoredLines, 1);
});

test('a trailing CR is removed before parsing', () => {
  const report = run([JSON.stringify(finished()) + '\r']);
  assert.equal(report.status, 'success');
  assert.equal(report.ignoredLines, 0);
});

test('masking: a secret-shaped string in finalText is masked in the summary, on success and failure', () => {
  const text = 'the token is ' + secret() + ' and that is all';
  for (const data of [{ finalText: text }, { status: 'error', finalText: text }]) {
    const report = run([finished(data)]);
    assert.ok(!report.summary.includes(secret()), report.summary);
    assert.ok(report.summary.includes('<masked>'), report.summary);
    assert.ok(!JSON.stringify(report).includes(secret()));
  }
});

test('masking happens before the cut: a secret straddling the 2000-byte limit leaves no prefix', () => {
  const text = 'a'.repeat(1990) + ' ' + secret();
  const report = run([finished({ finalText: text })]);
  assert.ok(Buffer.byteLength(report.summary, 'utf8') <= 2000);
  assert.ok(!report.summary.includes('gh' + 'p_'), report.summary.slice(-30));
});

test('the last runFinished wins, and a later failure undoes an earlier success', () => {
  assert.equal(run([finished(), finished({ status: 'error', finalText: 'late' })]).status, 'failure');
  assert.equal(run([finished({ finalText: 'one' }), finished({ finalText: 'two' })]).summary, 'two');
});

test('no denied case: permission-failure-looking text and events never yield denied', () => {
  const report = run(fixture('permission-text'));
  assert.equal(report.status, 'success');
  assert.equal(report.deniedCount, 0);
  assert.deepEqual(report.denials, []);
  const texts = ['Permission request failed', 'permission denied', 'denied by user', 'is not permitted', 'Error: tool call rejected'];
  for (const t of texts) {
    for (const lines of [
      [{ type: 'permission-denied', action: 'write', detail: t }, finished({ finalText: t })],
      [{ type: 'sessionUpdate', data: { update: { sessionUpdate: 'tool_call_update', status: 'failed', content: t } } }, finished({ status: 'error', finalText: t })],
      [finished({ status: 'denied', finalText: t })],
    ]) {
      const r = run(lines);
      assert.notEqual(r.status, 'denied', t);
      assert.equal(r.deniedCount, 0);
      assert.deepEqual(r.denials, []);
    }
  }
});

test('usage is always null: the schema states no token fields', () => {
  assert.equal(run([finished({ usage: { input_tokens: 1, output_tokens: 2 } })]).usage, null);
});

test('generated input: random lines never throw and always give a valid report shape', () => {
  let seed = 142;
  const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)];
  const junk = [null, 0, -1, 1.5, '', 'x', true, [], {}, [1, 'a'], { a: { b: null } }];
  const types = ['runStarted', 'runFinished', 'sessionUpdate', 'tool_call', 'error', 3, null, undefined];
  const fields = ['status', 'stopReason', 'finalText', 'update', 'title', 'name', 'sessionUpdate', 'kind', 'data'];
  const value = (depth: number): any => {
    const roll = rand();
    if (depth > 2 || roll < 0.4) return pick(junk);
    if (roll < 0.55) return pick(['success', 'end_turn', 'error', 'subagent_x', 'tool_call']);
    const obj: any = {};
    for (let i = 0; i < 3; i++) obj[pick(fields)] = value(depth + 1);
    return obj;
  };
  for (let round = 0; round < 300; round++) {
    const parser = kiro.create();
    for (let i = 0; i < 8; i++) {
      const roll = rand();
      let text: any;
      if (roll < 0.15) text = pick(['', '{', '[', 'null', '\r', '{"type":', '\u0000\ud800', 'x'.repeat(5000)]);
      else if (roll < 0.2) text = pick([undefined, null, 42, {}]);
      else text = JSON.stringify({ type: pick(types), data: value(0), ...(rand() < 0.3 ? { status: pick(junk) } : {}) });
      if (rand() < 0.1) parser.oversize(rand() < 0.5);
      parser.line(text);
    }
    const report = parser.end();
    assertShape(report);
    assert.notEqual(report.status, 'denied');
  }
});
