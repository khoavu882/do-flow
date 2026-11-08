'use strict';

// The log lag measure (feature 150, D.2; NFR-001, IC-021): the p95 of scripts/measure-log.ts on known samples, its usage
// errors (exit 2), and a 3-append smoke run of the whole path (fixture Console in --worker-log mode, real core, SSE reader,
// store, Session view connector with R1's Log tab, log store, render into the Node element shim) with no timing bar: the
// recorded numbers come from the script's own run, not from this test. The CLI takes 20 to 24 appends; the smoke run calls
// `measure` directly with 3, as measure-live.test.ts does with ticks (the floor is the CLI's, not the function's).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CORE_CLI } = require('./helpers/core-fixture.ts');
const { tempDir } = require('../../test/helper/tmp.ts');
const { P95_BAR_MS, MIN_APPENDS, MAX_APPENDS, MEASURE, p95, percentile, median, measure, parseFlags } = require('../scripts/measure-log.ts');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'measure-log.ts');

test('p95 is the nearest-rank 95th percentile of the samples, in any order', () => {
  const oneTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
  assert.equal(p95(oneTo(20)), 19, '20 samples: rank 19');
  assert.equal(p95(oneTo(24).reverse()), 23, '24 samples: rank 23, whatever the order');
  assert.equal(p95(oneTo(100)), 95);
  assert.equal(p95([7]), 7);
  // Two slow appends in 24: the p95 is the second slowest, so one outlier alone does not carry it.
  const slow = [...Array.from({ length: 22 }, () => 260), 990, 1400];
  assert.equal(p95(slow), 990);
  assert.equal(p95([...slow.slice(0, 21), 1000, 990, 1400]), 1000, 'a p95 of exactly the bar');
  assert.equal(percentile([5, 1, 3], 0.5), 3);
  assert.equal(percentile([5, 1, 3], 0), 1, 'p 0 is the smallest sample');
  assert.throws(() => p95([]), /no samples/);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(P95_BAR_MS, 1000);
  assert.equal(MIN_APPENDS, 20);
  assert.equal(MAX_APPENDS, 24);
  assert.equal(MEASURE, 'render in a Node element shim, not a browser paint');
});

test('parseFlags: --appends 20 to 24 (default 24) and an absolute, existing --core', () => {
  assert.deepEqual(parseFlags(['--core', CORE_CLI]), { core: CORE_CLI, appends: 24 });
  assert.deepEqual(parseFlags(['--core', CORE_CLI, '--appends', '20']), { core: CORE_CLI, appends: 20 });
  const errors: Array<[string[], RegExp]> = [
    [['--appends', '19'], /--appends needs a whole number from 20 to 24/],
    [['--appends', '25'], /--appends needs a whole number from 20 to 24/],
    [['--appends', '3'], /--appends needs a whole number from 20 to 24/],
    [['--appends', '20.5'], /--appends needs a whole number/],
    [['--appends'], /--appends needs a value/],
    [['--core', 'bin/doflow.js'], /--core must be an absolute path/],
    [['--core', path.join(path.sep, 'no', 'such', 'doflow.js')], /--core does not exist/],
    [['--ticks', '20'], /unknown argument "--ticks"/],
  ];
  for (const [argv, message] of errors) {
    const answer = parseFlags(argv);
    assert.ok('error' in answer, `${argv.join(' ')} is refused`);
    assert.match(answer.error, message, argv.join(' '));
  }
});

test('usage errors exit 2 with the usage line and print nothing on stdout', () => {
  for (const argv of [['--appends', '19'], ['--appends', 'many'], ['--core', 'relative.js'], ['--core'], ['--bogus']]) {
    const run = spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(run.status, 2, `${argv.join(' ')}: ${run.stderr}`);
    assert.equal(run.stdout, '', argv.join(' '));
    assert.match(run.stderr, /^measure-log: /);
    assert.match(run.stderr, /usage: measure-log\.ts /);
  }
});

test('smoke: three appends to R1 reach a render of the stdout region of the Session view\'s Log tab', { timeout: 120_000 }, async (t: any) => {
  const scratch = tempDir(t, 'doflow-ui-measure-log-');
  const lines: string[] = [];
  let result: any;
  try {
    result = await measure({ core: CORE_CLI, appends: 3, scratch, log: (line: string) => lines.push(line) });
  } catch (error) {
    t.diagnostic(lines.slice(-30).join('\n'));
    throw error;
  }
  assert.equal(result.measure, MEASURE);
  assert.equal(result.p95Method, 'nearest rank');
  assert.equal(result.samples.length, 3);
  for (const ms of result.samples) assert.ok(Number.isFinite(ms), `${ms} ms`);
  assert.equal(result.clientMs.length, 3);
  for (const ms of result.clientMs) assert.ok(ms === null || (Number.isFinite(ms) && ms >= 0), `${ms} ms`);
  assert.equal(result.p95, Math.max(...result.samples), 'three samples: the p95 is the largest');
  assert.equal(result.max, result.p95);
  assert.ok(result.min <= result.median && result.median <= result.max);
  assert.equal(result.platform, process.platform);
  assert.equal(result.node, process.version);
  assert.equal(result.fixtureExit, 0, 'the fixture Console stopped cleanly on SIGTERM');
  for (const n of [1, 2, 3]) assert.ok(lines.includes(`fixture-console: log ${n}`), `the fixture said log ${n}`);
  assert.ok(lines.some((line) => /^measure-log: log 3: -?\d+(\.\d)? ms$/.test(line)), 'the third append was measured');
  assert.deepEqual(fs.readdirSync(path.join(scratch, 'fixture')), [], 'the fixture Console removed its scratch directories');
  assert.ok(!('document' in globalThis), 'the element shim is gone from the global scope');
  t.diagnostic(`samples ${result.samples.join(', ')} ms; client ${result.clientMs.join(', ')} ms`);
});
