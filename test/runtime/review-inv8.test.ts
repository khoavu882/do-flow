'use strict';

// Feature 120 D.2 (IC-015, D3): INV-8 reviewer independence invariant.
// Enforces that a review seat is never the harness and model of a recorded subagent
// or sequential author (outcome ii). Primary-authored work remains governed by review.sameFamily.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateFindings, reviewAdvisories } = require('../../src/runtime/review/findings.ts');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const HEAD = 'a'.repeat(40);

function makeRecord(seats: any[], extra: any = {}) {
  return {
    schema: 1,
    row: '120',
    slug: '120-test',
    reviewedHead: HEAD,
    seats,
    converged: [
      { id: 'C1', from: [seats[0]?.findings?.[0]?.id || 'F1'], severity: 'should-fix', locator: 'src/a.ts:1', status: 'open' },
    ],
    ...extra,
  };
}

test('INV-8: normalize-equal refuses with error independence-model:<seat>', () => {
  const authors = [
    { kind: 'subagent', harness: 'codex', model: '  gpt-4o  ', channel: 'observed' },
  ];
  const seats = [
    {
      id: 'seat-1',
      harness: 'codex',
      model: 'GPT-4O',
      findings: [{ id: 'F1', severity: 'blocker', locator: 'src/a.ts:1', summary: 'a' }],
    },
  ];
  const res = validateFindings(makeRecord(seats), { authors });
  assert.ok(!res.ok);
  assert.ok(res.errors.includes('independence-model:seat-1'), `Expected independence-model:seat-1 in errors: ${res.errors}`);
});

test('INV-8: qualifier-only equality gives advisory independence-unverified:<seat>', () => {
  const authors = [
    { kind: 'subagent', harness: 'codex', model: 'gpt-4o', channel: 'observed' },
  ];

  // (qualifier)
  const seatParen = [
    { id: 'seat-p', harness: 'codex', model: 'gpt-4o (2024-05-13)', findings: [{ id: 'F1', severity: 'note', locator: 'src/a.ts:1', summary: 'a' }] },
  ];
  assert.deepEqual(reviewAdvisories(makeRecord(seatParen), { authors }), ['independence-unverified:seat-p']);

  // [qualifier]
  const seatBracket = [
    { id: 'seat-b', harness: 'codex', model: 'gpt-4o[preview]', findings: [{ id: 'F1', severity: 'note', locator: 'src/a.ts:1', summary: 'a' }] },
  ];
  assert.deepEqual(reviewAdvisories(makeRecord(seatBracket), { authors }), ['independence-unverified:seat-b']);

  // #qualifier
  const seatHash = [
    { id: 'seat-h', harness: 'codex', model: 'gpt-4o#2024-05-13', findings: [{ id: 'F1', severity: 'note', locator: 'src/a.ts:1', summary: 'a' }] },
  ];
  assert.deepEqual(reviewAdvisories(makeRecord(seatHash), { authors }), ['independence-unverified:seat-h']);
});

test('INV-8: unequal and both observed are independent (no error, no unverified advisory)', () => {
  const authors = [
    { kind: 'subagent', harness: 'codex', model: 'o3-mini', channel: 'observed' },
  ];
  const seats = [
    {
      id: 'seat-obs',
      harness: 'codex',
      model: 'gpt-4o',
      channel: 'observed',
      findings: [{ id: 'F1', severity: 'note', locator: 'src/a.ts:1', summary: 'a' }],
    },
  ];
  const res = validateFindings(makeRecord(seats), { authors });
  assert.deepEqual(res.errors, []);
  assert.deepEqual(reviewAdvisories(makeRecord(seats), { authors }), []);
});

