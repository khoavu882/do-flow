'use strict';

/**
 * G33: Baseline and contracts guard (074 IC-030).
 *
 * Verifies that the pinned benchmark snapshot commit is present in git history,
 * that manifest entries recomputed from git objects at that commit match manifest.json,
 * and that dev tasks conform to IC-013 rules against blobs at the pinned commit.
 *
 * Reads git objects of the pinned snapshot commit, never the working tree and
 * never installed tool versions. Spawns only `git`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const snapshotLib = require('../../bench/retrieval/lib/snapshot.js');
const { validateTaskFile } = require('../../bench/retrieval/lib/tasks.js');
const { sha256Hex } = require('../../bench/retrieval/lib/seal.js');

const REPO = path.resolve(__dirname, '..', '..');

test('G33.1: pinned snapshot commit is present in git history', () => {
  const snapshot = snapshotLib.loadSnapshot();
  const commit = snapshot.commit;
  const run = spawnSync('git', ['-C', REPO, 'cat-file', '-e', `${commit}^{commit}`]);
  if (run.status !== 0) {
    assert.fail('pinned commit absent; CI must fetch full history (fetch-depth 0)');
  }
});

test('G33.2: manifest recomputed from git ls-tree matches manifest.json and manifestSha256', () => {
  const snapshot = snapshotLib.loadSnapshot();
  const manifest = snapshotLib.loadManifest();

  const entries = snapshotLib.buildManifest(REPO, snapshot.commit, snapshot);
  const actualSha = snapshotLib.manifestDigest(entries);

  assert.equal(actualSha, snapshot.manifestSha256, 'recomputed manifest digest must match snapshot.manifestSha256');
  assert.deepEqual(entries, manifest.entries, 'recomputed manifest entries must match manifest.json');
});

test('G33.3: dev task file digest matches snapshot.json and satisfies IC-013 rules', () => {
  const snapshot = snapshotLib.loadSnapshot();
  const manifest = snapshotLib.loadManifest();
  const devFile = path.join(REPO, snapshot.taskFiles.dev.path);

  assert.ok(fs.existsSync(devFile), `dev tasks file must exist at ${devFile}`);
  const rawBytes = fs.readFileSync(devFile);
  const actualSha = sha256Hex(rawBytes);
  assert.equal(actualSha, snapshot.taskFiles.dev.sha256, 'dev tasks file sha256 must match snapshot.taskFiles.dev.sha256');

  const taskFile = JSON.parse(rawBytes.toString('utf8'));
  const findings = validateTaskFile(taskFile, {
    split: 'dev',
    snapshot,
    manifest,
    repoRoot: REPO,
  });

  assert.deepEqual(findings, [], `dev tasks must have 0 findings: ${JSON.stringify(findings)}`);
});

test('G33.3 control: mutated in-memory task missing a required field or anchor is reported with field name', () => {
  const snapshot = snapshotLib.loadSnapshot();
  const manifest = snapshotLib.loadManifest();
  const devFile = path.join(REPO, snapshot.taskFiles.dev.path);
  const taskFile = JSON.parse(fs.readFileSync(devFile, 'utf8'));

  // Control 1: Remove required literal field from exact-lookup task
  const copy1 = structuredClone(taskFile);
  const exactTask = copy1.tasks.find((t) => t.class === 'exact-lookup' && t.literal);
  assert.ok(exactTask, 'must find an exact-lookup task with literal');
  delete exactTask.literal;

  const f1 = validateTaskFile(copy1, { split: 'dev', snapshot, manifest, repoRoot: REPO });
  const missingLiteral = f1.find((f) => f.taskId === exactTask.id && f.code === 'E_FIELD');
  assert.ok(missingLiteral, 'must report E_FIELD for missing literal');
  assert.ok(missingLiteral.message.includes('literal'), 'error message must name the missing field');

  // Control 2: Mutate anchorSha on a qrel
  const copy2 = structuredClone(taskFile);
  const qrelTask = copy2.tasks.find((t) => t.qrels && t.qrels.length > 0);
  assert.ok(qrelTask, 'must find a task with qrels');
  qrelTask.qrels[0].anchorSha = '0'.repeat(64);

  const f2 = validateTaskFile(copy2, { split: 'dev', snapshot, manifest, repoRoot: REPO });
  const badAnchor = f2.find((f) => f.taskId === qrelTask.id && f.code === 'E_QREL_ANCHOR');
  assert.ok(badAnchor, 'must report E_QREL_ANCHOR when anchorSha does not match');
  assert.ok(badAnchor.message.includes('anchorSha'), 'error message must name anchorSha');
});
