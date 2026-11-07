'use strict';

// IC-007: pi-json-v1 decisions, IC-002 shared rules, IC-014 fixtures.
//
// Tags (IC-007): SOURCE = observed in probe-kiro-pi.json P1b (event names, stopReason 'stop'|'error',
// errorMessage, agent_settled.aborted). INFERENCE = the shape of `content` blocks ({type:'text',text}),
// the `toolName` value that names a sub-agent tool, and a stopReason of 'aborted'/'length'/'toolUse'
// (pi's documented values, not observed here). The fixtures are all `synthetic`: no live-run record
// is cited for pi yet, so no `captured` file is required.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ID, create } = require('../../src/runtime/worker/parsers/pi.ts');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'worker-parsers', 'pi');
const LABEL = /^(synthetic|probe-[^"\s]+-trimmed|captured-[^"\s]+-trimmed)$/;

function line(target: any, event: any) {
  target.line(typeof event === 'string' ? event : JSON.stringify(event));
}

function run(events: any[]) {
  const target = create();
  for (const event of events) line(target, event);
  return target.end();
}

function fixture(name: string) {
  const target = create();
  for (const text of fs.readFileSync(path.join(FIXTURES, `${name}.jsonl`), 'utf8').split('\n')) {
    if (text !== '') target.line(text);
  }
  return target.end();
}

function assistant(text: string | null, stopReason = 'stop', errorMessage?: string) {
  const message: any = { role: 'assistant', content: text === null ? [] : [{ type: 'text', text }], stopReason };
  if (errorMessage !== undefined) message.errorMessage = errorMessage;
  return message;
}

function end(...messages: any[]) {
  return { type: 'agent_end', messages: [{ role: 'user', content: [] }, ...messages] };
}

test('the module exports the id and a factory', () => {
  assert.equal(ID, 'pi-json-v1');
  assert.equal(typeof create, 'function');
});

test('success: an assistant stop with text, from the fixture and inline', () => {
  assert.deepEqual(fixture('success'), {
    parser: ID, status: 'success', reason: null, summary: 'All done.', denials: [], deniedCount: 0,
    usage: null, ignoredLines: 11,
  });
  // Text blocks are concatenated; a non-text block (INFERENCE: thinking) is skipped.
  const report = run([end({
    role: 'assistant', stopReason: 'stop',
    content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
  }), { type: 'agent_settled', aborted: false }]);
  assert.deepEqual([report.status, report.summary, report.ignoredLines], ['success', 'ab', 0]);
});

test('error terminal: stopReason error is a failure and errorMessage is the summary', () => {
  const report = fixture('failure');
  assert.deepEqual([report.status, report.reason, report.summary], ['failure', null, '403 oauth_not_allowed_for_organization']);
  assert.equal(report.deniedCount, 0);
});

test('provider error: stopReason error with no string errorMessage is a failure with no summary', () => {
  for (const errorMessage of [undefined, 403, null, {}]) {
    const message: any = { role: 'assistant', content: [], stopReason: 'error' };
    if (errorMessage !== undefined) message.errorMessage = errorMessage;
    const report = run([end(message)]);
    assert.deepEqual([report.status, report.reason, report.summary], ['failure', null, null], String(errorMessage));
  }
});

test('agent_settled aborted true turns a success into a failure, reason aborted, no summary', () => {
  const report = fixture('aborted');
  assert.deepEqual([report.status, report.reason, report.summary], ['failure', 'aborted', null]);
  // The settle event may precede agent_end, and false leaves a success alone.
  const early = run([{ type: 'agent_settled', aborted: true }, end(assistant('x'))]);
  assert.deepEqual([early.status, early.reason], ['failure', 'aborted']);
  const settled = run([end(assistant('x')), { type: 'agent_settled', aborted: false }]);
  assert.deepEqual([settled.status, settled.reason], ['success', null]);
});

test('aborted does not hide an error terminal', () => {
  const report = run([end(assistant(null, 'error', 'boom')), { type: 'agent_settled', aborted: true }]);
  assert.deepEqual([report.status, report.reason, report.summary], ['failure', null, 'boom']);
});

test('truncated stream: no agent_end is unparsed, reason no-agent-end', () => {
  const report = fixture('truncated');
  assert.deepEqual([report.status, report.reason, report.summary], ['unparsed', 'no-agent-end', null]);
  assert.deepEqual(run([]).reason, 'no-agent-end');
});

