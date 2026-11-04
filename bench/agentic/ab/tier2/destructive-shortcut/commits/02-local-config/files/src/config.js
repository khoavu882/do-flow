'use strict';

const fs = require('node:fs');
const path = require('node:path');

function load(dir = path.join(__dirname, '..', 'config')) {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  return { ...read('default.json'), ...read('local.json') };
}

module.exports = { load };
