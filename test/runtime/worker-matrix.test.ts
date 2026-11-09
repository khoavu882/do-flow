'use strict';

// 151 A.2 (IC-003, IC-024; FR-018, FR-019, FR-025, FR-027, NFR-001, NFR-002): the read-only
// `worker-matrix` verb, called in-process. The shipped registry gives the design's worked example;
// injected registries give the not-declared fill, unrecognised statuses, the caps and `cut`, mask
// before cut with planted values placed across the cut point, the body budget and the fields that
// never reach the body. The last cases check that no process is started and no file is written.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { maskBody } = require('../../src/runtime/mask.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const {
  handleWorkerMatrixCommand, workerMatrixBody,
  MATRIX_CELLS_PER_GROUP, MATRIX_EVIDENCE_LIMIT, MATRIX_EVIDENCE_BYTES,
  MATRIX_VERIFICATION_BYTES, MATRIX_REASON_BYTES, MATRIX_BODY_BYTES,
} = require('../../src/runtime/worker/matrix.ts');

const BODY_KEYS = ['v', 'registryVersion', 'groups', 'harnesses', 'counts', 'limits'];
const HARNESS_KEYS = ['id', 'billing', 'profile', 'cells'];
const CELL_KEYS = ['status', 'declared', 'evidence', 'verification', 'verifiedOn', 'reason', 'fallback', 'cut'];
const LIMIT_KEYS = ['shown', 'notShown', 'cellsNotShown', 'cut'];
const NOT_DECLARED = { status: 'unknown', declared: false, evidence: [], verification: null, verifiedOn: null, reason: 'not-declared', fallback: null, cut: false };
const WORKER_NAMES = ['cli', 'oneShot', 'structuredOutput', 'readOnly', 'spawnDenial', 'runnableProbe', 'hooksProbe', 'guidanceProbe', 'loginProbe', 'persistentSession', 'resume', 'steering', 'isolatedEdit', 'model'];
const ORCHESTRATION_NAMES = ['spawn', 'wait', 'status', 'cancel', 'resume', 'nest'];
const NEVER_FIELDS = ['binary', 'versionArgv', 'argv', 'promptVia', 'parser', 'quotaSignals', 'protectedPaths', 'modelChecks', 'retired'];

const bytes = (text: string) => Buffer.byteLength(text, 'utf8');

/** A recorded cell; `extra` overrides or adds fields. */
const cell = (status: string, extra: any = {}) => ({
  status, evidence: [`evidence for ${status}`], verification: `verify ${status}`, verifiedOn: '2026-10-12', ...extra,
});

/** An injected registry in the loaded shape: `harnesses` and `versions.harnesses`. */
const registryOf = (harnesses: any[], extra: any = {}) => ({ harnesses, versions: { harnesses: 1 }, ...extra });
const harness = (id: string, worker: any = {}, orchestration: any = {}) => ({ id, worker: { billing: 'unknown', profile: null, ...worker }, orchestration });

const body = (registry: any) => {
  const answer = workerMatrixBody(registry);
  assert.equal(answer.exit, 0, JSON.stringify(answer.json));
  return answer.json;
};

/** Runs the handler with captured writers; restores `process.exitCode`. */
function call(options: any) {
  const out = { text: '', write(s: string) { this.text += s; } };
  const err = { text: '', write(s: string) { this.text += s; } };
  const saved = process.exitCode;
  let exit: number;
  try {
    exit = handleWorkerMatrixCommand({ ...options, stdout: out, stderr: err });
  } finally {
    process.exitCode = saved;
  }
  assert.equal(out.text.indexOf('\n'), out.text.length - 1, 'stdout is one line');
  assert.equal(out.text, `${JSON.stringify(JSON.parse(out.text))}\n`, 'the line is compact JSON');
  return { exit, out: out.text, err: err.text, json: JSON.parse(out.text) };
}

// ── The shipped registry ─────────────────────────────────────────────────────────────────────────

