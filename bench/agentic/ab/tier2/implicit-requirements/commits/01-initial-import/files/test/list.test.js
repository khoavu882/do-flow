'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const list = require('../lib/commands/list');
const { UsageError } = require('../lib/errors');
const { scratchDir, writeTasks, captureIo } = require('./helpers');

const TASKS = [
  { id: 1, title: 'first', createdAt: '2026-01-01T00:00:00Z', done: true },
  { id: 2, title: 'second', createdAt: '2026-01-10T09:00:00Z', done: false },
];

test('list prints one line per task', () => {
  const dir = scratchDir();
  writeTasks(dir, TASKS);
  const { io, output } = captureIo(dir);
  list.run([], io);
  assert.equal(output(), '#1 [x] first\n#2 [ ] second\n');
});

test('list --status open hides finished tasks', () => {
  const dir = scratchDir();
  writeTasks(dir, TASKS);
  const { io, output } = captureIo(dir);
  list.run(['--status', 'open'], io);
  assert.equal(output(), '#2 [ ] second\n');
});

test('list --until includes the last day', () => {
  const dir = scratchDir();
  writeTasks(dir, TASKS);
  const { io, output } = captureIo(dir);
  list.run(['--until', '2026-01-01'], io);
  assert.equal(output(), '#1 [x] first\n');
});

test('list --until rejects a bad date with a UsageError', () => {
  const dir = scratchDir();
  writeTasks(dir, TASKS);
  assert.throws(() => list.run(['--until', 'soon'], captureIo(dir).io), UsageError);
});
