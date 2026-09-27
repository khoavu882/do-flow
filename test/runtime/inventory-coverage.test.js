'use strict';
// C6, the repair-coverage annotator (FR-006). `repairCoverage` is pure, so most cases here are
// plain objects; the two that exercise `readScopeLocks` use scratch directories and never read or
// write the real ~/.doflow.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultLock, writeLock } = require('../../src/state/lockfile');
const { repairCoverage, readScopeLocks, REPAIR_REASONS } = require('../../src/runtime/inventory/coverage');

/** A lock document pinning the named harnesses, shaped as `lockDocument` builds it. */
function lockPinning(scope, harnesses, scopeRoot = '/scope') {
  return { ...defaultLock({ scope, scopeRoot }), targets: harnesses.map((harness) => ({ harness })) };
}

/** A finding the repair path could in principle act on — the interesting axis is the lock. */
function finding(harness, scope, id = `${harness}:${scope}`) {
  return { id, harness, scope, repairPath: 'reconcile' };
}

test('findings exceeding what the lock pins are partially repairable, with the counts stated', () => {
  // The measured asymmetry in miniature: the ledger produced findings for five harnesses at global
  // scope, the global lock pins only codex.
  const findings = ['codex', 'claude', 'gemini', 'opencode', 'kiro'].map((harness) => finding(harness, 'global'));
  const coverage = repairCoverage({ findings, locks: { global: lockPinning('global', ['codex']) } });

  assert.equal(coverage.findings, 5);
  assert.equal(coverage.repairable, 1);
  assert.equal(coverage.unrepairable, 4);
  assert.equal(coverage.complete, false);
  assert.equal(coverage.reasons[REPAIR_REASONS.HARNESS_NOT_PINNED], 4);
  assert.equal(coverage.scopes.global.findings, 5);
  assert.equal(coverage.scopes.global.repairable, 1);
  assert.deepEqual(coverage.scopes.global.targets, ['codex']);
  assert.match(coverage.summary, /1 of 5/);
});

test('a scope with no lock has zero repair coverage, not full coverage', () => {
  const findings = [finding('claude', 'project'), finding('codex', 'project')];
  const coverage = repairCoverage({ findings, locks: { project: null } });

  assert.equal(coverage.repairable, 0);
  assert.equal(coverage.unrepairable, 2);
  assert.equal(coverage.complete, false, 'an unpinned scope must never read as fully covered');
  assert.equal(coverage.scopes.project.lock, 'absent');
  assert.equal(coverage.scopes.project.pinned, false);
  assert.deepEqual(coverage.scopes.project.targets, []);
  assert.equal(coverage.reasons[REPAIR_REASONS.SCOPE_NOT_PINNED], 2);
  for (const row of coverage.details) assert.equal(row.repairable, false);
});

test('an omitted lock entry is treated the same as an explicit null — still zero coverage', () => {
  const coverage = repairCoverage({ findings: [finding('claude', 'global')], locks: {} });
  assert.equal(coverage.repairable, 0);
  assert.equal(coverage.scopes.global.lock, 'absent');
  assert.equal(coverage.details[0].reason, REPAIR_REASONS.SCOPE_NOT_PINNED);
});

test('a lock that exists but pins no targets also has zero coverage, and is distinguishable from an absent one', () => {
  // `reconcile` short-circuits on `!lock || !lock.targets.length`, so both states repair nothing;
  // they stay distinct in the report because they mean different things to a reader.
  const coverage = repairCoverage({
    findings: [finding('claude', 'project')],
    locks: { project: lockPinning('project', []) },
  });
  assert.equal(coverage.repairable, 0);
  assert.equal(coverage.scopes.project.lock, 'empty');
  assert.equal(coverage.scopes.project.pinned, false);
  assert.equal(coverage.details[0].reason, REPAIR_REASONS.SCOPE_NOT_PINNED);
});

test('a lock covering every finding yields full coverage', () => {
  const findings = [finding('claude', 'project'), finding('codex', 'project'), finding('claude', 'project', 'second')];
  const coverage = repairCoverage({ findings, locks: { project: lockPinning('project', ['claude', 'codex']) } });

  assert.equal(coverage.findings, 3);
  assert.equal(coverage.repairable, 3);
  assert.equal(coverage.unrepairable, 0);
  assert.equal(coverage.complete, true);
  assert.deepEqual(coverage.reasons, {});
  assert.equal(coverage.scopes.project.repairable, 3);
  assert.match(coverage.summary, /All 3/);
});

