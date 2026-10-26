'use strict';

// 120 A.4 (IC-008, IC-014): `doflow primary --action resolve`, the status line and the doctor line.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { cwdHash } = require('../../src/runtime/context/identity.ts');

const CLI = path.resolve(__dirname, '../../bin/doflow.js');
const REGISTRY = { harnesses: [{ id: 'codex', primaryProbe: { model: 'payload', status: 'verified' } }, { id: 'opencode' }] };

function setup(t: any) {
  const root = tempDir(t, 'doflow-primary-cmd-');
  const project = path.join(root, 'project');
  const config = path.join(root, 'config');
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(config, 'doflow'), { recursive: true });
  const env = { HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: config, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, GIT_CONFIG_GLOBAL: '/dev/null' };
  return { root, project, config, env };
}

function observe(f: any, harness: any, model: any, session: any) {
  const dir = path.join(f.config, 'doflow', 'session-env', 'primary', cwdHash(f.project), harness);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${session}.json`), JSON.stringify({
    schema: 1, harness, model, event: 'SessionStart', observedAt: new Date(Date.now() - 60000).toISOString(), session,
  }));
}

function cli(f: any, args: any[], extraEnv: any = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: f.project, encoding: 'utf8', env: { ...f.env, ...extraEnv } });
}

/** Runs the handler in process with an injected registry; returns the printed lines and the exit code. */
function inProcess(f: any, args: any, extraEnv: any = {}) {
  const { handlePrimaryCommand } = require('../../src/runtime/context/primary-command.ts');
  const lines: any[] = [];
  const saved = process.exitCode;
  try {
    const code = handlePrimaryCommand({
      action: 'resolve', env: { ...f.env, ...extraEnv }, cwd: f.project, out: (line: any) => lines.push(line), registry: REGISTRY, ...args,
    });
    return { code, lines, exitCode: process.exitCode };
  } finally {
    process.exitCode = saved;
  }
}

function listFiles(dir: any) {
  const out: any[] = [];
  const walk = (d: any) => {
    for (const name of fs.readdirSync(d).sort()) {
      const file = path.join(d, name);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) { out.push(`${path.relative(dir, file)}/`); walk(file); } else out.push(`${path.relative(dir, file)}:${fs.readFileSync(file, 'utf8')}`);
    }
  };
  walk(dir);
  return out;
}

test('confirmed: text prints one line per field in order, --json prints the Primary object', (t) => {
  const f = setup(t);
  const env = { DOFLOW_PRIMARY_HARNESS: 'codex', DOFLOW_PRIMARY_MODEL: 'gpt-x' };
  observe(f, 'codex', 'GPT-X', '0123456789abcdef');
  const text = inProcess(f, {}, env);
  assert.equal(text.code, 0);
  assert.equal(text.exitCode, 0);
  assert.deepEqual(text.lines.map((line) => line.split(':')[0]), ['state', 'harness', 'model', 'family', 'declared', 'observed', 'probe', 'reason']);
  assert.equal(text.lines[0], 'state: confirmed');
  assert.equal(text.lines[1], 'harness: codex');
  assert.equal(text.lines[4], 'declared: codex/gpt-x (env, model env)');
  assert.match(text.lines[5], /^observed: GPT-X \(SessionStart, \d{4}-\d\d-\d\dT[\d:.]+Z, sessions 1\)$/);
  assert.equal(text.lines[6], 'probe: payload');
  assert.equal(text.lines[7], 'reason: -');

  const json = inProcess(f, { json: true }, env);
  assert.equal(json.lines.length, 1);
  const primary = JSON.parse(json.lines[0]);
  assert.equal(primary.state, 'confirmed');
  assert.equal(primary.observed.model, 'GPT-X');
  assert.equal(primary.declared.harness, 'codex');
});

test('contradicted prints the warning line; refused exits 1', (t) => {
  const f = setup(t);
  const env = { DOFLOW_PRIMARY_HARNESS: 'codex', DOFLOW_PRIMARY_MODEL: 'gpt-x' };
  observe(f, 'codex', 'other-model', '1123456789abcdef');
  const contradicted = inProcess(f, {}, env);
  assert.equal(contradicted.code, 0);
  assert.equal(contradicted.lines[0], 'state: contradicted');
  assert.equal(contradicted.lines.at(-1), 'warning: primary-contradicted: declared gpt-x, observed other-model');
  assert.equal(JSON.parse(inProcess(f, { json: true }, env).lines[0]).state, 'contradicted');

  fs.writeFileSync(path.join(f.config, 'doflow', 'settings.json'), JSON.stringify({ schema: 1, 'primary.onContradiction': 'refuse' }));
  const refused = inProcess(f, {}, env);
  assert.equal(refused.code, 1);
  assert.equal(refused.exitCode, 1);
  assert.equal(refused.lines[0], 'state: refused');
  assert.equal(refused.lines.at(-2), 'reason: primary-contradicted');
  const refusedJson = inProcess(f, { json: true }, env);
  assert.equal(refusedJson.code, 1);
  assert.equal(JSON.parse(refusedJson.lines[0]).state, 'refused');
});

test('usage: a bad or missing action and an extra flag exit 2', (t) => {
  const f = setup(t);
  for (const action of ['bogus', undefined]) {
    const result = inProcess(f, { action });
    assert.equal(result.code, 2);
    assert.equal(result.exitCode, 2);
    assert.match(result.lines[0], /action must be resolve/);
  }
  const json = inProcess(f, { action: 'bogus', json: true });
  assert.deepEqual(JSON.parse(json.lines[0]), { ok: false, error: 'usage', message: 'action must be resolve' });

  assert.equal(cli(f, ['primary', '--action', 'bogus']).status, 2);
  assert.equal(cli(f, ['primary']).status, 2);
  assert.equal(cli(f, ['primary', '--action']).status, 2);
  assert.equal(cli(f, ['primary', '--action', 'resolve', '--bogus']).status, 2);
  assert.equal(cli(f, ['primary', '--action', 'resolve', '--kind', 'review']).status, 2);
});

test('the verb writes nothing: config home and project stay byte-identical', (t) => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.config, 'doflow', 'settings.json'), JSON.stringify({ schema: 1, 'primary.harness': 'opencode' }));
  const before = { config: listFiles(f.config), project: listFiles(f.project), root: fs.readdirSync(f.root).sort() };
  const text = cli(f, ['primary', '--action', 'resolve']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^state: declared-only\nharness: opencode\nmodel: -\n/);
  assert.match(text.stdout, /declared: opencode\/- \(user\)\n/);
  const json = cli(f, ['primary', '--action', 'resolve', '--json']);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).state, 'declared-only');
  assert.equal(cli(f, ['primary', '--action', 'resolve'], { DOFLOW_SESSION_ROLE: 'worker' }).stdout.split('\n')[0], 'state: not-primary');
  assert.deepEqual({ config: listFiles(f.config), project: listFiles(f.project), root: fs.readdirSync(f.root).sort() }, before);
});

test('status prints one primary line and --json gains primary; neither writes session-env', (t) => {
  const f = setup(t);
  const env = { DOFLOW_PRIMARY_HARNESS: 'opencode', DOFLOW_PRIMARY_MODEL: 'gem-1' };
  const text = cli(f, ['status'], env);
  assert.equal(text.status, 0, text.stderr);
  const lines = text.stdout.split('\n').filter((line: any) => /^\s*primary: /.test(line));
  assert.deepEqual(lines, ['primary: declared-only opencode/gem-1 (env)']);
  const json = JSON.parse(cli(f, ['status', '--json'], env).stdout);
  assert.equal(json.primary.state, 'declared-only');
  assert.equal(json.primary.harness, 'opencode');
  const none = cli(f, ['status']);
  assert.ok(none.stdout.split('\n').includes('primary: unknown -/- (default)'));
  assert.equal(fs.existsSync(path.join(f.config, 'doflow', 'session-env')), false);
});

test('doctor prints one primary line and --json gains primary; neither writes session-env', (t) => {
  const f = setup(t);
  const env = { DOFLOW_PRIMARY_HARNESS: 'opencode', DOFLOW_PRIMARY_MODEL: 'gem-1' };
  const text = cli(f, ['doctor'], env);
  const lines = text.stdout.split('\n').filter((line: any) => /^\s*primary: /.test(line));
  assert.deepEqual(lines, ['  primary: declared-only opencode/gem-1 (env), probe declared-only']);
  const json = JSON.parse(cli(f, ['doctor', '--json'], env).stdout);
  assert.deepEqual(json.primary, { state: 'declared-only', harness: 'opencode', model: 'gem-1', origin: 'env', probe: 'declared-only' });
  assert.equal(fs.existsSync(path.join(f.config, 'doflow', 'session-env')), false);
});
