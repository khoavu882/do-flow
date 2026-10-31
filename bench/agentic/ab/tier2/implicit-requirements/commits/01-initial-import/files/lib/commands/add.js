'use strict';

const { parse } = require('../args');
const { UsageError } = require('../errors');
const { resolveFile, readTasks, writeTasks } = require('../store');

function run(argv, io) {
  const { values, positionals } = parse(argv, { file: { type: 'string' } });
  const title = positionals.join(' ').trim();
  if (!title) throw new UsageError('add needs a title');

  const file = resolveFile(values.file, io);
  const tasks = readTasks(file);
  const id = tasks.reduce((max, task) => Math.max(max, task.id), 0) + 1;
  tasks.push({ id, title, createdAt: new Date().toISOString(), done: false });
  writeTasks(file, tasks);
  io.stdout.write(`added #${id}\n`);
}

module.exports = { run };
