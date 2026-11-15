'use strict';
// The model-listing path: the closed parser set (on sample output captured from each CLI on 2026-11-15,
// see core/registry/harnesses.json worker.modelList.evidence), the runner (injected exec, never a real CLI),
// and the registry recipe of every harness. This replaces the removed DEFAULT_MODELS table, which no test asserted.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { tempDir } = require('../../helper/tmp.ts');
const { parseLines, parseTsvFirstColumn, parseTableColumn, parserFor } = require('../../../src/runtime/models/parsers.ts');
const { listHarnessModels } = require('../../../src/runtime/models/list-models.ts');
const { loadRegistry } = require('../../../src/registry/index.ts');

const REPO = path.resolve(__dirname, '../../..');
const registry = loadRegistry({ repoRoot: REPO });
const descriptorOf = (id: string) => registry.harnesses.find((h: any) => h.id === id).worker;

const AGY = 'Fetching available models...\ngemini-4-argon-high\tGemini 4 Argon (High)\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n';
const OPENCODE = 'anthropic/claude-x\nopenai/gpt-y\nanthropic/claude-x\n';
const PI = 'provider   model        context  max-out  thinking  images\nanthropic  claude-x     200K     64K      yes       yes\nopenai     gpt-y        400K     128K     yes       no\n';

test('tsv-first-column takes the id before the tab and skips the progress line', () => {
  assert.deepEqual(parseTsvFirstColumn(AGY), [
    { id: 'gemini-4-argon-high', displayName: 'Gemini 4 Argon (High)' },
    { id: 'gemini-3.8-flash-high', displayName: 'Gemini 3.8 Flash (High)' },
  ]);
  assert.deepEqual(parseTsvFirstColumn('Fetching available models...\n'), []);
});

test('lines takes one id per line, drops blanks and ANSI, and de-duplicates', () => {
  assert.deepEqual(parseLines(OPENCODE), [{ id: 'anthropic/claude-x' }, { id: 'openai/gpt-y' }]);
  assert.deepEqual(parseLines('\u001b[32mfoo/bar\u001b[0m\r\n\n  \n'), [{ id: 'foo/bar' }]);
  assert.deepEqual(parseLines(''), []);
});

test('table-column reads the named column under its header row', () => {
  assert.deepEqual(parseTableColumn(PI, 'model'), [{ id: 'claude-x' }, { id: 'gpt-y' }]);
  assert.deepEqual(parseTableColumn(PI, 'provider'), [{ id: 'anthropic' }, { id: 'openai' }]);
  assert.deepEqual(parseTableColumn('no header here\n', 'model'), []);
});

test('parserFor is a closed set', () => {
  assert.equal(typeof parserFor('lines'), 'function');
  assert.equal(typeof parserFor('tsv-first-column'), 'function');
  assert.deepEqual(parserFor('table-column:model')(PI).map((m: any) => m.id), ['claude-x', 'gpt-y']);
  for (const bad of ['json', 'table-column:', 'table-column:Bad Name', 'lines ', '', null, undefined, 7, 'eval:x']) assert.equal(parserFor(bad), null, String(bad));
});

test('every registry modelList recipe names a parser in the closed set, and a command without a shell placeholder', () => {
  for (const entry of registry.harnesses) {
    const list = entry.worker.modelList;
    assert.ok(list, `${entry.id} declares modelList`);
    if (list.status === 'supported') {
      assert.ok(parserFor(list.parse), `${entry.id} parse ${list.parse}`);
      assert.ok(list.argv.length > 0 && list.argv.every((item: string) => !item.includes('{')));
    } else {
      assert.equal(list.status, 'none-recorded');
      assert.ok(list.reason.length > 0);
    }
  }
  assert.deepEqual(registry.harnesses.filter((h: any) => h.worker.modelList.status === 'supported').map((h: any) => h.id).sort(), ['antigravity', 'opencode', 'pi']);
});

test('listHarnessModels runs the recipe through the injected exec and parses its output', async () => {
  const calls: any[] = [];
  const exec = async (file: string, args: string[], opts: any) => { calls.push({ file, args, timeout: opts.timeout }); return AGY; };
  const out = await listHarnessModels({ descriptor: descriptorOf('antigravity'), execImpl: exec });
  assert.equal(out.status, 'listed');
  assert.deepEqual(out.models.map((m: any) => m.id), ['gemini-4-argon-high', 'gemini-3.8-flash-high']);
  assert.deepEqual(calls, [{ file: 'agy', args: ['models'], timeout: 20000 }]);
  const pi = await listHarnessModels({ descriptor: descriptorOf('pi'), execImpl: async (file: string, args: string[]) => { assert.deepEqual([file, ...args], ['pi', '--list-models']); return PI; } });
  assert.deepEqual(pi.models.map((m: any) => m.id), ['claude-x', 'gpt-y']);
});

test('a harness with no listing command is none-recorded and starts nothing', async () => {
  for (const id of ['claude', 'codex', 'copilot', 'kiro']) {
    const out = await listHarnessModels({ descriptor: descriptorOf(id), execImpl: async () => { throw new Error('must not run'); } });
    assert.equal(out.status, 'none-recorded', id);
    assert.deepEqual(out.models, []);
    assert.ok(out.reason.length > 0);
  }
});

