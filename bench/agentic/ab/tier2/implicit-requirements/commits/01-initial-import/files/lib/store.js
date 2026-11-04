'use strict';

const fs = require('node:fs');
const path = require('node:path');

function resolveFile(option, io) {
  return option ? path.resolve(io.cwd, option) : path.join(io.cwd, 'tasks.json');
}

function readTasks(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function writeTasks(file, tasks) {
  fs.writeFileSync(file, `${JSON.stringify(tasks, null, 2)}\n`);
}

module.exports = { resolveFile, readTasks, writeTasks };
