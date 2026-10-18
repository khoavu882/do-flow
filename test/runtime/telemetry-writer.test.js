'use strict';

// 088 A.1 (IC-001, IC-002; FR-001, FR-002; NFR-005): the telemetry switch and writer. In process
// only: every case passes its environment and its file system explicitly, so the parent's DOFLOW_*
// never leaks in. The writer is keyed on `kind` (never `verb`, ledger.ts:318), takes its field set
// per kind from the registry, writes one append per call and never throws.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { spawnSync } = require('node:child_process');
const { telemetryOff, TelemetryWriter } = require('../../src/runtime/trace/telemetry.ts');
const { resolveRunsLocation, outerProjectRoot } = require('../../src/runtime/trace/ledger.ts');

const NOW = new Date('2026-10-17T08:30:15.123Z');
const NOW_ISO = '2026-10-17T08:30:15.123Z';
const VALID = Object.freeze({ DOFLOW_RUN_ID: 'r_088-a', DOFLOW_LINEAGE_ID: 'lin_1', DOFLOW_ATTEMPT: '3' });

/** A scratch registry: the real one ships empty `fields` until the phase that writes them. */
const REGISTRY = Object.freeze({
  version: 1,
  keyPrefix: 'doflow.',
  common: ['timestamp', 'kind', 'run', 'lineage', 'attempt'],
  kinds: {
    'verify.run': {
      store: 'runs-telemetry',
      writers: ['src/runtime/trace/telemetry.ts'],
      fields: {
        verify_id: { name: 'doflow.verify.run.verify_id', class: 'T0', type: 'hex16', phase: 'P2' },
        source: { name: 'doflow.verify.run.source', class: 'T2', type: 'enum:source', phase: 'P2' },
        task: { name: 'doflow.verify.run.task', class: 'T0', type: 'token|null', phase: 'P2' },
        label: { name: 'doflow.verify.run.label', class: 'T2', type: 'token', phase: 'P2' },
        count: { name: 'doflow.verify.run.count', class: 'T1', type: 'uint', phase: 'P2' },
        delta: { name: 'doflow.verify.run.delta', class: 'T1', type: 'int', phase: 'P2' },
        trace: { name: 'doflow.verify.run.trace', class: 'T0', type: 'hex32', phase: 'P2' },
        who: { name: 'doflow.verify.run.who', class: 'T0', type: 'id', phase: 'P2' },
        at: { name: 'doflow.verify.run.at', class: 'T1', type: 'iso8601ms', phase: 'P2' },
        day: { name: 'doflow.verify.run.day', class: 'T1', type: 'date', phase: 'P2' },
      },
    },
    'verify.tier': { store: 'runs-telemetry', writers: ['src/runtime/trace/telemetry.ts'], fields: {} },
  },
  vocabularies: { source: ['verb', 'dispatch'] },
});

function project(t) {
  const root = tempDir(t, 'doflow-telemetry-writer-');
  fs.mkdirSync(path.join(root, '.doflow', 'state', 'runs'), { recursive: true });
  return { root, config: path.join(root, '.doflow'), dir: path.join(root, '.doflow', 'state', 'runs', 'telemetry') };
}

function writer(root, extra = {}) {
  return new TelemetryWriter({ registry: REGISTRY, env: { ...VALID }, now: () => NOW, start: root, ...extra });
}

