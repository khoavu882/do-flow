'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const exportCommand = require('../lib/commands/export');
const { UsageError } = require('../lib/errors');
const { scratchDir, writeTasks, captureIo } = require('./helpers');

const TASKS = [
  { id: 1, title: 'old', createdAt: '2025-12-31T23:30:00Z', done: false },
  { id: 2, title: 'edge', createdAt: '2026-01-01T00:00:00Z', done: false },
  { id: 3, title: 'new', createdAt: '2026-02-01T00:00:00Z', done: true },
];

function exportIds(args) {
  const dir = scratchDir();
  writeTasks(dir, TASKS);
  const { io, output } = captureIo(dir);
  exportCommand.run(args, io);
  return JSON.parse(output()).map((task) => task.id);
}

test('export --since includes the start date and drops earlier tasks', () => {
  assert.deepEqual(exportIds(['--since', '2026-01-01']), [2, 3]);
});

test('export --since rejects a bad date with a UsageError', () => {
  const dir = scratchDir();
  writeTasks(dir, TASKS);
  assert.throws(() => exportCommand.run(['--since', 'later'], captureIo(dir).io), UsageError);
});
