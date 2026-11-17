'use strict';

// The steer lag measure (row 170 T8b; NFR-003, design section 10): the verdict rule and the printed lines of scripts/measure-steer.ts on known
// samples, its usage errors (exit 2), and a 3-message run of the whole path (a scratch project, the real core and supervisor over
// test/helper/fake-channel-harness.ts, the real Console as a child, SSE reader, live store, the Layers project connector, the file lane's log
// stream) whose exit code must agree with its own JSON. The recorded numbers come from the script's default run, not from this test.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CORE_CLI } = require('./helpers/core-fixture.ts');
const { P50_BAR_MS, MAX_BAR_MS, DEFAULT_SAMPLES, MAX_SAMPLES, FAKE_HARNESS, MEASURE, verdict, verdictLines, report, parseFlags } = require('../scripts/measure-steer.ts');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'measure-steer.ts');
const REPO = path.resolve(__dirname, '..', '..');
const POSIX: any = { skip: process.platform === 'win32' && 'worker process control is unverified on win32' };
const fill = (n: number, ms: number) => Array.from({ length: n }, () => ms);

test('the bars are row 161\'s: p50 < 300 ms and max < 1000 ms; 12 samples by default', () => {
  assert.deepEqual([P50_BAR_MS, MAX_BAR_MS, DEFAULT_SAMPLES, MAX_SAMPLES], [300, 1000, 12, 40]);
});

test('verdict: exit 0 only when, for the reply and the turn change, p50 < 300 ms and max < 1000 ms; each is judged on its own', () => {
  const ok = verdict({ reply: fill(12, 120), turn: fill(12, 60) });
  assert.deepEqual([ok.ok, ok.exit], [true, 0]);
  assert.equal(verdict({ reply: [...fill(11, 100), 999], turn: fill(12, 100) }).exit, 0, 'a max just under the bar');
  assert.equal(verdict({ reply: [...fill(11, 100), 1000], turn: fill(12, 100) }).exit, 1, 'a max of exactly the bar fails');
  assert.equal(verdict({ reply: fill(12, 100), turn: [...fill(5, 100), ...fill(7, 300)] }).exit, 1, 'a p50 of exactly the bar fails');
  const bad = verdict({ reply: fill(12, 400), turn: fill(12, 50) });
  assert.deepEqual([bad.ok, bad.reply.ok, bad.turn.ok], [false, false, true]);
});

test('verdictLines: one line per interval with n, p50 and max against the bars, then the verdict', () => {
  const lines = verdictLines(verdict({ reply: [40, 10, 30, 20], turn: [5, 1200, 7, 6] }));
  assert.deepEqual(lines, [
    'measure-steer: reply n=4 p50 20 ms (bar < 300) max 40 ms (bar < 1000) ok',
    'measure-steer: turn  n=4 p50 6 ms (bar < 300) max 1200 ms (bar < 1000) FAIL',
    'measure-steer: verdict FAIL',
  ]);
});

test('report: the printed JSON carries the samples, the lines and the fake harness of injected samples', () => {
  const samples = { reply: [40, 10, 30, 20], turn: [5, 1200, 7, 6] };
  const out = report({ ...verdict(samples), samples, early: 1, viewFailures: 0 });
  assert.equal(out.measure, MEASURE);
  assert.deepEqual(out.harness, { fake: 'test/helper/fake-channel-harness.ts', real: false });
  assert.equal(FAKE_HARNESS, 'test/helper/fake-channel-harness.ts');
  assert.ok(fs.existsSync(path.join(REPO, FAKE_HARNESS)), 'the fake the report names exists');
  assert.deepEqual(out.reply, { samples: samples.reply, min: 10, p50: 20, p95: 40, max: 40, ok: true });
  assert.deepEqual(out.turn, { samples: samples.turn, min: 5, p50: 6, p95: 1200, max: 1200, ok: false });
  assert.deepEqual([out.ok, out.early, out.viewFailures], [false, 1, 0]);
  assert.deepEqual(out.bar, { p50Ms: P50_BAR_MS, maxMs: MAX_BAR_MS });
  assert.equal(out.lines.length, 3);
});

test('parseFlags: --samples 1 to 40 (default 12) and an absolute, existing --core', () => {
  assert.deepEqual(parseFlags(['--core', CORE_CLI]), { core: CORE_CLI, samples: 12 });
  assert.deepEqual(parseFlags(['--core', CORE_CLI, '--samples', '3']), { core: CORE_CLI, samples: 3 });
  const errors: Array<[string[], RegExp]> = [
    [['--samples', '0'], /--samples needs a whole number from 1 to 40/],
    [['--samples', '41'], /--samples needs a whole number from 1 to 40/],
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
    assert.match(run.stderr, /^measure-steer: /);
    assert.match(run.stderr, /usage: measure-steer\.ts /);
  }
});

test('the script runs over the fake channel harness and prints p50 and max of the reply and the turn change for each of its samples, and the verdict lines (3 here, 12 by default)', { ...POSIX, timeout: 180_000 }, (t: any) => {
  const run = spawnSync(process.execPath, [SCRIPT, '--core', CORE_CLI, '--samples', '3'], { encoding: 'utf8', timeout: 170_000 });
  t.diagnostic(run.stderr.split('\n').slice(-12).join('\n'));
  assert.ok(run.status === 0 || run.status === 1, `exit ${run.status}: ${run.stderr}`);
  const out = JSON.parse(run.stdout);
  assert.equal(run.status, out.ok ? 0 : 1, 'the exit code is the JSON verdict');
  assert.deepEqual(out.harness, { fake: FAKE_HARNESS, real: false }, 'the run names the fake and no real harness');
  for (const kind of ['reply', 'turn']) {
    const part = out[kind];
    assert.equal(part.samples.length, 3, `${kind}: three samples`);
    for (const ms of part.samples) assert.ok(Number.isFinite(ms) && ms >= 0, `${kind}: ${ms} ms`);
    assert.equal(part.max, Math.max(...part.samples));
    assert.equal(part.min, Math.min(...part.samples));
    assert.ok(part.min <= part.p50 && part.p50 <= part.p95 && part.p95 <= part.max, `${kind}: ordered`);
    assert.equal(part.ok, part.p50 < 300 && part.max < 1000);
  }
  assert.deepEqual(out.bar, { p50Ms: 300, maxMs: 1000 });
  assert.equal(out.percentileMethod, 'nearest rank');
  assert.equal(out.viewFailures, 0);
  // The verdict lines are on stderr as in the JSON; a reply sample is the fake's own `working on record <n>` line reaching the page, so a sample exists only when the fake ran.
  assert.equal(out.lines.length, 3);
  const lines = run.stderr.split('\n');
  for (const line of out.lines) assert.ok(lines.includes(line), `stderr holds: ${line}`);
  assert.match(out.lines[0], /^measure-steer: reply n=3 p50 [\d.]+ ms \(bar < 300\) max [\d.]+ ms \(bar < 1000\) (ok|FAIL)$/);
  assert.match(out.lines[1], /^measure-steer: turn {2}n=3 p50 [\d.]+ ms \(bar < 300\) max [\d.]+ ms \(bar < 1000\) (ok|FAIL)$/);
  assert.equal(out.lines[2], `measure-steer: verdict ${out.ok ? 'ok' : 'FAIL'}`);
  assert.equal(out.platform, process.platform);
  assert.equal(out.node, process.version);
  t.diagnostic(`reply ${out.reply.samples.join(', ')} ms; turn ${out.turn.samples.join(', ')} ms`);
});