function readLines(dir, name = '2026-10-17.jsonl') {
  return fs.readFileSync(path.join(dir, name), 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
}

/** Counts every call that reaches the file system, forwarding to the real one. */
function countingFs() {
  const calls = { openSync: [], mkdirSync: [] };
  const wrapped = { ...fs };
  for (const name of Object.keys(calls)) {
    wrapped[name] = (...args) => { calls[name].push(args); return fs[name](...args); };
  }
  return { fsImpl: wrapped, calls };
}

test('A.1 switch: telemetryOff is true only for the exact string off', () => {
  assert.equal(telemetryOff({ DOFLOW_TELEMETRY: 'off' }), true);
  for (const value of [undefined, '', 'OFF', 'on', '0', 'false', ' off']) {
    assert.equal(telemetryOff({ DOFLOW_TELEMETRY: value }), false, `value ${JSON.stringify(value)}`);
  }
  assert.equal(telemetryOff({}), false);
});

test('A.1 switch: telemetryOff reads process.env when no environment is given', () => {
  const saved = process.env.DOFLOW_TELEMETRY;
  try {
    process.env.DOFLOW_TELEMETRY = 'off';
    assert.equal(telemetryOff(), true);
    delete process.env.DOFLOW_TELEMETRY;
    assert.equal(telemetryOff(), false);
  } finally {
    if (saved === undefined) delete process.env.DOFLOW_TELEMETRY; else process.env.DOFLOW_TELEMETRY = saved;
  }
});

test('A.1 writer: a known key is kept, an unknown key is dropped by name, common keys lead', (t) => {
  const { root, dir } = project(t);
  writer(root).write([{ kind: 'verify.run', verify_id: '0123456789abcdef', source: 'verb', secret_command: 'rm -rf /', verb: 'x' }]);
  const [line] = readLines(dir);
  assert.deepEqual(Object.keys(line), ['timestamp', 'kind', 'run', 'lineage', 'attempt', 'verify_id', 'source']);
  assert.deepEqual(line, {
    timestamp: NOW_ISO, kind: 'verify.run', run: 'r_088-a', lineage: 'lin_1', attempt: 3, verify_id: '0123456789abcdef', source: 'verb',
  });
  assert.ok(!JSON.stringify(line).includes('rm -rf'), 'an unknown key never carries its value to disk');
});

test('A.1 writer: a value that fails its type becomes null; each type has a pass and a fail', (t) => {
  const { root, dir } = project(t);
  writer(root).write([{
    kind: 'verify.run',
    verify_id: 'NOT-HEX', source: 'elsewhere', task: 'a b', label: '../etc', count: -1, delta: 1.9, trace: 'abc', who: 'x/y', at: '2026-10-17', day: '17-10-2026',
  }, {
    kind: 'verify.run',
    verify_id: 'abcdef0123456789', source: 'dispatch', task: 'T1.2', label: 'ok:1.x', count: 7.8, delta: -4, trace: '0123456789abcdef0123456789abcdef', who: 'w_1-a', at: '2026-10-17T01:02:03.004Z', day: '2026-10-17',
  }]);
  const [bad, good] = readLines(dir);
  for (const key of ['verify_id', 'source', 'task', 'label', 'count', 'trace', 'who', 'at', 'day']) assert.equal(bad[key], null, `bad ${key}`);
  assert.equal(bad.delta, 1, 'int truncates toward zero');
  assert.deepEqual({ ...good, timestamp: undefined }, {
    timestamp: undefined, kind: 'verify.run', run: 'r_088-a', lineage: 'lin_1', attempt: 3,
    verify_id: 'abcdef0123456789', source: 'dispatch', task: 'T1.2', label: 'ok:1.x', count: 7, delta: -4,
    trace: '0123456789abcdef0123456789abcdef', who: 'w_1-a', at: '2026-10-17T01:02:03.004Z', day: '2026-10-17',
  });
});

test('A.1 writer: a non-finite or non-number value fails uint and int', (t) => {
  const { root, dir } = project(t);
  writer(root).write([{ kind: 'verify.run', count: Number.NaN, delta: Infinity }, { kind: 'verify.run', count: '5', delta: null }]);
  const [first, second] = readLines(dir);
  assert.equal(first.count, null);
  assert.equal(first.delta, null);
  assert.equal(second.count, null);
  assert.equal(second.delta, null);
});

test('A.1 writer: requires kind; a record with only verb, an unknown kind or a prototype name writes nothing', (t) => {
  const { root, dir } = project(t);
  const c = countingFs();
  writer(root, { fsImpl: c.fsImpl }).write([{ verb: 'trace' }, { kind: 'nope' }, { kind: '__proto__' }, { kind: 'constructor' }, { kind: 7 }, null, 'text', []]);
  assert.equal(c.calls.openSync.length, 0);
  assert.equal(fs.existsSync(dir), false, 'nothing was created either');
});

test('A.1 writer: a bad record is skipped and the good ones around it are written', (t) => {
  const { root, dir } = project(t);
  writer(root).write([{ kind: 'verify.tier' }, { verb: 'x' }, { kind: 'verify.run', source: 'verb' }]);
  const lines = readLines(dir);
  assert.deepEqual(lines.map((line) => line.kind), ['verify.tier', 'verify.run']);
});

test('A.1 writer: DOFLOW_TELEMETRY=off writes nothing and creates nothing', (t) => {
  const { root, dir } = project(t);
  const c = countingFs();
  writer(root, { env: { ...VALID, DOFLOW_TELEMETRY: 'off' }, fsImpl: c.fsImpl }).write([{ kind: 'verify.run', source: 'verb' }]);
  assert.equal(c.calls.openSync.length, 0);
  assert.equal(c.calls.mkdirSync.length, 0);
  assert.equal(fs.existsSync(dir), false);
});

test('A.1 writer: telemetry on when the variable is unset or anything but off', (t) => {
  const { root, dir } = project(t);
  writer(root, { env: { ...VALID, DOFLOW_TELEMETRY: 'on' } }).write([{ kind: 'verify.tier' }]);
  assert.equal(readLines(dir).length, 1);
});

test('A.1 writer: one open-and-write per call, one line per record, file named for the first record UTC date', (t) => {
  const { root, dir } = project(t);
  const c = countingFs();
  writer(root, { fsImpl: c.fsImpl }).write([
    { kind: 'verify.run', timestamp: '2026-10-17T23:59:59.999Z' },
    { kind: 'verify.tier', timestamp: '2026-10-18T00:00:00.001Z' },
    { kind: 'verify.tier' },
  ]);
  assert.equal(c.calls.openSync.length, 1);
  assert.equal(c.calls.openSync[0][0], path.join(dir, '2026-10-17.jsonl'));
  const lines = readLines(dir);
  assert.deepEqual(lines.map((line) => line.timestamp), ['2026-10-17T23:59:59.999Z', '2026-10-18T00:00:00.001Z', NOW_ISO]);
  assert.deepEqual(fs.readdirSync(dir), ['2026-10-17.jsonl']);
});

test('A.1 writer: a supplied timestamp that is not ISO with milliseconds is replaced by now()', (t) => {
  const { root, dir } = project(t);
  writer(root).write([{ kind: 'verify.tier', timestamp: 'yesterday' }, { kind: 'verify.tier', timestamp: '2026-10-17T08:30:15Z' }, { kind: 'verify.tier', timestamp: 12 }]);
  assert.deepEqual(readLines(dir).map((line) => line.timestamp), [NOW_ISO, NOW_ISO, NOW_ISO]);
});

test('A.1 writer: identity comes from the environment only, validated; run is never local', (t) => {
  const { root, dir } = project(t);
  const cases = [
    [{ DOFLOW_RUN_ID: 'local', DOFLOW_LINEAGE_ID: 'lin_1', DOFLOW_ATTEMPT: '1' }, { run: null, lineage: 'lin_1', attempt: 1 }],
    [{ DOFLOW_RUN_ID: 'bad run', DOFLOW_LINEAGE_ID: '-x', DOFLOW_ATTEMPT: '0' }, { run: null, lineage: null, attempt: null }],
    [{ DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'l1', DOFLOW_ATTEMPT: '12345' }, { run: 'r1', lineage: 'l1', attempt: null }],
    [{}, { run: null, lineage: null, attempt: null }],
  ];
  for (const [env] of cases) writer(root, { env }).write([{ kind: 'verify.tier', run: 'smuggled', lineage: 'smuggled', attempt: 9 }]);
  const lines = readLines(dir);
  cases.forEach(([, expected], index) => {
    assert.equal(lines[index].run, expected.run, `case ${index} run`);
    assert.equal(lines[index].lineage, expected.lineage, `case ${index} lineage`);
    assert.equal(lines[index].attempt, expected.attempt, `case ${index} attempt`);
  });
});

test('A.1 writer: resolves the config by walking up from start, and DOFLOW_CONFIG_DIR wins', (t) => {
  const { root, dir } = project(t);
  const nested = path.join(root, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });
  writer(nested).write([{ kind: 'verify.tier' }]);
  assert.equal(readLines(dir).length, 1, 'found the project .doflow above the start');

  const other = tempDir(t, 'doflow-telemetry-writer-cfg-');
  fs.mkdirSync(path.join(other, 'state', 'runs'), { recursive: true });
  writer(nested, { env: { ...VALID, DOFLOW_CONFIG_DIR: other } }).write([{ kind: 'verify.tier' }]);
  assert.equal(readLines(path.join(other, 'state', 'runs', 'telemetry')).length, 1);
  assert.equal(readLines(dir).length, 1, 'the project store did not grow');
});

