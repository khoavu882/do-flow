'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { validatePoints, templateFindings } = require('../../src/runtime/packages/points.ts');
const { dominates } = require('../../src/runtime/review/dominance.ts');
const { judgeInstruction } = require('../../src/runtime/packages/instruction.ts');
const { qualifiedId, projectedName } = require('../../src/helper/package-ids.ts');

const POINTS_FILE = path.join(REPO_ROOT, 'core', 'registry', 'contribution-points.json');
const REAL = JSON.parse(fs.readFileSync(POINTS_FILE, 'utf8'));
const clone = (value: any) => JSON.parse(JSON.stringify(value));

function templateCopy(t: any) {
  const root = tempDir(t, 'doflow-package-templates-');
  fs.cpSync(path.join(REPO_ROOT, 'core', 'registry'), path.join(root, 'core', 'registry'), { recursive: true });
  return root;
}

test('every open point names a valid shipped template', () => {
  assert.deepEqual(REAL.points.filter((point: any) => point.status === 'open').map((point: any) => point.template), [
    'package-templates/review-preset',
    'package-templates/debate-preset',
    'package-templates/skill',
    'package-templates/agent',
  ]);
  assert.deepEqual(templateFindings({ registry: REAL, repoRoot: REPO_ROOT }), []);
});

test('open points require templates and reserved points refuse them', () => {
  const missing = clone(REAL);
  delete missing.points[0].template;
  const invalidMissing = validatePoints(missing);
  assert.equal(invalidMissing.ok, false);
  assert.match(invalidMissing.errors.join('\n'), /points\[0\]\.template/);

  const reserved = clone(REAL);
  reserved.points[4].template = 'package-templates/worker';
  const invalidReserved = validatePoints(reserved);
  assert.equal(invalidReserved.ok, false);
  assert.match(invalidReserved.errors.join('\n'), /points\[4\]\.template is refused on a reserved point/);
});

test('template findings catch unknown placeholders, bad paths, symlinks and programs on inert points', (t) => {
  const root = templateCopy(t);
  const base = path.join(root, 'core', 'registry', 'package-templates');
  const skillFile = path.join(base, 'skill', 'files', 'SKILL.md');
  fs.writeFileSync(skillFile, fs.readFileSync(skillFile, 'utf8') + '\n{{unknown}}\n');
  assert.ok(templateFindings({ registry: REAL, repoRoot: root, pointId: 'skill' }).some((finding: any) => finding.code === 'template-invalid'));

  const reviewConfig = path.join(base, 'review-preset', 'template.json');
  const review = JSON.parse(fs.readFileSync(reviewConfig, 'utf8'));
  review.path = 'presets/fixed.json';
  fs.writeFileSync(reviewConfig, JSON.stringify(review));
  assert.ok(templateFindings({ registry: REAL, repoRoot: root, pointId: 'review-preset' }).some((finding: any) => /path must contain \{\{local\}\} or \{\{projected\}\}/.test(finding.message)));

  const symlinkRoot = templateCopy(t);
  const symlinkFile = path.join(symlinkRoot, 'core', 'registry', 'package-templates', 'agent', 'files', 'agent.md');
  fs.unlinkSync(symlinkFile);
  fs.symlinkSync(path.join(base, 'agent', 'files', 'agent.md'), symlinkFile);
  assert.ok(templateFindings({ registry: REAL, repoRoot: symlinkRoot, pointId: 'agent' }).some((finding: any) => finding.code === 'template-invalid' && /symbolic link/.test(finding.message)));

  const programsRoot = templateCopy(t);
  const programsFile = path.join(programsRoot, 'core', 'registry', 'package-templates', 'review-preset', 'template.json');
  const config = JSON.parse(fs.readFileSync(programsFile, 'utf8'));
  config.programs = [];
  fs.writeFileSync(programsFile, JSON.stringify(config));
  assert.ok(templateFindings({ registry: REAL, repoRoot: programsRoot, pointId: 'review-preset' }).some((finding: any) => finding.code === 'template-invalid' && /programs is refused/.test(finding.message)));
});

test('the review preset template dominates core review-deep', () => {
  const template = path.join(REPO_ROOT, 'core', 'registry', 'package-templates', 'review-preset', 'files', 'preset.json');
  const preset = JSON.parse(fs.readFileSync(template, 'utf8'));
  const protocols = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'protocols.json'), 'utf8'));
  const models = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'models.json'), 'utf8'));
  assert.equal(dominates(preset, protocols.presets['review-deep'], {
    tiers: models.dispatchTiers.tiers,
    synthesizerStrength: protocols.synthesizerStrength,
  }), true);
});

test('the skill and agent templates, substituted, pass their instruction validators', (t) => {
  const out = tempDir(t, 'doflow-package-templates-sub-');
  const substitute = (text: any, local: any) => text
    .replaceAll('{{package}}', 'acme').replaceAll('{{local}}', local)
    .replaceAll('{{qualified}}', qualifiedId('acme', local)).replaceAll('{{projected}}', projectedName(qualifiedId('acme', local)));
  const base = path.join(REPO_ROOT, 'core', 'registry', 'package-templates');
  const name = projectedName(qualifiedId('acme', 'skill'));
  fs.mkdirSync(path.join(out, name));
  fs.writeFileSync(path.join(out, name, 'SKILL.md'), substitute(fs.readFileSync(path.join(base, 'skill', 'files', 'SKILL.md'), 'utf8'), 'skill'));
  assert.deepEqual(judgeInstruction('skill-v1', 'skill', path.join(out, name), { packageId: 'acme' }), []);
  const agentFile = path.join(out, `${projectedName(qualifiedId('acme', 'agent'))}.md`);
  fs.writeFileSync(agentFile, substitute(fs.readFileSync(path.join(base, 'agent', 'files', 'agent.md'), 'utf8'), 'agent'));
  assert.deepEqual(judgeInstruction('agent-v1', 'agent', agentFile, { packageId: 'acme' }), []);
});