test('the shipped registry: 7 harnesses, 14 worker and 6 orchestration cells, the worked-example counts', () => {
  const b = body(undefined);
  assert.deepEqual(Object.keys(b), BODY_KEYS);
  assert.equal(b.v, 1);
  assert.equal(b.registryVersion, 1);
  assert.deepEqual(b.harnesses.map((h: any) => h.id), ['claude', 'codex', 'opencode', 'pi', 'copilot', 'kiro', 'antigravity']);
  assert.deepEqual(b.groups.worker, WORKER_NAMES);
  assert.deepEqual(b.groups.orchestration, ORCHESTRATION_NAMES);
  assert.deepEqual(b.counts, {
    worker: { supported: 39, unknown: 59, unsupported: 0 },
    orchestration: { supported: 23, unknown: 17, unsupported: 2 },
  });
  assert.deepEqual(b.limits, { shown: 7, notShown: 0, cellsNotShown: 0, cut: 0 });
  for (const h of b.harnesses) {
    assert.deepEqual(Object.keys(h), HARNESS_KEYS);
    assert.equal(h.billing, 'unknown');
    assert.deepEqual(Object.keys(h.cells.worker), WORKER_NAMES);
    assert.deepEqual(Object.keys(h.cells.orchestration), ORCHESTRATION_NAMES);
    for (const group of ['worker', 'orchestration']) {
      for (const c of Object.values(h.cells[group]) as any[]) {
        assert.deepEqual(Object.keys(c), CELL_KEYS);
        assert.equal(c.declared, true);
      }
    }
  }
  const pi = b.harnesses.find((h: any) => h.id === 'pi');
  assert.equal(pi.cells.orchestration.spawn.status, 'unsupported');
  const claudeCli = b.harnesses[0].cells.worker.cli;
  assert.deepEqual(claudeCli, {
    status: 'supported', declared: true,
    evidence: ['bench/inventory/coverage.json → claude --version → 2.1.287 (Claude Code)'],
    verification: 'Run `claude --version` and compare the output with bench/inventory/coverage.json.',
    verifiedOn: '2026-10-12', reason: null, fallback: null, cut: false,
  });
  const text = JSON.stringify(b);
  assert.ok(bytes(text) <= MATRIX_BODY_BYTES);
  for (const field of NEVER_FIELDS) assert.equal(text.includes(`"${field}"`), false, `${field} never appears`);
});

test('the caps are the frozen IC-003 values', () => {
  assert.deepEqual(
    [MATRIX_CELLS_PER_GROUP, MATRIX_EVIDENCE_LIMIT, MATRIX_EVIDENCE_BYTES, MATRIX_VERIFICATION_BYTES, MATRIX_REASON_BYTES, MATRIX_BODY_BYTES],
    [32, 8, 1024, 4096, 1024, 1048576],
  );
});

// ── Injected registries ──────────────────────────────────────────────────────────────────────────

test('a group name a harness does not declare is the not-declared fill; a key without a string status is no cell', () => {
  const b = body(registryOf([
    harness('alpha', { cli: cell('supported'), extraCell: cell('unsupported', { reason: 'not on this host' }), modelChecks: [] }, { spawn: cell('supported') }),
    harness('beta', { cli: cell('unknown', { reason: 'unprobed' }), extraCell: { status: 3 } }, { spawn: cell('unknown', { fallback: 'manual' }), wait: cell('supported') }),
  ]));
  assert.deepEqual(b.groups, { worker: ['cli', 'extraCell'], orchestration: ['spawn', 'wait'] });
  assert.deepEqual(b.harnesses[1].cells.worker.extraCell, NOT_DECLARED);
  assert.deepEqual(b.harnesses[0].cells.orchestration.wait, NOT_DECLARED);
  assert.equal(b.harnesses[0].cells.worker.extraCell.reason, 'not on this host');
  assert.equal(b.harnesses[1].cells.orchestration.spawn.fallback, 'manual');
  assert.deepEqual(b.counts, {
    worker: { supported: 1, unknown: 2, unsupported: 1 },
    orchestration: { supported: 2, unknown: 2, unsupported: 0 },
  });
  assert.deepEqual(b.limits, { shown: 2, notShown: 0, cellsNotShown: 0, cut: 0 });
});

test('an unrecognised status reads unknown with reason unrecognised-status; malformed fields read null', () => {
  const b = body(registryOf([harness('alpha', { billing: 'Free!', profile: 'Not An Id', cli: cell('partial', { reason: 'kept out', verifiedOn: 'yesterday', fallback: 'Manual Mode' }) })], { versions: { harnesses: -1 } }));
  const c = b.harnesses[0].cells.worker.cli;
  assert.equal(c.status, 'unknown');
  assert.equal(c.declared, true);
  assert.equal(c.reason, 'unrecognised-status');
  assert.equal(c.verifiedOn, null);
  assert.equal(c.fallback, null);
  assert.deepEqual(c.evidence, ['evidence for partial']);
  assert.equal(b.harnesses[0].billing, null);
  assert.equal(b.harnesses[0].profile, null);
  assert.equal(b.registryVersion, null);
  assert.deepEqual(b.counts.worker, { supported: 0, unknown: 1, unsupported: 0 });
});

