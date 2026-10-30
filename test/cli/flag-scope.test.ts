'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const cp = require('node:child_process');
const { createScratch, childEnv } = require('../helper/scratch-env.ts');

const CLI = path.resolve(__dirname, '../../bin/doflow.js');
// Every spawn runs in a scratch HOME, XDG folders and cwd: if the flag scoping ever regressed, `install`,
// `update` and `remove --commit` would otherwise run for real against the developer's own install.
function run(...args: string[]) {
  const scratch = createScratch('doflow-flag-scope-');
  try {
    const env = childEnv(scratch, { XDG_DATA_HOME: path.join(scratch.dir, 'xdg-data') });
    return cp.spawnSync(process.execPath, [CLI, ...args], { cwd: scratch.dir, env, encoding: 'utf8' });
  } finally {
    scratch.remove();
  }
}

// `--commit` belongs to `roadmap` alone: every other verb answers it as it answered any unknown flag in beta.7.
for (const [args, status] of [
  [['install', '--commit'], 1],
  [['update', '--commit'], 1],
  [['remove', '--commit'], 1],
  [['protocol', '--action', 'list', '--commit'], 2],
  [['config', '--commit'], 2],
  [['review', '--action', 'check', '--commit'], 2],
] as Array<[string[], number]>) {
  test(`${args.join(' ')} refuses --commit as an unknown flag (exit ${status})`, () => {
    const result = run(...args);
    assert.equal(result.status, status, result.stdout + result.stderr);
    assert.match(result.stderr, /unknown flag '--commit'/);
  });
}

test('roadmap --action init-policy --commit is still accepted', () => {
  const result = run('roadmap', '--action', 'init-policy', '--commit');
  assert.doesNotMatch(result.stderr, /unknown flag/);
});

test('roadmap --action status --commit stays the roadmap usage error, not an unknown flag', () => {
  const result = run('roadmap', '--action', 'status', '--commit');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--commit belongs to --action init-policy/);
});

// `review` is documented as exit 2 = usage (docs/reference.md), so an unknown flag must not be exit 1.
test('review --bogus is a usage error (exit 2)', () => {
  const result = run('review', '--bogus');
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /unknown flag '--bogus'/);
});
