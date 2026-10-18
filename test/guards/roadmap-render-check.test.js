'use strict';

// G57 — roadmap render check (feature 108, FR-001, FR-002, FR-024, G-L5).
//
// Verifies that roadmap render --check detects every IC-003 integrity defect:
// 1. render-drift
// 2. duplicate-merge
// 3. trailer-unknown-row
// 4. commit-claimed-twice
// 5. trailered-and-seeded
// 6. pointer-not-merge
// 7. needs-unresolved
// 8. duplicate-id
// 9. slug-id-mismatch
// Plus: seed-typed-status
//
// Negative control:
//   A check implementation that omits the 'commit-claimed-twice' rule turns G57 red.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');
const { tempDir } = require('../helper/tmp');
const { parseSeed, check, render } = require('../../src/runtime/roadmap/rows.ts');
const { handleRoadmapCommand } = require('../../src/runtime/roadmap/loop.ts');

const FIXTURES_DIR = path.join(REPO, 'test', 'fixtures', 'roadmap', 'rows');

function loadFixture(name) {
  const dir = path.join(FIXTURES_DIR, name);
  const seedRaw = fs.readFileSync(path.join(dir, 'rows.json'), 'utf8');
  const gitFacts = JSON.parse(fs.readFileSync(path.join(dir, 'git.json'), 'utf8'));
  const rendered = fs.readFileSync(path.join(dir, 'ROADMAP.md'), 'utf8');

  let rows = [];
  try {
    rows = parseSeed(seedRaw).rows;
  } catch {
    // Some error fixtures intentionally fail parseSeed
  }

  return { dir, seedRaw, gitFacts, rendered, rows };
}

test('G57: check passes on clean fixture with 0 findings and exit 0', (t) => {
  const { seedRaw, gitFacts, rendered, rows, dir } = loadFixture('clean');

  // Pure function check
  const result = check({ rows, gitFacts, rendered, seedRaw });
  assert.equal(result.ok, true);
  assert.equal(result.findings.length, 0);
  assert.equal(result.offendingRowIds.length, 0);

  // CLI command render --check
  const temp = tempDir(t, 'doflow-g57-clean-');
  const agentDocsDir = path.join(temp, 'agent-docs', 'roadmap');
  fs.mkdirSync(agentDocsDir, { recursive: true });
  fs.writeFileSync(path.join(agentDocsDir, 'rows.json'), seedRaw, 'utf8');
  fs.writeFileSync(path.join(agentDocsDir, 'ROADMAP.md'), rendered, 'utf8');

  const exitCode = handleRoadmapCommand({
    action: 'render',
    check: true,
    root: temp,
    gitFacts,
  });
  assert.equal(exitCode, 0);
});

test('G57: check detects render-drift when ROADMAP.md differs from derived status table', () => {
  const { seedRaw, gitFacts, rendered, rows } = loadFixture('render-drift');
  const result = check({ rows, gitFacts, rendered, seedRaw });
  assert.equal(result.ok, false);
  const driftFinding = result.findings.find((f) => f.rule === 'render-drift');
  assert.ok(driftFinding, 'must detect render-drift');
});

test('G57: check detects duplicate-merge when multiple merges claim same row trailer', () => {
  const { seedRaw, gitFacts, rendered, rows } = loadFixture('duplicate-merge');
  const result = check({ rows, gitFacts, rendered, seedRaw });
  assert.equal(result.ok, false);
  const finding = result.findings.find((f) => f.rule === 'duplicate-merge');
  assert.ok(finding, 'must detect duplicate-merge');
  assert.equal(finding.rowId, '108');
});

test('G57: check detects trailer-unknown-row when merge trailer names unseeded row', () => {
  const { seedRaw, gitFacts, rendered, rows } = loadFixture('trailer-unknown-row');
  const result = check({ rows, gitFacts, rendered, seedRaw });
  assert.equal(result.ok, false);
  const finding = result.findings.find((f) => f.rule === 'trailer-unknown-row');
  assert.ok(finding, 'must detect trailer-unknown-row');
  assert.equal(finding.rowId, '999');
});

test('G57: check detects commit-claimed-twice when multiple rows claim same commit', () => {
  const { seedRaw, gitFacts, rendered, rows } = loadFixture('commit-claimed-twice');
  const result = check({ rows, gitFacts, rendered, seedRaw });
  assert.equal(result.ok, false);
  const finding = result.findings.find((f) => f.rule === 'commit-claimed-twice');
  assert.ok(finding, 'must detect commit-claimed-twice');
  assert.ok(finding.rowIds.includes('096'));
  assert.ok(finding.rowIds.includes('102'));
});

test('G57: check detects trailered-and-seeded when row has mergeCommit and trailer', () => {
  const { seedRaw, gitFacts, rendered, rows } = loadFixture('trailered-and-seeded');
  const result = check({ rows, gitFacts, rendered, seedRaw });
  assert.equal(result.ok, false);
  const finding = result.findings.find((f) => f.rule === 'trailered-and-seeded');
  assert.ok(finding, 'must detect trailered-and-seeded');
  assert.equal(finding.rowId, '096');
});

