'use strict';

const { parse } = require('../args');
const { UsageError } = require('../errors');
const { resolveFile, readTasks } = require('../store');

const FORMATS = ['json', 'csv'];
const COLUMNS = ['id', 'title', 'createdAt', 'done'];

function csvCell(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(tasks) {
  const rows = tasks.map((task) => COLUMNS.map((column) => csvCell(task[column])).join(','));
  return `${[COLUMNS.join(','), ...rows].join('\n')}\n`;
}

function toJson(tasks) {
  return `${JSON.stringify(tasks, null, 2)}\n`;
}

function run(argv, io) {
  const { values } = parse(argv, {
    file: { type: 'string' },
    format: { type: 'string', default: 'json' },
  });
  if (!FORMATS.includes(values.format)) {
    throw new UsageError(`--format must be one of: ${FORMATS.join(', ')}`);
  }

  const tasks = readTasks(resolveFile(values.file, io));
  io.stdout.write(values.format === 'csv' ? toCsv(tasks) : toJson(tasks));
}

module.exports = { run };
