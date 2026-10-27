'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { shPath, withToolStubs } = require('../helper/tool-stub.ts');
const { tempDir } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { handlePackageCommand } = require('../../src/runtime/packages/command.ts');
const { fetchGrantLine, parseSource } = require('../../src/runtime/packages/source.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const NO_TMP = '/nonexistent-doflow-tmp';
const AT = '2026-10-24T09:12:03Z';

function stubDir(t: any) {
  const dir = tempDir(t, 'doflow-psource-stubs-');
  const log = path.join(dir, 'calls.log');
  for (const name of ['git', 'npm']) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> '${shPath(log)}'\nexit 1\n`);
    fs.chmodSync(file, 0o755);
  }
  return { dir, log, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim() : '') };
}

function world(t: any) {
  const root = tempDir(t, 'doflow-psource-world-');
  const projectRoot = path.join(root, 'project');
  const homeDir = path.join(root, 'home');
  const xdg = path.join(root, 'xdg');
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(homeDir);
  fs.mkdirSync(xdg);
  return { root, projectRoot, homeDir, xdg, env: { ...process.env, HOME: homeDir, XDG_CONFIG_HOME: xdg } };
}

function runRemote(w: any, source: any, stubs: any, json = true) {
  const lines: any = [];
  const savedPath = process.env.PATH;
  const savedExitCode = process.exitCode;
  try {
    process.env.PATH = `${stubs.dir}${path.delimiter}${savedPath || ''}`;
    const code = handlePackageCommand({
      action: 'add', source, json, homeDir: w.homeDir, env: { ...w.env, PATH: process.env.PATH }, projectRoot: w.projectRoot, tmpDir: NO_TMP,
      out: (line: any) => lines.push(line),
    });
    return { code, lines, body: json ? JSON.parse(lines.join('')) : null, text: lines.join('\n') };
  } finally {
    process.env.PATH = savedPath;
    process.exitCode = savedExitCode;
  }
}

function assertNoPlan(w: any) {
  assert.equal(fs.existsSync(path.join(w.homeDir, '.doflow', 'packages', 'plans')), false);
}

test('parseSource accepts local, git and npm specs and refuses bad types', () => {
  for (const [spec, source] of [
    ['/tmp/package', { type: 'local', path: '/tmp/package' }],
    ['git:https://example.org/acme.git@v1.2.0', { type: 'git', url: 'https://example.org/acme.git', ref: 'v1.2.0' }],
    ['git:https://example.org/acme.git#pkgs/acme@v1.2.0', { type: 'git', url: 'https://example.org/acme.git', ref: 'v1.2.0', path: 'pkgs/acme' }],
    ['npm:acme-pkg@^1.2.0', { type: 'npm', name: 'acme-pkg', version: '^1.2.0' }],
    ['npm:@scope/acme@1.0.0', { type: 'npm', name: '@scope/acme', version: '1.0.0' }],
  ]) assert.deepEqual(parseSource(spec), { ok: true, source });

  for (const spec of [
    'ssh://example.org/acme.git',
    'git:ssh://example.org/acme.git@v1',
    'git:http://example.org/acme.git@v1',
    'git:file:///tmp/x@v1',
    'git:https://u:p@example.org/acme.git@v1',
    'git:https://example.org/acme.git',
    'git:https://example.org/a.git#../x@v1',
    'npm:Bad Name@1',
    'npm:-x@1',
  ]) {
    const result = parseSource(spec);
    assert.equal(result.ok, false, spec);
    assert.equal(result.finding.code, 'bad-type', spec);
    if (spec.includes('u:p@')) assert.doesNotMatch(result.finding.message, /p@/);
  }
});

test('add requires an exact fetch grant and a granted spec proceeds to pinning', (t) => {
  const w = world(t);
  const stubs = stubDir(t);
  const spec = 'git:https://example.org/acme.git@v1.2.0';
  const parsed = parseSource(spec);
  assert.equal(parsed.ok, true);
  const missing = runRemote(w, spec, stubs);
  assert.equal(missing.code, 1);
  assert.equal(missing.body.error, 'grant-missing');
  const grant = JSON.parse(missing.body.grantLine);
  assert.deepEqual(grant, { grant: 'fetch', source: parsed.source, at: grant.at });
  assert.equal(grant.source.ref, 'v1.2.0');
  assertNoPlan(w);
  assert.equal(stubs.calls(), '');

  const grantFile = path.join(w.xdg, 'doflow', 'packages', 'grants.jsonl');
  fs.mkdirSync(path.dirname(grantFile), { recursive: true });
  fs.writeFileSync(grantFile, `${fetchGrantLine(parsed.source, AT)}\n`);
  const matched = runRemote(w, spec, stubs);
  assert.equal(matched.code, 1);
  assert.equal(matched.body.error, 'source-unpinned');
  assert.equal(stubs.calls(), 'git -c core.hooksPath=/dev/null -c protocol.file.allow=never ls-remote https://example.org/acme.git v1.2.0');
  assertNoPlan(w);
  fs.rmSync(stubs.log);

  fs.writeFileSync(grantFile, `${fetchGrantLine({ ...parsed.source, ref: 'v2' }, AT)}\n`);
  const otherRef = runRemote(w, spec, stubs);
  assert.equal(otherRef.code, 1);
  assert.equal(otherRef.body.error, 'grant-missing');
  assertNoPlan(w);

  for (const bad of ['ssh://example.org/acme.git', 'git:https://u:p@example.org/acme.git@v1']) {
    const refused = runRemote(w, bad, stubs);
    assert.equal(refused.code, 1);
    assert.equal(refused.body.error, 'bad-type');
    assertNoPlan(w);
  }
  assert.equal(stubs.calls(), '');
});

test('the real CLI refuses an ungranted remote spec without spawning git or npm', (t) => {
  const w = world(t);
  const stubs = stubDir(t);
  const front = `${stubs.dir}${path.delimiter}${process.env.PATH}`;
  const probe = spawnSync('git', ['--version'], { env: { ...w.env, PATH: front }, encoding: 'utf8' });
  assert.equal(probe.status, 1);
  assert.match(stubs.calls(), /^git --version/);
  fs.rmSync(stubs.log);
  const result = spawnSync(process.execPath, [CLI, 'package', '--action', 'add', '--source', 'git:https://example.org/acme.git@v1.2.0', '--json'], {
    cwd: w.projectRoot, env: withToolStubs({ ...w.env, PATH: front }), encoding: 'utf8',
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).error, 'grant-missing');
  assert.equal(stubs.calls(), '');
  assertNoPlan(w);
});
