#!/usr/bin/env node
'use strict';

/**
 * Runs `executeIteration` in its own process for the agentic executor tests (feature 097, review
 * C-1 and C-2): signals and a second concurrent executor need a real process boundary. Reads the
 * options from the JSON file named by argv[2]; the workspace export is a tiny fake tree, like the
 * in-process tests. Prints the result as one JSON line and exits with its `exit` code.
 */

const fs = require('node:fs');
const path = require('node:path');
const execute = require('../../../bench/agentic/execute.js');

function fakeMaterialise(commit, dir) {
  const treeRoot = path.join(dir, 'tree');
  fs.mkdirSync(treeRoot, { recursive: true });
  fs.writeFileSync(path.join(treeRoot, 'README.md'), `snapshot ${commit}\n`);
  return { treeRoot, cleanup() {} };
}

const opts = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
execute.executeIteration({ ...opts, materialise: fakeMaterialise }).then((result) => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.exit;
}, (e) => {
  process.stdout.write(`${JSON.stringify({ threw: e.message })}\n`);
  process.exitCode = 9;
});
