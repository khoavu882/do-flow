'use strict';

// The reach half of `doflow doctor`: the JSON additions, the [Runtime Reach] text lines and the
// exit status, driven through the real CLI against ledgers written into a scratch home and project.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { REACH_DISPATCHER_REL, REACH_RUNTIME_REL } = require('../../src/runtime/reach.ts');

// A developer's PI_CODING_AGENT_DIR would send this file's global Pi MCP writes outside the scratch home.
delete process.env.PI_CODING_AGENT_DIR;

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');

function fixture(testContext: any) {
  const dir = tempDir(testContext, 'doflow-doctor-reach-');
  const home = path.join(dir, 'home');
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(home);
  fs.mkdirSync(proj);
  return { dir, home, proj };
}

function write(file: any, text: any = '', mode?: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
}

function ledger(root: any, scope: any, { skills = [] as any[], bare = [] as any[] }: any = {}) {
  const resources: any = [
    ...skills.map((harness: any) => ({ harness, assetId: 'skills.doflow', kind: 'copy-tree-file' })),
    ...bare.map((harness: any) => ({ harness, assetId: 'locator.doflow', kind: 'copy-tree-file' })),
  ];
  write(path.join(root, '.doflow', 'state', 'ledger.json'), JSON.stringify({
    version: 2, scope, scopeRoot: root, targets: {}, mcpSelections: {}, resources, legacyImports: [],
  }));
}

function install(root: any) {
  write(path.join(root, '.doflow', REACH_DISPATCHER_REL), '#!/bin/sh\n', 0o755);
  write(path.join(root, '.doflow', REACH_RUNTIME_REL), '');
}

/** Runs `doflow doctor` under an emptied environment so no real home, PATH tool or git config answers. */
function doctor(t: any, args: any, extraEnv: any = {}) {
  return spawnSync(process.execPath, [CLI, 'doctor', ...args], {
    cwd: t.dir,
    encoding: 'utf8',
    env: {
      HOME: t.home,
      USERPROFILE: t.home,
      XDG_CONFIG_HOME: path.join(t.dir, 'xdg'),
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      GIT_CONFIG_GLOBAL: '/dev/null',
      ...extraEnv,
    },
  });
}

test('doctor --json: a reached harness carries a REACHED row and the run exits 0', (testContext) => {
  const t = fixture(testContext);
  ledger(t.proj, 'project', { skills: ['pi'] });
  install(t.proj);
  const result = doctor(t, [t.proj, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const pi = report.harnesses.find((harness: any) => harness.id === 'pi');
  assert.equal(pi.status, 'PASS');
  assert.deepEqual(pi.reach, [{ scope: 'project', installRoot: t.proj, state: 'REACHED', root: path.join(t.proj, '.doflow') }]);
  assert.deepEqual(report.harnesses.find((harness: any) => harness.id === 'claude').reach, []);
  assert.equal(report.findings.some((finding: any) => finding.kind === 'runtime-no-reach'), false);
});

test('doctor --json: a NO-REACH row is a runtime-no-reach finding and exits 1', (testContext) => {
  const t = fixture(testContext);
  ledger(t.proj, 'project', { skills: ['pi'] });
  write(path.join(t.proj, '.doflow', REACH_DISPATCHER_REL), '#!/bin/sh\n', 0o755);
  const result = doctor(t, [t.proj, '--json']);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  const finding = report.findings.find((item: any) => item.kind === 'runtime-no-reach');
  assert.equal(finding.subject, 'pi:project');
  assert.ok(finding.detail.endsWith(`; fix: npx @khoavu882/doflow install ${t.proj} -t pi`), finding.detail);
  assert.equal(report.harnesses.find((harness: any) => harness.id === 'pi').reach[0].state, 'NO-REACH');
});

test('doctor text: adapter lines, one [Runtime Reach] line per row, and the fix on NO-REACH', (testContext) => {
  const t = fixture(testContext);
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

test('doctor text: with no ledger rows the section says so and the run exits 0', (testContext) => {
  const t = fixture(testContext);
  const result = doctor(t, [t.proj]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[Runtime Reach\]\n {2}No harness has DoFlow ledger rows in this project or in the home directory\./);
});

test('doctor reports ignored relative XDG and a deprecated file as warnings without changing its exit rule', (testContext) => {
  const t = fixture(testContext);
  const sentinel = path.join(t.home, '.config', 'doflow', 'failures', 'off');
  write(sentinel, 'off\n');
  const result = doctor(t, [t.proj], { XDG_CONFIG_HOME: 'relative/xdg' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[Settings\]/);
  assert.match(result.stdout, /XDG_CONFIG_HOME.*ignored|ignored.*XDG_CONFIG_HOME/);
  assert.ok(result.stdout.includes(sentinel));
  assert.match(result.stdout, /deprecated/);
});

test('doctor -g reports global rows only, and N/A alone leaves the exit code at 0', (testContext) => {
  const t = fixture(testContext);
  ledger(t.proj, 'project', { skills: ['pi'] });
  ledger(t.home, 'global', { bare: ['antigravity'] });
  const result = doctor(t, ['-g', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(result.stdout).harnesses.flatMap((harness: any) => harness.reach.map((row: any) => `${harness.id}:${row.scope}:${row.state}`));
  assert.deepEqual(rows, ['antigravity:global:N/A']);
});

test('doctor: an unreadable ledger is a warning, not a finding', (testContext) => {
  const t = fixture(testContext);
  write(path.join(t.home, '.doflow', 'state', 'ledger.json'), '{ not json');
  const result = doctor(t, [t.proj, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const warning = report.warnings.find((item: any) => item.kind === 'reach-ledger-unreadable');
  assert.equal(warning.subject, `global: ${path.join(t.home, '.doflow', 'state')}`);
  assert.match(warning.detail, /Cannot read neutral ledger/);
  assert.equal(report.findings.length, 0);
});

// 135: each harness's agent tool scope, native with its field or unenforced with the reason it projects none.
test('doctor and capabilities: one agent tool-scope row per harness, unenforced ones with their reason', (testContext) => {
  const t = fixture(testContext);
  const { loadRegistry } = require('../../src/registry/index.ts');
  const harnesses = loadRegistry({ repoRoot: REPO_ROOT }).harnesses;
  const report = JSON.parse(doctor(t, [t.proj, '--json']).stdout);
  assert.deepEqual(report.agentToolScope.map((row: any) => row.harness), harnesses.map((h: any) => h.id));
  for (const row of report.agentToolScope) {
    const entry = harnesses.find((h: any) => h.id === row.harness).agentLimits.toolScope;
    assert.deepEqual(row, entry.status === 'native' ? { harness: row.harness, status: 'native', field: entry.field } : { harness: row.harness, status: 'unenforced', reason: entry.reason });
  }
  const text = doctor(t, [t.proj]).stdout.split('\n');
  const section = text.slice(text.indexOf('[Agent Tool Scope]') + 1, text.indexOf('[Agent Tool Scope]') + 1 + harnesses.length);
  assert.equal(section.find((line: any) => line.startsWith('  claude ')), `  ${'claude'.padEnd(14)}native      tools`);
  assert.match(section.find((line: any) => line.startsWith('  codex ')), /unenforced {2}projects no tool field: /);
  const caps = spawnSync(process.execPath, [CLI, 'capabilities', '--json'], { cwd: t.dir, encoding: 'utf8', env: { HOME: t.home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(caps.status, 0, caps.stderr);
  assert.deepEqual(JSON.parse(caps.stdout).agentToolScope, report.agentToolScope);
});
