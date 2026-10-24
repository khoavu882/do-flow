'use strict';

// 088 IC-013: `bench perf measure --paired-env NAME=VALUE`. Every test drives main() with a stub
// runSurfaceFn, so nothing is timed and no surface process runs (except the one functional run of the
// new Antigravity surface at the end).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const runner = require('../../bench/perf/runner.ts');
const { tempDir } = require('../helper/tmp.ts');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REAL_BUDGETS = path.join(REPO_ROOT, 'bench', 'perf', 'budgets.json');
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const SURFACES = [
  { id: 'stub.a', kind: 'cli', argv: ['node', '-e', '0'], intentClass: 'help', enforced: false },
  { id: 'stub.b', kind: 'cli', argv: ['node', '-e', '0'], intentClass: 'verb', enforced: false },
];

/**
 * One measure run over stub surfaces. `duration(surface, n)` is the n-th (0-based) reading of that
 * variant. Returns exit code, captured output, the recorded calls and where the report landed.
 */
function measure(t, extraArgs, { duration = () => 10, surfaces = SURFACES, runs = 3, warmups = 0, seed = 7 } = {}) {
  const dir = tempDir(t, 'doflow-test-perf-paired-');
  const budgets = path.join(dir, 'budgets.json');
  const out = [];
  const err = [];
  const calls = [];
  const counts = new Map();
  const exitCode = runner.main(
    ['measure', '--runs', String(runs), '--warmups', String(warmups), '--seed', String(seed), '--budgets', budgets, ...extraArgs],
    {
      out: (m) => out.push(m),
      err: (m) => err.push(m),
      surfaces,
      pairedOutDir: dir,
      bashVersionFn: () => '3.2.57(1)-release',
      isAnotherNodeTestRunningFn: () => false,
      runSurfaceFn: (surface) => {
        const n = counts.get(surface.id) || 0;
        counts.set(surface.id, n + 1);
        calls.push({ id: surface.id, envOverlay: surface.envOverlay, setup: surface.setup });
        return duration(surface, n);
      },
    }
  );
  return { exitCode, out, err, calls, dir, budgets };
}

const PAIRED = ['--paired-env', 'DOFLOW_TELEMETRY=off'];
const pairedFiles = (dir) => fs.readdirSync(dir).filter((f) => f.startsWith('paired-'));
const reportOf = (run) => JSON.parse(run.out.join('\n'));

test('paired: each surface expands into #off and #on that join one seeded shuffle, fixed per seed', (t) => {
  const first = measure(t, PAIRED);
  assert.equal(first.exitCode, 0, first.err.join('\n'));
  assert.deepEqual(first.calls.map((c) => c.id), [
    'stub.b#off', 'stub.a#on', 'stub.b#on', 'stub.a#off',
    'stub.b#on', 'stub.a#off', 'stub.a#on', 'stub.b#off',
    'stub.b#off', 'stub.b#on', 'stub.a#off', 'stub.a#on',
  ]);
  // every round holds each variant exactly once: the variants are shuffled together, not run back to back
  for (let round = 0; round < 3; round++) {
    const ids = first.calls.slice(round * 4, round * 4 + 4).map((c) => c.id).sort();
    assert.deepEqual(ids, ['stub.a#off', 'stub.a#on', 'stub.b#off', 'stub.b#on']);
  }
  assert.deepEqual(measure(t, PAIRED).calls.map((c) => c.id), first.calls.map((c) => c.id), 'same seed, same order');
  assert.notDeepEqual(measure(t, PAIRED, { seed: 8 }).calls.map((c) => c.id), first.calls.map((c) => c.id), 'another seed reorders');

  // one setup: both variants carry the surface's own setup untouched; only the env overlay differs
  const surfaces = [{ ...SURFACES[0], setup: { kind: 'copy-fixture-project', fixture: 'x' } }];
  const withSetup = measure(t, PAIRED, { surfaces, runs: 1 });
  assert.deepEqual(withSetup.calls.map((c) => c.setup), [surfaces[0].setup, surfaces[0].setup]);
  const off = withSetup.calls.find((c) => c.id === 'stub.a#off');
  const on = withSetup.calls.find((c) => c.id === 'stub.a#on');
  assert.deepEqual(off.envOverlay, { DOFLOW_TELEMETRY: 'off' });
  assert.deepEqual(on.envOverlay, { DOFLOW_TELEMETRY: null });

  // control: without the flag nothing expands
  const plain = measure(t, []);
  assert.ok(plain.calls.every((c) => !c.id.includes('#') && c.envOverlay === undefined));
  assert.equal(plain.calls.length, 6);
});

