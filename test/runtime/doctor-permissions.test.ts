'use strict';

// AU-P6 (D9): `doflow doctor` warns when a user's own Claude permissions array hides DoFlow's shipped
// entries. The merge keeps a user array whole, so the entries are absent and nothing else says so.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { buildHealthReport } = require('../../src/runtime/health.ts');

const shipped = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'harnesses', 'claude', 'settings', 'settings.json'), 'utf8'));
const projectHooks = JSON.parse(JSON.stringify(shipped.hooks).split('~/.claude/hooks/').join('${CLAUDE_PROJECT_DIR}/.claude/hooks/'));
const stub = () => { const error: any = new Error('not found'); error.code = 'ENOENT'; throw error; };
const KIND = 'claude-permissions-user-array';

function setup(t: any, settings: any, where: 'home' | 'project' = 'home') {
  const home = tempDir(t, 'doflow-doctor-perm-home-');
  const project = tempDir(t, 'doflow-doctor-perm-project-');
  if (settings) {
    const file = path.join(where === 'home' ? home : project, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings));
  }
  const report = buildHealthReport({ repoRoot: REPO_ROOT, projectRoot: project, homeDir: home, execFileImpl: stub });
  return report.warnings.filter((w: any) => w.kind === KIND).concat(report.findings.filter((f: any) => f.kind === KIND));
}

test('a user allow array without DoFlow entries warns once, naming the list and the missing entries', (t) => {
  const found = setup(t, { hooks: shipped.hooks, permissions: { allow: ['Bash(ls:*)'] } });
  assert.equal(found.length, 1);
  assert.ok(found[0].subject.endsWith('permissions.allow'), found[0].subject);
  assert.ok(found[0].detail.includes('Bash(git *:*)'), found[0].detail);
  assert.ok(!found[0].detail.includes('Bash(ls:*)'), 'the user entries are not listed as missing');
});

test('deny, ask and allow are judged each; a list that holds every shipped entry does not warn', (t) => {
  const found = setup(t, { hooks: shipped.hooks, permissions: { allow: shipped.permissions.allow, deny: ['x'], ask: ['y'] } });
  assert.deepEqual(found.map((w: any) => w.subject.split(': ')[1]).sort(), ['permissions.ask', 'permissions.deny']);
});

test('a project-scope file is judged too', (t) => {
  const found = setup(t, { hooks: projectHooks, permissions: { ask: ['y'] } }, 'project');
  assert.equal(found.length, 1);
  assert.ok(found[0].subject.includes(`${path.sep}.claude${path.sep}settings.json`));
});

test('a project file with the global hook paths is not judged: DoFlow writes the project form there', (t) => {
  assert.deepEqual(setup(t, { hooks: shipped.hooks, permissions: { ask: ['y'] } }, 'project'), []);
});

test('no warning without a user array, without DoFlow installed in that file, or without the file', (t) => {
  assert.deepEqual(setup(t, { hooks: shipped.hooks, permissions: {} }), []);
  assert.deepEqual(setup(t, { hooks: shipped.hooks }), []);
  assert.deepEqual(setup(t, { permissions: { allow: ['Bash(ls:*)'] } }), [], 'no DoFlow hook in the file: DoFlow is not installed there');
  assert.deepEqual(setup(t, null), []);
});

test('the warning is a warning only: it is never a finding', (t) => {
  const home = tempDir(t, 'doflow-doctor-perm-home-');
  const file = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ hooks: shipped.hooks, permissions: { allow: ['z'] } }));
  const report = buildHealthReport({ repoRoot: REPO_ROOT, projectRoot: tempDir(t, 'doflow-doctor-perm-project-'), homeDir: home, execFileImpl: stub });
  assert.equal(report.findings.some((f: any) => f.kind === KIND), false);
});
