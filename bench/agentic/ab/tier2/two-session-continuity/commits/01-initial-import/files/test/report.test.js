'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const report = path.join(__dirname, '..', 'bin', 'report.js');

const JOBS = [
  { name: 'build', status: 'ok', startedAt: '2026-03-01T10:00:00Z', durationMs: 3900000 },
  { name: 'lint', status: 'failed', startedAt: '2026-03-01T10:05:00Z', durationMs: 45000 },
];

function run(args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobreport-test-'));
  const file = path.join(dir, 'jobs.json');
  fs.writeFileSync(file, JSON.stringify(JOBS));
  const result = spawnSync(process.execPath, [report, '--file', file, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trimEnd().split('\n').map((line) => line.split(/\s{2,}/));
}

test('the report lists every job with its status', () => {
  const [header, ...rows] = run([]);
  assert.deepEqual(header.slice(0, 2), ['name', 'status']);
  assert.deepEqual(rows.map((row) => row.slice(0, 2)), [['build', 'ok'], ['lint', 'failed']]);
});

test('verbose adds the started column', () => {
  const [header, first] = run(['--verbose']);
  assert.ok(header.includes('started'));
  assert.ok(first.includes('2026-03-01T10:00:00Z'));
});

test('slower-than keeps only the jobs over the limit', () => {
  const [, ...rows] = run(['--slower-than', '1m']);
  assert.deepEqual(rows.map((row) => row[0]), ['build']);
});