test('paired: deltas, bounds and the NFR-003 verdict are right', (t) => {
  // stub.a: off 30, on 31.5 (delta 1.5 <= max(2, 1.5)); stub.b: off 100, on 104.9 (<= max(2, 5), p95 <= max(5, 10))
  const run = measure(t, [...PAIRED, '--json'], {
    duration: (s) => ({ 'stub.a#off': 30, 'stub.a#on': 31.5, 'stub.b#off': 100, 'stub.b#on': 104.9 })[s.id],
  });
  assert.equal(run.exitCode, 0, run.err.join('\n'));
  const report = reportOf(run);
  assert.equal(report.v, 1);
  assert.equal(report.pairedEnv, 'DOFLOW_TELEMETRY=off');
  assert.equal(report.seed, 7);
  assert.equal(report.runs, 3);
  assert.equal(report.platform, process.platform);
  assert.equal(report.node, process.version);
  assert.equal(report.bash, '3.2.57(1)-release');
  const byId = new Map(report.surfaces.map((s) => [s.id, s]));
  assert.deepEqual(byId.get('stub.a'), {
    id: 'stub.a',
    off: { p50: 30, p95: 30, n: 3 },
    on: { p50: 31.5, p95: 31.5, n: 3 },
    delta: { p50Ms: 1.5, p95Ms: 1.5, p50Pct: 5, p95Pct: 5 },
    bound: { p50Ms: 2, p95Ms: 5 },
    pass: true,
  });
  const b = byId.get('stub.b');
  assert.deepEqual(b.delta, { p50Ms: 4.9, p95Ms: 4.9, p50Pct: 4.9, p95Pct: 4.9 });
  assert.deepEqual(b.bound, { p50Ms: 5, p95Ms: 10 });
  assert.equal(b.pass, true);
  assert.deepEqual(reportOf({ out: [fs.readFileSync(path.join(run.dir, pairedFiles(run.dir)[0]), 'utf8')] }), report, 'file equals stdout');

  // negative control: #on 3 ms slower at a 30 ms p50 -> delta 3 > max(2, 1.5)
  const slow = reportOf(measure(t, [...PAIRED, '--json'], { duration: (s) => (s.id.endsWith('#on') ? 33 : 30) }));
  assert.equal(slow.surfaces[0].delta.p50Ms, 3);
  assert.equal(slow.surfaces[0].pass, false);

  // negative control: 5.1 % over a 100 ms p50 -> past max(2, 5 %)
  const pct = reportOf(measure(t, [...PAIRED, '--json'], { duration: (s) => (s.id.endsWith('#on') ? 105.1 : 100) }));
  assert.equal(pct.surfaces[0].pass, false);

  // negative control: p50 equal but a slow tail on #on (p95 +10 > max(5, 3)) fails on p95 alone
  const tail = reportOf(measure(t, [...PAIRED, '--json'], {
    runs: 10,
    duration: (s, n) => (s.id.endsWith('#on') && n === 9 ? 40 : 30),
  }));
  assert.equal(tail.surfaces[0].delta.p50Ms, 0);
  assert.equal(tail.surfaces[0].delta.p95Ms, 10);
  assert.equal(tail.surfaces[0].pass, false);

  // text output names the verdict
  const text = measure(t, PAIRED, { duration: (s) => (s.id.endsWith('#on') ? 33 : 30) });
  assert.match(text.out.join('\n'), /stub\.a\s+off p50=30 p95=30\s+on p50=33 p95=33\s+delta p50=3ms p95=3ms\s+FAIL/);
});

