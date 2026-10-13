'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger.ts');
const { readPlan } = require('../../src/runtime/retrieval-record.ts');
const sourceVersion = require('../../src/runtime/source-version.ts');
const health = require('../../src/runtime/health.ts');
const originalProbe = health.probeFreshness;
health.probeFreshness = () => ({ state: 'FRESH', artifact: null, refresh: null, label: null, reason: null });
const { handleRetrievalPlanCommand } = require('../../src/runtime/retrieval-plan.ts');

function call(options) {
  const lines = [];
  const log = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try { return { code: handleRetrievalPlanCommand(options), out: lines.join('\n') }; }
  finally { console.log = log; process.exitCode = 0; }
}

test('report rechecks absence freshness against sourceRoot and keys derived attempts by freshness', (t) => {
  const dir = tempDir(t, 'doflow-report-freshness-');
  t.after(() => { health.probeFreshness = originalProbe; });
  const sourceRoot = path.join(dir, 'checkout');
  const stateRoot = path.join(dir, 'state');
  fs.mkdirSync(sourceRoot);
  fs.mkdirSync(stateRoot);
  fs.writeFileSync(path.join(sourceRoot, 'tracked.js'), 'before\n');
  execFileSync('git', ['init', '-q'], { cwd: sourceRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: sourceRoot });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: sourceRoot });
  execFileSync('git', ['add', 'tracked.js'], { cwd: sourceRoot });
  execFileSync('git', ['commit', '-qm', 'initial'], { cwd: sourceRoot });

  assert.equal(call({ taskId: 'freshness-report', action: 'declare', need: 'locate-known-symbol',
    stateRoot, sourceRoot, json: true }).code, 0);
  const plan = readPlan(stateRoot, 'freshness-report');
  const need = plan.needs[0];
  const tree = sourceVersion.measureTreeState(sourceRoot);
  const ledger = new EvidenceLedger({ repoRoot: stateRoot });
  ledger.addEvidence({ taskId: 'freshness-report', kind: 'structural', result: 'EMPTY',
    source: { provider: need.provider, capability: need.capability, queryRef: need.queryRef },
    freshness: { status: 'FRESH', gitCommit: tree.gitCommit, treeFingerprint: tree.fingerprint } });
  ledger.save('freshness-report');

  fs.writeFileSync(path.join(sourceRoot, 'tracked.js'), 'after\n');
  const report = call({ taskId: 'freshness-report', action: 'report', need: need.intent,
    stateRoot, sourceRoot, json: true });
  assert.equal(report.code, 0, report.out);
  const output = JSON.parse(report.out);
  assert.equal(output.needs[0].result, 'EMPTY');
  const derived = output.needs[0].attempts.find((attempt) => attempt.recordedBy === 'derived');
  assert.ok(derived);
  assert.equal(derived.indexState, 'STALE');
  assert.equal(derived.reason, 'index-stale');
});
