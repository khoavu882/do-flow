'use strict';

const { parse } = require('../args');
const { UsageError } = require('../errors');
const { DateError, parseDate, isWithin } = require('../dates');
const { resolveFile, readTasks } = require('../store');

const STATUSES = ['open', 'done', 'all'];

function run(argv, io) {
  const { values } = parse(argv, {
    file: { type: 'string' },
    status: { type: 'string', default: 'all' },
    until: { type: 'string' },
  });
  if (!STATUSES.includes(values.status)) {
    throw new UsageError(`--status must be one of: ${STATUSES.join(', ')}`);
  }

  let until;
  if (values.until !== undefined) {
    try {
      until = parseDate(values.until);
    } catch (err) {
      if (err instanceof DateError) throw new UsageError(`--until: ${err.message}`);
      throw err;
    }
  }

  const tasks = readTasks(resolveFile(values.file, io))
    .filter((task) => values.status === 'all' || task.done === (values.status === 'done'))
    .filter((task) => isWithin(parseDate(task.createdAt), undefined, until));

  for (const task of tasks) {
    io.stdout.write(`#${task.id} [${task.done ? 'x' : ' '}] ${task.title}\n`);
  }
}

module.exports = { run };
