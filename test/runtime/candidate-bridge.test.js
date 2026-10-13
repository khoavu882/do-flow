'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');

const { CANDIDATE_FIELDS, toEvidence } = require('../../src/runtime/candidate.ts');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger.ts');
const { measureTreeState, sourceVersionFor, clearTreeStateCache } = require('../../src/runtime/source-version.ts');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');

test('C.1: CANDIDATE_FIELDS lists the 7 canonical candidate fields in IC-009', () => {
  assert.deepEqual(CANDIDATE_FIELDS, [
    'locator',
    'provider',
    'capability',
    'need',
    'sourceVersion',
    'rank',
    'score',
  ]);
});

test('C.1: a candidate with rank: 1, score: 0.85 persists without either', (t) => {
  const dir = tempDir(t, 'doflow-cb-persist-');
  fs.writeFileSync(path.join(dir, 'a.js'), 'module.exports = { x: 1 };\n');
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', 'a.js');
  git('commit', '-m', 'init');

  clearTreeStateCache();
  const treeState = measureTreeState(dir);
  const sv = sourceVersionFor(dir, { file: 'a.js' }, treeState);

  const candidate = {
    locator: { file: 'a.js', line: 1 },
    provider: 'ripgrep',
    capability: 'code.exact-search',
    rank: 1,
    score: 0.85,
    sourceVersion: {
      fileHash: sv.fileHash,
    },
  };

  const evidenceInput = toEvidence(
    { candidate },
    { taskId: 'task-a', root: dir, treeState, kind: 'exact-search', provenance: 'extracted' }
  );

  // In memory check: rank and score stripped
  assert.equal('rank' in evidenceInput, false);
  assert.equal('score' in evidenceInput, false);
  assert.equal(evidenceInput.rank, undefined);
  assert.equal(evidenceInput.score, undefined);
  assert.deepEqual(evidenceInput.source, { provider: 'ripgrep', capability: 'code.exact-search' });
  assert.deepEqual(evidenceInput.locator, { file: 'a.js', line: 1 });

  // Persistence check: writing to EvidenceLedger succeeds and persists without rank or score
  const ledger = new EvidenceLedger({ repoRoot: dir });
  const id = ledger.addEvidence(evidenceInput);
  ledger.save('task-a');

  const inMemRecord = ledger.getEvidence(id);
  assert.ok(inMemRecord);
  assert.equal('rank' in inMemRecord, false);
  assert.equal('score' in inMemRecord, false);

  const statePath = path.join(dir, '.doflow', 'state', 'evidence', 'task-a.json');
  assert.ok(fs.existsSync(statePath));
  const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const diskItem = onDisk.evidence.find((item) => item.id === id);
  assert.ok(diskItem);
  assert.equal('rank' in diskItem, false);
  assert.equal('score' in diskItem, false);
});

test('C.1: a raw item with score exits 2', (t) => {
  const dir = tempDir(t, 'doflow-cb-raw-');
  fs.writeFileSync(path.join(dir, 'a.js'), 'module.exports = { x: 1 };\n');
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', 'a.js');
  git('commit', '-m', 'init');

  const batchFile = path.join(dir, 'batch.json');
  fs.writeFileSync(
    batchFile,
    JSON.stringify([
      {
        kind: 'exact-search',
        provenance: 'extracted',
        source: { provider: 'grep', capability: 'code.exact-search' },
        locator: 'a.js:1',
        score: 0.85,
      },
    ])
  );

  const res = spawnSync(process.execPath, [DOFLOW, 'evidence', '--task-id', 'task-a', '--action', 'add', '--batch', batchFile], {
    cwd: dir,
    env: { ...process.env, HOME: dir },
    encoding: 'utf8',
  });

  assert.equal(res.status, 2);
  assert.match(res.stderr + res.stdout, /is a retrieval score and this boundary records none/);

  // Direct toEvidence call throws scoreFieldRefusal rather than stripping
  assert.throws(
    () =>
      toEvidence(
        {
          item: {
            kind: 'exact-search',
            provenance: 'extracted',
            source: { provider: 'grep', capability: 'code.exact-search' },
            locator: 'a.js:1',
            score: 0.85,
          },
        },
        { taskId: 'task-a', root: dir }
      ),
    /is a retrieval score and this boundary records none/
  );
});