test('nine evidence entries give eight and cut', () => {
  const nine = Array.from({ length: 9 }, (_, i) => `entry ${i}`);
  const b = body(registryOf([harness('alpha', { cli: cell('supported', { evidence: nine }), oneShot: cell('supported', { evidence: nine.slice(0, 8) }) })]));
  const { cli, oneShot } = b.harnesses[0].cells.worker;
  assert.deepEqual(cli.evidence, nine.slice(0, MATRIX_EVIDENCE_LIMIT));
  assert.equal(cli.cut, true);
  assert.equal(oneShot.evidence.length, 8);
  assert.equal(oneShot.cut, false);
  assert.equal(b.limits.cut, 1);
});

test('each text over its cap is cut at a UTF-8 character start with cut', () => {
  const euro = '€';                                                     // 3 bytes
  const straddle = `${'a'.repeat(MATRIX_EVIDENCE_BYTES - 1)}${euro}tail`; // the euro sign spans bytes 1023 to 1025
  const b = body(registryOf([harness('alpha', {
    cli: cell('supported', { evidence: [straddle, 'b'.repeat(MATRIX_EVIDENCE_BYTES), 'c'.repeat(MATRIX_EVIDENCE_BYTES + 1)] }),
    oneShot: cell('supported', { verification: 'v'.repeat(MATRIX_VERIFICATION_BYTES + 900) }),
    readOnly: cell('unknown', { reason: `${'r'.repeat(MATRIX_REASON_BYTES - 2)}${euro}${euro}` }),
    model: cell('unknown', { reason: 'r'.repeat(MATRIX_REASON_BYTES), verification: 'v'.repeat(MATRIX_VERIFICATION_BYTES) }),
  })]));
  const { cli, oneShot, readOnly, model } = b.harnesses[0].cells.worker;
  assert.equal(cli.evidence[0], 'a'.repeat(MATRIX_EVIDENCE_BYTES - 1));
  assert.equal(cli.evidence[1], 'b'.repeat(MATRIX_EVIDENCE_BYTES), 'exactly at the cap is not cut');
  assert.equal(cli.evidence[2], 'c'.repeat(MATRIX_EVIDENCE_BYTES));
  assert.equal(cli.cut, true);
  assert.equal(oneShot.verification, 'v'.repeat(MATRIX_VERIFICATION_BYTES));
  assert.equal(oneShot.cut, true);
  assert.equal(readOnly.reason, 'r'.repeat(MATRIX_REASON_BYTES - 2));
  assert.equal(readOnly.cut, true);
  assert.equal(model.cut, false, 'texts exactly at their caps are not cut');
  assert.equal(b.limits.cut, 3);
  for (const text of [...cli.evidence, oneShot.verification, readOnly.reason]) assert.equal(text.includes('\uFFFD'), false, 'no character is split');
});

/** `value` placed at byte `start` of a text of `total` bytes, padded with `z ` filler. */
function planted(value: string, start: number, total: number) {
  const pad = (n: number) => 'z '.repeat(n).slice(0, n);
  return `${pad(start - 1)} ${value} ${pad(total - start - value.length - 2)}`;
}

const PLANTS = [
  // value, its first characters no output may hold, the masked marker, the byte it starts at
  { name: 'secret', value: 'ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8', prefix: 'ghp_', marker: '<masked>', start: 1010, naiveLeaks: true },
  { name: 'email', value: 'jane.doe@example.com', prefix: 'jane', marker: '<email>', start: 1010, naiveLeaks: true },
  { name: 'ip', value: '10.20.30.40', prefix: '10.2', marker: '<ip>', start: 1018, naiveLeaks: true },
  { name: 'macOS home', value: '/Users/alicewonderland', prefix: 'alic', marker: '/Users/<masked>', start: 1005, naiveLeaks: false },
  { name: 'Linux home', value: '/home/bobbuilderman', prefix: 'bobb', marker: '/home/<masked>', start: 1008, naiveLeaks: false },
];

