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
const FIXTURES = path.join(REPO, 'test', 'fixtures', 'worker', 'model-lists');
// The owner's recorded output (pi 1.5.2 `pi --list-models`, opencode 2.2.7 `opencode models`), trimmed; see PROVENANCE.txt there.
const PI = fs.readFileSync(path.join(FIXTURES, 'pi-list-models.txt'), 'utf8');
const OPENCODE_CAPTURE = fs.readFileSync(path.join(FIXTURES, 'opencode-models.txt'), 'utf8');
const PI_COLUMNS = { provider: 'provider', contextTokens: 'context', maxOutputTokens: 'max-out', reasoning: 'thinking', imageInput: 'images' };
const piRecipe = (extra: any = {}) => ({ parse: 'table-column:model', columns: PI_COLUMNS, ...extra });
const idsOf = (models: any[]) => models.map((m: any) => m.id);

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
  assert.deepEqual(idsOf(parseTableColumn(PI, 'model')), ['claude-fable-5', 'claude-haiku-4-5', 'Gemma-4-12b-Comp', 'Qwen-3.6-35B', 'gpt-4', 'gpt-4.1', 'gpt-4-turbo', 'gpt-6.1-terra', 'gpt-6-luna']);
  assert.deepEqual(parseTableColumn(PI, 'provider').map((m: any) => m.id), ['anthropic', 'ollama-local', 'openai', 'openai-codex']);
  assert.deepEqual(parseTableColumn('no header here\n', 'model'), []);
});

test('parserFor is a closed set', () => {
  assert.equal(typeof parserFor({ parse: 'lines' }), 'function');
  assert.equal(typeof parserFor({ parse: 'tsv-first-column' }), 'function');
  assert.equal(idsOf(parserFor({ parse: 'table-column:model' })(PI)).length, 9, 'one id column, so an id under two providers is one entry');
  for (const bad of ['json', 'table-column:', 'table-column:Bad Name', 'lines ', '', null, undefined, 7, 'eval:x']) assert.equal(parserFor({ parse: bad }), null, String(bad));
  for (const bad of [null, undefined, 'lines', 7]) assert.equal(parserFor(bad as any), null, String(bad));
});

