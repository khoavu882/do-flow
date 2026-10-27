'use strict';
const { bashPath } = require('../helper/bash-locator.ts');

// Feature 082 C.6 (IC-001, IC-038 wiring, DEC-032, DEC-055): the `dispatch` verb and worker's 082
// flags wired through `bin/doflow.js` and the `doflow-run` dispatcher, against the real registry.
//
// No harness binary can start (NFR-002). Every child's PATH is the scratch bin/ from
// test/helper/dispatch-sandbox.js: fake CLI links, `node`, `git`, and for the dispatcher case the
// two coreutils the dispatcher calls (dirname, date). The node directory is never on PATH
// (DEC-056). Every child sets the five DOFLOW_* identity variables through the sandbox.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeDispatchSandbox } = require('../helper/dispatch-sandbox.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const RUN = path.join(REPO_ROOT, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const SLUG = '082-dispatch-fixture';
const SKIP = process.platform === 'win32' ? 'tree cleanup is unverified on win32 (NFR-005)' : false;

function project(t: any) {
  const box = makeDispatchSandbox(t, { plan: 'dependent', slug: SLUG, systemTools: ['dirname', 'date'] });
  const spawn = (cmd: any, args: any, extraEnv: any = {}) => {
    const done = spawnSync(cmd, args, { cwd: box.root, env: { ...box.env, ...extraEnv }, encoding: 'utf8' });
    let data = null;
    try { data = JSON.parse(done.stdout); } catch { /* no JSON on stdout */ }
    return { status: done.status, stdout: done.stdout, stderr: done.stderr, data };
  };
  return {
    box,
    cli: (...args: any[]) => spawn(process.execPath, [CLI, ...args]),
    run: (...args: any[]) => spawn(bashPath(), [RUN, ...args], { DOFLOW_CLI: CLI, DOFLOW_CONFIG_DIR: path.join(box.dir, 'config') }),
  };
}

test('IC-001: dispatch --action inspect with no dispatch run exits 1 no-dispatch-run, through the CLI and the dispatcher', { skip: SKIP }, (t) => {
  const p = project(t);
  for (const [via, r] of [['cli', p.cli('dispatch', '--action', 'inspect', '--slug', SLUG, '--json')],
    ['dispatcher', p.run('dispatch', '--action', 'inspect', '--slug', SLUG, '--json')]] as [string, any][]) {
    assert.equal(r.status, 1, `${via}: ${r.stderr || r.stdout}`);
    assert.ok(r.data, `${via}: JSON on stdout: ${r.stdout}`);
    assert.equal(r.data.disposition, 'refused', via);
    assert.equal(r.data.reason, 'no-dispatch-run', via);
  }
});

test('IC-001 (SF-5(c)): the help shows --reserve-tokens as required with spawn --prompt-file', { skip: SKIP }, (t) => {
  const p = project(t);
  const r = p.cli('--help');
  assert.equal(r.status, 0, r.stderr || r.stdout);
  const line = r.stdout.split('\n').find((l: any) => l.includes('spawn: --prompt-file'));
  assert.ok(line, `a spawn line in the help: ${r.stdout}`);
  assert.match(line, /spawn: --prompt-file --reserve-tokens <n>, or --request-id;/);
  assert.doesNotMatch(line, /\[--reserve-tokens/, 'not shown as optional');
});

test('IC-001: a missing --action is exit 2', { skip: SKIP }, (t) => {
  const p = project(t);
  const r = p.cli('dispatch', '--slug', SLUG, '--json');
  assert.equal(r.status, 2, r.stderr || r.stdout);
  assert.equal(r.data?.ok, false);
  assert.equal(r.data?.error, 'usage');
});

test('IC-038: worker --action status --edit is exit 2 (the flag applies to run, describe and select)', { skip: SKIP }, (t) => {
  const p = project(t);
  const r = p.cli('worker', '--action', 'status', '--edit', '--worker-run', 'w-000000000000', '--json');
  assert.equal(r.status, 2, r.stderr || r.stdout);
  assert.match(r.stdout + r.stderr, /--edit does not apply to --action status/);
});

test('IC-038: --child-of, --request and --exec-worktree reach worker, refused for actions other than run', { skip: SKIP }, (t) => {
  const p = project(t);
  for (const [flag, value] of [['--child-of', 'w-000000000000'], ['--request', 'd-000000000000.c1'], ['--exec-worktree', p.box.root]]) {
    const r = p.cli('worker', '--action', 'status', flag, value, '--worker-run', 'w-000000000000', '--json');
    assert.equal(r.status, 2, `${flag}: ${r.stderr || r.stdout}`);
    assert.match(r.stdout + r.stderr, new RegExp(`${flag} does not apply to --action status`));
  }
});

test('IC-002: dispatch start over a graph plan, then cancel, succeed through the CLI with one line each', { skip: SKIP }, (t) => {
  const p = project(t);
  const started = p.cli('dispatch', '--action', 'start', '--slug', SLUG, '--by', 'tester');
  assert.equal(started.status, 0, started.stderr || started.stdout);
  assert.equal(started.stdout.trimEnd().split('\n').length, 1, `one line: ${started.stdout}`);
  assert.equal(started.data, null, 'no JSON without --json');

  const inspected = p.cli('dispatch', '--action', 'inspect', '--slug', SLUG, '--json');
  assert.equal(inspected.status, 0, inspected.stderr || inspected.stdout);
  assert.equal(inspected.data.disposition, 'inspected');

  const cancelled = p.cli('dispatch', '--action', 'cancel', '--slug', SLUG, '--by', 'tester', '--reason', 'test over');
  assert.equal(cancelled.status, 0, cancelled.stderr || cancelled.stdout);
  assert.equal(cancelled.stdout.trimEnd().split('\n').length, 1, `one line: ${cancelled.stdout}`);
  assert.equal(cancelled.data, null, 'no JSON without --json');
});