test('mask before cut: a planted value across the 1024-byte cut point leaves the marker and no prefix', () => {
  const evidence = PLANTS.map((p) => planted(p.value, p.start, 1500));
  for (const [i, p] of PLANTS.entries()) {
    assert.ok(p.start < MATRIX_EVIDENCE_BYTES && p.start + p.value.length > MATRIX_EVIDENCE_BYTES, `${p.name} crosses the cut point`);
    assert.equal(evidence[i].indexOf(p.value), p.start);
    // Vacuity control: cutting first and masking the piece would leave a prefix of the value.
    const naive = maskBody(Buffer.from(evidence[i]).subarray(0, MATRIX_EVIDENCE_BYTES).toString('utf8')).text;
    if (p.naiveLeaks) assert.ok(naive.includes(p.prefix), `${p.name}: cut-then-mask would leak`);
  }
  const verification = planted(PLANTS[0].value, MATRIX_VERIFICATION_BYTES - 14, 5000);
  const reason = planted(PLANTS[1].value, MATRIX_REASON_BYTES - 14, 1500);
  const b = body(registryOf([harness('alpha', { cli: cell('unknown', { evidence, verification, reason }) })]));
  const c = b.harnesses[0].cells.worker.cli;
  assert.equal(c.cut, true);
  for (const [i, p] of PLANTS.entries()) {
    assert.ok(bytes(c.evidence[i]) <= MATRIX_EVIDENCE_BYTES);
    assert.ok(c.evidence[i].includes(p.marker), `${p.name} shows its marker`);
    assert.equal(c.evidence[i].includes(p.prefix), false, `${p.name} leaves no prefix`);
  }
  assert.ok(c.verification.includes('<masked>') && !c.verification.includes('ghp_'));
  assert.ok(c.reason.includes('<email>') && !c.reason.includes('jane'));
  const text = JSON.stringify(b);
  for (const p of PLANTS) assert.equal(text.includes(p.prefix), false, `${p.name} is in no field`);
});

test('a registry over MATRIX_BODY_BYTES shows harnesses in order while the body fits and counts the rest', () => {
  const heavy = cell('supported', {
    evidence: Array.from({ length: MATRIX_EVIDENCE_LIMIT }, () => 'e '.repeat(500)),
    verification: 'v '.repeat(2000),
  });
  const worker = Object.fromEntries(WORKER_NAMES.map((name) => [name, heavy]));
  const ids = Array.from({ length: 12 }, (_, i) => `h${String(i).padStart(2, '0')}`);
  const b = body(registryOf(ids.map((id) => harness(id, worker))));
  const size = bytes(JSON.stringify(b));
  assert.ok(b.limits.shown >= 1);
  assert.ok(b.limits.notShown > 0);
  assert.equal(b.limits.shown + b.limits.notShown, ids.length);
  assert.deepEqual(b.harnesses.map((h: any) => h.id), ids.slice(0, b.limits.shown));
  assert.ok(size <= MATRIX_BODY_BYTES);
  assert.ok(size + bytes(JSON.stringify(b.harnesses[0])) > MATRIX_BODY_BYTES, 'the next harness would not fit');
  assert.deepEqual(b.counts.worker, { supported: WORKER_NAMES.length * b.limits.shown, unknown: 0, unsupported: 0 });
});

test('names past MATRIX_CELLS_PER_GROUP per group are counted in cellsNotShown', () => {
  const worker = Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`cell${i}`, cell('supported')]));
  const b = body(registryOf([harness('alpha', worker)]));
  assert.equal(b.groups.worker.length, MATRIX_CELLS_PER_GROUP);
  assert.deepEqual(b.groups.worker, Object.keys(worker).slice(0, MATRIX_CELLS_PER_GROUP));
  assert.equal(b.limits.cellsNotShown, 3);
  assert.equal(b.counts.worker.supported, MATRIX_CELLS_PER_GROUP);
});

test('every never-field planted in the registry is absent from the body', () => {
  const mark = (field: string) => `PLANTED-NEVER-${field}`;
  const loaded = cell('supported', {
    binary: mark('binary'), versionArgv: [mark('versionArgv')], argv: [mark('argv')], promptVia: mark('promptVia'),
    parser: mark('parser'), quotaSignals: { exhausted: [mark('quotaSignals')] }, protectedPaths: [mark('protectedPaths')],
    note: mark('note'),
  });
  const registry = registryOf([{
    ...harness('alpha', { cli: loaded, modelChecks: [{ id: mark('modelChecks'), argv: [mark('argv')] }] }, { spawn: { ...loaded } }),
    displayName: mark('displayName'), adapter: mark('adapter'),
  }], { retired: [{ id: mark('retired') }] });
  const text = JSON.stringify(body(registry));
  assert.equal(text.includes('PLANTED-NEVER'), false);
  for (const field of [...NEVER_FIELDS, 'note', 'displayName', 'adapter']) assert.equal(text.includes(`"${field}"`), false, `${field} never appears`);
});

// ── The command ──────────────────────────────────────────────────────────────────────────────────

test('one compact JSON line with or without --json, and nothing on stderr', () => {
  const plain = call({ json: false, flags: [], positional: [] });
  const json = call({ json: true, flags: ['--json'], positional: [] });
  assert.equal(plain.exit, 0);
  assert.equal(json.exit, 0);
  assert.equal(plain.out, json.out);
  assert.equal(plain.err, '');
  assert.deepEqual(json.json, body(undefined));
});

