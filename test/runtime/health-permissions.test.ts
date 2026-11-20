'use strict';

// AU-P6 (D9): `doflow doctor` warns when a user's own Claude permissions array hides DoFlow's shipped
// entries. The merge keeps a user array whole, so the entries are absent and nothing else says so.
// A file is judged when the install ledger of its scope records a Claude settings.json projection,
// whether or not the file carries DoFlow's hooks (an install with hooks off has none).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { buildHealthReport, handleDoctorCommand } = require('../../src/runtime/health.ts');
const { defaultLedger, writeLedger, stateRoot } = require('../../src/state/index.ts');

const shipped = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'harnesses', 'claude', 'settings', 'settings.json'), 'utf8'));
const stub = () => { const error: any = new Error('not found'); error.code = 'ENOENT'; throw error; };
const KIND = 'claude-permissions-user-array';

function record(root: string, scope: 'global' | 'project', resources: any[]) {
  const ledger = { ...defaultLedger({ scope, scopeRoot: root }), resources };
  writeLedger(scope === 'global' ? stateRoot({ scope, homeDir: root }) : path.join(root, '.doflow', 'state'), ledger);
}
const claudeSettings = { harness: 'claude', assetId: 'claude.settings', kind: 'settings-file', identity: 'settings.json' };

function setup(t: any, settings: any, { where = 'home', ledger = true }: { where?: 'home' | 'project'; ledger?: boolean } = {}) {
  const home = tempDir(t, 'doflow-doctor-perm-home-');
  const project = tempDir(t, 'doflow-doctor-perm-project-');
  const root = where === 'home' ? home : project;
  if (settings) {
    const file = path.join(root, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings));
  }
  if (ledger) record(root, where === 'home' ? 'global' : 'project', [claudeSettings]);
  const report = buildHealthReport({ repoRoot: REPO_ROOT, projectRoot: project, homeDir: home, execFileImpl: stub });
  return { warnings: report.warnings.filter((w: any) => w.kind === KIND), findings: report.findings.filter((f: any) => f.kind === KIND) };
}

test('a user allow array without DoFlow entries warns once, naming the list and the missing entries', (t) => {
  const { warnings } = setup(t, { permissions: { allow: ['Bash(ls:*)'] } });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].subject.endsWith('permissions.allow'), warnings[0].subject);
  assert.ok(warnings[0].detail.includes('Bash(git *:*)'), warnings[0].detail);
  assert.ok(!warnings[0].detail.includes('Bash(ls:*)'), 'the user entries are not listed as missing');
});

test('an install with hooks off (no hook entries in the file) is judged from the ledger', (t) => {
  const { warnings } = setup(t, { permissions: { ask: ['y'] } });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].subject.endsWith('permissions.ask'));
});

test('deny, ask and allow are judged each; a list that holds every shipped entry does not warn', (t) => {
  const { warnings } = setup(t, { permissions: { allow: shipped.permissions.allow, deny: ['x'], ask: ['y'] } });
  assert.deepEqual(warnings.map((w: any) => w.subject.split(': ')[1]).sort(), ['permissions.ask', 'permissions.deny']);
});

test('a project-scope file is judged through the project ledger', (t) => {
  const { warnings } = setup(t, { permissions: { ask: ['y'] } }, { where: 'project' });
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].subject.includes(`${path.sep}.claude${path.sep}settings.json`));
});

test('no warning without a user array, without a ledger record of the projection, or without the file', (t) => {
  assert.deepEqual(setup(t, { permissions: {} }).warnings, []);
  assert.deepEqual(setup(t, {}).warnings, []);
  assert.deepEqual(setup(t, { hooks: shipped.hooks, permissions: { allow: ['Bash(ls:*)'] } }, { ledger: false }).warnings, [], 'no ledger: DoFlow did not project into this file');
  assert.deepEqual(setup(t, null).warnings, []);
});

test('a ledger that records another harness only does not make the Claude file DoFlow-managed', (t) => {
  const home = tempDir(t, 'doflow-doctor-perm-home-');
  const file = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ permissions: { allow: ['z'] } }));
  record(home, 'global', [{ harness: 'codex', assetId: 'x', kind: 'copy-tree-file', identity: 'a' }]);
  const report = buildHealthReport({ repoRoot: REPO_ROOT, projectRoot: tempDir(t, 'doflow-doctor-perm-project-'), homeDir: home, execFileImpl: stub });
  assert.equal(report.warnings.some((w: any) => w.kind === KIND), false);
});

test('the warning is a warning only: it is produced and never a finding', (t) => {
  const { warnings, findings } = setup(t, { permissions: { allow: ['z'] } });
  assert.equal(warnings.length, 1, 'the scenario must produce the warning for the next assertion to mean anything');
  assert.deepEqual(findings, []);
});

test('the text doctor separates the long subject from its detail, and --json keeps subject and detail apart', async (t) => {
  const home = tempDir(t, 'doflow-doctor-perm-home-');
  const project = tempDir(t, 'doflow-doctor-perm-project-');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['z'] } }));
  record(home, 'global', [claudeSettings]);
  const run = async (json: boolean) => {
    const lines: string[] = [];
    const log = console.log;
    const saved = process.exitCode;
    console.log = (...args: any[]) => { lines.push(args.join(' ')); };
    try {
      await handleDoctorCommand({ json, repoRoot: REPO_ROOT, projectRoot: project, execFileImpl: stub, homeDir: home, env: { HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg'), DOFLOW_TELEMETRY: 'off' } });
    } finally { console.log = log; process.exitCode = saved; }
    return lines.join('\n');
  };
  const text = await run(false);
  const line = text.split('\n').find((l) => l.includes('permissions.allow'));
  assert.ok(line, 'the warning is rendered');
  assert.match(line, /permissions\.allow {2,}your own permissions\.allow list wins whole/);
  const warning = JSON.parse(await run(true)).warnings.find((w: any) => w.kind === KIND);
  assert.ok(warning.subject.endsWith('permissions.allow'));
  assert.ok(warning.detail.startsWith('your own permissions.allow list wins whole'), 'the JSON detail is unchanged');
});
