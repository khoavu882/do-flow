'use strict';

// IC-002 / IC-014: agy-stream-json-v1 decisions, precedence, masking, bounds, fixtures.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const antigravity = require('../../src/runtime/worker/parsers/antigravity.ts');

const ID = 'agy-stream-json-v1';
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'worker-parsers', 'antigravity');
const LABEL = /^(synthetic|probe-[\w.-]+-trimmed|captured-[\w.-]+-trimmed)$/;

function parser() {
  return antigravity.create();
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

test('module exports the id and a factory that returns the IC-001 instance', () => {
  assert.equal(antigravity.ID, ID);
  const target = parser();
  assert.deepEqual(Object.keys(target).sort(), ['end', 'line', 'oversize']);
  assert.deepEqual(parser().end(), {
    parser: ID,
    status: 'unparsed',
    reason: 'no-result-event',
    summary: null,
    denials: [],
    deniedCount: 0,
    usage: null,
    ignoredLines: 0,
  });
});

test('fixtures: every line is LF-terminated JSON with a _fixture label, no absolute path, no secret', () => {
  const files = fs.readdirSync(FIXTURES).filter((name: string) => name.endsWith('.jsonl')).sort();
  assert.deepEqual(files.map((name: string) => name.replace(/\.jsonl$/, '')),
    ['failure', 'spawn', 'success', 'truncated', 'unknown-events']);
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
  assert.deepEqual([...labels].sort(), ['synthetic']);
});

test('fixture success: response is the summary; usage has total_tokens', () => {
  assert.deepEqual(fixture('success'), {
    parser: ID,
    status: 'success',
    reason: null,
    summary: 'The repository ships a CLI installer.',
    denials: [],
    deniedCount: 0,
    usage: { tokens: 150 },
    ignoredLines: 4,
  });
});

test('fixture failure: error result gives failure report with finished-error reason', () => {
  const report = fixture('failure');
  assert.deepEqual([report.status, report.reason, report.summary, report.usage],
    ['failure', 'finished-error', 'Could not complete task due to error', { tokens: 40 }]);
});

test('fixture truncated: no result event is unparsed with no-result-event', () => {
  const report = fixture('truncated');
  assert.deepEqual([report.status, report.reason, report.summary], ['unparsed', 'no-result-event', null]);
});

test('fixture unknown-events: unread event types add to ignoredLines', () => {
  const report = fixture('unknown-events');
  assert.deepEqual([report.status, report.summary, report.ignoredLines], ['success', 'Completed successfully.', 3]);
});

test('fixture spawn: subagent event is a spawn-observed failure', () => {
  const report = fixture('spawn');
  assert.deepEqual([report.status, report.reason, report.summary], ['failure', 'spawn-observed', null]);
});

test('oversize JSON-looking line makes the report unparsed with oversize-line', () => {
  const target = parser();
  target.oversize(true);
  line(target, { event: 'result', result: { status: 'SUCCESS', response: 'ok' } });
  const report = target.end();
  assert.equal(report.status, 'unparsed');
  assert.equal(report.reason, 'oversize-line');
});

test('empty result response gives unparsed with no-final-message', () => {
  const report = run([{ event: 'result', result: { status: 'SUCCESS', response: '   ' } }]);
  assert.equal(report.status, 'unparsed');
  assert.equal(report.reason, 'no-final-message');
});

test('result status other than SUCCESS without finished_reason gives failure with reason null', () => {
  const report = run([{ event: 'result', result: { status: 'FAILED', response: 'something went wrong' } }]);
  assert.equal(report.status, 'failure');
  assert.equal(report.reason, null);
  assert.equal(report.summary, 'something went wrong');
});

test('summary is masked and cut at 2000 bytes', () => {
  const longSummary = 'A'.repeat(2500);
  const report = run([{ event: 'result', result: { status: 'SUCCESS', response: longSummary } }]);
  assert.equal(report.status, 'success');
  assert.equal(report.summary.length, 2000);
});