test('a failed listing is a result with a reason, never a throw', async () => {
  const run = (error: any, out = '') => listHarnessModels({ descriptor: descriptorOf('opencode'), execImpl: async () => { if (error) throw error; return out; } });
  const enoent = await run(Object.assign(new Error('spawn opencode ENOENT'), { code: 'ENOENT' }));
  assert.equal(enoent.status, 'failed');
  assert.match(enoent.reason, /opencode is not installed/);
  const slow = await run(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }));
  assert.match(slow.reason, /no answer within 20 s/);
  const crash = await run(new Error('login required\nsecond line'));
  assert.match(crash.reason, /the command failed \(login required\)/);
  const empty = await run(null, '\n  \n');
  assert.equal(empty.status, 'failed');
  assert.match(empty.reason, /printed no model ids/);
  assert.deepEqual(empty.models, []);
});

// ---- the listing is another program's output: nothing in it is trusted ----------------------------------------

const ESC = '\u001b';

test('parsers drop every escape form and control character: OSC title, OSC 8 hyperlink, CSI, 8-bit forms, CR', () => {
  const hostile = [
    `${ESC}]0;pwned title\u0007good/one`,
    `${ESC}]8;;https://evil.example${ESC}\\good/two${ESC}]8;;${ESC}\\`,
    `\u009b31mgood/three\u009b0m`,
    `${ESC}[2Jgood/four`,
    `${ESC}]0;never closed good/hidden`,
    'good/five\rrewritten/six',
    'bell\u0007id/seven',
  ].join('\n');
  assert.deepEqual(parseLines(hostile).map((m: any) => m.id), ['good/one', 'good/two', 'good/three', 'good/four', 'good/five', 'rewritten/six', 'bellid/seven']);
  const named = parseTsvFirstColumn(`m1\t${ESC}]0;x\u0007Nice${ESC}[31m Name\u009b0m\r\u0085\u2028\u202e!\nm2\t${'n'.repeat(500)}`);
  assert.deepEqual(named[0], { id: 'm1', displayName: 'Nice Name' });
  assert.equal(named[1].displayName.length, 120);
  // Nothing printable is left holding a control character.
  for (const m of [...parseLines(hostile), ...named]) assert.doesNotMatch(`${m.id}${m.displayName ?? ''}`, /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202e]/);
});

test('lines does not take a log line as an id', () => {
  assert.deepEqual(parseLines('WARN: update available\nINFO starting up\nreal/model\n'), [{ id: 'real/model' }]);
});

test('listHarnessModels keeps only ids the settings model-id check accepts and counts what it dropped', async () => {
  const out = await listHarnessModels({ descriptor: descriptorOf('opencode'), execImpl: async () => '--foo\n-rf\nok/model\n.hidden\n/abs\n' + 'x'.repeat(121) + '\nsecond/model\n' });
  assert.equal(out.status, 'listed');
  assert.deepEqual(out.models.map((m: any) => m.id), ['ok/model', 'second/model']);
  assert.equal(out.dropped, 5);
  assert.equal(out.capped, false);
  const none = await listHarnessModels({ descriptor: descriptorOf('opencode'), execImpl: async () => '--foo\n--bar\n' });
  assert.equal(none.status, 'failed');
  assert.match(none.reason, /2 rejected as not model ids/);
});

test('listHarnessModels refuses a 1 MiB answer and keeps at most 500 of 10,000 ids, saying so', async () => {
  const big = await listHarnessModels({ descriptor: descriptorOf('opencode'), execImpl: async () => `ok/model\n${'a'.repeat(1024 * 1024)}\n` });
  assert.equal(big.status, 'failed');
  assert.match(big.reason, /256 KiB/);
  const many = await listHarnessModels({ descriptor: descriptorOf('opencode'), execImpl: async () => Array.from({ length: 10000 }, (_, i) => `p/m${i}`).join('\n') });
  assert.equal(many.status, 'listed');
  assert.equal(many.models.length, 500);
  assert.equal(many.models[0].id, 'p/m0');
  assert.equal(many.capped, true);
});

// The real exec helper, with a scratch script standing in for the harness CLI: no real CLI runs.
const POSIX = { skip: process.platform === 'win32' ? 'POSIX shell scripts' : false };
function scriptDescriptor(t: any, body: string) {
  const dir = tempDir(t, 'doflow-list-script-');
  const file = path.join(dir, 'fake-cli');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { cli: { binary: file }, modelList: { status: 'supported', argv: [], parse: 'lines' } };
}

test('a listing that does not answer is ended at the timeout through the real exec helper', POSIX, async (t: any) => {
  const started = Date.now();
  const out = await listHarnessModels({ descriptor: scriptDescriptor(t, 'exec sleep 30'), timeoutMs: 300 });
  assert.equal(out.status, 'failed');
  assert.match(out.reason, /no answer within 0\.3 s/);
  assert.ok(Date.now() - started < 10000);
});

test('a listing that never stops writing is stopped at the output cap through the real exec helper', POSIX, async (t: any) => {
  const out = await listHarnessModels({ descriptor: scriptDescriptor(t, 'exec yes p/model'), timeoutMs: 15000 });
  assert.equal(out.status, 'failed');
  assert.match(out.reason, /more than 256 KiB of output/);
});
