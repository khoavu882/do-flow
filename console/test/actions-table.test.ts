'use strict';

// The action table's agreements (feature 162, IC-001, IC-007, IC-012; requirement AC-1). The ids of `ACTIONS`, of
// scopes.ts `ACTION_IDS` and of verb-runner.ts `WRITE_SHAPES` are one set; each row's write shape exists and takes
// exactly the parameters the row passes; the core is reached for a write only through `runner.act`, called from
// actions.ts alone; and no Console source file other than the three declared writers opens a file for writing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { ACTIONS } = require('../src/actions.ts');
const { ACTION_IDS, DEVICE_ROUTES } = require('../src/scopes.ts');
const { WRITE_SHAPES, WRITE_SHAPE_IDS } = require('../src/verb-runner.ts');

const SRC = path.join(__dirname, '..', 'src');
const sources = () => fs.readdirSync(SRC).filter((name: string) => name.endsWith('.ts')).sort()
  .map((name: string) => ({ name, text: fs.readFileSync(path.join(SRC, name), 'utf8') }));

test('ACTIONS ids, ACTION_IDS and WRITE_SHAPE_IDS are one set; every row names a WRITE_SHAPES key; the table is frozen; control lists one route per id', () => {
  const ids = ACTIONS.map((spec: any) => spec.id);
  assert.deepEqual([...ids].sort(), [...ACTION_IDS].sort());
  assert.deepEqual([...ids].sort(), [...WRITE_SHAPE_IDS].sort());
  assert.equal(new Set(ids).size, ids.length);
  for (const spec of ACTIONS) assert.ok(Object.hasOwn(WRITE_SHAPES, spec.shape), `${spec.id} -> ${spec.shape}`);
  assert.ok(Object.isFrozen(ACTIONS) && ACTIONS.every((spec: any) => Object.isFrozen(spec) && Object.isFrozen(spec.fields)));
  const writes = DEVICE_ROUTES.control.filter((entry: string) => !entry.startsWith('GET '));
  assert.deepEqual(writes, ACTION_IDS.map((id: string) => `POST /api/actions/${id}`));
  assert.ok(DEVICE_ROUTES.view.every((entry: string) => entry.startsWith('GET ')), 'view lists no write');
  assert.ok(DEVICE_ROUTES.view.includes('GET /api/actions') && DEVICE_ROUTES.control.includes('GET /api/actions'));
});

/**
 * IC-012, the four-way check: the words table (web/derive/actions.js ACTION_WORDS) is keyed by the same ids as ACTIONS,
 * ACTION_IDS and WRITE_SHAPE_IDS. The module is an ES module in a CommonJS package, so its one file is copied beside a
 * {"type":"module"} marker in a scratch folder and imported from there, read-only.
 */
