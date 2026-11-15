'use strict';

// The Layers lag measure (feature 161 T8; IC-010, AC-8, NFR-001): the percentiles and the exit rule of
// scripts/measure-layers.ts on known samples, its usage errors (exit 2), and a 4-sample run of the whole path (fixture Console in
// --layers mode, real core, SSE reader, live store, the Layers project connector, the file lane's log stream) whose exit code
// must agree with its own JSON. The recorded numbers come from the script's full 24 + 24 run, not from this test.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CORE_CLI } = require('./helpers/core-fixture.ts');
const { P50_BAR_MS, MAX_BAR_MS, DEFAULT_SAMPLES, summarize, verdict, parseFlags } = require('../scripts/measure-layers.ts');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'measure-layers.ts');
const fill = (n: number, ms: number) => Array.from({ length: n }, () => ms);

test('summarize: p50, p95 and max by nearest rank, in any order', () => {
  const oneTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
  assert.deepEqual(summarize(oneTo(24).reverse()), { n: 24, min: 1, p50: 12, p95: 23, max: 24 });
  assert.deepEqual(summarize([7]), { n: 1, min: 7, p50: 7, p95: 7, max: 7 });
  assert.throws(() => summarize([]), /no samples/);
  assert.equal(P50_BAR_MS, 300);
  assert.equal(MAX_BAR_MS, 1000);
  assert.equal(DEFAULT_SAMPLES, 24);
});

test('verdict: exit 0 only when, for both kinds, p50 < 300 ms and max < 1000 ms', () => {
  const ok = verdict({ audit: fill(24, 120), brief: fill(24, 90) });
  assert.equal(ok.ok, true);
  assert.equal(ok.exit, 0);
  assert.equal(verdict({ audit: [...fill(23, 100), 999], brief: fill(24, 100) }).exit, 0, 'a max just under the bar');
  assert.equal(verdict({ audit: [...fill(23, 100), 1000], brief: fill(24, 100) }).exit, 1, 'a max of exactly the bar fails');
  assert.equal(verdict({ audit: fill(24, 100), brief: [...fill(11, 100), ...fill(13, 300)] }).exit, 1, 'a p50 of exactly the bar fails');
  assert.equal(verdict({ audit: fill(24, 100), brief: [...fill(13, 100), ...fill(11, 900)] }).exit, 0, 'a slow tail under the max bar is fine while p50 holds');
  const bad = verdict({ audit: fill(24, 400), brief: fill(24, 50) });
  assert.equal(bad.ok, false);
  assert.deepEqual([bad.audit.ok, bad.brief.ok], [false, true], 'each kind is judged on its own');
});

test('parseFlags: --samples 1 to 100 (default 24) and an absolute, existing --core', () => {
  assert.deepEqual(parseFlags(['--core', CORE_CLI]), { core: CORE_CLI, samples: 24 });
  assert.deepEqual(parseFlags(['--core', CORE_CLI, '--samples', '4']), { core: CORE_CLI, samples: 4 });
  const errors: Array<[string[], RegExp]> = [
    [['--samples', '0'], /--samples needs a whole number from 1 to 100/],
    [['--samples', '101'], /--samples needs a whole number from 1 to 100/],
    [['--samples', '2.5'], /--samples needs a whole number/],
    [['--samples'], /--samples needs a value/],
    [['--core', 'bin/doflow.js'], /--core must be an absolute path/],
    [['--core', path.join(path.sep, 'no', 'such', 'doflow.js')], /--core does not exist/],
    [['--appends', '20'], /unknown argument "--appends"/],
  ];
  for (const [argv, message] of errors) {
    const answer = parseFlags(argv);
    assert.ok('error' in answer, `${argv.join(' ')} is refused`);
    assert.match(answer.error, message, argv.join(' '));
  }
});

test('usage errors exit 2 with the usage line and print nothing on stdout', () => {
  for (const argv of [['--samples', '0'], ['--samples', 'many'], ['--core', 'relative.js'], ['--core'], ['--bogus']]) {
    const run = spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(run.status, 2, `${argv.join(' ')}: ${run.stderr}`);
    assert.equal(run.stdout, '', argv.join(' '));
    assert.match(run.stderr, /^measure-layers: /);
    assert.match(run.stderr, /usage: measure-layers\.ts /);
  }
});

test('the script exits 0 and prints p50, p95 and max for audit and brief over its samples (4 here, 24 by default)', { timeout: 180_000 }, (t: any) => {
  const run = spawnSync(process.execPath, [SCRIPT, '--core', CORE_CLI, '--samples', '4'], { encoding: 'utf8', timeout: 170_000 });
  t.diagnostic(run.stderr.split('\n').slice(-20).join('\n'));
  assert.ok(run.status === 0 || run.status === 1, `exit ${run.status}: ${run.stderr}`);
  const out = JSON.parse(run.stdout);
  assert.equal(run.status, out.ok ? 0 : 1, 'the exit code is the JSON verdict');
  for (const kind of ['audit', 'brief']) {
    const part = out[kind];
    assert.equal(part.samples.length, 4, `${kind}: four samples`);
    for (const ms of part.samples) assert.ok(Number.isFinite(ms) && ms >= 0, `${kind}: ${ms} ms`);
    assert.equal(part.max, Math.max(...part.samples));
    assert.equal(part.min, Math.min(...part.samples));
    assert.ok(Number.isFinite(part.p50) && Number.isFinite(part.p95), kind);
    assert.ok(part.min <= part.p50 && part.p50 <= part.p95 && part.p95 <= part.max, `${kind}: ordered`);
    assert.equal(part.ok, part.p50 < 300 && part.max < 1000);
  }
  assert.deepEqual(out.bar, { p50Ms: 300, maxMs: 1000 });
  // DEC-007: the figures and the two targets are printed with the worst case stated, not hidden. The note is read from the
  // script's output, so dropping it from the output path (not only from the constant) fails here.
  assert.equal(typeof out.worstCaseNote, 'string', 'the output states the worst case');
  assert.match(out.worstCaseNote, /watch event is lost/);
  assert.match(out.worstCaseNote, /1\.2 s/);
  assert.match(out.worstCaseNote, /300 ms/);
  assert.match(out.worstCaseNote, /1 s/);
  assert.match(out.worstCaseNote, /DEC-007/);
  assert.ok(Number.isFinite(out.audit.p50) && Number.isFinite(out.brief.max), 'the note stands in the same output as the measured figures');
  assert.equal(out.percentileMethod, 'nearest rank');
  assert.ok(Array.isArray(out.coreKinds) && ['machine', 'layers', 'file'].every((kind) => out.coreKinds.includes(kind)), `the core lists the Layers channel kinds: ${JSON.stringify(out.coreKinds)}`);
  assert.equal(out.fixtureExit, 0, 'the fixture Console stopped cleanly on SIGTERM');
  assert.equal(out.platform, process.platform);
  assert.equal(out.node, process.version);
  const lines = run.stderr.split('\n');
  for (const n of [1, 4]) {
    assert.ok(lines.includes(`fixture-console: audit ${n}`), `the fixture said audit ${n}`);
    assert.ok(lines.includes(`fixture-console: brief ${n}`), `the fixture said brief ${n}`);
  }
  t.diagnostic(`audit ${out.audit.samples.join(', ')} ms; brief ${out.brief.samples.join(', ')} ms`);
});
