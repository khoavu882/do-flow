#!/usr/bin/env node
'use strict';

const { parseArgs } = require('node:util');
const { loadJobs } = require('../lib/jobs');
const { parseDuration } = require('../lib/duration');

function render(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
  const lines = rows.map((row) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd());
  return `${lines.join('\n')}\n`;
}

function buildRows(jobs, { verbose }) {
  const header = verbose ? ['name', 'status', 'started'] : ['name', 'status'];
  const rows = jobs.map((job) => {
    const row = [job.name, job.status];
    if (verbose) row.push(job.startedAt || '-');
    return row;
  });
  return [header, ...rows];
}

function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      file: { type: 'string', default: 'jobs.json' },
      verbose: { type: 'boolean', default: false },
      'slower-than': { type: 'string' },
    },
  });

  let jobs = loadJobs(values.file);
  if (values['slower-than'] !== undefined) {
    const limit = parseDuration(values['slower-than']);
    jobs = jobs.filter((job) => job.durationMs > limit);
  }
  process.stdout.write(render(buildRows(jobs, { verbose: values.verbose })));
}

main(process.argv.slice(2));