test('N3: A.1 block: resolveRunsLocation and outerProjectRoot map <W> to <P>; a flat project is unchanged', (t) => {
  const scratch = tempDir(t, 'doflow-telemetry-writer-n3-');
  const env = {
    HOME: path.join(scratch, 'home'),
    XDG_CONFIG_HOME: path.join(scratch, 'xdg'),
  };
  delete env.DOFLOW_CONFIG_DIR;
  fs.mkdirSync(env.HOME, { recursive: true });
  fs.mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });

  const P = tempDir(t, 'doflow-telemetry-writer-p-');
  const W = path.join(P, '.doflow', 'state', 'dispatch-worktrees', 'd-000000000001');
  fs.mkdirSync(path.join(P, '.doflow', 'state', 'runs'), { recursive: true });
  fs.mkdirSync(path.join(W, '.doflow', 'state', 'delivery'), { recursive: true });
  fs.writeFileSync(path.join(W, '.doflow', 'state', 'delivery', 'A.1.json'), '{}');

  // map <W> to <P>
  const locW = resolveRunsLocation({ start: W, env });
  assert.equal(locW.configDir, path.join(P, '.doflow'));
  assert.equal(locW.origin, 'project');
  assert.equal(outerProjectRoot(W), P);

  // a flat project is unchanged
  const locP = resolveRunsLocation({ start: P, env });
  assert.equal(locP.configDir, path.join(P, '.doflow'));
  assert.equal(locP.origin, 'project');
  assert.equal(outerProjectRoot(P), P);
});

