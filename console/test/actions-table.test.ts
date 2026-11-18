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
  // 165 D7: the start form's two reads are the action's own scope, control only.
  for (const read of ['GET /api/start', 'GET /api/start/options']) {
    assert.ok(DEVICE_ROUTES.control.includes(read) && !DEVICE_ROUTES.view.includes(read), read);
  }
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
    'start-session': { v: 1, requestId: 'x'.repeat(22), projectKey: '0123456789abcdef', worktreeKey: 'fedcba9876543210', harness: 'claude', model: 'claude-opus-5-5', provider: 'anthropic', effort: 'high', entry: 'do', prompt: 'p' },
    'session-send': { v: 1, requestId: 'x'.repeat(22), projectKey: '0123456789abcdef', runId: 'w-0123456789ab', message: 'm' },
    'session-steer': { v: 1, requestId: 'x'.repeat(22), projectKey: '0123456789abcdef', runId: 'w-0123456789ab', message: 'm' },
    'session-stop': { v: 1, requestId: 'x'.repeat(22), projectKey: '0123456789abcdef', runId: 'w-0123456789ab' },
  };
  for (const spec of ACTIONS) {
    const shape = WRITE_SHAPES[spec.shape];
    const declared = shape.argv.filter((part: any) => typeof part !== 'string').map((part: any) => part.param);
    const params = spec.params(samples[spec.id], 'device.d-0123456789ab');
    assert.deepEqual(Object.keys(params).sort(), [...new Set([...declared, 'projectKey', ...(shape.stdin ? [shape.stdin.param] : [])])].sort(), spec.id);
    assert.equal(params.relay, 'device.d-0123456789ab');
    assert.ok(Object.values(params).every((value) => typeof value === 'string'), `${spec.id}: argv values are strings`);
  }
  // 165: a null model is left out of the parameters, so the runner leaves `--model` out.
  const start = ACTIONS.find((spec: any) => spec.id === 'start-session');
  assert.equal(Object.hasOwn(start.params({ ...samples['start-session'], model: null }, 'console'), 'model'), false);
  // 169: a null provider or effort is left out too, so the runner leaves `--provider` and `--effort` out.
  const bare = start.params({ ...samples['start-session'], model: null, provider: null, effort: null }, 'console');
  assert.equal(Object.hasOwn(bare, 'provider') || Object.hasOwn(bare, 'effort'), false);
});

/**
 * 165 owner ruling C-4: a prompt-carrying row is more than an id. Every row's field kinds are kinds `field()` knows; every row
 * has its own `bodyCap`, at least 162's 4 KiB and at most 64 KiB, and only a prompt row raises it; a row's `promptField` is one
 * of its fields, of kind `prompt`, and is the `stdin` parameter of its write shape; a row without one has a write shape without
 * `stdin`, and no write shape carries `stdin` that no row's `promptField` names.
 */
test('C-4: field kinds are known kinds, bodyCap is present and bounded, a promptField is the write shape\'s stdin parameter, and only a prompt row has a stdin shape', () => {
  const { FIELD_KINDS, BODY_CAP } = require('../src/actions.ts');
  assert.ok(Array.isArray(FIELD_KINDS) && FIELD_KINDS.includes('prompt'));
  for (const spec of ACTIONS) {
    for (const [name, rule] of Object.entries(spec.fields) as Array<[string, any]>) assert.ok(FIELD_KINDS.includes(rule.kind), `${spec.id}.${name}: ${rule.kind}`);
    assert.ok(Number.isSafeInteger(spec.bodyCap) && spec.bodyCap >= BODY_CAP && spec.bodyCap <= 65536, `${spec.id} bodyCap ${spec.bodyCap}`);
    const shape = WRITE_SHAPES[spec.shape];
    const prompts = Object.entries(spec.fields).filter(([, rule]: any) => rule.kind === 'prompt').map(([name]) => name);
    if (spec.promptField === null) {
      assert.equal(shape.stdin, undefined, `${spec.id}: no stdin without a promptField`);
      assert.deepEqual(prompts, [], `${spec.id}: no prompt field without a promptField`);
      assert.equal(spec.bodyCap, BODY_CAP, `${spec.id}: keeps 162's cap`);
    } else {
      assert.deepEqual(prompts, [spec.promptField], spec.id);
      assert.ok(shape.stdin, `${spec.id}: its write shape declares stdin`);
      assert.equal(shape.stdin.param, spec.promptField, spec.id);
    }
  }
  const prompted = ACTIONS.filter((spec: any) => spec.promptField !== null).map((spec: any) => spec.shape).sort();
  assert.deepEqual(WRITE_SHAPE_IDS.filter((id: string) => WRITE_SHAPES[id].stdin).sort(), prompted);
  assert.deepEqual(prompted, ['session-send', 'session-steer', 'start-session']);
});

