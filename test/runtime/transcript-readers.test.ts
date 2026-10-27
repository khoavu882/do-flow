'use strict';
// 093 V.4 (IC-022, IC-026): the five transcript readers over V.2's synthetic fixtures. Text and metadata
// modes, masking after JSON decoding, the caps, the byte cursor, drift, dedup/difference rules, read-only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { V8_ROOT, FIXTURES, MARKERS } = require('../fixtures/transcripts/v8/scan.ts');
const { maskBody } = require('../../src/runtime/mask.ts');
const { loadTranscriptRegistry } = require('../../src/runtime/transcripts/registry.ts');
const cursorModule = require('../../src/runtime/transcripts/cursor.ts');
const { tempDir } = require('../helper/tmp.ts');

const READERS_DIR = path.resolve(__dirname, '../../src/runtime/transcripts/readers');
const readers: Record<string, any> = {};
for (const id of ['claude-jsonl', 'codex-rollout', 'kiro-jsonl', 'copilot-events', 'pi-jsonl']) readers[id] = require(path.join(READERS_DIR, `${id}.ts`));

const ID = 'fa000000-0000-4000-8000-00000000';
const KEY = '0123456789abcdef';
const fx = (rel: string) => path.join(V8_ROOT, rel);
/** reader id -> harness, main fixture. */
const MAIN: Record<string, { harness: string; file: string }> = {
  'claude-jsonl': { harness: 'claude', file: `claude/-work-fixture-project/${ID}c001.jsonl` },
  'codex-rollout': { harness: 'codex', file: `codex/2026/01/01/rollout-2026-01-01T00-00-00-${ID}d001.jsonl` },
  'kiro-jsonl': { harness: 'kiro', file: `kiro/${ID}e001.jsonl` },
  'copilot-events': { harness: 'copilot', file: `copilot/${ID}f001/events.jsonl` },
  'pi-jsonl': { harness: 'pi', file: `pi/--work-fixture-project--/2026-01-01T00-00-00-000Z_${ID}a001.jsonl` },
};
const read = (id: string, opts: any = {}) => readers[id].read({ file: fx(MAIN[id].file), mode: 'text', agentKey: KEY, ...opts });
const kinds = (out: any) => out.events.map((e: any) => e.kind);

/** Every string that must not reach an event, except as <masked> or <email>. */
const FORBIDDEN = [
  'fx-Secret-4471', 'fixture.person@example.invalid', 'FIXTURE-THINKING-MARKER-7f3a', 'FIXTURE-USER-PROMPT-MARKER-91c2',
  'fixture.attach@example.invalid', 'fixture-unknown-record-type', '/work/fixture-project', 'FIXTURE-TOOL-RESULT-TEXT-5e1d',
  'FIXTURE-OTHER-PROJECT-REPLY-2b8d', 'fa000000-0000-4000', 'fixture-missing-keys-record',
];

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out[path.relative(root, full)] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(root);
  return out;
}

function copyMain(t: any, id: string): { dir: string; file: string; companion?: string } {
  const dir = tempDir(t, 'doflow-v8-readers-');
  const file = path.join(dir, path.basename(MAIN[id].file));
  fs.copyFileSync(fx(MAIN[id].file), file);
  let companion;
  if (id === 'kiro-jsonl') { companion = file.replace(/\.jsonl$/, '.json'); fs.copyFileSync(fx(MAIN[id].file.replace(/\.jsonl$/, '.json')), companion); }
  return { dir, file, companion };
}

test('the five readers are exactly the registry readers (no opencode, no gemini) and share its required keys', () => {
  const loaded = loadTranscriptRegistry();
  assert.equal(loaded.ok, true);
  const entries = loaded.registry.entries.filter((e: any) => e.reader !== null);
  assert.deepEqual(entries.map((e: any) => e.reader).sort(), Object.keys(readers).sort());
  assert.deepEqual(fs.readdirSync(READERS_DIR).sort(), Object.keys(readers).map((id) => `${id}.ts`).sort());
  for (const e of entries) {
    assert.equal(readers[e.reader].id, e.reader);
    assert.deepEqual(readers[e.reader].REQUIRED_KEYS, e.requiredKeys, `${e.reader} required keys match the registry`);
  }
});

