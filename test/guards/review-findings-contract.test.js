'use strict';

// G59 — review findings contract (feature 108, FR-009, IC-006).
//
// do-code-review writes the head-bound review/findings.json schema 1 at the feature artifact root.
// The contract specifies:
//   - path: review/findings.json
//   - schema: 1
//   - reviewedHead: 40-character hex commit
//   - seats: array of review seats (the two lenses of the final review)
//   - converged: array with dispositions rules (open, fixed with fixedIn, refuted with locator evidence, user-accepted with decision)
//   - converged.md stays prose
// Shipped fixture passes validateFindings from src/runtime/roadmap/gates.ts.
// Feature 095 (IC-001, IC-005): the SKILL also names every optional convergence field and its
// vocabulary (read from src/runtime/review/findings.ts, not hand-listed), `review --action check`
// and the re-review rule (`reviewedHead`.. and the round cap); a convergence fixture holds every
// optional field and its counts are non-zero.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');
const { tempDir } = require('../helper/tmp');
const { validateFindings } = require('../../src/runtime/roadmap/gates.ts');
const {
  FINDING_FIELDS, ORIGINS, VERIFICATIONS, ACCEPTED_AS, ROUND_CAP, countFindings,
} = require('../../src/runtime/review/findings.ts');

const SKILL_PATH = path.join(REPO, 'core/shared/skills/do-code-review/SKILL.md');
const FIXTURE_PATH = path.join(REPO, 'test/fixtures/roadmap/findings/schema-1.json');
const CONVERGENCE_FIXTURE_PATH = path.join(REPO, 'test/fixtures/roadmap/findings/schema-1-convergence.json');
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Inspect SKILL.md for the required output contract declarations.
 */