test('INV-8: unequal when either is claim or unknown gives advisory independence-unverified:<seat>', () => {
  // Author is claim
  const authorsClaim = [
    { kind: 'subagent', harness: 'claude', model: 'claude-3-5-sonnet', channel: 'claim' },
  ];
  const seatClaude = [
    {
      id: 'seat-claude',
      harness: 'claude',
      model: 'claude-3-opus',
      channel: 'observed',
      findings: [{ id: 'F1', severity: 'note', locator: 'src/a.ts:1', summary: 'a' }],
    },
  ];
  assert.deepEqual(reviewAdvisories(makeRecord(seatClaude), { authors: authorsClaim }), ['independence-unverified:seat-claude']);

  // Model is unknown
  const authorsUnknown = [
    { kind: 'sequential', harness: 'claude', model: 'unknown', channel: 'claim' },
  ];
  assert.deepEqual(reviewAdvisories(makeRecord(seatClaude), { authors: authorsUnknown }), ['independence-unverified:seat-claude']);
});

test('INV-8: different harness is independent', () => {
  const authors = [
    { kind: 'subagent', harness: 'codex', model: 'gpt-4o', channel: 'observed' },
  ];
  const seats = [
    {
      id: 'seat-diff',
      harness: 'claude',
      model: 'gpt-4o',
      findings: [{ id: 'F1', severity: 'note', locator: 'src/a.ts:1', summary: 'a' }],
    },
  ];
  assert.deepEqual(validateFindings(makeRecord(seats), { authors }).errors, []);
  assert.deepEqual(reviewAdvisories(makeRecord(seats), { authors }), []);
});

test('INV-8: seat with neither harness nor model gives seat-identity-missing only when 120 data exists', () => {
  const seats = [
    { id: 'seat-no-id', findings: [{ id: 'F1', severity: 'note', locator: 'src/a.ts:1', summary: 'a' }] },
  ];

  // With 120 authors data present: advisory seat-identity-missing
  const authors = [
    { kind: 'subagent', harness: 'codex', model: 'gpt-4o', channel: 'observed' },
  ];
  assert.deepEqual(reviewAdvisories(makeRecord(seats), { authors }), ['seat-identity-missing:seat-no-id']);

  // Negative control: no 120 data (no authors, no harness/model on author or seat) -> no advisory
  assert.deepEqual(reviewAdvisories(makeRecord(seats), { authors: [] }), []);
  assert.deepEqual(reviewAdvisories(makeRecord(seats)), []);
});

test('INV-8: authorKinds respects protocols.json and excludes record and primary authors (outcome ii)', () => {
  // Author kind 'primary' with same harness and model as seat
  const authorsPrimary = [
    { kind: 'primary', harness: 'claude', model: 'claude-3-5-sonnet', channel: 'observed' },
  ];
  const seats = [
    {
      id: 'seat-primary-peer',
      harness: 'claude',
      model: 'claude-3-5-sonnet',
      findings: [{ id: 'F1', severity: 'note', locator: 'src/a.ts:1', summary: 'a' }],
    },
  ];
  // Under outcome (ii), INV-8 covers ["subagent", "sequential"]. Primary is governed by review.sameFamily, not INV-8.
  const res = validateFindings(makeRecord(seats), { authors: authorsPrimary });
  assert.ok(!res.errors.includes('independence-model:seat-primary-peer'));

  // Author kind 'record' with same harness and model
  const authorsRecord = [
    { kind: 'record', harness: 'claude', model: 'claude-3-5-sonnet', channel: 'claim' },
  ];
  const resRecord = validateFindings(makeRecord(seats), { authors: authorsRecord });
  assert.ok(!resRecord.errors.includes('independence-model:seat-primary-peer'));

  // But sequential IS covered by INV-8
  const authorsSeq = [
    { kind: 'sequential', harness: 'claude', model: 'claude-3-5-sonnet', channel: 'claim' },
  ];
  const resSeq = validateFindings(makeRecord(seats), { authors: authorsSeq });
  assert.ok(resSeq.errors.includes('independence-model:seat-primary-peer'));
});

test('INV-8: config schema --json lists invariant.INV-8 with locked: true', () => {
  const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin/doflow.js'), 'config', 'schema', '--json'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed.invariants), 'schema has invariants array');
  const inv8 = parsed.invariants.find((inv: any) => inv.id === 'INV-8');
  assert.ok(inv8, 'invariants lists INV-8');
  assert.equal(inv8.locked, true);
  assert.equal(inv8.key, 'invariant.INV-8');
  assert.deepEqual(inv8.authorKinds, ['subagent', 'sequential']);
});