const EXPECT: Record<string, { kinds: string[]; other: number }> = {
  'claude-jsonl': { kinds: ['usage', 'reply', 'tool-call', 'usage', 'tool-result', 'reply', 'usage'], other: 5 },
  'codex-rollout': { kinds: ['model-change', 'reply', 'tool-call', 'tool-result', 'usage', 'reply'], other: 6 },
  'kiro-jsonl': { kinds: ['reply', 'tool-call', 'tool-result', 'reply', 'usage'], other: 6 },
  'copilot-events': { kinds: ['reply', 'tool-call', 'tool-result', 'subagent-start', 'usage', 'usage', 'reply'], other: 5 },
  'pi-jsonl': { kinds: ['model-change', 'reply', 'tool-call', 'usage', 'tool-result', 'reply'], other: 6 },
};

for (const id of Object.keys(readers)) {
  test(`${id}: text mode gives the expected events, masked, and none of the withheld content`, () => {
    const out = read(id);
    assert.deepEqual(kinds(out), EXPECT[id].kinds);
    assert.equal(out.otherRecords, EXPECT[id].other, 'thinking, prompt, attachment, unknown and missing-key records are counted');
    assert.equal(out.unparsable, 0);
    assert.deepEqual(out.warnings, []);
    assert.equal(out.reset, false);
    assert.equal(out.eof, true);
    assert.ok(out.masked >= 4, `a secret and an email in the reply, two secrets in the arguments (masked ${out.masked})`);
    assert.match(out.cursor, /^\d+:\d+:\d+:\d+$/);
    out.events.forEach((e: any, i: number) => {
      assert.deepEqual(Object.keys(e), ['seq', 'at', 'kind', 'agentKey', 'model', 'tool', 'text', 'args', 'cut', 'tokens', 'record']);
      assert.equal(e.seq, i);
      assert.equal(e.agentKey, KEY);
      assert.equal(e.record, null);
      assert.equal(e.cut, false);
    });
    const [reply, call, result] = ['reply', 'tool-call', 'tool-result'].map((k) => out.events.find((e: any) => e.kind === k));
    assert.match(reply.text, /^FIXTURE-REPLY-OK .*password=<masked> and mail <email>$/);
    assert.match(call.args, /<masked>/);
    assert.equal(call.text, null);
    assert.equal(result.text, null);
    assert.equal(result.args, null);
    assert.match(call.tool.callKey, /^[0-9a-f]{16}$/);
    assert.equal(call.tool.callKey, result.tool.callKey);
    const bytes = Buffer.byteLength(`FIXTURE-TOOL-RESULT-TEXT-5e1d ${{ 'claude-jsonl': 'cmain', 'codex-rollout': 'xmain', 'kiro-jsonl': 'kmain', 'copilot-events': 'pmain', 'pi-jsonl': 'pmain' }[id]}`);
    if (['kiro-jsonl', 'pi-jsonl'].includes(id)) assert.ok(result.tool.bytes > bytes, 'a block array is sized as recorded');
    else assert.equal(result.tool.bytes, bytes);
    const json = JSON.stringify(out);
    for (const needle of FORBIDDEN) assert.ok(!json.includes(needle), `${id} output holds ${needle}`);
    assert.ok(!json.includes('"token\\":\\"fx'), 'no escaped secret form either');
  });

  test(`${id}: metadata mode carries no text and no args, and nothing to mask`, () => {
    const meta = read(id, { mode: 'metadata' });
    const text = read(id);
    assert.deepEqual(kinds(meta), kinds(text));
    assert.equal(meta.masked, 0);
    for (const e of meta.events) { assert.equal(e.text, null); assert.equal(e.args, null); assert.equal(e.cut, false); }
    const strip = (o: any) => o.events.map((e: any) => ({ ...e, text: null, args: null, cut: false }));
    assert.deepEqual(strip(meta), strip(text), 'every other field is the same in both modes');
    assert.ok(meta.events.some((e: any) => e.tool && e.tool.name), 'tool names stay');
    const json = JSON.stringify(meta);
    for (const needle of [...FORBIDDEN, 'FIXTURE-REPLY']) assert.ok(!json.includes(needle), `${id} metadata holds ${needle}`);
  });
}