test('F4: outerProjectRoot handles drive root, POSIX root, and normal paths', () => {
  // Drive root preserves trailing separator (C:\, not drive-relative C:)
  assert.equal(outerProjectRoot('C:\\.doflow\\x'), 'C:\\');
  assert.equal(outerProjectRoot('C:\\.doflow'), 'C:\\');
  assert.equal(outerProjectRoot('d:\\.doflow\\state'), 'd:\\');
  assert.equal(outerProjectRoot('C:/.doflow/x'), 'C:/');

  // POSIX root preserves '/'
  assert.equal(outerProjectRoot('/.doflow/x'), '/');
  assert.equal(outerProjectRoot('/.doflow'), '/');
  assert.equal(outerProjectRoot('/.doflow/state/runs'), '/');

  // Normal paths
  assert.equal(outerProjectRoot('/Users/user/project/.doflow/state/dispatch-worktrees/d-1'), '/Users/user/project');
  assert.equal(outerProjectRoot('/Users/user/project'), '/Users/user/project');
  assert.equal(outerProjectRoot('C:\\Users\\user\\project\\.doflow\\state'), 'C:\\Users\\user\\project');
});

test('A.1 writer: creates only telemetry/, non-recursively, and only when state/runs exists', (t) => {
  const root = tempDir(t, 'doflow-telemetry-writer-bare-');
  fs.mkdirSync(path.join(root, '.doflow', 'state'), { recursive: true });
  const c = countingFs();
  writer(root, { fsImpl: c.fsImpl }).write([{ kind: 'verify.tier' }]);
  assert.equal(fs.existsSync(path.join(root, '.doflow', 'state', 'runs')), false, 'no runs/ was invented');
  assert.equal(c.calls.openSync.length, 0);

  const { root: ready, dir } = project(t);
  const d = countingFs();
  writer(ready, { fsImpl: d.fsImpl }).write([{ kind: 'verify.tier' }]);
  assert.equal(d.calls.mkdirSync.length, 1);
  assert.equal(d.calls.mkdirSync[0][0], dir);
  assert.notEqual(d.calls.mkdirSync[0][1] && d.calls.mkdirSync[0][1].recursive, true);
  assert.equal(readLines(dir).length, 1);
});

