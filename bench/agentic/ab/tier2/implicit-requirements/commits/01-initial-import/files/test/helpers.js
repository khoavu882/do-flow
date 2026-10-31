'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function scratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-test-'));
}

function writeTasks(dir, tasks) {
  const file = path.join(dir, 'tasks.json');
  fs.writeFileSync(file, JSON.stringify(tasks));
  return file;
}

function captureIo(cwd) {
  let out = '';
  return { io: { cwd, stdout: { write: (chunk) => { out += chunk; } } }, output: () => out };
}

module.exports = { scratchDir, writeTasks, captureIo };
