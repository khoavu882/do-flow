'use strict';

// The latency measure (feature 149, E.2; NFR-001, DEC-015, DEC-049): the p95 of scripts/measure-live.ts on known samples,
// and a 3-tick smoke run of the whole path (fixture Console, real core, SSE reader, store, Run view connector, render into
// the Node element shim) with no timing bar: the recorded numbers come from the script's own run, not from this test.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CORE_CLI } = require('./helpers/core-fixture.ts');
const { tempDir } = require('../../test/helper/tmp.ts');
const { P95_BAR_MS, MIN_TICKS, p95, percentile, median, measure } = require('../scripts/measure-live.ts');

test('p95 is the nearest-rank 95th percentile of the samples, in any order', () => {
  const oneTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
  assert.equal(p95(oneTo(20)), 19, '20 samples: rank 19');
  assert.equal(p95(oneTo(100)), 95, '100 samples: rank 95');
  assert.equal(p95(oneTo(24).reverse()), 23, '24 samples: rank 23, whatever the order');
  assert.equal(p95([7]), 7);
  // Two slow ticks in 24: the p95 is the second slowest, so one outlier alone does not carry it.
  const slow = [...Array.from({ length: 22 }, () => 90), 480, 900];
  assert.equal(p95(slow), 480);
  assert.equal(p95([...slow.slice(0, 21), 510, 480, 900]), 510);
  assert.equal(percentile([5, 1, 3], 0.5), 3);
  assert.equal(percentile([5, 1, 3], 0), 1, 'p 0 is the smallest sample');
  assert.throws(() => p95([]), /no samples/);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(P95_BAR_MS, 500);
  assert.equal(MIN_TICKS, 20);
});

test('smoke: three annotate ticks of the fixture Console reach a render of the Run view through the live path', { timeout: 90_000 }, async (t: any) => {
  const scratch = tempDir(t, 'doflow-ui-measure-');
  const lines: string[] = [];
  let result: any;
  try {
    result = await measure({ core: CORE_CLI, ticks: 3, scratch, log: (line: string) => lines.push(line) });
  } catch (error) {
    t.diagnostic(lines.slice(-20).join('\n'));
    throw error;
  }
  assert.equal(result.measure, 'node-dom-shim');
  assert.equal(result.samples.length, 3);
  assert.equal(result.warmup.length, 3, 'the three state steps run first and are not samples');
  for (const ms of [...result.samples, ...result.warmup, ...result.clientMs]) assert.ok(Number.isFinite(ms) && ms >= 0, `${ms} ms`);
  assert.equal(result.clientMs.length, 3);
  assert.equal(result.p95, Math.max(...result.samples), 'three samples: the p95 is the largest');
  assert.equal(result.max, result.p95);
  assert.ok(result.min <= result.median && result.median <= result.max);
  assert.equal(result.platform, process.platform);
  assert.equal(result.node, process.version);
  assert.ok(lines.some((line) => /implementation annotated, tick 3: /.test(line)), 'the third annotate tick was measured');
  assert.deepEqual(fs.readdirSync(path.join(scratch, 'fixture')), [], 'the fixture Console removed its scratch directories');
  assert.ok(!('document' in globalThis), 'the element shim is gone from the global scope');
  t.diagnostic(`samples ${result.samples.join(', ')} ms; warmup ${result.warmup.join(', ')} ms`);
});
