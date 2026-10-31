'use strict';

const { parse } = require('../args');
const { UsageError } = require('../errors');
const { DateError, parseDate, isWithin } = require('../dates');
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
    since: { type: 'string' },
  });
  if (!FORMATS.includes(values.format)) {
    throw new UsageError(`--format must be one of: ${FORMATS.join(', ')}`);
  }

  let since;
  if (values.since !== undefined) {
    try {
      since = parseDate(values.since);
    } catch (err) {
      if (err instanceof DateError) throw new UsageError(`--since: ${err.message}`);
      throw err;
    }
  }

  const tasks = readTasks(resolveFile(values.file, io)).filter((task) =>
    isWithin(parseDate(task.createdAt), since, undefined),
  );
  io.stdout.write(values.format === 'csv' ? toCsv(tasks) : toJson(tasks));
}

module.exports = { run };