test('A.1 writer: never throws on an unwritable directory, a directory as target, or a throwing file system', (t) => {
  const { root, dir } = project(t);
  fs.mkdirSync(path.join(dir, '2026-10-17.jsonl'), { recursive: true }); // the target is a directory
  assert.doesNotThrow(() => writer(root).write([{ kind: 'verify.tier' }]));

  const locked = project(t);
  fs.mkdirSync(locked.dir);
  fs.chmodSync(locked.dir, 0o500);
  assert.doesNotThrow(() => writer(locked.root).write([{ kind: 'verify.tier' }]));
  fs.chmodSync(locked.dir, 0o700);

  const boom = new Proxy(fs, { get() { return () => { throw new Error('disk gone'); }; } });
  assert.doesNotThrow(() => writer(root, { fsImpl: boom }).write([{ kind: 'verify.tier' }]));
});

test('A.1 writer: never throws on hostile input', (t) => {
  const { root } = project(t);
  const hostile = [undefined, null, 5, 'x', {}, [null], [{ kind: 'verify.tier', count: 10n }],
    [{ get kind() { throw new Error('getter'); } }], [Object.create(null)]];
  hostile.forEach((input, index) => assert.doesNotThrow(() => writer(root).write(input), `input ${index}`));
  assert.doesNotThrow(() => new TelemetryWriter({ registry: null, start: root }).write([{ kind: 'verify.tier' }]));
  assert.doesNotThrow(() => new TelemetryWriter().write([{ kind: 'nope' }]));
});

test('A.1 writer: the shipped registry is the default, kinds are declared and writes need no fields', (t) => {
  const { root, dir } = project(t);
  new TelemetryWriter({ env: { ...VALID }, now: () => NOW, start: root }).write([{ kind: 'verify.run', undeclared: 1 }]);
  const [line] = readLines(dir);
  assert.deepEqual(line, { timestamp: NOW_ISO, kind: 'verify.run', run: 'r_088-a', lineage: 'lin_1', attempt: 3 });
});

test('A.1 writer: SAFE_TOKEN is the ledger pattern, held equal by reading ledger.ts', () => {
  const { SAFE_TOKEN } = require('../../src/runtime/trace/telemetry.ts');
  const ledger = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'runtime', 'trace', 'ledger.ts'), 'utf8');
  assert.ok(ledger.includes(`const SAFE_TOKEN = ${SAFE_TOKEN};`), 'ledger.ts SAFE_TOKEN changed: update telemetry.ts');
});

test('A.1 writer: a hostile record costs only itself', (t) => {
  const { root, dir } = project(t);
  writer(root).write([{ kind: 'verify.tier' }, { get kind() { throw new Error('getter'); } }, { kind: 'verify.run', count: 2 }]);
  assert.deepEqual(readLines(dir).map((line) => line.kind), ['verify.tier', 'verify.run']);
});

// --- A.1c: a non-regular target never blocks, never throws and is never followed -----------------

const TELEMETRY_MODULE = path.join(__dirname, '..', '..', 'src', 'runtime', 'trace', 'telemetry.ts');
const POSIX = process.platform !== 'win32';

/** Runs one write in a child process that is killed after 3 s: a hang is a failure, not a stall. */
function writeInChild(root, extraEnv = {}) {
  const code = `const { TelemetryWriter } = require(${JSON.stringify(TELEMETRY_MODULE)});
new TelemetryWriter({ env: { ...process.env }, start: process.argv[1], now: () => new Date('${NOW_ISO}') }).write([{ kind: 'verify.tier' }]);`;
  return spawnSync(process.execPath, ['-e', code, root], { timeout: 3000, killSignal: 'SIGKILL', env: { ...process.env, ...extraEnv }, encoding: 'utf8' });
}

function mkfifo(file) {
  const made = spawnSync('mkfifo', [file]);
  assert.equal(made.status, 0, `mkfifo failed: ${made.stderr}`);
}