test('paired: a variant that fails drops its surface from the report and exits 1', (t) => {
  const run = measure(t, [...PAIRED, '--json'], {
    duration: (s) => {
      if (s.id === 'stub.a#on') throw new Error('boom');
      return 10;
    },
  });
  assert.equal(run.exitCode, 1);
  const report = reportOf(run);
  assert.deepEqual(report.surfaces.map((s) => s.id), ['stub.b']);
  assert.deepEqual(report.failed, [{ surfaceId: 'stub.a#on', reason: 'boom' }]);
});

test('paired: budgets.json is never written; the report goes to paired-<date>.json', (t) => {
  const realBefore = sha(REAL_BUDGETS);
  const dir = tempDir(t, 'doflow-test-perf-paired-budgets-');
  const budgets = path.join(dir, 'budgets.json');
  fs.writeFileSync(budgets, '{"sentinel":true}\n');
  const before = sha(budgets);
  const out = [];
  const code = runner.main(['measure', '--runs', '2', '--warmups', '0', '--budgets', budgets, ...PAIRED], {
    out: (m) => out.push(m),
    err: () => {},
    surfaces: SURFACES,
    pairedOutDir: dir,
    isAnotherNodeTestRunningFn: () => false,
    runSurfaceFn: () => 10,
  });
  assert.equal(code, 0);
  assert.equal(sha(budgets), before, 'budgets file bytes unchanged');
  assert.equal(sha(REAL_BUDGETS), realBefore, 'the repo budgets.json bytes unchanged');
  const files = pairedFiles(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^paired-\d{4}-\d{2}-\d{2}\.json$/);

  // control: the same run with --write and no paired flag does rewrite the budgets file, so the check above can fail
  const code2 = runner.main(['measure', '--runs', '2', '--warmups', '0', '--budgets', budgets, '--write'], {
    out: () => {},
    err: () => {},
    surfaces: SURFACES,
    isAnotherNodeTestRunningFn: () => false,
    runSurfaceFn: () => 10,
  });
  assert.equal(code2, 0);
  assert.notEqual(sha(budgets), before);
});

test('no --paired-env: output is byte-identical to the pre-088 runner and nothing is written', (t) => {
  const run = measure(t, [], { runs: 5, warmups: 1, duration: (s) => ({ 'stub.a': 30, 'stub.b': 12 })[s.id] });
  assert.equal(run.exitCode, 0, run.err.join('\n'));
  // reference captured from the runner at the commit before this change (same stub, same seed)
  assert.match(run.out[0], /^perf measure: 2 measured, 0 unmeasured \(redos=\d+\)$/);
  assert.deepEqual(run.out.slice(1), [
    '  stub.a                         p50=30ms p95=30ms ceiling=40ms',
    '  stub.b                         p50=12ms p95=12ms ceiling=22ms',
  ]);
  assert.equal(run.out.length, 3);
  assert.deepEqual(fs.readdirSync(run.dir), [], 'no paired report, no budgets file without --write');
  assert.deepEqual(run.calls.map((c) => c.id).filter((id, i, all) => all.indexOf(id) === i).sort(), ['stub.a', 'stub.b']);

  const json = measure(t, ['--json']);
  const parsed = reportOf(json);
  assert.deepEqual(Object.keys(parsed), ['verb', 'ok', 'exitCode', 'runs', 'warmups', 'seed', 'rows']);
  assert.deepEqual(Object.keys(parsed.rows[0]), [
    'surfaceId', 'platform', 'arch', 'machineId', 'measuredOn', 'runs', 'warmups', 'interleave', 'seed',
    'p50Ms', 'p95Ms', 'maxMs', 'madMs', 'controlP50Ms', 'redos', 'headroomMs', 'ceilingMs', 'status',
  ]);

  // control: the flag changes the output
  assert.notEqual(measure(t, PAIRED, { runs: 5, warmups: 1 }).out[0], run.out[0]);
});

