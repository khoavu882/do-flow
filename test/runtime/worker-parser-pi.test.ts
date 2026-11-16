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

function messageEnd(message: any) {
  return { type: 'message_end', message };
}
// totalTokens is deliberately not input + output (Pi adds cache reads and writes to it): a parser that read it would be wrong.
const usageOf = (input: any, output: any, total?: any) => ({ input, output, cacheRead: 7, cacheWrite: 9, totalTokens: 9999, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
const withUsage = (usage: any, stopReason = 'stop') => ({ ...assistant('x', stopReason), usage });
const usageOfRun = (...messages: any[]) => run([...messages.map(messageEnd), end(assistant('x'))]);

test('usage: the stream sums each assistant message_end (input + output, never totalTokens); tokens and cost', () => {
  const report = fixture('usage');
  assert.equal(report.status, 'success');
  assert.equal(report.usage.tokens, 120 + 150);
  assert.ok(Math.abs(report.usage.cost - (0.0008 + 0.00082)) < 1e-12, String(report.usage.cost));
  assert.equal(report.ignoredLines, 12);
});

test('usage: no usage at all is null, never zero', () => {
  assert.equal(fixture('success').usage, null);
  assert.equal(usageOfRun(assistant('x')).usage, null);
  assert.equal(run([end(assistant('x'))]).usage, null);
});

test('usage (A-2): a message counts input + output; one without a readable input and output has no count', () => {
  assert.deepEqual(usageOfRun(withUsage(usageOf(3, 4, 0.5))).usage, { tokens: 7, cost: 0.5 });
  for (const usage of [{ totalTokens: 7 }, { input: 3 }, { output: 4 }, { input: '3', output: 4 }, { input: -1, output: 4 }, { input: 1.5, output: 4 }, { input: 3, output: null }, { input: NaN, output: 4 }, null, 'x', 7]) {
    assert.equal(usageOfRun(withUsage(usage)).usage, null, JSON.stringify(usage));
  }
});

test('usage (A-5): an input and output that are both 0 is "not reported", the same as absent', () => {
  assert.equal(usageOfRun(withUsage(usageOf(0, 0, 0))).usage, null);
  // One of the two being 0 is a real count.
  assert.deepEqual(usageOfRun(withUsage(usageOf(0, 5, 0.1))).usage, { tokens: 5, cost: 0.1 });
  assert.deepEqual(usageOfRun(withUsage(usageOf(5, 0, 0.1))).usage, { tokens: 5, cost: 0.1 });
});

test('usage (A-1): all or nothing: one assistant message_end with no count makes the run tokens null', () => {
  const none = usageOfRun(withUsage(usageOf(10, 1, 1)), withUsage({ totalTokens: 5 }), withUsage(usageOf(2, 2, 1)));
  assert.equal(none.usage, null);
  assert.equal(usageOfRun(withUsage(usageOf(10, 1, 1)), assistant('c')).usage, null);
  assert.equal(usageOfRun(withUsage(usageOf(10, 1, 1)), withUsage(usageOf(0, 0, 0))).usage, null);
  assert.deepEqual(usageOfRun(withUsage(usageOf(10, 1, 1)), withUsage(usageOf(2, 2, 1))).usage, { tokens: 15, cost: 2 });
});

test('usage (A-1): a failure message with no count (Pi\'s synthetic one) is skipped; one with a count is summed', () => {
  for (const stopReason of ['error', 'aborted']) {
    for (const usage of [undefined, usageOf(0, 0, 0), { totalTokens: 5 }]) {
      const failed = run([messageEnd(withUsage(usageOf(10, 1, 1))), messageEnd({ ...assistant(null, stopReason, 'boom'), usage }), end(assistant(null, 'error', 'boom'))]);
      assert.deepEqual(failed.usage, { tokens: 11, cost: 1 }, `${stopReason} ${JSON.stringify(usage)}`);
    }
    const counted = run([messageEnd(withUsage(usageOf(10, 1, 1))), messageEnd({ ...assistant(null, stopReason), usage: usageOf(3, 0, 0.25) }), end(assistant(null, 'error'))]);
    assert.deepEqual(counted.usage, { tokens: 14, cost: 1.25 });
  }
  // Only a failure or aborted message, with no count: nothing was reported.
  assert.equal(run([messageEnd(assistant(null, 'error', 'boom')), end(assistant(null, 'error', 'boom'))]).usage, null);
  // Any other stop reason with no count is not skipped.
  for (const stopReason of ['length', 'toolUse', 'stop']) {
    assert.equal(usageOfRun(withUsage(usageOf(10, 1, 1)), withUsage(undefined, stopReason)).usage, null, stopReason);
  }
});

test('usage (A-3): cost is summed only when every counted message carries one, else null; a cost with no count is never added', () => {
  for (const cost of [undefined, null, 'free', -1, {}, { total: 'x' }, { total: null }, { total: NaN }]) {
    const noCost: any = { input: 2, output: 2 };
    if (cost !== undefined) noCost.cost = cost;
    assert.deepEqual(usageOfRun(withUsage(noCost)).usage, { tokens: 4, cost: null }, JSON.stringify(cost));
    assert.deepEqual(usageOfRun(withUsage(usageOf(10, 1, 1)), withUsage(noCost)).usage, { tokens: 15, cost: null }, JSON.stringify(cost));
  }
  // A cost on a message with no token count is not added (and that message nulls the tokens anyway).
  assert.equal(usageOfRun(withUsage(usageOf(10, 1, 1)), withUsage(usageOf(0, 0, 5))).usage, null);
  const skipped = run([messageEnd(withUsage(usageOf(10, 1, 1))), messageEnd({ ...assistant(null, 'error', 'boom'), usage: usageOf(0, 0, 5) }), end(assistant(null, 'error', 'boom'))]);
  assert.deepEqual(skipped.usage, { tokens: 11, cost: 1 });
  // An explicit zero cost Pi sent is a zero.
  assert.deepEqual(usageOfRun(withUsage(usageOf(1, 1, 0))).usage, { tokens: 2, cost: 0 });
});

test('usage (A-4): a token value or sum beyond a safe integer, or a cost beyond a finite sum, is null', () => {
  const big = 2 ** 53 + 1;
  assert.equal(usageOfRun(withUsage(usageOf(big, 1, 1))).usage, null);
  assert.equal(usageOfRun(withUsage(usageOf(1, 1e308, 1))).usage, null);
  assert.equal(usageOfRun(withUsage(usageOf(2 ** 53 - 1, 1, 1))).usage, null, 'one message whose input + output is unsafe');
  assert.equal(usageOfRun(withUsage(usageOf(2 ** 52, 0, 1)), withUsage(usageOf(2 ** 52, 0, 1))).usage, null, 'a running sum that leaves the safe range');
  assert.deepEqual(usageOfRun(withUsage(usageOf(2 ** 52, 0, 1))).usage, { tokens: 2 ** 52, cost: 1 });
  // Cost: a value or a sum that is not finite makes cost null and keeps the tokens.
  assert.deepEqual(usageOfRun(withUsage(usageOf(1, 1, 1e308)), withUsage(usageOf(1, 1, 1e308))).usage, { tokens: 4, cost: null });
  assert.deepEqual(usageOfRun(withUsage(usageOf(1, 1, Infinity))).usage, { tokens: 2, cost: null });
});

test('usage: only assistant message_end counts; message_update, turn_end, agent_end and user messages are not read', () => {
  const counted = withUsage(usageOf(5, 0, 0.5));
  const report = run([
    { type: 'message_update', usage: usageOf(99, 9, 9), assistantMessageEvent: { type: 'text_delta', delta: 'd' } },
    messageEnd({ role: 'user', content: [], usage: usageOf(99, 9, 9) }),
    messageEnd({ role: 'toolResult', content: [], usage: usageOf(99, 9, 9) }),
    messageEnd(counted),
    { type: 'turn_end', message: counted, toolResults: [] },
    end(counted),
  ]);
  assert.deepEqual(report.usage, { tokens: 5, cost: 0.5 });
});

test('usage: a failure and a cut-off answer still report what Pi spent', () => {
  const failed = run([messageEnd({ ...assistant(null, 'error', 'boom'), usage: usageOf(3, 0, 0.25) }), end(assistant(null, 'error', 'boom'))]);
  assert.deepEqual([failed.status, failed.usage], ['failure', { tokens: 3, cost: 0.25 }]);
  assert.deepEqual(fixture('length').usage, { tokens: 4176, cost: 0.0616 });
});

test('usage (A-6): an assistant message_end that gave no count is an ignored line; one that did is not', () => {
  const base = run([end(assistant('x'))]).ignoredLines;
  assert.equal(run([messageEnd(withUsage(usageOf(1, 1, 1))), end(assistant('x'))]).ignoredLines, base);
  for (const usage of [undefined, null, 'x', {}, { totalTokens: 5 }, usageOf(0, 0, 0), { input: 1 }]) {
    assert.equal(usageOfRun(withUsage(usage)).ignoredLines, base + 1, JSON.stringify(usage));
  }
  // A skipped failure message is still a line nothing was read from.
  assert.equal(run([messageEnd(assistant(null, 'error', 'b')), end(assistant(null, 'error', 'b'))]).ignoredLines, base + 1);
});

test('length: a last message with stopReason length is its own non-success outcome, reason length, not unparsed', () => {
  const report = fixture('length');
  assert.deepEqual([report.status, report.reason], ['failure', 'length']);
  // The partial answer Pi printed is kept as the (masked) summary.
  assert.equal(report.summary, 'The answer is cut o');
  const empty = run([end(assistant(null, 'length'))]);
  assert.deepEqual([empty.status, empty.reason, empty.summary], ['failure', 'length', null]);
  const blank = run([end(assistant('  ', 'length'))]);
  assert.deepEqual([blank.status, blank.reason, blank.summary], ['failure', 'length', null]);
});

test('length: it is not a success for any settle, and a spawn or oversize line still beats it', () => {
  assert.deepEqual(run([end(assistant('part', 'length')), { type: 'agent_settled', aborted: false }]).status, 'failure');
  assert.equal(run([end(assistant('part', 'length')), { type: 'agent_settled', aborted: true }]).reason, 'length');
  assert.equal(run([{ type: 'tool_execution_start', toolName: 'subagent' }, end(assistant('part', 'length'))]).reason, 'spawn-observed');
  const target = create();
  line(target, end(assistant('part', 'length')));
  target.oversize(true);
  assert.equal(target.end().reason, 'oversize-line');
  // Only an assistant message: a user message that says length is no signal.
  assert.deepEqual(run([end({ role: 'user', content: [], stopReason: 'length' })]).reason, 'no-final-message');
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
  const types = ['agent_end', 'agent_settled', 'tool_execution_start', 'message_end', 'session', 'turn_end', 'x', 3, null];
  const values = [null, true, false, 0, -1, 1.5, 'subagent', '', 'stop', 'error', 'length', [], {}, [null], [{}], { role: 'assistant', usage: { totalTokens: 3, cost: { total: 0.5 } } }, { role: 'assistant', usage: { input: 3, output: 4, cost: { total: 0.5 } } }, { role: 'assistant', stopReason: 'error', usage: { input: 1e308, output: 2 ** 53 + 1, cost: { total: 1e308 } } }, { role: 'assistant', usage: { input: 2 ** 53 - 1, output: 1, cost: { total: 1e308 } } }, 1e308, 2 ** 53 + 1, { totalTokens: 2 }, [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'm' }] }]];
  const keys = ['messages', 'aborted', 'toolName', 'stopReason', 'errorMessage', 'content', 'role', 'message', 'usage'];
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
    assert.ok(report.usage === null || (Number.isSafeInteger(report.usage.tokens) && report.usage.tokens > 0 && (report.usage.cost === null || (Number.isFinite(report.usage.cost) && report.usage.cost >= 0))));
    if (report.status === 'success') assert.ok(report.summary !== null && report.summary.length > 0);
  }
});

test('fixtures: every line is a labelled JSON object, LF endings, no absolute path, no secret shape', () => {
  const files = fs.readdirSync(FIXTURES).filter((name: string) => name.endsWith('.jsonl'));
  assert.deepEqual(files.sort(), ['aborted.jsonl', 'failure.jsonl', 'length.jsonl', 'spawn.jsonl', 'success.jsonl', 'truncated.jsonl', 'unknown-events.jsonl', 'usage.jsonl']);
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
