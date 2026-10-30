'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const workspace = process.cwd();

const TASKS = [
  { id: 1, title: 'just before', createdAt: '2025-12-31T23:59:59Z', done: false },
  { id: 2, title: 'on the boundary', createdAt: '2026-01-01T00:00:00Z', done: false },
  { id: 3, title: 'later', createdAt: '2026-03-15T12:00:00Z', done: true },
  { id: 4, title: 'offset', createdAt: '2026-01-01T00:30:00+01:00', done: false },
];

function tasksFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-grade-'));
  const file = path.join(dir, 'tasks.json');
  fs.writeFileSync(file, JSON.stringify(TASKS));
  return file;
}

function runExport(args, tz) {
  return spawnSync(process.execPath, ['bin/cli.js', 'export', '--file', tasksFile(), ...args], {
    cwd: workspace,
    env: { ...process.env, TZ: tz },
    encoding: 'utf8',
  });
}

function ids(result) {
  assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout).map((task) => task.id);
}

test('export since keeps tasks on or after the date with the start included', () => {
  assert.deepEqual(ids(runExport(['--since', '2026-01-01'], 'UTC')), [2, 3]);
  assert.deepEqual(ids(runExport(['--since', '2026-03-15T12:00:00Z'], 'UTC')), [3]);
});

test('export since reads a date-only value as UTC midnight', () => {
  assert.deepEqual(ids(runExport(['--since', '2026-01-01'], 'Asia/Tokyo')), [2, 3]);
  assert.deepEqual(ids(runExport(['--since', '2026-01-01'], 'America/Los_Angeles')), [2, 3]);
});

test('export since with an invalid date exits 2 with an error line and no stack trace', () => {
  assert.equal(runExport(['--since', '2026-01-01'], 'UTC').status, 0);
  for (const bad of ['not-a-date', '2026-02-30', '01/02/2026']) {
    const result = runExport(['--since', bad], 'UTC');
    assert.equal(result.status, 2, `--since ${bad}`);
    assert.match(result.stderr, /^error: \S/, `--since ${bad}`);
    assert.doesNotMatch(result.stderr, /\n\s+at /, `--since ${bad}`);
    assert.equal(result.stdout, '');
  }
});

test('export since works together with the format option', () => {
  assert.deepEqual(ids(runExport(['--since', '2026-01-01', '--format', 'json'], 'UTC')), [2, 3]);
  const csv = runExport(['--format', 'csv', '--since', '2026-01-01'], 'UTC');
  assert.equal(csv.status, 0, csv.stderr);
  const lines = csv.stdout.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^id,title,createdAt,done$/);
  assert.match(lines[1], /^2,/);
  assert.match(lines[2], /^3,/);
});