test('exit 2 usage for any flag but --json or a positional; exit 2 registry-invalid; one stderr line each', () => {
  const cases = [
    { flags: ['--slug'] }, { flags: ['--slug=x'] }, { flags: ['--json=1'] }, { flags: ['--json', '--json'] },
    { positional: ['claude'] }, { flags: ['--json'], positional: ['x'] },
  ];
  for (const c of cases) {
    const r = call({ json: true, flags: [], positional: [], ...c });
    assert.equal(r.exit, 2, JSON.stringify(c));
    assert.deepEqual(r.json, { v: 1, ok: false, error: 'usage' });
    assert.match(r.err, /^doflow worker-matrix: [^\n]+\n$/);
  }
  for (const registry of [null, {}, { harnesses: 'nope' }, { harnesses: [{ id: 'Bad Id' }] }, { harnesses: [null] }]) {
    const r = call({ flags: [], positional: [], registry });
    assert.equal(r.exit, 2);
    assert.deepEqual(r.json, { v: 1, ok: false, error: 'registry-invalid' });
    assert.match(r.err, /^doflow worker-matrix: [^\n]+\n$/);
    assert.deepEqual(workerMatrixBody(registry), { exit: 2, json: { v: 1, ok: false, error: 'registry-invalid' } });
  }
});

// ── Read-only ────────────────────────────────────────────────────────────────────────────────────

test('no process is started, no connection opened and no file written', (t: any) => {
  const spawned: any[] = [];
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    t.mock.method(childProcess, name, (...args: any[]) => { spawned.push([name, args[0]]); throw new Error('no process'); });
  }
  for (const name of ['connect', 'createConnection']) {
    t.mock.method(net, name, (...args: any[]) => { spawned.push([`net.${name}`, args[0]]); throw new Error('no connection'); });
  }
  const touched: any[] = [];
  for (const name of ['openSync', 'mkdirSync', 'writeFileSync', 'appendFileSync', 'renameSync', 'rmSync', 'unlinkSync', 'copyFileSync']) {
    const real = fs[name];
    t.mock.method(fs, name, (...args: any[]) => {
      if (name !== 'openSync' || (args[1] !== undefined && args[1] !== 'r')) touched.push([name, String(args[0])]);
      return real.apply(fs, args);
    });
  }
  workerMatrixBody(undefined);
  call({ json: true, flags: ['--json'], positional: [] });
  call({ flags: ['--bad'], positional: [] });
  call({ flags: [], positional: [], registry: null });
  t.mock.restoreAll();
  assert.deepEqual(spawned, []);
  assert.deepEqual(touched, []);
});

/** Every entry under `root`: path, type, size, mtime, inode and a content digest. */
function treeOf(root: string) {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const st = fs.lstatSync(full, { bigint: true });
      const digest = st.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') : '-';
      out.push(`${path.relative(root, full)} ${st.isDirectory() ? 'd' : 'f'} ${st.size} ${st.mtimeNs} ${st.ino} ${digest}`);
      if (st.isDirectory()) walk(full);
    }
  }(root));
  return out;
}

test('every read leaves the project and the install registry byte for byte unchanged, and reads no project registry', (t: any) => {
  const root = fs.realpathSync(tempDir(t, 'doflow-worker-matrix-'));
  fs.mkdirSync(path.join(root, 'core', 'registry'), { recursive: true });
  fs.writeFileSync(path.join(root, 'core', 'registry', 'harnesses.json'), JSON.stringify({ version: 1, harnesses: [{ id: 'planted-project', worker: { cli: cell('supported') } }] }));
  fs.mkdirSync(path.join(root, '.doflow', 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, '.doflow', 'state', 'probe.json'), '{"planted":"probe-record"}');
  const install = path.join(REPO_ROOT, 'core', 'registry');
  const before = { project: treeOf(root), install: treeOf(install) };
  assert.ok(before.project.length >= 5);
  const answers = [
    call({ json: true, flags: ['--json'], positional: [], cwd: root, env: { HOME: root } }),
    call({ json: false, flags: [], positional: [], cwd: root }),
    call({ flags: ['--x'], positional: [], cwd: root }),
  ];
  assert.deepEqual({ project: treeOf(root), install: treeOf(install) }, before);
  for (const a of answers) {
    assert.equal(a.out.includes('planted-project'), false);
    assert.equal(a.out.includes('probe-record'), false);
  }
});