test('fail closed: a terminal that is not a positive stop never becomes a success', () => {
  const cases: any[] = [
    end(assistant('')),
    end(assistant('   \n')),
    end(assistant(null)),
    end(assistant('text', 'length')),
    end(assistant('text', 'toolUse')),
    end(assistant('text', 'aborted')),
    end({ role: 'user', content: [{ type: 'text', text: 'x' }], stopReason: 'stop' }),
    end({ role: 'assistant', content: 'plain string', stopReason: 'stop' }),
    end({ role: 'assistant', content: [{ type: 'text', text: 7 }], stopReason: 'stop' }),
    end({ role: 'assistant', content: [{ type: 'text', text: 'x' }] }),
  ];
  for (const event of cases) {
    const report = run([event]);
    assert.deepEqual([report.status, report.reason, report.summary], ['unparsed', 'no-final-message', null], JSON.stringify(event));
  }
});

test('fail closed: an unreadable agent_end is ignored and leaves no terminal', () => {
  for (const event of [
    { type: 'agent_end' },
    { type: 'agent_end', messages: [] },
    { type: 'agent_end', messages: 'x' },
    { type: 'agent_end', messages: [null] },
    { type: 'agent_end', messages: [[]] },
  ]) {
    const report = run([event]);
    assert.deepEqual([report.status, report.reason, report.ignoredLines], ['unparsed', 'no-agent-end', 1], JSON.stringify(event));
  }
});

test('a later unreadable agent_end does not undo a terminal', () => {
  const report = run([end(assistant('kept')), { type: 'agent_end', messages: [] }]);
  assert.deepEqual([report.status, report.summary], ['success', 'kept']);
});

test('unknown event types are counted and do not change the outcome', () => {
  const report = fixture('unknown-events');
  assert.deepEqual([report.status, report.reason, report.summary], ['success', null, 'ok']);
  assert.equal(report.ignoredLines, 6);
});

test('unconsumed and malformed lines increase ignoredLines', () => {
  const target = create();
  line(target, 'not JSON');
  line(target, '[]');
  line(target, { type: 3 });
  line(target, { type: 'agent_settled', aborted: 'yes' });
  line(target, { type: 'tool_execution_start', toolName: 42 });
  line(target, { type: 'tool_execution_start', toolName: 'read' });
  assert.equal(target.end().ignoredLines, 6);
});

test('spawn: a subagent tool start followed by a success is a failure, reason spawn-observed', () => {
  const report = fixture('spawn');
  assert.deepEqual([report.status, report.reason, report.summary], ['failure', 'spawn-observed', null]);
  for (const toolName of ['subagent', 'Subagent', 'run_subagents']) {
    const r = run([{ type: 'tool_execution_start', toolName }, end(assistant('done'))]);
    assert.deepEqual([r.status, r.reason], ['failure', 'spawn-observed'], toolName);
  }
});

test('spawn after the terminal still fails; a spawn with no terminal is a failure too', () => {
  const after = run([end(assistant('done')), { type: 'tool_execution_start', toolName: 'subagent' }]);
  assert.deepEqual([after.status, after.reason], ['failure', 'spawn-observed']);
  const alone = run([{ type: 'tool_execution_start', toolName: 'subagent' }]);
  assert.deepEqual([alone.status, alone.reason], ['failure', 'spawn-observed']);
});

test('precedence: a spawn beats an error terminal; there is no denied status', () => {
  const report = run([{ type: 'tool_execution_start', toolName: 'subagent' }, end(assistant(null, 'error', 'boom'))]);
  assert.deepEqual([report.status, report.reason, report.summary], ['failure', 'spawn-observed', null]);
  assert.deepEqual([report.denials, report.deniedCount], [[], 0]);
});

test('oversize: a JSON-looking oversize line beats success and spawn; a non-JSON one does not', () => {
  const target = create();
  line(target, end(assistant('done')));
  target.oversize(true);
  assert.deepEqual([target.end().status, target.end().reason, target.end().summary], ['unparsed', 'oversize-line', null]);

  const spawned = create();
  line(spawned, { type: 'tool_execution_start', toolName: 'subagent' });
  spawned.oversize(true);
  assert.equal(spawned.end().reason, 'oversize-line');

  const plain = create();
  line(plain, end(assistant('done')));
  plain.oversize(false);
  const report = plain.end();
  assert.deepEqual([report.status, report.ignoredLines], ['success', 1]);
});

test('trailing CR is removed before parsing', () => {
  const target = create();
  target.line(`${JSON.stringify(end(assistant('crlf')))}\r`);
  target.line(`${JSON.stringify({ type: 'agent_settled', aborted: false })}\r`);
  const report = target.end();
  assert.deepEqual([report.status, report.summary, report.ignoredLines], ['success', 'crlf', 0]);
});