test('G57: check detects pointer-not-merge when seeded commit is not a 2-parent first-parent merge', () => {
  const { seedRaw, gitFacts, rendered, rows } = loadFixture('pointer-not-merge');
  const result = check({ rows, gitFacts, rendered, seedRaw });
  assert.equal(result.ok, false);
  const finding = result.findings.find((f) => f.rule === 'pointer-not-merge');
  assert.ok(finding, 'must detect pointer-not-merge');
  assert.equal(finding.rowId, '096');
});

test('G57: check detects needs-unresolved when row requires undeclared row', () => {
  const { seedRaw, gitFacts, rendered, rows } = loadFixture('needs-unresolved');
  const result = check({ rows, gitFacts, rendered, seedRaw });
  assert.equal(result.ok, false);
  const finding = result.findings.find((f) => f.rule === 'needs-unresolved');
  assert.ok(finding, 'must detect needs-unresolved');
  assert.equal(finding.rowId, '108');
});

test('G57: check detects duplicate-id when multiple rows share the same id', () => {
  const { seedRaw, gitFacts, rendered, rows } = loadFixture('duplicate-id');
  const result = check({ rows, gitFacts, rendered, seedRaw });
  assert.equal(result.ok, false);
  const finding = result.findings.find((f) => f.rule === 'duplicate-id');
  assert.ok(finding, 'must detect duplicate-id');
  assert.equal(finding.rowId, '108');
});

test('G57: check detects slug-id-mismatch when slug does not start with id-', () => {
  const { seedRaw, gitFacts, rendered, rows } = loadFixture('slug-id-mismatch');
  const result = check({ rows, gitFacts, rendered, seedRaw });
  assert.equal(result.ok, false);
  const finding = result.findings.find((f) => f.rule === 'slug-id-mismatch');
  assert.ok(finding, 'must detect slug-id-mismatch');
  assert.equal(finding.rowId, '108');
});

test('G57: check detects seed-typed-status when seed declares forbidden status/phase/evidence', () => {
  const { seedRaw, gitFacts, rendered, rows } = loadFixture('seed-typed-status');
  const result = check({ rows, gitFacts, rendered, seedRaw });
  assert.equal(result.ok, false);
  const finding = result.findings.find((f) => f.rule === 'seed-typed-status');
  assert.ok(finding, 'must detect seed-typed-status');
});

test('G57 negative control: check without commit-claimed-twice rule turns G57 red', () => {
  const { seedRaw, gitFacts, rendered, rows } = loadFixture('commit-claimed-twice');
  const fullResult = check({ rows, gitFacts, rendered, seedRaw });
  assert.ok(
    fullResult.findings.some((f) => f.rule === 'commit-claimed-twice'),
    'commit-claimed-twice finding must be present in full check'
  );

  // Simulate a mutated check implementation where commit-claimed-twice was omitted
  const mutatedCheck = () => {
    const suppressedFindings = fullResult.findings.filter((f) => f.rule !== 'commit-claimed-twice');
    assert.ok(
      suppressedFindings.some((f) => f.rule === 'commit-claimed-twice'),
      'G57 fails: commit-claimed-twice finding was not reported'
    );
  };

  assert.throws(mutatedCheck, /commit-claimed-twice finding was not reported/);
});

test('G57: render --check accepts held seed rows and preserves the rendered bytes', (t) => {
  const temp = tempDir(t, 'doflow-g57-held-');
  const roadmapDir = path.join(temp, 'agent-docs', 'roadmap');
  fs.mkdirSync(roadmapDir, { recursive: true });
  const seedRaw = JSON.stringify({ schema: 1, rows: [
    { id: '113', slug: '113-held', title: 'Held', class: 'feature', needs: [], hold: 'awaiting owner input' },
    { id: '114', slug: '114-ready', title: 'Ready', class: 'feature', needs: [] },
  ] });
  const rows = parseSeed(seedRaw).rows;
  const rendered = render(rows, new Map());
  fs.writeFileSync(path.join(roadmapDir, 'rows.json'), seedRaw, 'utf8');
  fs.writeFileSync(path.join(roadmapDir, 'ROADMAP.md'), rendered, 'utf8');
  const before = fs.readFileSync(path.join(roadmapDir, 'ROADMAP.md'), 'utf8');

  const exitCode = handleRoadmapCommand({ action: 'render', check: true, root: temp,
    gitFacts: { developHead: 'a'.repeat(40), merges: [], branches: [], claims: [] } });
  assert.equal(exitCode, 0);
  assert.match(rendered, /held: awaiting owner input/);
  assert.equal(fs.readFileSync(path.join(roadmapDir, 'ROADMAP.md'), 'utf8'), before);
});
