'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { measureFreshness, FreshnessValidator } = require('../../src/runtime/freshness.ts');
const { measureTreeState } = require('../../src/runtime/source-version.ts');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger.ts');

const CLI = path.resolve(__dirname, '../../bin/doflow.js');

function project(t, gitBacked = false) {
  const root = tempDir(t, 'doflow-freshness-observations-');
  fs.writeFileSync(path.join(root, 'a.js'), 'module.exports = 1;\n');
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  if (gitBacked) {
    git('init', '-q');
    git('add', 'a.js');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial');
  }
  return { root, git };
}

function cli(root, ...args) {
  const result = spawnSync(process.execPath, [CLI, ...args, '--json'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, HOME: root, USERPROFILE: root },
  });
  return { ...result, data: result.stdout ? JSON.parse(result.stdout) : null };
}

test('freshness describes observed bytes, including dirty files and later commits', (t) => {
  const { root, git } = project(t, true);
  const file = path.join(root, 'a.js');
  fs.writeFileSync(file, 'module.exports = 2;\n');
  const item = { locator: { file: 'a.js', line: 1 }, freshness: measureFreshness(root, { file: 'a.js' }, git('rev-parse', 'HEAD')) };
  const check = () => new FreshnessValidator({ repoRoot: root }).checkEvidenceFreshness(item).status;
  assert.equal(check(), 'FRESH', 'an observation made after an edit is fresh');
  git('add', 'a.js');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'observed edit');
  assert.equal(check(), 'FRESH', 'committing identical observed bytes does not expire evidence');
  fs.writeFileSync(file, 'module.exports = 3;\n');
  assert.equal(check(), 'STALE');
  fs.writeFileSync(file, 'module.exports = 2;\n');
  assert.equal(check(), 'FRESH', 'restored observed bytes can be checked again');
});

test('content observations expire without Git, including deletion', (t) => {
  const { root } = project(t);
  const item = { locator: { file: 'a.js' }, freshness: measureFreshness(root, { file: 'a.js' }, null) };
  const check = () => new FreshnessValidator({ repoRoot: root }).checkEvidenceFreshness(item).status;
  assert.equal(check(), 'FRESH');
  fs.writeFileSync(path.join(root, 'a.js'), 'module.exports = 4;\n');
  assert.equal(check(), 'STALE');
  fs.unlinkSync(path.join(root, 'a.js'));
  assert.equal(check(), 'STALE');
});

test('a changed observation keeps readiness off READY, and completion is refused on that recorded verdict', (t) => {
  const { root } = project(t, true);
  const task = 'freshness-boundary';
  const added = cli(root, 'evidence', '--action', 'add', '--task-id', task,
    '--kind', 'exact-search', '--provenance', 'extracted', '--provider', 'local-read',
    '--capability', 'code.exact-search', '--locator', 'a.js:1',
    '--establishes', 'target_identified');
  assert.equal(added.status, 0, added.stderr);
  assert.equal(cli(root, 'orchestrate', '--action', 'start', '--task-id', task, '--task-class', 'trivial-edit').status, 0);
  fs.writeFileSync(path.join(root, 'a.js'), 'module.exports = 5;\n');
  const readiness = cli(root, 'readiness', '--task-id', task, '--task-class', 'trivial-edit', '--scope', 'a.js only');
  assert.equal(readiness.data.state, 'NEEDS_EVIDENCE');
  // Completion reads the evaluation `readiness` just recorded rather than grading inputs of its own.
  const completion = cli(root, 'orchestrate', '--action', 'complete-stage', '--task-id', task,
    '--task-class', 'trivial-edit', '--stage', 'implementation', '--scope', 'a.js only');
  assert.notEqual(completion.status, 0, 'completion is refused on the same stale observation');
  assert.match(completion.stderr, new RegExp(`task '${task}' was last evaluated NEEDS_EVIDENCE at \\S+ against the 'trivial-edit' template, not READY`));
});

