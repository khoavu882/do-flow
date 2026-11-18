'use strict';

// Site C3: the tier, tools and report block, from the real `brief-tools` verb printed as text (no --json), in a scratch
// feature. C1 reaches the same verb with --json inside a brief; this fixture parses what the verb itself prints.

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { bashPath } = require('../../helper/bash-locator.ts');
const { feature, FEATURE, REPO } = require('./_project.ts');

/** @returns {Array<{label: string, text: string}>} the frame `brief-tools` prints. */
function build(scratch: any) {
  const f = feature(scratch, 'c3');
  const dispatcher = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
  const res = spawnSync(bashPath(), [dispatcher, 'brief-tools', '--owner', 'core-implementer', '--tier', 'frontier', '--harness', 'claude', '--slug', FEATURE, '--heading-level', '2'], {
    cwd: f.project, encoding: 'utf8', timeout: 300000, input: '', env: scratch.env({ DOFLOW_CLI: path.join(REPO, 'bin', 'doflow.js') }),
  });
  if (res.status !== 0) throw new Error(`brief-tools exited ${res.status}: ${res.stderr}`);
  return [{ label: 'brief-tools text', text: res.stdout }];
}

module.exports = { build };
