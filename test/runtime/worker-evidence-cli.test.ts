'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');

const REPO_ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const POSIX_ONLY: any = { skip: process.platform === 'win32' && 'the fake CLI uses a POSIX shebang' };

function project(t: any) {
  const dir = fs.realpathSync(tempDir(t, 'doflow-worker-evidence-cli-'));
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  const work = path.join(dir, 'project');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.mkdirSync(work);

  const calls = path.join(dir, 'codex-calls.log');
  fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CODEX_CALLS"
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'codex-cli 0.163.0'
  exit 0
fi
if [ "$1" = "check" ]; then
  printf '%s\\n' 'Usage: codex exec [OPTIONS] [PROMPT]'
  printf '%s\\n' 'instructions are read from stdin'
  exit 0
fi
exit 3
`, { mode: 0o755 });

  const env: any = {
    PATH: bin,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    TMPDIR: process.env.TMPDIR || '/tmp',
    FAKE_CODEX_CALLS: calls,
  };
  const cli = (...args: any[]) => spawnSync(process.execPath, [CLI, ...args], {
    cwd: work,
    env,
    encoding: 'utf8',
  });

  return { calls, cli, work };
}

function writeChecks(p: any) {
  const checks = path.join(p.work, 'checks.json');
  fs.writeFileSync(checks, JSON.stringify({
    schema: 'doflow-worker-checks-v1',
    harness: 'codex',
    binary: 'codex',
    version: { argv: ['--version'], expect: '^codex-cli \\d+\\.\\d+\\.\\d+' },
    checks: [{
      id: 'exec-help',
      argv: ['check', '--help'],
      expect: ['^Usage: codex exec \\[OPTIONS\\] \\[PROMPT\\]$', '^instructions are read from stdin$'],
      establishes: ['oneShot'],
    }],
  }, null, 2));
  return checks;
}

test('worker evidence CLI forwards --checks and --out to a real evidence run', POSIX_ONLY, (t) => {
  const p = project(t);
  const checks = writeChecks(p);
  const out = path.join(p.work, 'evidence.json');

  const result = p.cli(
    'worker', '--action', 'evidence', '--harness', 'codex',
    '--checks', checks, '--out', out, '--json',
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).establishes, ['oneShot']);
  assert.equal(fs.existsSync(out), true, 'the evidence file is written at --out');

  const record = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(record.schema, 'doflow-worker-evidence-v1');
  assert.equal(record.kind, 'cli-check');
  assert.equal(record.cliVersion, 'codex-cli 0.163.0');
  assert.deepEqual(record.establishes, ['oneShot']);
  assert.equal(record.checks.length, 1);
  assert.equal(record.checks[0].id, 'exec-help');
  assert.equal(record.checks[0].result, 'pass', 'the check expectations ran and matched');
  assert.deepEqual(fs.readFileSync(p.calls, 'utf8').trim().split(/\r?\n/), ['--version', 'check --help']);
});

test('worker evidence without --checks is refused naming --checks', POSIX_ONLY, (t) => {
  const p = project(t);
  const out = path.join(p.work, 'evidence.json');

  const result = p.cli(
    'worker', '--action', 'evidence', '--harness', 'codex', '--out', out, '--json',
  );
  assert.equal(result.status, 2, result.stderr || result.stdout);
  assert.match(result.stdout + result.stderr, /--checks/);
  assert.equal(fs.existsSync(out), false, 'a usage refusal writes no evidence file');
  assert.equal(fs.existsSync(p.calls), false, 'a usage refusal never runs the fake harness');
});

test('worker evidence still refuses unknown flags before running the harness', POSIX_ONLY, (t) => {
  const p = project(t);

  const result = p.cli('worker', '--action', 'evidence', '--unknown-worker-flag');
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, /unknown flag '--unknown-worker-flag'/);
  assert.equal(fs.existsSync(p.calls), false, 'unknown flags are rejected before the evidence action');
});
