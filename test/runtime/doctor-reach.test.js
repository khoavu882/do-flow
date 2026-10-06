'use strict';

// The reach half of `doflow doctor`: the JSON additions, the [Runtime Reach] text lines and the
// exit status, driven through the real CLI against ledgers written into a scratch home and project.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO_ROOT } = require('../../src/helper/repo-root');
const { REACH_DISPATCHER_REL, REACH_RUNTIME_REL } = require('../../src/runtime/reach');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const made = [];
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-doctor-reach-')));
  made.push(dir);
  const home = path.join(dir, 'home');
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(home);
  fs.mkdirSync(proj);
  return { dir, home, proj };
}

function write(file, text = '', mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
}

function ledger(root, scope, { skills = [], bare = [] }) {
  const resources = [
    ...skills.map((harness) => ({ harness, assetId: 'skills.doflow', kind: 'copy-tree-file' })),
    ...bare.map((harness) => ({ harness, assetId: 'locator.doflow', kind: 'copy-tree-file' })),
  ];
  write(path.join(root, '.doflow', 'state', 'ledger.json'), JSON.stringify({
    version: 2, scope, scopeRoot: root, targets: {}, mcpSelections: {}, resources, legacyImports: [],
  }));
}

function install(root) {
  write(path.join(root, '.doflow', REACH_DISPATCHER_REL), '#!/bin/sh\n', 0o755);
  write(path.join(root, '.doflow', REACH_RUNTIME_REL), '');
}

/** Runs `doflow doctor` under an emptied environment so no real home, PATH tool or git config answers. */
function doctor(t, args) {
  return spawnSync(process.execPath, [CLI, 'doctor', ...args], {
    cwd: t.dir,
    encoding: 'utf8',
    env: {
      HOME: t.home,
      USERPROFILE: t.home,
      XDG_CONFIG_HOME: path.join(t.dir, 'xdg'),
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  });
}

test('doctor --json: a reached harness carries a REACHED row and the run exits 0', () => {
  const t = fixture();
  ledger(t.proj, 'project', { skills: ['pi'] });
  install(t.proj);
  const result = doctor(t, [t.proj, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const pi = report.harnesses.find((harness) => harness.id === 'pi');
  assert.equal(pi.status, 'PASS');
  assert.deepEqual(pi.reach, [{ scope: 'project', installRoot: t.proj, state: 'REACHED', root: path.join(t.proj, '.doflow') }]);
  assert.deepEqual(report.harnesses.find((harness) => harness.id === 'claude').reach, []);
  assert.equal(report.findings.some((finding) => finding.kind === 'runtime-no-reach'), false);
});

test('doctor --json: a NO-REACH row is a runtime-no-reach finding and exits 1', () => {
  const t = fixture();
  ledger(t.proj, 'project', { skills: ['pi'] });
  write(path.join(t.proj, '.doflow', REACH_DISPATCHER_REL), '#!/bin/sh\n', 0o755);
  const result = doctor(t, [t.proj, '--json']);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  const finding = report.findings.find((item) => item.kind === 'runtime-no-reach');
  assert.equal(finding.subject, 'pi:project');
  assert.ok(finding.detail.endsWith(`; fix: npx @khoavu882/doflow install ${t.proj} -t pi`), finding.detail);
  assert.equal(report.harnesses.find((harness) => harness.id === 'pi').reach[0].state, 'NO-REACH');
});

test('doctor text: adapter lines, one [Runtime Reach] line per row, and the fix on NO-REACH', () => {
  const t = fixture();
  ledger(t.proj, 'project', { skills: ['pi'] });
  install(t.proj);
  ledger(t.home, 'global', { skills: ['pi'], bare: ['antigravity'] });
  const result = doctor(t, [t.proj]);
  assert.equal(result.status, 1, result.stderr);
  const lines = result.stdout.split('\n');
  assert.ok(lines.includes('  Pi Coding Agent              adapter PASS'));
  const section = lines.slice(lines.indexOf('[Runtime Reach]') + 1);
  assert.equal(section[0], `  ${'pi'.padEnd(14)}${'project'.padEnd(9)}${'✓ REACHED'.padEnd(13)}${path.join(t.proj, '.doflow')} [install at ${t.proj}]`);
  assert.equal(section[1], `  ${'pi'.padEnd(14)}${'global'.padEnd(9)}${'✗ NO-REACH'.padEnd(13)}fix: npx @khoavu882/doflow install -g -t pi`);
  assert.equal(section[2], `  ${'antigravity'.padEnd(14)}${'global'.padEnd(9)}${'○ N/A'.padEnd(13)}no skills at global scope`);
});

test('doctor text: with no ledger rows the section says so and the run exits 0', () => {
  const t = fixture();
  const result = doctor(t, [t.proj]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[Runtime Reach\]\n {2}No harness has DoFlow ledger rows in this project or in the home directory\./);
});

test('doctor -g reports global rows only, and N/A alone leaves the exit code at 0', () => {
  const t = fixture();
  ledger(t.proj, 'project', { skills: ['pi'] });
  ledger(t.home, 'global', { bare: ['antigravity'] });
  const result = doctor(t, ['-g', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(result.stdout).harnesses.flatMap((harness) => harness.reach.map((row) => `${harness.id}:${row.scope}:${row.state}`));
  assert.deepEqual(rows, ['antigravity:global:N/A']);
});

test('doctor: an unreadable ledger is a warning, not a finding', () => {
  const t = fixture();
  write(path.join(t.home, '.doflow', 'state', 'ledger.json'), '{ not json');
  const result = doctor(t, [t.proj, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const warning = report.warnings.find((item) => item.kind === 'reach-ledger-unreadable');
  assert.equal(warning.subject, `global: ${path.join(t.home, '.doflow', 'state')}`);
  assert.match(warning.detail, /Cannot read neutral ledger/);
  assert.equal(report.findings.length, 0);
});