test('completion reads the recorded verdict, not the tree: a READY record stays READY after its observation changes', (t) => {
  const { root } = project(t, true);
  const task = 'freshness-after-ready';
  const added = cli(root, 'evidence', '--action', 'add', '--task-id', task,
    '--kind', 'exact-search', '--provenance', 'extracted', '--provider', 'local-read',
    '--capability', 'code.exact-search', '--locator', 'a.js:1',
    '--establishes', 'target_identified');
  assert.equal(added.status, 0, added.stderr);
  assert.equal(cli(root, 'orchestrate', '--action', 'start', '--task-id', task, '--task-class', 'trivial-edit').status, 0);
  assert.equal(cli(root, 'readiness', '--task-id', task, '--task-class', 'trivial-edit', '--scope', 'a.js').data.state, 'READY');
  fs.writeFileSync(path.join(root, 'a.js'), 'module.exports = 6;\n');
  // Readiness is graded once, before the work; the edit that follows is the work itself.
  const completion = cli(root, 'orchestrate', '--action', 'complete-stage', '--task-id', task,
    '--task-class', 'trivial-edit', '--stage', 'implementation');
  assert.equal(completion.status, 0, completion.stderr);
  assert.equal(cli(root, 'readiness', '--task-id', task, '--task-class', 'trivial-edit', '--scope', 'a.js').data.state, 'NEEDS_EVIDENCE',
    'a fresh evaluation does see the change');
});

function makeAbsenceItem(root, runner) {
  const state = measureTreeState(root, runner);
  return {
    kind: 'structural',
    provenance: 'extracted',
    source: { provider: 'native.rg', capability: 'code.exact-search' },
    locator: {},
    content: 'no matches found',
    establishes: ['target_identified'],
    result: 'EMPTY',
    freshness: {
      gitCommit: state.gitCommit,
      fileHash: null,
      isDirty: null,
      treeFingerprint: state.fingerprint,
      observedAt: new Date().toISOString(),
      status: 'FRESH',
    },
  };
}

test('a FRESH absence goes STALE after a new commit', (t) => {
  const { root, git } = project(t, true);
  const item = makeAbsenceItem(root);
  const validator = new FreshnessValidator({ repoRoot: root });
  assert.equal(validator.checkEvidenceFreshness(item).status, 'FRESH');

  fs.writeFileSync(path.join(root, 'b.js'), 'module.exports = 2;\n');
  git('add', 'b.js');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'second commit');

  const check = validator.checkEvidenceFreshness(item);
  assert.equal(check.status, 'STALE');
  assert.equal(check.reason, 'tree-changed-since-recorded');

  const ledger = new EvidenceLedger();
  ledger.addEvidence(item);
  assert.equal(ledger.getAllEvidence()[0].freshness.status, 'FRESH');
  const count = validator.validateLedgerFreshness(ledger);
  assert.equal(count, 1);
  assert.equal(ledger.getAllEvidence()[0].freshness.status, 'STALE');
});

test('it goes STALE after an uncommitted edit to a clean tracked file', (t) => {
  const { root, git } = project(t, true);
  const item = makeAbsenceItem(root);
  const validator = new FreshnessValidator({ repoRoot: root });
  assert.equal(validator.checkEvidenceFreshness(item).status, 'FRESH');

  fs.writeFileSync(path.join(root, 'a.js'), 'module.exports = 99;\n');

  const check = validator.checkEvidenceFreshness(item);
  assert.equal(check.status, 'STALE');
  assert.equal(check.reason, 'tree-changed-since-recorded');

  const ledger = new EvidenceLedger();
  ledger.addEvidence(item);
  const count = validator.validateLedgerFreshness(ledger);
  assert.equal(count, 1);
  assert.equal(ledger.getAllEvidence()[0].freshness.status, 'STALE');
});