function checkSkillContract(text) {
  const missing = [];
  if (!/review\/findings\.json/.test(text)) missing.push('path: review/findings.json');
  if (!/schema\s+1/i.test(text)) missing.push('schema 1');
  if (!/\breviewedHead\b/.test(text)) missing.push('reviewedHead');
  if (!/\bseats\b/.test(text)) missing.push('seats');
  if (!/\bconverged\b/.test(text)) missing.push('converged');
  for (const status of ['open', 'fixed', 'refuted', 'user-accepted']) {
    if (!new RegExp(`\\b${status}\\b`).test(text)) missing.push(`disposition status: ${status}`);
  }
  for (const field of ['fixedIn', 'evidence', 'decision']) {
    if (!new RegExp(`\\b${field}\\b`).test(text)) missing.push(`disposition field: ${field}`);
  }
  if (!/`evidence` \(`path:line`/.test(text)) missing.push('refuted evidence is a locator (path:line)');
  if (!/converged\.md\b/.test(text) || !/\bstays prose\b/.test(text)) {
    missing.push('converged.md stays prose');
  }
  for (const field of [...FINDING_FIELDS, 'rounds']) {
    if (!new RegExp(`\`${field}\``).test(text)) missing.push(`convergence field: ${field}`);
  }
  for (const value of [...ORIGINS, ...VERIFICATIONS, ...ACCEPTED_AS]) {
    if (!new RegExp(`(?<![\\w-])${escape(value)}(?![\\w-])`).test(text)) missing.push(`convergence value: ${value}`);
  }
  if (!/review --action check/.test(text)) missing.push('verb: review --action check');
  if (!/`reviewedHead`\.\.new head/.test(text)) missing.push('re-review reads reviewedHead..new head');
  if (!new RegExp(`at round ${ROUND_CAP}\\b`).test(text)) missing.push(`re-review round cap: round ${ROUND_CAP}`);
  return { ok: missing.length === 0, missing };
}

test('G59: do-code-review SKILL.md declares review/findings.json schema 1 output contract', () => {
  const text = fs.readFileSync(SKILL_PATH, 'utf8');
  const result = checkSkillContract(text);
  assert.equal(result.ok, true, `SKILL.md is missing contract elements:\n  ${result.missing.join('\n  ')}`);
});

test('G59: shipped example fixture test/fixtures/roadmap/findings/schema-1.json passes validateFindings', () => {
  assert.ok(fs.existsSync(FIXTURE_PATH), 'shipped fixture schema-1.json must exist');
  const raw = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const data = JSON.parse(raw);
  const result = validateFindings(data);
  assert.equal(result.ok, true, `shipped fixture failed validateFindings: ${result.errors.join(', ')}`);
});

test('G59 negative control: a scratch SKILL copy without the contract turns G59 red', (t) => {
  const scratch = tempDir(t, 'doflow-g59-skill-');
  const original = fs.readFileSync(SKILL_PATH, 'utf8');
  // Mutate scratch text to strip the review/findings.json output contract block
  const stripped = original.replace(/3\.\s+\*\*Review findings output contract[\s\S]*?`converged\.md` stays prose\.?/i, '');
  const scratchFile = path.join(scratch, 'SKILL.md');
  fs.writeFileSync(scratchFile, stripped, 'utf8');

  const scratchText = fs.readFileSync(scratchFile, 'utf8');
  const result = checkSkillContract(scratchText);
  assert.equal(result.ok, false, 'scratch SKILL copy without contract must fail contract check');
  assert.throws(
    () => {
      assert.equal(result.ok, true, `SKILL.md is missing contract elements: ${result.missing.join(', ')}`);
    },
    /SKILL\.md is missing contract elements/,
    'must throw assertion error on missing contract'
  );
});

test('G59 negative control: fixture with user-accepted entry lacking decision fails validation', () => {
  const raw = fs.readFileSync(FIXTURE_PATH, 'utf8');
  const mutated = JSON.parse(raw);
  const userAccepted = mutated.converged.find((f) => f.status === 'user-accepted');
  assert.ok(userAccepted, 'shipped fixture must contain a user-accepted finding for control');
  delete userAccepted.decision;

  const result = validateFindings(mutated);
  assert.equal(result.ok, false, 'fixture with user-accepted entry lacking decision must fail validation');
  assert.ok(
    result.errors.includes(`decision:${userAccepted.id}`),
    `expected decision error on ${userAccepted.id}, got: ${result.errors.join(', ')}`
  );
});

test('G59 negative control: a refuted entry whose evidence is prose fails validation, and the SKILL names the locator', () => {
  const mutated = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const refuted = mutated.converged.find((f) => f.status === 'refuted');
  assert.ok(refuted, 'shipped fixture must contain a refuted finding for control');
  refuted.evidence = 'because';
  assert.ok(validateFindings(mutated).errors.includes(`evidence:${refuted.id}`), 'prose evidence must fail validation');
  const text = fs.readFileSync(SKILL_PATH, 'utf8').replace('`evidence` (`path:line` or test path)', '`evidence`');
  assert.ok(checkSkillContract(text).missing.includes('refuted evidence is a locator (path:line)'));
});

test('G59: convergence fixture holds every optional field, passes validateFindings and counts non-zero', () => {
  const data = JSON.parse(fs.readFileSync(CONVERGENCE_FIXTURE_PATH, 'utf8'));
  const result = validateFindings(data);
  assert.equal(result.ok, true, `convergence fixture failed validateFindings: ${result.errors.join(', ')}`);
  assert.ok(Object.hasOwn(data, 'rounds'), 'convergence fixture must carry rounds');
  const absent = FINDING_FIELDS.filter((field) => !data.converged.some((f) => Object.hasOwn(f, field)));
  assert.deepEqual(absent, [], 'convergence fixture must hold every optional finding field at least once');
  const counts = countFindings(data);
  for (const key of ['pre_existing', 'escaped', 'confirmed', 'bug_classes']) {
    assert.ok(counts[key] > 0, `countFindings must report ${key} > 0, got ${counts[key]}`);
  }
});

test('G59 negative control: a SKILL copy without a convergence name or the check verb is named missing', () => {
  const original = fs.readFileSync(SKILL_PATH, 'utf8');
  const noVerification = checkSkillContract(original.replace(/`verification`/g, '`x`'));
  assert.ok(noVerification.missing.includes('convergence field: verification'), noVerification.missing.join(', '));
  const noVerb = checkSkillContract(original.replace(/review --action check/g, 'review'));
  assert.ok(noVerb.missing.includes('verb: review --action check'), noVerb.missing.join(', '));
  const noCap = checkSkillContract(original.replace(new RegExp(`at round ${ROUND_CAP}\\b`, 'g'), 'later'));
  assert.ok(noCap.missing.includes(`re-review round cap: round ${ROUND_CAP}`), noCap.missing.join(', '));
});

module.exports = { checkSkillContract };