test('tool results carry status, bytes and the call-to-result duration, never text', () => {
  const pick = (id: string) => read(id).events.find((e: any) => e.kind === 'tool-result').tool;
  assert.deepEqual(pick('claude-jsonl'), { name: 'Bash', callKey: pick('claude-jsonl').callKey, status: 'ok', bytes: 35, durationMs: 1000 });
  assert.deepEqual([pick('codex-rollout').name, pick('codex-rollout').status, pick('codex-rollout').durationMs], ['shell', null, 1000]);
  assert.deepEqual([pick('kiro-jsonl').name, pick('kiro-jsonl').status, pick('kiro-jsonl').durationMs], ['execute_bash', 'ok', null]);
  assert.deepEqual([pick('copilot-events').name, pick('copilot-events').status, pick('copilot-events').durationMs], ['bash', 'ok', 1000]);
  assert.deepEqual([pick('pi-jsonl').name, pick('pi-jsonl').status, pick('pi-jsonl').durationMs], ['bash', 'ok', 321]);
});

test('Claude usage is deduplicated by message.id', () => {
  const out = read('claude-jsonl');
  const usage = out.events.filter((e: any) => e.kind === 'usage');
  assert.equal(usage.length, 3, 'four lines carry usage, three messages');
  assert.deepEqual(usage.map((e: any) => e.tokens.input), [50, 60, 70]);
  assert.deepEqual(usage[0].tokens, { input: 50, output: 20, cacheRead: 100, cacheWrite: 10, reasoning: null });
  assert.equal(usage[0].at, '2026-01-01T00:00:02.000Z');
  assert.equal(usage[0].model, 'claude-fixture-1');
});

