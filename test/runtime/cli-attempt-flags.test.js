'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('../../src/cli/index.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const BIN = path.join(REPO_ROOT, 'bin', 'doflow.js');

test('doflow --help documents --absence, --status and retrieval-plan attempt action', () => {
  const res = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.stdout.includes('--absence'), 'help must list --absence');
  assert.ok(res.stdout.includes('--status'), 'help must list --status');
  assert.ok(res.stdout.includes('attempt'), 'help must mention attempt');
  assert.match(res.stdout, /retrieval-plan:\s*declare\|report\|attempt/, 'help must list attempt action for retrieval-plan');
});

test('parseArgs parses --status into attemptStatus and --absence flag', () => {
  const parsed = parseArgs(['retrieval-plan', '--task-id', 't1', '--action', 'attempt', '--status', 'EMPTY', '--absence']);
  assert.equal(parsed.cmd, 'retrieval-plan');
  assert.equal(parsed.taskId, 't1');
  assert.equal(parsed.action, 'attempt');
  assert.equal(parsed.attemptStatus, 'EMPTY');
  assert.equal(parsed.absence, true);
});

test('parseArgs parses --status=UNREACHED inline syntax', () => {
  const parsed = parseArgs(['retrieval-plan', '--task-id', 't1', '--status=UNREACHED']);
  assert.equal(parsed.attemptStatus, 'UNREACHED');
});

// FU-8eqytg: the unknown-flag message is bounded and print-safe, and `--reason=x` is the same flag as `--reason x`.
const { tempDir } = require('../helper/tmp.ts');

function runCli(args, cwd, home) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') } });
}

test('parseArgs reads --reason=x like --reason x', () => {
  assert.equal(parseArgs(['status', '--reason=x']).reason, 'x');
  assert.equal(parseArgs(['status', '--reason', 'x']).reason, 'x');
  assert.equal(parseArgs(['followup', '--action', 'settle', '--reason=two words']).reason, 'two words');
});

test('doflow status --reason=x is not reported as an unknown flag', (t) => {
  const dir = tempDir(t, 'doflow-cli-reason-');
  const done = runCli(['status', '--reason=x'], dir, dir);
  assert.doesNotMatch(done.stderr, /unknown flag/);
  assert.equal(done.status, 0, done.stderr);
});

test('an unknown flag is reported bounded and without raw control characters', (t) => {
  const dir = tempDir(t, 'doflow-cli-unknown-');
  const long = `--nope=${'a'.repeat(300)}`;
  const longDone = runCli(['status', long], dir, dir);
  assert.equal(longDone.status, 1);
  assert.match(longDone.stderr, /unknown flag '--nope=a+/);
  assert.ok(longDone.stderr.length < 200, `message is ${longDone.stderr.length} chars`);
  const esc = runCli(['status', '--bad\u001b[31m\u0007\nflag'], dir, dir);
  assert.equal(esc.status, 1);
  assert.doesNotMatch(esc.stderr, /[\u001b\u0007]/);
  assert.equal(esc.stderr.trimEnd().split('\n').length, 1, 'one line');
  assert.match(esc.stderr, /unknown flag '--bad/);
  const dashes = runCli(['workflow', '--', 'x'], dir, dir);
  assert.match(dashes.stderr, /unknown flag '--'/);
});
