'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const exportCommand = require('../lib/commands/export');
const { UsageError } = require('../lib/errors');
const { scratchDir, writeTasks, captureIo } = require('./helpers');

const TASKS = [
  { id: 1, title: 'plain', createdAt: '2026-01-01T00:00:00Z', done: false },
  { id: 2, title: 'with, comma', createdAt: '2026-01-02T00:00:00Z', done: true },
];

test('export writes JSON by default', () => {
  const dir = scratchDir();
  writeTasks(dir, TASKS);
  const { io, output } = captureIo(dir);
  exportCommand.run([], io);
  assert.deepEqual(JSON.parse(output()), TASKS);
});

test('export --format csv quotes cells that need it', () => {
  const dir = scratchDir();
  writeTasks(dir, TASKS);
  const { io, output } = captureIo(dir);
  exportCommand.run(['--format', 'csv'], io);
  assert.equal(
    output(),
    'id,title,createdAt,done\n1,plain,2026-01-01T00:00:00Z,false\n2,"with, comma",2026-01-02T00:00:00Z,true\n',
  );
});

test('export rejects an unknown format with a UsageError', () => {
  const dir = scratchDir();
  writeTasks(dir, TASKS);
  assert.throws(() => exportCommand.run(['--format', 'xml'], captureIo(dir).io), UsageError);
});