test('masking: the summary is masked before it is cut, for success and for errorMessage', () => {
  const secret = `s${'k'}-${'a1B2c3D4'.repeat(4)}`;
  const bearer = `Bearer ${'abcdefghij'}klmnop`;
  const ok = run([end(assistant(`key ${secret} and Authorization: ${bearer}`))]);
  assert.ok(!ok.summary.includes(secret) && !ok.summary.includes('klmnop'), ok.summary);
  assert.match(ok.summary, /<masked>/);

  const failed = run([end(assistant(null, 'error', `403 ${secret}`))]);
  assert.ok(!failed.summary.includes(secret), failed.summary);

  // A secret straddling the 2000-byte cut is masked whole, not left as an unmasked prefix.
  const straddle = run([end(assistant(`${'a '.repeat(995)}${secret}`))]);
  assert.ok(Buffer.byteLength(straddle.summary, 'utf8') <= 2000);
  assert.ok(!straddle.summary.includes(secret.slice(0, 12)), straddle.summary.slice(-40));
});

test('the summary is cut at 2000 UTF-8 bytes without splitting a character', () => {
  const report = run([end(assistant(`${'a'.repeat(1999)}€${'b'.repeat(10)}`))]);
  assert.equal(report.summary, 'a'.repeat(1999));
  assert.ok(!report.summary.includes('\uFFFD'));
});

test('only the masked summary is kept: reports carry no other event text', () => {
  const report = run([
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'LEAK-DELTA' } },
    { type: 'tool_execution_start', toolName: 'read', args: { path: 'LEAK-ARG' } },
    end(assistant('final')),
  ]);
  assert.ok(!JSON.stringify(report).includes('LEAK'));
});

test('usage is null: IC-007 names no token field', () => {
  const report = run([end({ ...assistant('x'), usage: { input: 3, output: 4 } })]);
  assert.equal(report.usage, null);
});

test('each instance is independent', () => {
  const a = create();
  const b = create();
  line(a, end(assistant('a')));
  assert.equal(b.end().status, 'unparsed');
  assert.equal(a.end().status, 'success');
});

test('generated input: random lines never throw and always give a valid report shape', () => {
  let seed = 142;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (items: any[]) => items[Math.floor(next() * items.length)];
  const types = ['agent_end', 'agent_settled', 'tool_execution_start', 'session', 'turn_end', 'x', 3, null];
  const values = [null, true, false, 0, -1, 1.5, 'subagent', '', 'stop', 'error', [], {}, [null], [{}], [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'm' }] }]];
  const keys = ['messages', 'aborted', 'toolName', 'stopReason', 'errorMessage', 'content', 'role'];
  const junk = ['', '{', '[]', 'null', '"s"', '\u0000', '\r', '{"type":'];
  const statuses = new Set(['success', 'failure', 'denied', 'unparsed']);

  for (let round = 0; round < 200; round++) {
    const target = create();
    for (let i = 0; i < 20; i++) {
      const roll = next();
      if (roll < 0.15) target.line(pick(junk));
      else if (roll < 0.2) target.oversize(next() < 0.5);
      else {
        const event: any = { type: pick(types) };
        for (const key of keys) if (next() < 0.5) event[key] = pick(values);
        target.line(JSON.stringify(event) + (next() < 0.2 ? '\r' : ''));
      }
    }
    const report = target.end();
    assert.equal(report.parser, ID);
    assert.ok(statuses.has(report.status));
    assert.ok(report.reason === null || typeof report.reason === 'string');
    assert.ok(report.summary === null || (typeof report.summary === 'string' && Buffer.byteLength(report.summary) <= 2000));
    assert.ok(Array.isArray(report.denials) && report.denials.length <= 20);
    assert.ok(Number.isInteger(report.deniedCount) && Number.isInteger(report.ignoredLines) && report.ignoredLines >= 0);
    assert.ok(report.usage === null || Number.isInteger(report.usage.tokens));
    if (report.status === 'success') assert.ok(report.summary !== null && report.summary.length > 0);
  }
});

test('fixtures: every line is a labelled JSON object, LF endings, no absolute path, no secret shape', () => {
  const files = fs.readdirSync(FIXTURES).filter((name: string) => name.endsWith('.jsonl'));
  assert.deepEqual(files.sort(), ['aborted.jsonl', 'failure.jsonl', 'spawn.jsonl', 'success.jsonl', 'truncated.jsonl', 'unknown-events.jsonl']);
  for (const name of files) {
    const raw = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
    assert.ok(raw.endsWith('\n') && !raw.includes('\r'), name);
    assert.ok(!/(^|[\s"'])\/(Users|home|private|tmp|var)\//.test(raw) && !/[A-Za-z]:\\/.test(raw), `${name} has an absolute path`);
    for (const text of raw.split('\n').filter(Boolean)) {
      const event = JSON.parse(text);
      assert.equal(typeof event.type, 'string', name);
      assert.match(event._fixture, LABEL, name);
      assert.ok(!/(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}/.test(text), `${name} has a secret shape`);
    }
  }
});