test('A.1c writer: a FIFO target with no reader returns promptly and does not hang', { skip: !POSIX }, (t) => {
  const { root, dir } = project(t);
  fs.mkdirSync(dir);
  mkfifo(path.join(dir, '2026-10-17.jsonl'));
  const result = writeInChild(root);
  assert.equal(result.error, undefined, `the child did not exit by itself: ${result.error && result.error.code}`);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
});

test('A.1c writer: a FIFO target with a reader attached is still skipped, nothing is sent down the pipe', { skip: !POSIX }, (t) => {
  const { root, dir } = project(t);
  fs.mkdirSync(dir);
  const fifo = path.join(dir, '2026-10-17.jsonl');
  mkfifo(fifo);
  const reader = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const result = writeInChild(root);
    assert.equal(result.error, undefined, `the child did not exit by itself: ${result.error && result.error.code}`);
    assert.equal(result.status, 0, result.stderr);
    let received = 0;
    try { received = fs.readSync(reader, Buffer.alloc(4096)); } catch (error) { assert.equal(error.code, 'EAGAIN'); }
    assert.equal(received, 0, 'no byte reached the reader');
  } finally {
    fs.closeSync(reader);
  }
});

test('A.1c writer: a symlink target is not followed, the file it points at is untouched', { skip: !POSIX }, (t) => {
  const { root, dir } = project(t);
  fs.mkdirSync(dir);
  const outside = path.join(tempDir(t, 'doflow-telemetry-writer-out-'), 'victim.jsonl');
  fs.writeFileSync(outside, 'keep\n');
  fs.symlinkSync(outside, path.join(dir, '2026-10-17.jsonl'));
  assert.doesNotThrow(() => writer(root).write([{ kind: 'verify.tier' }]));
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep\n');
});

test('A.1c writer: a dangling symlink target creates nothing at its destination', { skip: !POSIX }, (t) => {
  const { root, dir } = project(t);
  fs.mkdirSync(dir);
  const outside = path.join(tempDir(t, 'doflow-telemetry-writer-out-'), 'new.jsonl');
  fs.symlinkSync(outside, path.join(dir, '2026-10-17.jsonl'));
  assert.doesNotThrow(() => writer(root).write([{ kind: 'verify.tier' }]));
  assert.equal(fs.existsSync(outside), false);
});

test('A.1c writer: a directory target and an unwritable directory are skipped without a throw', (t) => {
  const dirTarget = project(t);
  fs.mkdirSync(path.join(dirTarget.dir, '2026-10-17.jsonl'), { recursive: true });
  assert.doesNotThrow(() => writer(dirTarget.root).write([{ kind: 'verify.tier' }]));
  assert.ok(fs.statSync(path.join(dirTarget.dir, '2026-10-17.jsonl')).isDirectory());
  if (!POSIX || process.getuid?.() === 0) return;
  const locked = project(t);
  fs.mkdirSync(locked.dir);
  fs.chmodSync(locked.dir, 0o500);
  try {
    assert.doesNotThrow(() => writer(locked.root).write([{ kind: 'verify.tier' }]));
    assert.deepEqual(fs.readdirSync(locked.dir), []);
  } finally {
    fs.chmodSync(locked.dir, 0o700);
  }
});

test('A.1c writer: a regular file is appended to, line after line, and a swapped-in FIFO is caught after open', (t) => {
  const { root, dir } = project(t);
  writer(root).write([{ kind: 'verify.tier' }]);
  writer(root).write([{ kind: 'verify.run' }]);
  assert.deepEqual(readLines(dir).map((line) => line.kind), ['verify.tier', 'verify.run']);

  // The race between lstat and open: lstat says "absent", open finds something that is not a file.
  const fake = { ...fs, lstatSync: () => { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error; },
    fstatSync: () => ({ isFile: () => false }) };
  const written = [];
  fake.writeSync = (...args) => { written.push(args); return 0; };
  writer(root, { fsImpl: fake }).write([{ kind: 'verify.tier' }]);
  assert.equal(written.length, 0, 'nothing is written to a descriptor that is not a regular file');
});