test('--paired-env with --write is a usage error (exit 2) and runs nothing', (t) => {
  for (const args of [[...PAIRED, '--write'], ['--write', ...PAIRED]]) {
    const run = measure(t, args);
    assert.equal(run.exitCode, 2);
    assert.match(run.err.join('\n'), /perf measure: --paired-env never writes budgets\.json; drop --write/);
    assert.equal(run.calls.length, 0);
    assert.deepEqual(fs.readdirSync(run.dir), []);
  }
  // control: the paired flag alone is accepted (--write alone is covered by the budgets test)
  assert.equal(measure(t, PAIRED).exitCode, 0);
});

test('--paired-env needs NAME=VALUE with NAME matching [A-Z_][A-Z0-9_]*; anything else exits 2', (t) => {
  for (const bad of ['DOFLOW_TELEMETRY', 'doflow_telemetry=off', '=off', '1A=b', 'A-B=c', 'A B=c', '']) {
    const run = measure(t, ['--paired-env', bad]);
    assert.equal(run.exitCode, 2, `rejects ${JSON.stringify(bad)}`);
    assert.match(run.err.join('\n'), /--paired-env must look like NAME=VALUE|needs a value/);
    assert.equal(run.calls.length, 0);
  }
  const missing = measure(t, ['--paired-env']);
  assert.equal(missing.exitCode, 2);
  assert.match(missing.err.join('\n'), /--paired-env needs a value/);
  // control: well-formed values, an empty VALUE and an '=' inside VALUE are accepted
  for (const good of ['DOFLOW_TELEMETRY=off', '_X1=', 'A=b=c']) {
    assert.equal(measure(t, ['--paired-env', good]).exitCode, 0, `accepts ${good}`);
  }
});

test('runSurfaceProcess applies the env overlay: a string sets, null removes, absent leaves the environment alone', () => {
  const key = 'DOFLOW_PAIRED_TEST_VAR';
  const saved = process.env[key];
  process.env[key] = 'inherited';
  try {
    const envSeen = (overlay) => {
      let seen;
      runner.runSurfaceProcess(
        { id: 's', kind: 'cli', argv: ['node', '-e', '0'], intentClass: 'help', ...(overlay ? { envOverlay: overlay } : {}) },
        REPO_ROOT,
        null,
        (_cmd, _args, opts) => { seen = opts.env; return { status: 0 }; }
      );
      return seen;
    };
    assert.equal(envSeen({ [key]: 'off' })[key], 'off');
    assert.equal(Object.hasOwn(envSeen({ [key]: null }), key), false);
    assert.equal(envSeen(undefined)[key], 'inherited');
    assert.equal(envSeen({ [key]: null }).DOFLOW_QUIET, '1');
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

test('hook.antigravity.pre-bash-guard is a surface over the stream runner with a shell-command fixture, and it runs', () => {
  const { surfaces } = runner.enumerateHookSurfaces({ repoRoot: REPO_ROOT, isToolInstalledFn: () => true });
  const surface = surfaces.find((s) => s.id === 'hook.antigravity.pre-bash-guard');
  assert.ok(surface, 'surface enumerated');
  assert.deepEqual(surface.argv.slice(-2), [path.join('core', 'harnesses', 'shared', 'hooks', 'stream-hook-runner.js'), 'PreToolUse']);
  assert.equal(surface.stdinFixture, path.join('test', 'fixtures', 'hooks', 'antigravity', 'pre-bash-guard', 'perf.json'));
  assert.equal(surface.stdinField, 'native');
  const native = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, surface.stdinFixture), 'utf8')).native;
  assert.equal(native.toolCall.name, 'run_command');
  assert.equal(typeof native.toolCall.args.CommandLine, 'string');
  assert.equal(typeof runner.runSurfaceProcess(surface, REPO_ROOT), 'number');
});
