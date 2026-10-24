'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadPoints, judgeContribution, POINT_VALIDATORS } = require('../../src/runtime/packages/points.ts');
const { judgeInstruction } = require('../../src/runtime/packages/instruction.ts');
const { checkPackage } = require('../../src/runtime/packages/manifest.ts');
const { packageView, resetPackageView } = require('../../src/runtime/packages/view.ts');
const { planPackage, applyPlan } = require('../../src/runtime/packages/store.ts');
const { readLock, writeLock, lockPackages } = require('../../src/state/lockfile.ts');

const HOST = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
const POINTS = loadPoints().registry;
const NO_TMP = '/nonexistent-doflow-tmp';
const manifestOf = (point: string, entry: any) => ({
  manifest: 1, id: 'acme', version: '1.2.0', summary: 'Instruction package',
  doflow: '>=2.0.0-beta.1 <3.0.0', contributions: [{ point, version: 1, id: 'triage', ...entry }],
});

function packageDir(t: any, manifest: any, files: Record<string, string>): string {
  const dir = path.join(tempDir(t, 'doflow-instruction-'), 'pkg');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'doflow-package.json'), JSON.stringify(manifest, null, 2));
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  return dir;
}
const skillText = (name: string = 'acme-triage') => `---
name: ${name}
description: A triage skill
---

# Triage
`;
const agentText = (name: string = 'acme-triage', description: string = 'A triage agent', access: string = 'read-only') =>
  `---
name: ${name}
description: "${description}"
access: ${access}
model: inherit
effort: high
---
`;

test('skill-v1 checks projected frontmatter name, directory name, and SKILL.md', (t: any) => {
  const root = tempDir(t, 'doflow-instruction-');
  const dir = path.join(root, 'acme-triage');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillText());
  const judge = (at: string) => judgeInstruction('skill-v1', 'triage', at, { packageId: 'acme' });
  assert.deepEqual(judge(dir), []);
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillText('triage'));
  assert.deepEqual(judge(dir).map((f: any) => [f.field, f.code]), [['.name', 'name-mismatch']]);
  const wrongDir = path.join(root, 'triage');
  fs.mkdirSync(wrongDir);
  fs.writeFileSync(path.join(wrongDir, 'SKILL.md'), skillText());
  assert.deepEqual(judge(wrongDir).map((f: any) => [f.field, f.code]), [['.dir', 'name-mismatch']]);
  fs.rmSync(path.join(dir, 'SKILL.md'));
  assert.equal(judge(dir)[0].code, 'file-missing');
});

test('agent-v1 checks projected name, description bounds, and access', (t: any) => {
  const root = tempDir(t, 'doflow-instruction-');
  const file = path.join(root, 'acme-triage.md');
  const judge = () => judgeInstruction('agent-v1', 'triage', file, { packageId: 'acme' });
  fs.writeFileSync(file, agentText());
  assert.deepEqual(judge(), []);
  fs.writeFileSync(file, agentText('acme-triage', 'x'.repeat(161)));
  assert.deepEqual(judge().map((f: any) => [f.field, f.code]), [['.description', 'contribution-invalid']]);
  fs.writeFileSync(file, agentText('acme-triage', 'x'.repeat(160)));
  assert.deepEqual(judge(), []);
  fs.writeFileSync(file, agentText('triage'));
  assert.deepEqual(judge().map((f: any) => [f.field, f.code]), [['.name', 'name-mismatch']]);
  fs.writeFileSync(file, '---\nname: acme-triage\ndescription: agent\n---\n');
  assert.deepEqual(judge().map((f: any) => [f.field, f.code]), [['.access', 'contribution-invalid']]);
});

test('checkPackage routes skill directories and agent files to instruction validators', (t: any) => {
  const skillManifest = manifestOf('skill', { dir: 'skills/acme-triage' });
  const skillFiles = { 'skills/acme-triage/SKILL.md': skillText() };
  assert.deepEqual(checkPackage(packageDir(t, skillManifest, skillFiles), { pointsRegistry: POINTS, hostVersion: HOST }).findings, []);
  const badSkill = packageDir(t, skillManifest, { 'skills/acme-triage/SKILL.md': skillText('triage') });
  assert.deepEqual(checkPackage(badSkill, { pointsRegistry: POINTS, hostVersion: HOST }).findings.map((f: any) => [f.field, f.code]), [['acme.triage.name', 'name-mismatch']]);
  const agentManifest = manifestOf('agent', { file: 'agents/acme-triage.md' });
  const agentFiles = { 'agents/acme-triage.md': agentText() };
  assert.deepEqual(checkPackage(packageDir(t, agentManifest, agentFiles), { pointsRegistry: POINTS, hostVersion: HOST }).findings, []);
});

test('skill and agent validators are registered and contribution points are judged correctly', () => {
  assert.ok(Object.hasOwn(POINT_VALIDATORS, 'skill-v1'));
  assert.ok(Object.hasOwn(POINT_VALIDATORS, 'agent-v1'));
  assert.equal(judgeContribution(POINTS, { point: 'skill', version: 1 }, { packageId: 'acme', index: 0 }), null);
  assert.equal(judgeContribution(POINTS, { point: 'agent', version: 1 }, { packageId: 'acme', index: 0 }), null);
  assert.equal(judgeContribution(POINTS, { point: 'capability-provider', version: 1 }, { packageId: 'acme', index: 0 }).code, 'point-reserved');
});

test('instruction package trust is required before activation', (t: any) => {
  const temp = tempDir(t, 'doflow-instruction-');
  const home = path.join(temp, 'home');
  const xdg = path.join(temp, 'config');
  const project = path.join(temp, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(xdg);
  fs.mkdirSync(project);
  const env = { HOME: home, XDG_CONFIG_HOME: xdg };
  const grantsFile = path.join(xdg, 'doflow', 'packages', 'grants.jsonl');
  const pkg = packageDir(t, manifestOf('skill', { dir: 'skills/acme-triage' }), { 'skills/acme-triage/SKILL.md': skillText() });
  const planned = planPackage({ action: 'add', source: pkg, homeDir: home, repoRoot: REPO_ROOT });
  assert.equal(planned.ok, true, JSON.stringify(planned.findings));
  const applied = applyPlan({ planId: planned.plan.planId, action: 'add', homeDir: home, repoRoot: REPO_ROOT, env });
  assert.equal(applied.ok, true, JSON.stringify(applied.findings));
  const options = { scope: 'global', homeDir: home };
  const lock = readLock(options);
  writeLock(options, { ...lock, packages: lockPackages(lock).map((row: any) => row.id === 'acme' ? { ...row, enabled: true } : row) });
  const view = () => {
    resetPackageView();
    return packageView({ repoRoot: REPO_ROOT, homeDir: home, env, projectRoot: project, tmpDir: NO_TMP, settingsView: {} });
  };
  let state = view().packages.find((item: any) => item.id === 'acme');
  assert.equal(state.state, 'needs-trust');
  assert.ok(state.reasons.includes('grant-missing'));
  fs.mkdirSync(path.dirname(grantsFile), { recursive: true });
  fs.writeFileSync(grantsFile, planned.plan.grantLines.trust + '\n');
  state = view().packages.find((item: any) => item.id === 'acme');
  assert.equal(state.state, 'active');
});