test('C.1: a changed file refuses', (t) => {
  const dir = tempDir(t, 'doflow-cb-changed-');
  const filePath = path.join(dir, 'target.txt');
  fs.writeFileSync(filePath, 'version 1 initial text\n');
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', 'target.txt');
  git('commit', '-m', 'init');

  clearTreeStateCache();
  const state = measureTreeState(dir);
  const sv = sourceVersionFor(dir, { file: 'target.txt' }, state);
  assert.ok(sv.fileHash);

  const candidate = {
    locator: { file: 'target.txt' },
    provider: 'ripgrep',
    capability: 'code.exact-search',
    sourceVersion: {
      fileHash: sv.fileHash,
    },
  };

  // Modify file on disk so fileHash differs
  fs.writeFileSync(filePath, 'version 2 modified text\n');

  assert.throws(
    () => toEvidence({ candidate }, { taskId: 'task-a', root: dir, kind: 'exact-search', provenance: 'extracted' }),
    (err) => {
      assert.match(err.message, /^the file changed between the search and this record/);
      assert.match(err.message, /target\.txt: searched [0-9a-f]{7}, now [0-9a-f]{7}/);
      assert.match(err.message, /Re-run the search and record the new result\.$/);
      return true;
    }
  );
});

test('C.1: an unknown candidate field refuses', (t) => {
  const dir = tempDir(t, 'doflow-cb-unknown-');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');

  const candidate = {
    locator: { file: 'a.txt' },
    provider: 'ripgrep',
    capability: 'code.exact-search',
    unknownField: 'invalid',
  };

  assert.throws(
    () => toEvidence({ candidate }, { taskId: 'task-a', root: dir, kind: 'exact-search', provenance: 'extracted' }),
    /unknown candidate field 'unknownField'\. Accepted: locator, provider, capability, need, sourceVersion, rank, score/
  );
});

test('C.1: a candidate whose locator file is missing is refused by the item validator', (t) => {
  const dir = tempDir(t, 'doflow-cb-missing-');
  const candidate = {
    locator: { file: 'does-not-exist.js' },
    provider: 'ripgrep',
    capability: 'code.exact-search',
  };

  assert.throws(
    () =>
      toEvidence(
        { candidate },
        { taskId: 'task-a', root: dir, kind: 'exact-search', provenance: 'extracted' }
      ),
    /the locator does not resolve/
  );
});

test('C.1: a candidate freshness equals what a raw item with the same locator gets', (t) => {
  const dir = tempDir(t, 'doflow-cb-fresh-path-');
  fs.writeFileSync(path.join(dir, 'file.txt'), 'hello world\n');
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', 'file.txt');
  git('commit', '-m', 'init');

  clearTreeStateCache();
  const state = measureTreeState(dir);
  const sv = sourceVersionFor(dir, { file: 'file.txt' }, state);

  const candidate = {
    locator: { file: 'file.txt' },
    provider: 'ripgrep',
    capability: 'code.exact-search',
    sourceVersion: {
      fileHash: sv.fileHash,
    },
  };

  const rawItem = {
    kind: 'exact-search',
    provenance: 'extracted',
    source: { provider: 'ripgrep', capability: 'code.exact-search' },
    locator: { file: 'file.txt' },
  };

  const ctx = {
    taskId: 'task-a',
    root: dir,
    treeState: state,
    kind: 'exact-search',
    provenance: 'extracted',
  };

  const candidateResult = toEvidence({ candidate }, ctx);
  const rawItemResult = toEvidence({ item: rawItem }, ctx);

  assert.deepEqual(candidateResult.freshness, rawItemResult.freshness);
  assert.equal(candidateResult.freshness.status, 'FRESH');
  assert.equal(candidateResult.freshness.fileHash, sv.fileHash);
  assert.equal(candidateResult.freshness.isDirty, false);
});

test('C.1: candidate path validates kind, provenance and taskId without defaults', (t) => {
  const dir = tempDir(t, 'doflow-cb-nodefaults-');
  fs.writeFileSync(path.join(dir, 'a.js'), 'const x = 1;\n');

  const candidate = {
    locator: { file: 'a.js' },
    provider: 'ripgrep',
    capability: 'code.exact-search',
  };

  // taskId missing
  assert.throws(
    () => toEvidence({ candidate }, { root: dir, kind: 'exact-search', provenance: 'extracted' }),
    /taskId is required/
  );

  // kind missing
  assert.throws(
    () => toEvidence({ candidate }, { taskId: 'task-a', root: dir, provenance: 'extracted' }),
    /kind is required/
  );

  // provenance missing
  assert.throws(
    () => toEvidence({ candidate }, { taskId: 'task-a', root: dir, kind: 'exact-search' }),
    /provenance is required/
  );
});