test('Copilot cumulative usage is differenced, also against records before the window', (t) => {
  const usage = read('copilot-events').events.filter((e: any) => e.kind === 'usage');
  assert.deepEqual(usage.map((e: any) => e.tokens), [
    { input: 100, output: 50, cacheRead: 10, cacheWrite: 2, reasoning: 5 },
    { input: 80, output: 40, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
  ]);
  // A cursor placed after the first usage record: the second still differences against it.
  const { file } = copyMain(t, 'copilot-events');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const upto = lines.slice(0, 7).join('\n') + '\n'; // through the first usage record
  fs.writeFileSync(file, upto);
  const first = readers['copilot-events'].read({ file, mode: 'text', agentKey: KEY });
  fs.writeFileSync(file, fs.readFileSync(fx(MAIN['copilot-events'].file)));
  const next = readers['copilot-events'].read({ file, mode: 'text', agentKey: KEY, cursor: first.cursor });
  assert.deepEqual(next.events.filter((e: any) => e.kind === 'usage').map((e: any) => e.tokens.input), [80]);
  // A counter that restarts (negative step) reports the value itself.
  fs.appendFileSync(file, `${JSON.stringify({ id: 'evx', parentId: null, timestamp: '2026-01-01T00:00:12.000Z', type: 'session.usage_record', data: { modelMetrics: { 'copilot-fixture-1': { usage: { inputTokens: 7, outputTokens: 3 } } } } })}\n`);
  const after = readers['copilot-events'].read({ file, mode: 'text', agentKey: KEY, cursor: next.cursor });
  assert.deepEqual(after.events.map((e: any) => e.tokens), [{ input: 7, output: 3, cacheRead: null, cacheWrite: null, reasoning: null }]);
});

test('Kiro events have at: null and per-turn usage comes from the companion once', (t) => {
  const out = read('kiro-jsonl');
  assert.ok(out.events.every((e: any) => e.at === null));
  const usage = out.events.find((e: any) => e.kind === 'usage');
  assert.deepEqual(usage.tokens, { input: 90, output: 45, cacheRead: 10, cacheWrite: 2, reasoning: null });
  assert.equal(usage.model, 'kiro-fixture-1');
  assert.equal(read('kiro-jsonl', { cursor: out.cursor }).events.length, 0, 'the turn is not returned twice');
  const { file, companion } = copyMain(t, 'kiro-jsonl');
  const copyCursor = readers['kiro-jsonl'].read({ file, companion, mode: 'text', agentKey: KEY }).cursor;
  const j = JSON.parse(fs.readFileSync(companion, 'utf8'));
  j.user_turn_metadatas.push({ ...j.user_turn_metadatas[0], input_token_count: 5, end_timestamp: '2026-01-01T00:01:00.000Z' });
  fs.writeFileSync(companion, JSON.stringify(j));
  const next = readers['kiro-jsonl'].read({ file, companion, mode: 'text', agentKey: KEY, cursor: copyCursor });
  assert.deepEqual(next.events.map((e: any) => [e.kind, e.tokens && e.tokens.input]), [['usage', 5]]);
});

test('model-change and the model on later events follow the record (Codex, Pi)', () => {
  const codex = read('codex-rollout');
  assert.deepEqual(codex.events.filter((e: any) => e.kind !== 'model-change').map((e: any) => e.model), Array(5).fill('codex-fixture-1'));
  const pi = read('pi-jsonl');
  assert.equal(pi.events[0].model, 'pi-fixture-1');
  assert.deepEqual(pi.events.find((e: any) => e.kind === 'usage').tokens, { input: 100, output: 40, cacheRead: 10, cacheWrite: 2, reasoning: 6 });
  assert.deepEqual(codex.events.find((e: any) => e.kind === 'usage').tokens, { input: 80, output: 40, cacheRead: 20, cacheWrite: 5, reasoning: 8 });
});

test('the second project\'s reply is read from its own file and from nowhere else', () => {
  const other = readers['claude-jsonl'].read({ file: fx(`claude/-work-other-project/${ID}c0f2.jsonl`), mode: 'text', agentKey: KEY });
  assert.ok(other.events.some((e: any) => e.text && e.text.startsWith('FIXTURE-REPLY-OK cother')), 'its own reply is readable');
  assert.ok(!JSON.stringify(other).includes('FIXTURE-OTHER-PROJECT-REPLY-2b8d'), 'and the 32-character marker is masked by the long-run rule');
  for (const id of Object.keys(readers)) assert.ok(!JSON.stringify(read(id)).includes('OTHER-PROJECT'));
});

test('sub-agent files read like main files and expose only their header facts', () => {
  const sub = readers['claude-jsonl'].read({ file: fx(`claude/-work-fixture-project/${ID}c001/subagents/agent-afx1.jsonl`), mode: 'text', agentKey: KEY });
  assert.deepEqual(kinds(sub), EXPECT['claude-jsonl'].kinds);
  const h = (id: string, rel: string) => readers[id].header({ file: fx(rel) });
  const c1 = h('claude-jsonl', `claude/-work-fixture-project/${ID}c001/subagents/agent-afx1.jsonl`);
  const c2 = h('claude-jsonl', `claude/-work-fixture-project/${ID}c001/subagents/agent-afx2.jsonl`);
  assert.deepEqual([c1.agentId, c1.label, c1.depth, c1.sessionId], ['afx1', 'fixture-explorer', 1, `${ID}c001`]);
  assert.deepEqual([c2.agentId, c2.label, c2.depth], ['afx2', 'fixture-reviewer', 2]);
  const x = h('codex-rollout', `codex/2026/01/01/rollout-2026-01-01T00-00-30-${ID}d002.jsonl`);
  assert.deepEqual([x.sessionId, x.parentSessionId, x.label, x.depth], [`${ID}d002`, `${ID}d001`, 'fixture-worker', 1]);
  assert.equal(h('codex-rollout', MAIN['codex-rollout'].file).parentSessionId, null);
  const p = h('pi-jsonl', `pi/--work-fixture-project--/2026-01-01T00-00-30-000Z_${ID}a002.jsonl`);
  assert.deepEqual([p.sessionId, p.parentSessionId, p.cwd], [`${ID}a002`, `${ID}a001`, '/work/fixture-project']);
  assert.equal(h('pi-jsonl', MAIN['pi-jsonl'].file).parentSessionId, null);
  const c = h('copilot-events', MAIN['copilot-events'].file);
  assert.deepEqual([c.sessionId, c.children], [`${ID}f001`, [{ agentId: 'agent-fx-1', label: 'fixture-agent', depth: null }]]);
  const k = h('kiro-jsonl', MAIN['kiro-jsonl'].file);
  assert.deepEqual([k.sessionId, k.parentSessionId, k.model], [`${ID}e001`, null, 'kiro-fixture-1']);
});

// ---- redaction: the escaped-JSON case is the row's negative control -----------------------------------------

test('control: masking the raw line before decoding lets the escaped-JSON secret through; the readers do not', () => {
  const raw = fs.readFileSync(fx(MAIN['codex-rollout'].file), 'utf8').split('\n').find((l: string) => l.includes('"function_call"'));
  const rawMasked = JSON.parse(maskBody(raw).text);
  assert.ok(rawMasked.payload.arguments.includes('fx-Secret-4471-esc'), 'raw-line masking leaks the escaped secret');
  for (const id of Object.keys(readers)) {
    const call = read(id).events.find((e: any) => e.kind === 'tool-call');
    assert.ok(!call.args.includes('fx-Secret-4471'), `${id} arguments`);
    assert.match(call.args, /token[^<]*<masked>/, `${id} masks the escaped token's value`);
  }
});

test('a secret in a structured argument is masked through its key, and a deep or wide argument stays bounded', (t) => {
  const { file } = copyMain(t, 'pi-jsonl');
  const rec = (n: number, input: any) => JSON.stringify({ id: `x${n}`, parentId: null, timestamp: '2026-01-01T00:00:09.000Z', type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: `c${n}`, name: 'bash', arguments: input }] } });
  fs.appendFileSync(file, `${rec(1, { password: 'hunter2-plain', nested: { a: [{ apiKey: 'hunter2-deep' }] } })}\n${rec(2, Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, 'v'])))}\n`);
  const out = readers['pi-jsonl'].read({ file, mode: 'text', agentKey: KEY });
  const calls = out.events.filter((e: any) => e.kind === 'tool-call').slice(-2);
  assert.ok(!calls[0].args.includes('hunter2'), calls[0].args);
  assert.ok(Buffer.byteLength(calls[1].args) <= 512 && calls[1].cut);
});