test('IC-012: the words table\'s ids, ACTION_IDS, ACTIONS ids and WRITE_SHAPE_IDS are one set, and every entry says an effect and an applied notice', async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-actions-table-'));
  try {
    fs.mkdirSync(path.join(scratch, 'derive'));
    fs.copyFileSync(path.join(__dirname, '..', 'web', 'derive', 'actions.js'), path.join(scratch, 'derive', 'actions.js'));
    fs.writeFileSync(path.join(scratch, 'package.json'), '{"type":"module"}\n');
    const { ACTION_WORDS } = await import(pathToFileURL(path.join(scratch, 'derive', 'actions.js')).href);
    const words = Object.keys(ACTION_WORDS).sort();
    assert.deepEqual(words, [...ACTION_IDS].sort());
    assert.deepEqual(words, ACTIONS.map((spec: any) => spec.id).sort());
    assert.deepEqual(words, [...WRITE_SHAPE_IDS].sort());
    for (const id of words) assert.deepEqual(Object.keys(ACTION_WORDS[id]).sort(), ['applied', 'effect'], id);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('each row passes its write shape exactly the parameters the shape declares (plus projectKey), and the relay label is the one given, never the body\'s', () => {
  const samples: Record<string, any> = {
    'decide-gate': { v: 1, requestId: 'x'.repeat(22), projectKey: '0123456789abcdef', slug: 'feat-a', taskId: 't1', gateId: 'gate-a', decision: 'approve', note: 'n', expect: { revision: 7 } },
    'close-run': { v: 1, requestId: 'x'.repeat(22), projectKey: '0123456789abcdef', slug: 'feat-a', taskId: 't1', note: 'n', expect: { revision: 7 } },
    'cancel-worker': { v: 1, requestId: 'x'.repeat(22), projectKey: '0123456789abcdef', slug: 'feat-a', runId: 'w-0123456789ab', reason: 'r' },
  };
  for (const spec of ACTIONS) {
    const declared = WRITE_SHAPES[spec.shape].argv.filter((part: any) => typeof part !== 'string').map((part: any) => part.param);
    const params = spec.params(samples[spec.id], 'device.d-0123456789ab');
    assert.deepEqual(Object.keys(params).sort(), [...new Set([...declared, 'projectKey'])].sort(), spec.id);
    assert.equal(params.relay, 'device.d-0123456789ab');
    assert.ok(Object.values(params).every((value) => typeof value === 'string'), `${spec.id}: argv values are strings`);
  }
});

test('a write reaches the core only through runner.act: verb-runner.ts defines it, actions.ts alone calls it', () => {
  const callers = sources().filter(({ text }: any) => /\.act\s*\(/.test(text)).map(({ name }: any) => name);
  assert.deepEqual(callers, ['actions.ts']);
  const definers = sources().filter(({ text }: any) => /function\s+act\s*\(/.test(text)).map(({ name }: any) => name);
  assert.deepEqual(definers, ['verb-runner.ts']);
  // And no Console module but the runner spawns a process.
  const spawners = sources().filter(({ text }: any) => /require\(\s*['"](?:node:)?child_process['"]\s*\)/.test(text)).map(({ name }: any) => name);
  assert.deepEqual(spawners, ['verb-runner.ts']);
});

/**
 * AC-1: the Console writes no state file. The declared writers are lan-store.ts (the device store, 160), lan-cert.ts
 * (the LAN certificate, 160) and action-log.ts (the action log, 162 D10). Every other module reaches node:fs only as
 * `const fs = require('node:fs')` (no alias or destructuring the scan could miss), calls none of fs's writing or
 * removing functions, and opens a file only read-only (static.ts's O_RDONLY | O_NOFOLLOW open is the one such call).
 */
test('AC-1: no console/src file other than lan-store.ts, lan-cert.ts and action-log.ts opens, writes, renames, copies or removes a file', () => {
  const WRITERS = ['lan-store.ts', 'lan-cert.ts', 'action-log.ts'];
  const writing = /\b(?:fs|promises)\s*\.\s*(?:writeFile|appendFile|createWriteStream|rename|copyFile|cp|truncate|ftruncate|unlink|rm|rmdir|mkdir|mkdtemp|chmod|chown|symlink|link|utimes|write|writev)(?:Sync)?\s*\(/;
  const opening = /\b(?:fs|promises)\s*\.\s*open(?:Sync)?\s*\(([^\n]*)/g;
  const writeFlag = /O_WRONLY|O_RDWR|O_APPEND|O_CREAT|O_TRUNC|['"][rwa]\+|['"][wa]x?['"]/;
  const others = sources().filter(({ name }: any) => !WRITERS.includes(name));
  assert.ok(others.length >= 20, `scanned ${others.length} modules`);
  for (const { name, text } of others) {
    const fsRequires = text.match(/require\(\s*['"](?:node:)?fs(?:\/promises)?['"]\s*\)/g) ?? [];
    const plain = text.match(/const fs = require\('node:fs'\);/g) ?? [];
    assert.equal(fsRequires.length, plain.length, `${name}: node:fs is required only as \`const fs = require('node:fs')\``);
    assert.equal(writing.test(text), false, `${name} calls a writing fs function`);
    for (const match of text.matchAll(opening)) {
      assert.equal(writeFlag.test(match[1]), false, `${name}: open with a write flag: ${match[0]}`);
      assert.ok(/O_RDONLY/.test(match[1]), `${name}: an open says O_RDONLY: ${match[0]}`);
    }
  }
  assert.deepEqual(others.filter(({ text }: any) => /\b(?:fs|promises)\s*\.\s*open(?:Sync)?\s*\(/.test(text)).map(({ name }: any) => name), ['static.ts']);
});
