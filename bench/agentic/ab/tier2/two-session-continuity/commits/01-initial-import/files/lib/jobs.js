'use strict';

const fs = require('node:fs');

function loadJobs(file) {
  const jobs = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(jobs)) throw new TypeError(`${file} must hold a list of jobs`);
  for (const job of jobs) {
    if (typeof job.name !== 'string' || typeof job.status !== 'string') {
      throw new TypeError('every job needs a name and a status');
    }
  }
  return jobs;
}

module.exports = { loadJobs };