test('a 5 KiB reply is cut at 4 KiB after masking, a secret on the cut stays masked, and args cut at 512 B', (t) => {
  const { file } = copyMain(t, 'claude-jsonl');
  const body = `${'x '.repeat(2040)} password=fx-Secret-4471-edge and a tail ${'y '.repeat(500)}`;
  assert.ok(Buffer.byteLength(body) > 5000);
  const line = (uuid: string, block: any) => JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:00:20.000Z', sessionId: `${ID}c001`, uuid, message: { id: `m_${uuid}`, role: 'assistant', model: 'claude-fixture-1', content: [block] } });
  fs.appendFileSync(file, `${line('big', { type: 'text', text: body })}\n${line('args', { type: 'tool_use', id: 't9', name: 'Edit', input: { new_string: 'word '.repeat(300) } })}\n`);
  const out = readers['claude-jsonl'].read({ file, mode: 'text', agentKey: KEY });
  const reply = out.events.filter((e: any) => e.kind === 'reply').at(-1);
  assert.equal(reply.cut, true);
  assert.ok(Buffer.byteLength(reply.text) <= 4096 && Buffer.byteLength(reply.text) > 4000);
  assert.ok(!reply.text.includes('fx-S'), 'not even the start of the secret survives the cut');
  const call = out.events.filter((e: any) => e.kind === 'tool-call').at(-1);
  assert.equal(call.cut, true);
  assert.ok(Buffer.byteLength(call.args) <= 512);
  assert.equal(readers['claude-jsonl'].read({ file, mode: 'metadata', agentKey: KEY }).events.every((e: any) => !e.cut && e.text === null), true);
});

// ---- cursor -------------------------------------------------------------------------------------------------

const replyLine = (n: number) => `${JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:05:00.000Z', sessionId: `${ID}c001`, uuid: `app${n}`, message: { id: `mapp${n}`, role: 'assistant', model: 'claude-fixture-1', content: [{ type: 'text', text: `APPENDED-${n}` }] } })}\n`;

