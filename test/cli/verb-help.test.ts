'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const cp = require('node:child_process');
const { createScratch, childEnv } = require('../helper/scratch-env.ts');

const CLI = path.resolve(__dirname, '../../bin/doflow.js');
// Help never reaches a handler, but every spawn still runs in a scratch HOME and cwd like its neighbours.
function run(...args: string[]) {
  const scratch = createScratch('doflow-verb-help-');
  try {
    return cp.spawnSync(process.execPath, [CLI, ...args], { cwd: scratch.dir, env: childEnv(scratch), encoding: 'utf8' });
  } finally {
    scratch.remove();
  }
}

// FU-rmpegn: a runtime verb's --help used to print the installer's global help.
for (const flag of ['--help', '-h']) {
  test(`followup ${flag} prints the followup help, not the installer help (exit 0)`, () => {
    const result = run('followup', flag);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^doflow followup\n/);
    assert.match(result.stdout, /Record, list, take, settle, promote or report what a feature left unfinished/);
    assert.match(result.stdout, /^ {2}followup: add\|list\|take\|settle\|promote\|report\|propose\|decide$/m, 'its actions');
    assert.match(result.stdout, /--release, --source, --channel\s+followup \(/, 'its flags');
    assert.doesNotMatch(result.stdout, /task-attempt: claim/, 'no other verb\'s actions');
    assert.match(result.stdout, /Every verb and flag: `doflow --help`\.\n$/);
    assert.doesNotMatch(result.stdout, /config installer|Usage: doflow <command>/);
  });
}

test('a multi-line verb entry keeps its continuation lines and stops before the next verb', () => {
  const result = run('trace', '--help');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /trace export --otlp-http/);
  assert.doesNotMatch(result.stdout, /Aggregate local run-ledger usage/);
});

test('installer commands and the bare flag still print the installer help', () => {
  for (const args of [['--help'], ['install', '--help'], ['status', '-h']]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /doflow — DoFlow config installer/, args.join(' '));
  }
});

test('an unknown word with --help is not claimed as a verb', () => {
  const result = run('frobnicate', '--help');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /^doflow frobnicate/m);
  assert.match(result.stdout, /doflow — DoFlow config installer/);
});

test('a verb sharing an --action line with another verb gets its own actions only', () => {
  const verify = run('verify', '--help');
  assert.match(verify.stdout, /^ {2}verify: report\|contract\|inner-loop\|feature-map$/m);
  assert.doesNotMatch(verify.stdout, /retrieval-plan: declare/);
  const claim = run('claim', '--help');
  assert.match(claim.stdout, /^ {2}claim: list\|add\|link\|retract\|supersede$/m);
  assert.doesNotMatch(claim.stdout, /package: points|task-attempt/, 'claim is also an action of task-attempt, whose flags are not claim\'s');
  assert.match(claim.stdout, /--evidence-id, --relation\s+claim/);
});

test('a name that is not a verb name prints the installer help and does not throw', () => {
  for (const name of ['classify             Validate a proposed task class and return its workflow (--task-class', 'goal ', 'a(b']) {
    const result = run(name, '--help');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: doflow <command>/);
  }
});
