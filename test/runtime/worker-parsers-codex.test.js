'use strict';

// IC-003: Codex exec JSONL decisions, masking, bounds and usage.

const test = require('node:test');
const assert = require('node:assert/strict');
const { PARSERS, parserFor } = require('../../src/runtime/worker/parsers.ts');

const ID = 'codex-exec-json-v1';

function parser() {
  return PARSERS[ID].create();
}

function line(target, event) {
  target.line(typeof event === 'string' ? event : JSON.stringify(event));
}

function run(events) {
  const target = parser();
  for (const event of events) line(target, event);
  return target.end();
}

test('codex-exec-json-v1 is registered and returned by parserFor', () => {
  assert.equal(PARSERS[ID].id, ID);
  assert.equal(parserFor(ID), PARSERS[ID]);
});

test('item.completed agent messages use the last stream message and strip trailing CR', () => {
  const target = parser();
  target.line(`${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'first' } })}\r`);
  line(target, { type: 'item.completed', item: { type: 'agent_message', text: 'last' } });
  line(target, { type: 'turn.completed' });
  assert.deepEqual(target.end(), {
    parser: ID, status: 'success', reason: null, summary: 'last', denials: [], deniedCount: 0,
    usage: null, ignoredLines: 0,
  });
});

test('negative control: every collab spawn event defeats an otherwise successful turn', () => {
  for (const type of ['item.started', 'item.updated', 'item.completed']) {
    const report = run([
      { type, item: { type: 'collab_tool_call', tool: 'spawn_agent' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
      { type: 'turn.completed' },
    ]);
    assert.deepEqual([report.status, report.reason, report.summary], ['failure', 'spawn-observed', null], type);
  }
});

test('declined command executions are counted, masked, cut, and capped at 20 stored denials', () => {
  const target = parser();
  for (let i = 0; i < 25; i++) {
    line(target, {
      type: 'item.completed',
      item: { type: 'command_execution', status: 'declined', command: `cmd-${i} Bearer supersecretvalue ${'x'.repeat(300)}` },
    });
  }
  line(target, { type: 'turn.completed' });
  const report = target.end();
  assert.equal(report.status, 'denied');
  assert.equal(report.reason, null);
  assert.equal(report.deniedCount, 25);
  assert.equal(report.denials.length, 20);
  assert.equal(report.denials[0].action, 'command');
  assert.ok(report.denials[0].detail.length <= 200);
  assert.match(report.denials[0].detail, /<masked>/);
  assert.ok(!report.denials[0].detail.includes('supersecretvalue'));
});

test('turn.completed sums valid non-negative token fields on its last usage object', () => {
  const report = run([
    { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
    { type: 'turn.completed', usage: { input_tokens: 3, output_tokens: 7 } },
    { type: 'turn.completed', usage: { input_tokens: -1, output_tokens: 5, total_tokens: 400 } },
  ]);
  assert.equal(report.status, 'success');
  assert.deepEqual(report.usage, { tokens: 5 });
});

test('turn.completed usage is null when neither input nor output is a valid non-negative integer', () => {
  const report = run([
    { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
    { type: 'turn.completed', usage: { input_tokens: 1.5, output_tokens: -2 } },
  ]);
  assert.equal(report.status, 'success');
  assert.equal(report.usage, null);
});

test('turn.failed uses its message as a masked failure summary with a null reason', () => {
  const report = run([{ type: 'turn.failed', error: { message: 'Authorization: Bearer abcdefghijklmnop' } }]);
  assert.equal(report.status, 'failure');
  assert.equal(report.reason, null);
  assert.equal(report.summary, 'Authorization: <masked>');
});

test('error without a terminal event is a stream-error failure; terminal failure takes precedence', () => {
  const streamError = run([{ type: 'error', message: 'Bearer abcdefghijklmnop' }]);
  assert.deepEqual([streamError.status, streamError.reason, streamError.summary], ['failure', 'stream-error', 'Bearer <masked>']);

  const terminal = run([
    { type: 'error', message: 'earlier stream issue' },
    { type: 'turn.failed', error: { message: 'turn failed' } },
  ]);
  assert.deepEqual([terminal.status, terminal.reason, terminal.summary], ['failure', null, 'turn failed']);
});

test('completed turns use the final-message file only when the stream has no agent message', () => {
  const fromFile = parser();
  fromFile.lastMessage('  final from file  ');
  line(fromFile, { type: 'turn.completed' });
  const fileReport = fromFile.end();
  assert.deepEqual([fileReport.status, fileReport.summary], ['success', '  final from file  ']);

  const fromStream = parser();
  fromStream.lastMessage('file value');
  line(fromStream, { type: 'item.completed', item: { type: 'agent_message', text: 'stream value' } });
  line(fromStream, { type: 'turn.completed' });
  assert.equal(fromStream.end().summary, 'stream value');
});

test('completed turns without a non-empty final message are unparsed', () => {
  const target = parser();
  target.lastMessage(' \n\t ');
  line(target, { type: 'turn.completed' });
  const report = target.end();
  assert.deepEqual([report.status, report.reason], ['unparsed', 'no-final-message']);
});

test('negative control: a JSON-looking oversize line cannot become a success', () => {
  const target = parser();
  line(target, { type: 'item.completed', item: { type: 'agent_message', text: 'done' } });
  line(target, { type: 'turn.completed' });
  target.oversize(true);
  const report = target.end();
  assert.deepEqual([report.status, report.reason, report.summary], ['unparsed', 'oversize-line', null]);
});

test('a denial takes precedence over an oversize line', () => {
  const target = parser();
  target.oversize(true);
  line(target, { type: 'item.completed', item: { type: 'command_execution', status: 'declined', command: 'rm -rf /' } });
  assert.deepEqual([target.end().status, target.end().reason], ['denied', null]);
});

test('completed turns without final text and streams without a turn end use their specified reasons', () => {
  const noFinal = run([{ type: 'turn.completed' }]);
  assert.deepEqual([noFinal.status, noFinal.reason], ['unparsed', 'no-final-message']);
  const noEnd = run([]);
  assert.deepEqual([noEnd.status, noEnd.reason], ['unparsed', 'no-turn-end']);
});

test('unconsumed and malformed lines increase ignoredLines', () => {
  const target = parser();
  line(target, 'not JSON');
  line(target, { type: 3 });
  line(target, { type: 'item.started', item: { type: 'agent_message', text: 'not consumed' } });
  line(target, { type: 'turn.completed' });
  const report = target.end();
  assert.equal(report.ignoredLines, 3);
  assert.deepEqual([report.status, report.reason], ['unparsed', 'no-final-message']);
});

test('summaries are body-masked and cut at 2000 UTF-8 bytes without splitting a character', () => {
  const secret = run([
    { type: 'item.completed', item: { type: 'agent_message', text: 'Authorization: Bearer abcdefghijklmnop' } },
    { type: 'turn.completed' },
  ]);
  assert.equal(secret.summary, 'Authorization: <masked>');

  const long = run([
    { type: 'item.completed', item: { type: 'agent_message', text: `${'a'.repeat(1999)}€${'b'.repeat(10)}` } },
    { type: 'turn.completed' },
  ]);
  assert.equal(long.summary, 'a'.repeat(1999));
  assert.ok(Buffer.byteLength(long.summary, 'utf8') <= 2000);
  assert.ok(!long.summary.includes('\uFFFD'));
});