test('the cursor survives an append, leaves an unfinished line alone and reads nothing twice', (t) => {
  const { file } = copyMain(t, 'claude-jsonl');
  const run = (cursor?: string, extra: any = {}) => readers['claude-jsonl'].read({ file, mode: 'text', agentKey: KEY, cursor, ...extra });
  const first = run();
  assert.equal(first.events.length, 7);
  const idle = run(first.cursor);
  assert.deepEqual([idle.events.length, idle.reset, idle.eof, idle.cursor], [0, false, true, first.cursor]);
  fs.appendFileSync(file, replyLine(1));
  const second = run(first.cursor);
  assert.deepEqual(second.events.map((e: any) => [e.seq, e.kind, e.text]), [[7, 'reply', 'APPENDED-1']]);
  assert.equal(second.reset, false);
  assert.equal(second.otherRecords, 0);
  // A half-written line is not consumed; once finished it is.
  const half = replyLine(2);
  fs.appendFileSync(file, half.slice(0, 40));
  const partial = run(second.cursor);
  assert.deepEqual([partial.events.length, partial.unparsable, partial.cursor], [0, 0, second.cursor]);
  fs.appendFileSync(file, half.slice(40));
  const third = run(second.cursor);
  assert.deepEqual(third.events.map((e: any) => e.text), ['APPENDED-2']);
});

test('the cursor resets to the last 64 records on truncation and on a new inode', (t) => {
  const { dir, file } = copyMain(t, 'claude-jsonl');
  const run = (cursor?: string) => readers['claude-jsonl'].read({ file, mode: 'text', agentKey: KEY, cursor });
  const first = run();
  const many = Array.from({ length: 100 }, (_, i) => replyLine(i + 100)).join('');
  fs.writeFileSync(file, replyLine(200)); // same inode, shorter
  const truncated = run(first.cursor);
  assert.equal(truncated.reset, true);
  assert.deepEqual(truncated.events.filter((e: any) => e.kind === 'reply').map((e: any) => e.text), ['APPENDED-200']);
  assert.equal(truncated.events[0].seq, 0, 'sequence numbers restart at the reset');
  // New inode, longer content: replaced through a rename.
  const swap = path.join(dir, 'swap.jsonl');
  fs.writeFileSync(swap, many);
  fs.renameSync(swap, file);
  const replaced = run(truncated.cursor);
  assert.equal(replaced.reset, true);
  const replies = replaced.events.filter((e: any) => e.kind === 'reply');
  assert.equal(replies.length, 64, 'the last 64 records');
  assert.equal(replies.at(-1).text, 'APPENDED-199');
  assert.equal(replies[0].text, 'APPENDED-136');
  // No cursor at all: the same window, but nothing was reset.
  const fresh = run();
  assert.deepEqual([fresh.reset, fresh.events.length], [false, replaced.events.length]);
});

test('a call reads at most the window it is given, and the limit keeps whole records', (t) => {
  const { file } = copyMain(t, 'claude-jsonl');
  const before = readers['claude-jsonl'].read({ file, mode: 'text', agentKey: KEY });
  fs.appendFileSync(file, Array.from({ length: 50 }, (_, i) => replyLine(i)).join(''));
  const size = Number(before.cursor.split(':')[1]);
  const small = readers['claude-jsonl'].read({ file, mode: 'text', agentKey: KEY, cursor: before.cursor, maxBytes: 1024 });
  const read1 = Number(small.cursor.split(':')[1]) - size;
  assert.ok(read1 > 0 && read1 <= 1024, `read ${read1} bytes`);
  assert.equal(small.eof, false);
  // Walk to the end in small steps: every event once, in order.
  let cursor = before.cursor;
  const seen: string[] = [];
  for (let i = 0; i < 200; i++) {
    const step = readers['claude-jsonl'].read({ file, mode: 'text', agentKey: KEY, cursor, maxBytes: 1024, limit: 3 });
    assert.ok(step.events.length <= 3);
    seen.push(...step.events.filter((e: any) => e.kind === 'reply').map((e: any) => e.text));
    cursor = step.cursor;
    if (step.eof) break;
  }
  assert.deepEqual(seen, Array.from({ length: 50 }, (_, i) => `APPENDED-${i}`));
  assert.equal(cursorModule.MAX_READ_BYTES, 256 * 1024);
  assert.equal(readers['claude-jsonl'].read({ file, mode: 'text', agentKey: KEY, limit: 9999 }).events.length <= 500, true);
});