test('it goes STALE after a second edit to a file that was dirty at record time', (t) => {
  const { root, git } = project(t, true);
  fs.writeFileSync(path.join(root, 'a.js'), 'dirty one\n');
  const item = makeAbsenceItem(root);
  const validator = new FreshnessValidator({ repoRoot: root });
  assert.equal(validator.checkEvidenceFreshness(item).status, 'FRESH');

  const futureSec = Math.floor(Date.now() / 1000) + 10;
  fs.writeFileSync(path.join(root, 'a.js'), 'dirty two with noticeably more content\n');
  fs.utimesSync(path.join(root, 'a.js'), futureSec, futureSec);

  const check = validator.checkEvidenceFreshness(item);
  assert.equal(check.status, 'STALE');
  assert.equal(check.reason, 'tree-changed-since-recorded');

  const ledger = new EvidenceLedger();
  ledger.addEvidence(item);
  const count = validator.validateLedgerFreshness(ledger);
  assert.equal(count, 1);
  assert.equal(ledger.getAllEvidence()[0].freshness.status, 'STALE');
});

test('it stays FRESH with no change', (t) => {
  const { root, git } = project(t, true);
  const item = makeAbsenceItem(root);
  const validator = new FreshnessValidator({ repoRoot: root });
  const check = validator.checkEvidenceFreshness(item);
  assert.equal(check.status, 'FRESH');

  const ledger = new EvidenceLedger();
  ledger.addEvidence(item);
  const count = validator.validateLedgerFreshness(ledger);
  assert.equal(count, 0);
  assert.equal(ledger.getAllEvidence()[0].freshness.status, 'FRESH');
});

test('one pass over three absence items spawns git once', (t) => {
  const { root, git } = project(t, true);
  const ledger = new EvidenceLedger();
  for (let i = 0; i < 3; i++) {
    const item = makeAbsenceItem(root);
    item.content = `absence ${i}`;
    ledger.addEvidence(item);
  }

  let spawns = 0;
  const countingRunner = (args, cwd) => {
    spawns++;
    return execFileSync('git', args, { cwd: cwd || root, encoding: 'utf8' });
  };

  const validator = new FreshnessValidator({ repoRoot: root, gitRunner: countingRunner });
  spawns = 0;
  const count = validator.validateLedgerFreshness(ledger);
  assert.equal(spawns, 1, 'expected exactly one git spawn for three absence items in one pass');
  assert.equal(count, 0, 'items should stay fresh with no changes');
});

test('standalone absence checks remeasure while one ledger pass shares a fingerprint', (t) => {
  const { root } = project(t, true);
  const item = makeAbsenceItem(root);
  let spawns = 0;
  const countingRunner = (args, cwd) => {
    spawns++;
    return execFileSync('git', args, { cwd: cwd || root, encoding: 'utf8' });
  };
  const validator = new FreshnessValidator({ repoRoot: root, gitRunner: countingRunner });

  assert.equal(validator.checkEvidenceFreshness(item).status, 'FRESH');
  fs.writeFileSync(path.join(root, 'a.js'), 'changed after absence was recorded\n');
  assert.equal(validator.checkEvidenceFreshness(item).status, 'STALE');

  const ledger = new EvidenceLedger();
  ledger.addEvidence(item);
  ledger.addEvidence({ ...item, content: 'second absence' });
  spawns = 0;
  validator.validateLedgerFreshness(ledger);
  assert.equal(spawns, 1, 'two absence items in one pass share one git status measurement');
});

test('a FRESH absence with missing or unmeasurable fingerprint returns STALE tree-unverifiable', (t) => {
  const { root, git } = project(t, true);
  const itemMissingFp = makeAbsenceItem(root);
  itemMissingFp.freshness.treeFingerprint = null;
  const validator = new FreshnessValidator({ repoRoot: root });
  const check1 = validator.checkEvidenceFreshness(itemMissingFp);
  assert.equal(check1.status, 'STALE');
  assert.equal(check1.reason, 'tree-unverifiable');

  const nonGitRoot = tempDir(t, 'doflow-freshness-nongit-');
  const itemInNonGit = makeAbsenceItem(root);
  const validatorNonGit = new FreshnessValidator({ repoRoot: nonGitRoot });
  const check2 = validatorNonGit.checkEvidenceFreshness(itemInNonGit);
  assert.equal(check2.status, 'STALE');
  assert.equal(check2.reason, 'tree-unverifiable');
});

