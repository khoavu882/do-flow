'use strict';
// runtime-evidence-absence.test.js — absence records, provider freshness probing, and refusals
// (feature 076, plan task C.3; IC-006, DEC-009, DEC-010, DEC-018, DEC-019).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../helper/tmp.ts');
const { spawnSync, execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');

/** A git-backed scratch project. */
function project(label) {
  const real = suiteTempDir(`doflow-runtime-evidence-absence-${label}-`);
  fs.writeFileSync(path.join(real, 'a.js'), 'module.exports = { x: 1 };\n');
  const git = (...args) => execFileSync('git', ['-C', real, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return real;
}

function run(cwd, args, { input } = {}) {
  const res = spawnSync('node', [DOFLOW, ...args], {
    cwd,
    env: { ...process.env, HOME: cwd },
    input: input ?? '',
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function json(cwd, args, { input } = {}) {
  const res = run(cwd, [...args, '--json'], { input });
  try {
    return { ...res, data: JSON.parse(res.stdout) };
  } catch (error) {
    throw new Error(`expected JSON on stdout for '${args.join(' ')}':\n${res.stdout}\n${res.stderr}`);
  }
}

test('an absence against a STALE fixture index is written STALE', () => {
  const root = project('stale-index');
  const graphDir = path.join(root, 'graphify-out');
  fs.mkdirSync(graphDir, { recursive: true });
  const graphFile = path.join(graphDir, 'graph.json');
  fs.writeFileSync(graphFile, JSON.stringify({ nodes: [], edges: [] }));

  // Make graph.json older than a.js so probeFreshness evaluates to STALE
  const oldTime = (Date.now() - 200000) / 1000;
  fs.utimesSync(graphFile, oldTime, oldTime);

  const decl = run(root, [
    'retrieval-plan',
    '--task-id', 'task-1',
    '--action', 'declare',
    '--need', 'trace-dependency',
    '--stage', 'implementation',
  ]);
  assert.equal(decl.status, 0);

  const res = json(root, [
    'evidence',
    '--task-id', 'task-1',
    '--action', 'add',
    '--kind', 'structural',
    '--provenance', 'extracted',
    '--provider', 'graphify.query',
    '--capability', 'code.relationships',
    '--absence',
    '--need', 'trace-dependency',
    '--content', 'no dependents found',
  ]);
  assert.equal(res.status, 0);
  assert.equal(res.data.written, 1);
  const item = res.data.evidence[0];
  assert.equal(item.result, 'EMPTY');
  assert.equal(item.freshness.status, 'STALE');
  assert.equal(item.freshness.fileHash, null);
  assert.equal(item.freshness.isDirty, null);
  assert.match(item.freshness.treeFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(item.locator, {});
  assert.match(item.source.queryRef, /^rp_[a-z0-9]+_[a-z0-9]+#trace-dependency$/);
});

test('after refreshing the fixture index, a second absence is FRESH without a re-declare', () => {
  const root = project('refresh-index');
  const graphDir = path.join(root, 'graphify-out');
  fs.mkdirSync(graphDir, { recursive: true });
  const graphFile = path.join(graphDir, 'graph.json');
  fs.writeFileSync(graphFile, JSON.stringify({ nodes: [], edges: [] }));

  // First state: STALE
  const oldTime = (Date.now() - 200000) / 1000;
  fs.utimesSync(graphFile, oldTime, oldTime);

  const decl = run(root, [
    'retrieval-plan',
    '--task-id', 'task-refresh',
    '--action', 'declare',
    '--need', 'trace-dependency',
    '--stage', 'implementation',
  ]);
  assert.equal(decl.status, 0);

  const firstWrite = json(root, [
    'evidence',
    '--task-id', 'task-refresh',
    '--action', 'add',
    '--kind', 'structural',
    '--provenance', 'extracted',
    '--provider', 'graphify.query',
    '--capability', 'code.relationships',
    '--absence',
    '--need', 'trace-dependency',
    '--content', 'no dependents found',
  ]);
  assert.equal(firstWrite.status, 0);
  assert.equal(firstWrite.data.evidence[0].freshness.status, 'STALE');

  // Refresh fixture index on disk: make graph.json newer than all source files
  const newTime = (Date.now() + 100000) / 1000;
  fs.utimesSync(graphFile, newTime, newTime);

  // Second absence written without re-declaring plan
  const secondWrite = json(root, [
    'evidence',
    '--task-id', 'task-refresh',
    '--action', 'add',
    '--kind', 'structural',
    '--provenance', 'extracted',
    '--provider', 'graphify.query',
    '--capability', 'code.relationships',
    '--absence',
    '--need', 'trace-dependency',
    '--content', 'still no dependents found',
  ]);
  assert.equal(secondWrite.status, 0);
  const secondItem = secondWrite.data.evidence[0];
  assert.equal(secondItem.result, 'EMPTY');
  assert.equal(secondItem.freshness.status, 'FRESH');
  assert.match(secondItem.freshness.treeFingerprint, /^sha256:[0-9a-f]{64}$/);
});

test('an unmapped index provider gives UNKNOWN', () => {
  const root = project('unmapped-provider');
  const decl = run(root, [
    'retrieval-plan',
    '--task-id', 'task-unmapped',
    '--action', 'declare',
    '--need', 'locate-known-symbol',
    '--stage', 'implementation',
  ]);
  assert.equal(decl.status, 0);

  const res = json(root, [
    'evidence',
    '--task-id', 'task-unmapped',
    '--action', 'add',
    '--kind', 'exact-search',
    '--provenance', 'extracted',
    '--provider', 'custom.unmapped-indexer',
    '--capability', 'code.exact-search',
    '--absence',
    '--need', 'locate-known-symbol',
    '--content', 'symbol not found',
  ]);
  assert.equal(res.status, 0);
  const item = res.data.evidence[0];
  assert.equal(item.result, 'EMPTY');
  assert.equal(item.freshness.status, 'UNKNOWN');
  assert.match(item.freshness.treeFingerprint, /^sha256:[0-9a-f]{64}$/);
});

test('native.rg gives FRESH with a fingerprint', () => {
  const root = project('native-rg');
  const decl = run(root, [
    'retrieval-plan',
    '--task-id', 'task-rg',
    '--action', 'declare',
    '--need', 'locate-known-symbol',
    '--stage', 'implementation',
  ]);
  assert.equal(decl.status, 0);

  const res = json(root, [
    'evidence',
    '--task-id', 'task-rg',
    '--action', 'add',
    '--kind', 'exact-search',
    '--provenance', 'extracted',
    '--provider', 'native.rg',
    '--capability', 'code.exact-search',
    '--absence',
    '--need', 'locate-known-symbol',
    '--content', 'no matches',
  ]);
  assert.equal(res.status, 0);
  const item = res.data.evidence[0];
  assert.equal(item.result, 'EMPTY');
  assert.equal(item.freshness.status, 'FRESH');
  assert.match(item.freshness.treeFingerprint, /^sha256:[0-9a-f]{64}$/);
});

test('outside git, a native.rg absence is UNKNOWN with no fingerprint', () => {
  const root = suiteTempDir('doflow-runtime-evidence-nogit-');
  fs.writeFileSync(path.join(root, 'a.js'), 'console.log(1);\n');

  const decl = run(root, [
    'retrieval-plan',
    '--task-id', 'task-nogit',
    '--action', 'declare',
    '--need', 'locate-known-symbol',
    '--stage', 'implementation',
  ]);
  assert.equal(decl.status, 0);

  const res = json(root, [
    'evidence',
    '--task-id', 'task-nogit',
    '--action', 'add',
    '--kind', 'exact-search',
    '--provenance', 'extracted',
    '--provider', 'native.rg',
    '--capability', 'code.exact-search',
    '--absence',
    '--need', 'locate-known-symbol',
    '--content', 'no matches',
  ]);
  assert.equal(res.status, 0);
  const item = res.data.evidence[0];
  assert.equal(item.result, 'EMPTY');
  assert.equal(item.freshness.status, 'UNKNOWN');
  assert.equal(item.freshness.gitCommit, null);
  assert.equal(item.freshness.treeFingerprint, undefined);
});

test('each absence refusal exits 2 with its message', () => {
  const root = project('refusals');
  const decl = run(root, [
    'retrieval-plan',
    '--task-id', 'task-refuse',
    '--action', 'declare',
    '--need', 'locate-known-symbol',
    '--need', 'inspect-history',
    '--stage', 'implementation',
  ]);
  assert.equal(decl.status, 0);

  // 1. --absence without --need (with declared plan)
  const r1 = run(root, [
    'evidence',
    '--task-id', 'task-refuse',
    '--action', 'add',
    '--kind', 'exact-search',
    '--provenance', 'extracted',
    '--provider', 'native.rg',
    '--capability', 'code.exact-search',
    '--absence',
  ]);
  assert.equal(r1.status, 2);
  assert.equal(
    r1.stderr.trim(),
    "doflow evidence: --absence needs --need <intent>: an empty answer means nothing without the query it answered. Declared intents for task 'task-refuse': inspect-history, locate-known-symbol."
  );

  // 1b. --absence without --need (no plan declared)
  const r1b = run(root, [
    'evidence',
    '--task-id', 'task-noplan',
    '--action', 'add',
    '--kind', 'exact-search',
    '--provenance', 'extracted',
    '--provider', 'native.rg',
    '--capability', 'code.exact-search',
    '--absence',
  ]);
  assert.equal(r1b.status, 2);
  assert.equal(
    r1b.stderr.trim(),
    "doflow evidence: --absence needs --need <intent>: an empty answer means nothing without the query it answered. Declared intents for task 'task-noplan': none declared."
  );

  // 2. --absence with a locator
  const r2 = run(root, [
    'evidence',
    '--task-id', 'task-refuse',
    '--action', 'add',
    '--kind', 'exact-search',
    '--provenance', 'extracted',
    '--provider', 'native.rg',
    '--capability', 'code.exact-search',
    '--absence',
    '--need', 'locate-known-symbol',
    '--locator', 'a.js',
  ]);
  assert.equal(r2.status, 2);
  assert.equal(
    r2.stderr.trim(),
    'doflow evidence: an absence record carries no locator: it states that the provider found nothing. Drop --locator, or record what was found as an ordinary item with --need <intent>.'
  );

  // 3. --absence with provenance other than extracted
  const r3 = run(root, [
    'evidence',
    '--task-id', 'task-refuse',
    '--action', 'add',
    '--kind', 'exact-search',
    '--provenance', 'inferred',
    '--provider', 'native.rg',
    '--capability', 'code.exact-search',
    '--absence',
    '--need', 'locate-known-symbol',
    '--content', 'no matches',
  ]);
  assert.equal(r3.status, 2);
  assert.equal(
    r3.stderr.trim(),
    "doflow evidence: an absence record must be 'extracted': it is the provider's answer as you read it. Re-run with --provenance extracted."
  );

  // 4. --absence with an observation
  const r4 = run(root, [
    'evidence',
    '--task-id', 'task-refuse',
    '--action', 'add',
    '--kind', 'test-result',
    '--provenance', 'extracted',
    '--provider', 'native.rg',
    '--capability', 'code.exact-search',
    '--absence',
    '--need', 'locate-known-symbol',
    '--observed-command', 'npm test',
  ]);
  assert.equal(r4.status, 2);
  assert.equal(
    r4.stderr.trim(),
    'doflow evidence: an absence record carries no observation: it records a lookup, not an execution. Drop the observation.'
  );

  // Batch refusal
  const batchPath = path.join(root, 'batch-with-locator.json');
  fs.writeFileSync(
    batchPath,
    JSON.stringify([
      {
        kind: 'exact-search',
        provenance: 'extracted',
        source: { provider: 'native.rg', capability: 'code.exact-search' },
        absence: true,
        locator: 'a.js',
        need: 'locate-known-symbol',
      },
    ])
  );
  const rBatch = run(root, [
    'evidence',
    '--task-id', 'task-refuse',
    '--action', 'add',
    '--batch', batchPath,
  ]);
  assert.equal(rBatch.status, 2);
  assert.equal(
    rBatch.stderr.trim(),
    'doflow evidence: an absence record carries no locator: it states that the provider found nothing. Drop --locator, or record what was found as an ordinary item with --need <intent>.'
  );
});