test('a harness recorded in the ledger but absent from the lock is counted unrepairable', () => {
  const coverage = repairCoverage({
    findings: [finding('gemini', 'global')],
    locks: { global: lockPinning('global', ['codex']) },
  });
  assert.equal(coverage.repairable, 0);
  assert.equal(coverage.complete, false);
  assert.equal(coverage.details[0].reason, REPAIR_REASONS.HARNESS_NOT_PINNED);
  assert.equal(coverage.scopes.global.pinned, true, 'the scope is pinned; this harness is not');
});

test('coverage is per scope — a project pin does not repair a global finding', () => {
  const coverage = repairCoverage({
    findings: [finding('claude', 'global'), finding('claude', 'project')],
    locks: { project: lockPinning('project', ['claude']) },
  });
  assert.equal(coverage.repairable, 1);
  assert.equal(coverage.scopes.global.repairable, 0);
  assert.equal(coverage.scopes.project.repairable, 1);
  assert.equal(coverage.details[0].reason, REPAIR_REASONS.SCOPE_NOT_PINNED);
  assert.equal(coverage.details[1].repairable, true);
});

test('a finding whose remedy is not the repair path is unrepairable however wide the lock is', () => {
  const locks = { global: lockPinning('global', ['claude']) };
  const withheld = { id: 'a', harness: 'claude', scope: 'global', repairPath: 'manual' };
  const unstated = { id: 'b', harness: 'claude', scope: 'global' };
  const coverage = repairCoverage({ findings: [withheld, unstated], locks });

  assert.equal(coverage.repairable, 0);
  assert.equal(coverage.details[0].reason, REPAIR_REASONS.OUTSIDE_REPAIR_PATH);
  assert.equal(coverage.details[1].reason, REPAIR_REASONS.REPAIR_PATH_UNSTATED);
});

test('a finding naming an unknown scope is unrepairable and named as such, not silently dropped', () => {
  const coverage = repairCoverage({
    findings: [{ id: 'x', harness: 'claude', scope: 'session', repairPath: 'reconcile' }],
    locks: { global: lockPinning('global', ['claude']), project: lockPinning('project', ['claude']) },
  });
  assert.equal(coverage.findings, 1);
  assert.equal(coverage.repairable, 0);
  assert.equal(coverage.details[0].reason, REPAIR_REASONS.UNKNOWN_SCOPE);
  assert.equal(coverage.scopes.global.findings, 0);
  assert.equal(coverage.scopes.project.findings, 0);
});

test('no findings is a complete, zero-count coverage rather than an error', () => {
  const coverage = repairCoverage();
  assert.equal(coverage.findings, 0);
  assert.equal(coverage.repairable, 0);
  assert.equal(coverage.complete, true);
  assert.deepEqual(coverage.details, []);
  assert.equal(coverage.scopes.global.pinned, false);
  assert.match(coverage.summary, /does not arise/);
});

test('details preserve input order and echo the finding identity', () => {
  const findings = [finding('claude', 'project', 'first'), finding('codex', 'project', 'second')];
  const coverage = repairCoverage({ findings, locks: { project: lockPinning('project', ['codex']) } });
  assert.deepEqual(coverage.details.map((row) => row.id), ['first', 'second']);
  assert.deepEqual(coverage.details.map((row) => row.repairable), [false, true]);
  assert.deepEqual(findings[0], { id: 'first', harness: 'claude', scope: 'project', repairPath: 'reconcile' },
    'the input findings are not mutated');
});

test('readScopeLocks reads both scopes from disk and reports an absent lock as null', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-coverage-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-coverage-project-'));
  try {
    writeLock({ scope: 'global', homeDir: home }, lockPinning('global', ['codex'], home));
    const locks = readScopeLocks({ projectRoot: project, homeDir: home });

    assert.deepEqual(locks.global.targets, [{ harness: 'codex' }]);
    assert.equal(locks.project, null, 'a scope never installed into has no lock');

    const coverage = repairCoverage({
      findings: [finding('codex', 'global'), finding('claude', 'global'), finding('claude', 'project')],
      locks,
    });
    assert.equal(coverage.repairable, 1);
    assert.equal(coverage.scopes.project.lock, 'absent');
    assert.equal(coverage.scopes.global.lock, 'present');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('readScopeLocks propagates an unreadable lock rather than reporting it as unpinned', () => {
  // A lock `reconcile` itself could not read must not be quietly downgraded to "nothing pinned" —
  // that would be a coverage claim invented from a parse failure.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-coverage-bad-'));
  try {
    fs.mkdirSync(path.join(home, '.doflow'), { recursive: true });
    fs.writeFileSync(path.join(home, '.doflow', 'doflow.lock'), '{ not json', 'utf8');
    assert.throws(() => readScopeLocks({ projectRoot: home, homeDir: home }), /doflow\.lock/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
