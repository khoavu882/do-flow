'use strict';

// Feature 122 C.4 (IC-017, IC-009): a suspension keeps its projection marker until a write removes
// the package files, SessionStart checks recorded packages in the background, and doctor reports
// projected suspensions.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { tempDir } = require('../helper/tmp');
const { encodeEnvelope } = require('../helper/hook-fixtures');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { handlePackageCommand } = require('../../src/runtime/packages/command.ts');
const state = require('../../src/runtime/packages/state.ts');
const { handleDoctorCommand } = require('../../src/runtime/health.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const NO_TMP = path.join(path.parse(__dirname).root, 'doflow-no-such-system-tmp');
const VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
const NEXT_MAJOR = Number(VERSION.split('.')[0]) + 1;
const SKILL = `---
name: acme-triage
description: Triage incoming reports for the acme team
---

# Triage

Sort the reports by severity.
`;

function writePackage(dir) {
  fs.mkdirSync(path.join(dir, 'skills', 'acme-triage'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'acme-triage', 'SKILL.md'), SKILL);
  fs.writeFileSync(path.join(dir, 'doflow-package.json'), `${JSON.stringify({
    manifest: 1, id: 'acme', version: '1.0.0', summary: 'acme triage skill',
    doflow: `>=${VERSION} <${NEXT_MAJOR}.0.0`,
    contributions: [{ point: 'skill', version: 1, id: 'triage', dir: 'skills/acme-triage' }],
  }, null, 2)}\n`);
  return dir;
}

function world(t) {
  const scratch = createScratch('doflow-package-suspend-');
  t.after(() => scratch.remove());
  const project = path.join(scratch.dir, 'work');
  fs.mkdirSync(project);
  const install = spawnSync(process.execPath, [CLI, 'install', '-g', '-f', '--no-backup', '-t', 'claude'],
    { cwd: project, env: scratch.env({ DOFLOW_CONFIG_DIR: '', DOFLOW_CLI: '', DOFLOW_AGENT: '', DOFLOW_FAILURE_CAPTURE: '' }), encoding: 'utf8', input: '\n' });
  assert.equal(install.status, 0, install.stdout + install.stderr);

  const source = writePackage(path.join(scratch.dir, 'acme'));
  const grants = path.join(scratch.xdg, 'doflow', 'packages', 'grants.jsonl');
  const home = (...parts) => path.join(scratch.home, ...parts);
  const pkg = (action, extra = {}) => {
    const lines = [];
    const saved = process.exitCode;
    try {
      const code = handlePackageCommand({ action, homeDir: scratch.home,
        env: { HOME: scratch.home, XDG_CONFIG_HOME: scratch.xdg, DOFLOW_TELEMETRY: 'off' },
        projectRoot: project, tmpDir: NO_TMP, settingsView: {}, json: true,
        writer: { write() {} }, repoRoot: REPO_ROOT, out: (line) => lines.push(line), ...extra });
      return { code, text: lines.join('\n') };
    } finally {
      process.exitCode = saved;
    }
  };
  const add = () => {
    const planned = pkg('add', { source });
    assert.equal(planned.code, 0, planned.text);
    const { plan } = JSON.parse(planned.text);
    const applied = pkg('add', { plan: plan.planId });
    assert.equal(applied.code, 0, applied.text);
    return plan;
  };
  const trust = (plan) => {
    fs.mkdirSync(path.dirname(grants), { recursive: true });
    fs.appendFileSync(grants, `${plan.grantLines.trust}\n`);
  };
  return { scratch, project, home, pkg, add, trust };
}

test('verify unprojects suspended package files and retains the suspension without restoring trust', (t) => {
  const w = world(t);
  const plan = w.add();
  w.trust(plan);
  assert.equal(w.pkg('enable', { id: 'acme' }).code, 0);

  const skillFile = w.home('.claude', 'skills', 'acme-triage', 'SKILL.md');
  assert.equal(fs.existsSync(skillFile), true);
  const storeRoot = w.home('.doflow', 'packages', 'store', 'acme');
  const storeEntry = path.join(storeRoot, fs.readdirSync(storeRoot)[0]);
  const storedSkill = path.join(storeEntry, 'skills', 'acme-triage', 'SKILL.md');
  const bytes = fs.readFileSync(storedSkill);
  bytes[bytes.length - 2] = bytes[bytes.length - 2] ^ 1;
  fs.writeFileSync(storedSkill, bytes);

  const listed = JSON.parse(w.pkg('list').text);
  const pkg = listed.packages.find((item) => item.id === 'acme');
  assert.equal(pkg.state, 'suspended');
  assert.ok(pkg.reasons.includes('content-changed'));
  assert.equal(fs.existsSync(skillFile), true, 'list does not remove projected files');
  const beforeVerify = state.readState({ homeDir: w.scratch.home });
  const prior = beforeVerify.state.suspended.find((item) => item.package === 'acme');
  assert.equal(prior === undefined || prior.projected === true, true);

  const verified = w.pkg('verify');
  assert.equal(verified.code, 1, verified.text);
  assert.equal(fs.existsSync(skillFile), false);
  const afterVerify = state.readState({ homeDir: w.scratch.home });
  assert.deepEqual(afterVerify.state.suspended[0] && {
    reason: afterVerify.state.suspended[0].reason, projected: afterVerify.state.suspended[0].projected,
  }, { reason: 'content-changed', projected: false });

  const stillSuspended = JSON.parse(w.pkg('list').text).packages.find((item) => item.id === 'acme');
  assert.equal(stillSuspended.state, 'suspended');
  assert.ok(stillSuspended.reasons.includes('content-changed'));
});

test('doctor JSON lists suspended packages that still have projected files', async (t) => {
  const w = world(t);
  const plan = w.add();
  w.trust(plan);
  assert.equal(w.pkg('enable', { id: 'acme' }).code, 0);
  state.recordSuspension({ homeDir: w.scratch.home }, {
    packageId: 'acme', reason: 'content-changed', since: '2026-10-24T09:12:03Z', projected: true,
  });

  const lines = [];
  const log = console.log;
  const saved = process.exitCode;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    await handleDoctorCommand({ json: true, repoRoot: REPO_ROOT, projectRoot: w.project,
      env: { HOME: w.scratch.home, XDG_CONFIG_HOME: w.scratch.xdg, DOFLOW_TELEMETRY: 'off' },
      homeDir: w.scratch.home, tmpDir: NO_TMP });
  } finally {
    console.log = log;
    process.exitCode = saved;
  }
  const report = JSON.parse(lines.join('\n'));
  assert.deepEqual(report.packages.suspendedProjected, ['acme']);
});

