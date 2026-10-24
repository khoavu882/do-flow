'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { toEvidence } = require('../../src/runtime/candidate.ts');
const { FreshnessValidator } = require('../../src/runtime/freshness.ts');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');

test('candidate absence and need are retained as an EMPTY evidence item', (t) => {
  const root = tempDir(t, 'doflow-candidate-absence-');
  fs.writeFileSync(path.join(root, 'a.js'), 'module.exports = {};\n');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', 'a.js');
  git('commit', '-qm', 'init');

  const declared = spawnSync(process.execPath, [DOFLOW, 'retrieval-plan', '--task-id', 'candidate-absence',
    '--action', 'declare', '--need', 'locate-known-symbol', '--json'],
  { cwd: root, env: { ...process.env, HOME: root }, encoding: 'utf8' });
  assert.equal(declared.status, 0, `${declared.stdout}\n${declared.stderr}`);
  const plan = JSON.parse(declared.stdout);
  let evidence;
  assert.doesNotThrow(() => { evidence = toEvidence({ candidate: {
    provider: plan.needs[0].provider,
    capability: plan.needs[0].capability,
    absence: true,
    need: 'locate-known-symbol',
  } }, {
    taskId: 'candidate-absence', root, plan,
    kind: 'structural', provenance: 'extracted', establishes: ['architecture_mapped'],
  }); }, 'candidate absence is accepted and converted into an evidence record');

  assert.equal(evidence.result, 'EMPTY');
  assert.equal(evidence.freshness.status, 'FRESH');
});

test('freshness validation does not probe the tree when the ledger has no absence', (t) => {
  let spawns = 0;
  const root = tempDir(t, 'doflow-no-absence-probe-');
  execFileSync('git', ['-C', root, 'init', '-q'], { stdio: 'ignore' });
  const validator = new FreshnessValidator({ repoRoot: root, gitRunner: () => { spawns += 1; return ''; } });
  validator.validateLedgerFreshness({ getAllEvidence: () => [] });
  assert.equal(spawns, 0, 'a ledger without an absence performs no git probe');
});