test('every registry modelList recipe names a parser in the closed set, and a command without a shell placeholder', () => {
  for (const entry of registry.harnesses) {
    const list = entry.worker.modelList;
    assert.ok(list, `${entry.id} declares modelList`);
    if (list.status === 'supported') {
      assert.ok(parserFor(list), `${entry.id} parse ${list.parse}`);
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
  assert.deepEqual(pi.models.map((m: any) => m.id), ['claude-fable-5', 'claude-haiku-4-5', 'Gemma-4-12b-Comp', 'Qwen-3.6-35B', 'gpt-4', 'gpt-4.1', 'gpt-4-turbo', 'gpt-6.1-terra', 'gpt-6-luna']);
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

test('169 table-column with columns keeps provider, sizes and flags per model from the recorded Pi listing', () => {
  const tally = { columnFaults: 0 };
  const models = parserFor(piRecipe())(PI, tally);
  assert.equal(tally.columnFaults, 0);
  const at = (provider: string, id: string) => models.find((m: any) => m.provider === provider && m.id === id);
  assert.deepEqual(at('anthropic', 'claude-fable-5'), { id: 'claude-fable-5', provider: 'anthropic', contextTokens: 1000000, maxOutputTokens: 128000, reasoning: true, imageInput: true });
  assert.deepEqual(at('ollama-local', 'Gemma-4-12b-Comp'), { id: 'Gemma-4-12b-Comp', provider: 'ollama-local', contextTokens: 128000, maxOutputTokens: 16400, reasoning: false, imageInput: false });
  assert.equal(at('openai', 'gpt-4')?.contextTokens, 8200);
  assert.equal(at('openai', 'gpt-4.1')?.contextTokens, 1000000);
  assert.equal(at('openai', 'gpt-4.1')?.maxOutputTokens, 32800);
  assert.equal(at('openai', 'gpt-4-turbo')?.maxOutputTokens, 4100);
});

test('169 an id listed under two providers gives two entries; the same (provider, id) twice gives one', () => {
  const models = parserFor(piRecipe())(PI);
  assert.equal(models.length, 10);
  assert.deepEqual(models.filter((m: any) => m.id === 'gpt-6.1-terra').map((m: any) => [m.provider, m.contextTokens]), [['openai', 272000], ['openai-codex', 500000]]);
  const twice = `${PI}openai-codex  gpt-6.1-terra               500K     128K     yes       yes\n`;
  assert.equal(parserFor(piRecipe())(twice).length, 10);
  assert.equal(parserFor({ parse: 'table-column:model' })(PI).filter((m: any) => m.id === 'gpt-6.1-terra').length, 1, 'with no provider column the id alone is the key');
});

test('169 a row with the wrong cell count keeps its id and no column, and is counted', () => {
  const text = 'provider model context max-out thinking images\nopenai gpt-a 128K 16K yes yes\nopenai gpt-b 128K\nopenai gpt-c 128K 16K yes yes extra\n';
  const tally = { columnFaults: 0 };
  assert.deepEqual(parserFor(piRecipe())(text, tally), [
    { id: 'gpt-a', provider: 'openai', contextTokens: 128000, maxOutputTokens: 16000, reasoning: true, imageInput: true },
    { id: 'gpt-b' },
    { id: 'gpt-c' },
  ]);
  assert.equal(tally.columnFaults, 2);
});

test('169 a cell that does not convert is left out of that model and counted', () => {
  const text = 'provider model context max-out thinking images\nopenai gpt-a lots 16K maybe yes\n-bad! gpt-b 1.5M 0.5K TRUE No\n';
  const tally = { columnFaults: 0 };
  assert.deepEqual(parserFor(piRecipe())(text, tally), [
    { id: 'gpt-a', maxOutputTokens: 16000, imageInput: true, provider: 'openai' },
    { id: 'gpt-b', contextTokens: 1500000, maxOutputTokens: 500, reasoning: true, imageInput: false },
  ]);
  assert.equal(tally.columnFaults, 3);
});

test('169 displayName goes through cleanName and effortLevels is a comma list of effort names', () => {
  const recipe = { parse: 'table-column:model', columns: { displayName: 'name', effortLevels: 'levels' } };
  const text = 'model name levels\nm1 Fancy\u001b[31m low,high\nm2 x low,bad!level\nm3 y ' + Array.from({ length: 17 }, (_, i) => `l${i}`).join(',') + '\n';
  const tally = { columnFaults: 0 };
  assert.deepEqual(parserFor(recipe)(text, tally), [
    { id: 'm1', displayName: 'Fancy', effortLevels: ['low', 'high'] },
    { id: 'm2', displayName: 'x' },
    { id: 'm3', displayName: 'y' },
  ]);
  assert.equal(tally.columnFaults, 2);
});

test('169 a declared column the header does not have is not read', () => {
  const models = parserFor({ parse: 'table-column:model', columns: { provider: 'provider', contextTokens: 'nope' } })(PI);
  assert.equal(models.length, 10);
  assert.equal(models.every((m: any) => m.contextTokens === undefined && typeof m.provider === 'string'), true);
});

test('169 providerInId splits the recorded OpenCode ids at the first separator and a bare id keeps no provider', () => {
  const models = parserFor({ parse: 'lines', providerInId: true }, '/')(OPENCODE_CAPTURE);
  assert.deepEqual(models, [
    { id: 'gemma4:12b', provider: 'ollama' },
    { id: 'Qwen-3.6-35B:latest', provider: 'ollama' },
    { id: 'gpt-5.5', provider: 'openai' },
    { id: 'gpt-5.5-fast', provider: 'openai' },
    { id: 'gpt-6.1-terra', provider: 'openai' },
    { id: 'big-pickle', provider: 'opencode' },
    { id: 'beam-free', provider: 'opencode' },
    { id: 'iceman-free', provider: 'opencode' },
  ]);
  assert.deepEqual(parserFor({ parse: 'lines', providerInId: true }, '/')('bare-id\na/b/c\n/lead\n'), [{ id: 'bare-id' }, { id: 'b/c', provider: 'a' }, { id: '/lead' }]);
  assert.deepEqual(idsOf(parserFor({ parse: 'lines' })(OPENCODE_CAPTURE)).slice(0, 2), ['ollama/gemma4:12b', 'ollama/Qwen-3.6-35B:latest'], 'without providerInId the id stays whole');
});

test('169 listHarnessModels reports the columns it read and the faults, and keeps the caps', async () => {
  const worker = { cli: { binary: 'pi' }, modelList: { status: 'supported', argv: ['--list-models'], ...piRecipe() }, provider: { status: 'supported', via: 'flag', argv: ['--provider', '{provider}'] } };
  const out = await listHarnessModels({ descriptor: worker, execImpl: async () => `${PI}openai gpt-short 128K\n` });
  assert.equal(out.status, 'listed');
  assert.deepEqual(out.columns, ['provider', 'contextTokens', 'maxOutputTokens', 'reasoning', 'imageInput']);
  assert.equal(out.columnFaults, 1);
  assert.equal(out.models.length, 11);
  const noColumns = await listHarnessModels({ descriptor: descriptorOf('pi'), execImpl: async () => PI });
  assert.equal(noColumns.columns, undefined);
  assert.equal(noColumns.columnFaults, undefined);
  const prefixed = await listHarnessModels({ descriptor: { cli: { binary: 'opencode' }, modelList: { status: 'supported', argv: ['models'], parse: 'lines', providerInId: true }, provider: { status: 'supported', via: 'id-prefix', separator: '/' } }, execImpl: async () => OPENCODE_CAPTURE });
  assert.equal(prefixed.models[0].provider, 'ollama');
  assert.equal(prefixed.models[0].id, 'gemma4:12b');
});