// ---- drift ----------------------------------------------------------------------------------------------------

test('30 % records without the required keys or not JSON give format-unrecognized, 20 % do not', (t) => {
  for (const id of Object.keys(readers)) {
    const { file, companion } = copyMain(t, id);
    const good = fs.readFileSync(file, 'utf8').split('\n').filter((l: string) => l && !l.includes('fixture-missing-keys-record') && !l.includes('fixture-unknown-record-type'));
    const build = (goodCount: number, bad: string[]) => {
      const lines = Array.from({ length: goodCount }, (_, i) => good[i % good.length]);
      fs.writeFileSync(file, `${[...lines, ...bad].join('\n')}\n`);
      return readers[id].read({ file, companion, mode: 'text', agentKey: KEY });
    };
    const thirty = build(7, ['{"note":"a"}', '{"note":"b"}', '{"torn":']);
    assert.deepEqual(thirty.warnings, ['format-unrecognized'], id);
    assert.equal(thirty.unparsable, 1, id);
    assert.ok(thirty.events.length > 0, 'the events that did parse are kept');
    assert.deepEqual(build(7, ['{"note":"a"}', '{"note":"b"}']).warnings, ['format-unrecognized'], `${id}: 22 %`);
    assert.deepEqual(build(8, ['{"note":"a"}', '{"note":"b"}']).warnings, [], `${id}: exactly 20 % is not more than 20 %`);
  }
});

test('an unknown record type that keeps its required keys is counted, not a format change', () => {
  for (const id of Object.keys(readers)) assert.deepEqual(read(id).warnings, [], id);
});

// ---- read-only ------------------------------------------------------------------------------------------------

test('readers open files read-only, write nothing, and leave every fixture home byte-identical', () => {
  const before = snapshot(V8_ROOT);
  const listing = fs.readdirSync(V8_ROOT, { recursive: true }).sort();
  const writes: string[] = [];
  const orig: Record<string, any> = {};
  for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'writeSync', 'unlinkSync', 'renameSync', 'rmSync', 'copyFileSync', 'truncateSync', 'ftruncateSync', 'utimesSync']) {
    orig[name] = (fs as any)[name];
    (fs as any)[name] = (...args: any[]) => { writes.push(name); return orig[name](...args); };
  }
  const origOpen = fs.openSync;
  const flags: any[] = [];
  (fs as any).openSync = (p: any, f: any, ...rest: any[]) => { flags.push(f); return origOpen(p, f, ...rest); };
  try {
    for (const harnessFile of FIXTURES.filter((f: any) => ['main', 'subagent', 'other-project'].includes(f.kind) && f.harness !== 'antigravity')) {
      const id = ({ claude: 'claude-jsonl', codex: 'codex-rollout', kiro: 'kiro-jsonl', copilot: 'copilot-events', pi: 'pi-jsonl' } as any)[harnessFile.harness];
      for (const mode of ['text', 'metadata']) {
        readers[id].read({ file: fx(harnessFile.file), mode, agentKey: KEY });
        readers[id].header({ file: fx(harnessFile.file) });
      }
    }
  } finally {
    Object.assign(fs, orig);
    (fs as any).openSync = origOpen;
  }
  assert.deepEqual(writes, []);
  assert.ok(flags.length > 20 && flags.every((f) => f === 'r'), `open flags: ${[...new Set(flags)]}`);
  assert.deepEqual(snapshot(V8_ROOT), before);
  assert.deepEqual(fs.readdirSync(V8_ROOT, { recursive: true }).sort(), listing);
});

test('every marker the fixtures plant is accounted for: masked, absent, or counted', () => {
  // The marker list is V.2's; this guards that V.4's FORBIDDEN list did not drift from it.
  const ids = MARKERS.map((m: any) => m.id);
  for (const needed of ['secret-reply', 'secret-args-plain', 'secret-args-escaped', 'email', 'thinking', 'user-prompt', 'attachment-user-email', 'unknown-record-type', 'path', 'tool-result-text', 'other-project-reply']) {
    assert.ok(ids.includes(needed), needed);
  }
});
