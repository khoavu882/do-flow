'use strict';
// The model-listing path: the closed parser set (on sample output captured from each CLI on 2026-11-15,
// see core/registry/harnesses.json worker.modelList.evidence), the runner (injected exec, never a real CLI),
// and the registry recipe of every harness. This replaces the removed DEFAULT_MODELS table, which no test asserted.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
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
