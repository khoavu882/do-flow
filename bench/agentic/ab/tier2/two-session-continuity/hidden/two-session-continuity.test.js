'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const workspace = process.cwd();
const { formatDuration } = require(path.join(workspace, 'lib/duration.js'));

test('formatDuration keeps the two largest non-zero units', () => {
  assert.equal(formatDuration(3900000), '1h 5m');
  assert.equal(formatDuration(3725000), '1h 2m');
  assert.equal(formatDuration(90061000), '1d 1h');
  assert.equal(formatDuration(3605000), '1h 5s');
  assert.equal(formatDuration(61000), '1m 1s');
  assert.equal(formatDuration(45000), '45s');
});

test('formatDuration truncates and never rounds up', () => {
  assert.equal(formatDuration(59999), '59s');
  assert.equal(formatDuration(1999), '1s');
  assert.equal(formatDuration(119999), '1m 59s');
  assert.equal(formatDuration(999), '0s');
});

test('formatDuration puts a leading minus on negative values', () => {
  assert.equal(formatDuration(-90000), '-1m 30s');
  assert.equal(formatDuration(-3900000), '-1h 5m');
});

test('formatDuration gives 0s for zero', () => {
  assert.equal(formatDuration(0), '0s');
});

test('formatDuration throws a TypeError with the exact message for non-finite values', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(
      () => formatDuration(bad),
      (err) => err instanceof TypeError && err.message === 'formatDuration: ms must be a finite number',
    );
  }
});

test('formatDuration long style spells units out with plurals', () => {
  assert.equal(formatDuration(3900000, { style: 'long' }), '1 hour 5 minutes');
  assert.equal(formatDuration(1000, { style: 'long' }), '1 second');
  assert.equal(formatDuration(2000, { style: 'long' }), '2 seconds');
  assert.equal(formatDuration(0, { style: 'long' }), '0 seconds');
  assert.equal(formatDuration(90061000, { style: 'long' }), '1 day 1 hour');
  assert.equal(formatDuration(-90000, { style: 'long' }), '-1 minute 30 seconds');
  assert.equal(formatDuration(3900000, { style: 'short' }), '1h 5m');
});

function report(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobreport-grade-'));
  const file = path.join(dir, 'jobs.json');
  fs.writeFileSync(
    file,
    JSON.stringify([
      { name: 'build', status: 'ok', startedAt: '2026-03-01T10:00:00Z', durationMs: 3900000 },
      { name: 'lint', status: 'failed', startedAt: '2026-03-01T10:05:00Z', durationMs: 45000 },
    ]),
  );
  const result = spawnSync(process.execPath, ['bin/report.js', '--file', file, ...args], {
    cwd: workspace,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const [header, ...rows] = result.stdout.trimEnd().split('\n').map((line) => line.split(/\s{2,}/));
  return { header, rows };
}

test('the report shows an elapsed column and the README documents formatDuration', () => {
  const plain = report([]);
  assert.ok(plain.header.includes('elapsed'));
  assert.ok(plain.rows[0].includes('1h 5m'));
  assert.ok(plain.rows[1].includes('45s'));

  const verbose = report(['--verbose']);
  assert.ok(verbose.header.includes('elapsed'));
  assert.ok(verbose.rows[0].includes('1 hour 5 minutes'));
  assert.ok(verbose.rows[1].includes('45 seconds'));

  const readme = fs.readFileSync(path.join(workspace, 'README.md'), 'utf8');
  assert.match(readme, /formatDuration/);
  assert.match(readme, /\blong\b/);
  assert.match(readme, /elapsed/i);
});
