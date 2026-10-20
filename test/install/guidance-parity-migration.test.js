'use strict';
// guidance-parity-migration.test.js — updating an install made before the core-set projections
// (Kiro steering and Copilot instructions took the whole guidance tree, Antigravity rules only the
// four rule files) removes the files the new registry no longer produces, keeps the one the user edited, leaves the user's own
// file, moves Copilot's rule files under instructions/rules/ and leaves nothing for `reconcile` to
// report. The old install is made from a package copy whose assets.json is put back to the old
// projections; the update then runs from the same copy with the current assets.json, so both runs go
// through the real CLI, adapters and ledger.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');

const REPO = path.resolve(__dirname, '..', '..');
const TARGETS = 'kiro,copilot,antigravity';
const REGISTRY = path.join('core', 'registry', 'assets.json');

let scratch;
let pkg;
let project;
let doflow;

before(() => {
  scratch = createScratch('doflow-guidance-parity-migration-');
  pkg = path.join(scratch.dir, 'pkg');
  project = path.join(scratch.dir, 'project');
  fs.mkdirSync(pkg);
  fs.mkdirSync(project);
  for (const part of ['bin', 'src', 'core', 'package.json']) fs.cpSync(path.join(REPO, part), path.join(pkg, part), { recursive: true });
  doflow = path.join(pkg, 'bin', 'doflow.js');
});

after(() => scratch?.remove());

function run(args) {
  const result = spawnSync(process.execPath, [doflow, ...args], { cwd: project, env: scratch.env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

/** The projections as they were before the core set: the three selects and the flat layout removed,
 * and the Copilot and Antigravity rule sources back on core/shared/guidance/rules. */
function oldRegistry(current) {
  const old = structuredClone(current);
  const asset = (id) => old.assets.find((item) => item.id === id);
  delete asset('guidance.context-layer').projection.kiro.select;
  Object.assign(asset('instructions.copilot'), { source: 'core/shared/guidance/rules' });
  delete asset('instructions.copilot').projection.copilot.select;
  Object.assign(asset('rules.antigravity'), { source: 'core/shared/guidance/rules' });
  delete asset('rules.antigravity').projection.antigravity.select;
  delete asset('rules.antigravity').projection.antigravity.layout;
  delete asset('rules.antigravity').projection.antigravity.transform;
  return old;
}

function filesUnder(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')).sort();
}

const CORE_STEERING = ['DOFLOW_CORE.md', 'FLAGS.md', 'PRINCIPLES.md', 'rules/RULE_01_SAFETY.md', 'rules/RULE_02_WORKFLOW.md', 'rules/RULE_03_QUALITY.md', 'rules/RULE_04_QUESTIONS.md'];
const EDITED = 'modes/MODE_Orchestration.md';

test('updating an install made before the core-set projections migrates Kiro, Copilot and Antigravity', () => {
  const currentRegistry = fs.readFileSync(path.join(pkg, REGISTRY), 'utf8');
  fs.writeFileSync(path.join(pkg, REGISTRY), `${JSON.stringify(oldRegistry(JSON.parse(currentRegistry)), null, 2)}\n`);
  run(['install', project, '--force', '--mcp', 'none', '-t', TARGETS]);

  const steering = path.join(project, '.kiro', 'steering');
  const copilotInstructions = path.join(project, '.github', 'instructions');
  const rules = path.join(project, '.agents', 'rules');
  assert.ok(filesUnder(steering).length > CORE_STEERING.length, 'the old install put the whole tree in steering');
  assert.ok(filesUnder(copilotInstructions).includes('RULE_01_SAFETY.instructions.md'), 'the old Copilot rules sit directly under instructions/');
  assert.deepEqual(filesUnder(rules), ['RULE_01_SAFETY.md', 'RULE_02_WORKFLOW.md', 'RULE_03_QUALITY.md', 'RULE_04_QUESTIONS.md']);

  fs.writeFileSync(path.join(steering, 'my-notes.md'), 'a steering file of my own\n');
  fs.appendFileSync(path.join(steering, EDITED), '\nA line the user added.\n');
  const edited = fs.readFileSync(path.join(steering, EDITED));

  fs.writeFileSync(path.join(pkg, REGISTRY), currentRegistry);
  const update = run(['update', project, '--force', '--mcp', 'none', '-t', TARGETS]);

  // Kiro: the core set, the edited file (kept, with a notice) and the user's own file.
  assert.deepEqual(filesUnder(steering), [...CORE_STEERING, EDITED, 'my-notes.md'].sort());
  assert.deepEqual(fs.readFileSync(path.join(steering, EDITED)), edited);
  assert.equal(fs.readFileSync(path.join(steering, 'my-notes.md'), 'utf8'), 'a steering file of my own\n');
  const notices = update.split('\n').filter((line) => line.includes('kept hand-edited'));
  assert.equal(notices.length, 1, update);
  assert.ok(notices[0].includes(path.join('.kiro', 'steering', EDITED)), notices[0]);
  // The shared copy under .doflow/guidance stays whole.
  assert.ok(fs.existsSync(path.join(project, '.doflow', 'guidance', EDITED)));

  // Copilot: the rules moved under instructions/rules/, and the core files beside them.
  assert.deepEqual(filesUnder(copilotInstructions), [
    'DOFLOW_CORE.instructions.md', 'FLAGS.instructions.md', 'PRINCIPLES.instructions.md',
    'rules/RULE_01_SAFETY.instructions.md', 'rules/RULE_02_WORKFLOW.instructions.md', 'rules/RULE_03_QUALITY.instructions.md', 'rules/RULE_04_QUESTIONS.instructions.md',
  ]);

  // Antigravity: the three core files joined the four rules, flat.
  assert.deepEqual(filesUnder(rules), ['DOFLOW_CORE.md', 'FLAGS.md', 'PRINCIPLES.md', 'RULE_01_SAFETY.md', 'RULE_02_WORKFLOW.md', 'RULE_03_QUALITY.md', 'RULE_04_QUESTIONS.md']);
  for (const name of filesUnder(rules)) {
    assert.ok(fs.readFileSync(path.join(rules, name), 'utf8').startsWith('---\ntrigger: always_on\n---\n\n'),
      `${name} gained the always_on front-matter, including the four rules the old install wrote bare`);
  }

  // Every ledger row names a file that exists, none names a path no longer produced, and reconcile
  // finds the install clean.
  const rows = JSON.parse(fs.readFileSync(path.join(project, '.doflow', 'state', 'ledger.json'), 'utf8')).resources
    .filter((row) => typeof row.target === 'string');
  assert.deepEqual(rows.filter((row) => !fs.existsSync(row.target)).map((row) => row.target), []);
  const stale = [path.join(copilotInstructions, 'RULE_01_SAFETY.instructions.md'), path.join(steering, 'references', 'RESEARCH_CONFIG.md'), path.join(steering, EDITED)];
  assert.deepEqual(rows.filter((row) => stale.includes(row.target)).map((row) => row.target), []);
  const reconcile = run(['reconcile', project, '--dry-run', '-t', TARGETS]);
  for (const id of ['kiro', 'copilot', 'antigravity']) assert.match(reconcile, new RegExp(`${id}: clean`));
  assert.match(reconcile, /Observed state matches doflow\.lock/);
});