test('SessionStart package verification is silent and skips a lock with no packages', async (t) => {
  const root = tempDir(t, 'doflow-package-suspend-hook-');
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const xdg = path.join(root, 'xdg');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'node-calls');
  const lock = path.join(home, '.doflow', 'doflow.lock');
  const dispatcher = path.join(home, '.doflow', 'scripts', 'doflow', 'bin', 'doflow-run');
  const hook = path.join(REPO_ROOT, 'core', 'harnesses', 'shared', 'hooks', 'policies', 'session-context.sh');
  for (const dir of [home, project, xdg, bin, path.dirname(dispatcher)]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/bash\nprintf "%s|%s\\n" "$*" "$PWD" >> "$HOOK_NODE_LOG"\n');
  fs.chmodSync(path.join(bin, 'node'), 0o755);
  fs.writeFileSync(dispatcher, '#!/bin/bash\nnode "$@"\n');
  fs.chmodSync(dispatcher, 0o755);

  const runHook = () => spawnSync('/bin/bash', [hook], {
    cwd: project,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, PATH: `${bin}:/usr/bin:/bin`, HOOK_NODE_LOG: log },
    input: encodeEnvelope('claude', 'SessionStart', 'session-context',
      JSON.stringify({ session_id: '<masked>', cwd: project, source: 'startup' })),
    encoding: 'utf8', timeout: 5000,
  });
  const writeLock = (packages) => {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ packages }));
  };
  const waitForLine = async (prefix) => {
    const until = Date.now() + 3000;
    while (Date.now() < until) {
      if (fs.existsSync(log) && fs.readFileSync(log, 'utf8').split('\n').some((line) => line.startsWith(prefix))) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];

  writeLock([]);
  const negative = runHook();
  assert.equal(negative.status, 0, negative.stderr);
  assert.equal(negative.stdout, '');
  assert.equal(negative.stderr, '');
  await waitForLine('storage --action upkeep');
  assert.equal(calls().some((line) => line.startsWith('package --action verify')), false);

  writeLock([{ id: 'acme' }]);
  const positive = runHook();
  assert.equal(positive.status, 0, positive.stderr);
  assert.equal(positive.stdout, '');
  assert.equal(positive.stderr, '');
  await waitForLine('package --action verify');
  assert.ok(calls().some((line) => line === `package --action verify|${path.join(home, '.doflow')}`));
});