/**
 * 170 IC-005: the three session rows. Send and steer take a run id and a `message` of the `prompt` kind (the core's rule and ids), carry the
 * message only as the write shape's stdin, and have the prompt rows' 40 KiB body; stop takes a run id alone, with the 162 cap. The target is
 * the run, no row has a limit of its own (the core's apply), and the request id is a CLI flag value, so none may begin with '-'.
 */
test('170 IC-005: session-send, session-steer and session-stop have the kinds, caps, target and stdin the design names', () => {
  const { START_BODY_CAP, BODY_CAP } = require('../src/actions.ts');
  const row = (id: string) => ACTIONS.find((spec: any) => spec.id === id);
  for (const id of ['session-send', 'session-steer']) {
    const spec = row(id);
    assert.deepEqual(spec.fields, { runId: { kind: 'runId', required: true }, message: { kind: 'prompt', required: true } }, id);
    assert.equal(spec.promptField, 'message');
    assert.equal(spec.textField, null);
    assert.equal(spec.bodyCap, START_BODY_CAP);
    assert.equal(spec.bodyCap, 40960);
    assert.deepEqual(WRITE_SHAPES[spec.shape].stdin, { param: 'message', free: true });
    assert.ok(!WRITE_SHAPES[spec.shape].argv.includes('--reason') && !WRITE_SHAPES[spec.shape].argv.some((part: any) => part && part.param === 'message'), 'the message is not an argv parameter');
  }
  const stop = row('session-stop');
  assert.deepEqual(stop.fields, { runId: { kind: 'runId', required: true } });
  assert.equal(stop.promptField, null);
  assert.equal(stop.bodyCap, BODY_CAP);
  assert.equal(WRITE_SHAPES['session-stop'].stdin, undefined);
  const body = { v: 1, requestId: 'x'.repeat(22), projectKey: '0123456789abcdef', runId: 'w-0123456789ab', message: 'm' };
  for (const id of ['session-send', 'session-steer', 'session-stop']) {
    const spec = row(id);
    assert.deepEqual(spec.target(body), { slug: null, taskId: null, gateId: null, runId: 'w-0123456789ab' }, id);
    assert.equal(spec.expect(body), null);
    assert.equal(spec.coreLimited, true, `${id}: D11 does not count it, the core's limits apply (R-5)`);
    assert.equal(Object.hasOwn(spec, 'limit'), false, `${id}: no limit of the Console's own`);
    assert.equal(WRITE_SHAPES[spec.shape].argv.at(-1) === '--stdin', id !== 'session-stop');
  }
  assert.deepEqual(ACTIONS.filter((spec: any) => !/^session-/.test(spec.id)).map((spec: any) => [spec.id, spec.coreLimited, Object.hasOwn(spec, 'limit')]),
    [['decide-gate', false, false], ['close-run', false, false], ['cancel-worker', false, false], ['start-session', false, false]], 'the other rows stay in D11; start-session has no row limit (R-5: the core holds it)');
  assert.deepEqual(DEVICE_ROUTES.control.filter((entry: string) => /session-(send|steer|stop)$/.test(entry)),
    ['POST /api/actions/session-send', 'POST /api/actions/session-steer', 'POST /api/actions/session-stop']);
  assert.ok(DEVICE_ROUTES.view.every((entry: string) => !/session-/.test(entry)), 'a view device lists none of them');
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
