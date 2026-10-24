'use strict';

// G62 — review depth has one source (feature 095b, FR-002, FR-005, NFR-003, IC-001; 119 D-4).
//
// The depth rule (single risks, light paths) lives in core/registry/verification.json `reviewDepth`; the seat
// counts live in core/registry/protocols.json review presets and nowhere else (check d).
// Checks keep the depth rule in the registry and the verb, never in prose:
//   (a) do-code-review's SKILL.md names `review --action start`, the verb that decides depth.
//   (b) No file under core/shared/ states a single-depth rule: the word `single`, or `one seat` /
//       `one reviewer`, within 80 characters of a risk level name (the keys of verification.json riskLevels) or of a
//       reviewDepth.lightPaths entry. The rule lives in core/registry/verification.json.
//   (c) The skill proceeds past `review --action start` only on exit 0 with ok:true, and keeps the
//       measured risk only when the result's riskSource is `record`.
//   (d) verification.json `reviewDepth` holds no `depths` and no `seats` key at any depth, and every review preset's
//       seat count is its own `seats` length in protocols.json (the one source of the seat counts).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared.ts');

const SHARED = path.join(REPO, 'core', 'shared');
const SKILL = path.join(SHARED, 'skills', 'do-code-review', 'SKILL.md');
const WINDOW = 80;

const verification = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'verification.json'), 'utf8'));
const TERMS: any = [...Object.keys(verification.riskLevels), ...verification.reviewDepth.lightPaths];

function filesUnder(dir: any) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry: any) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

const escape = (s: any) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const spans = (text: any, re: any) => [...text.matchAll(re)].map((m) => ({ start: m.index, end: m.index + m[0].length }));

// A risk level is a whole upper-case word ($DOFLOW is not LOW); a light path is matched as written.
const termRe = (term: any) => new RegExp(term in verification.riskLevels ? `\\b${term}\\b` : escape(term), 'g');
// A depth value is `single`, or one seat/reviewer stated as the count; both sit near a risk level.
const SINGLE = /\b(?:single|one (?:seat|reviewer)s?)\b/gi;

/** Every risk level or light-path term that sits within WINDOW characters of a depth `single`. */
function singleDepthRules(text: any) {
  const singles = spans(text, SINGLE);
  const hits: any = [];
  for (const term of TERMS) {
    for (const t of spans(text, termRe(term))) {
      const near = singles.find((s) => Math.max(s.start - t.end, t.start - s.end) <= WINDOW);
      if (near) hits.push(`'${term}' near 'single' at offset ${near.start}`);
    }
  }
  return hits;
}

test('G62.d the seat counts have one source: protocols.json, not verification.json reviewDepth', () => {
  const keys = (value: any, found: any = []) => {
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) { found.push(key); keys(child, found); }
    }
    return found;
  };
  const stray = keys(verification.reviewDepth).filter((key: any) => key === 'depths' || key === 'seats');
  assert.deepEqual(stray, [], 'reviewDepth must not carry seat counts');
  const protocols = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'protocols.json'), 'utf8'));
  const review = Object.entries(protocols.presets).filter(([, preset]) => preset.kind === 'review');
  assert.ok(review.length >= 2);
  for (const [id, preset] of review) {
    assert.ok(Array.isArray(preset.seats) && preset.seats.length >= 1, `${id} has seats`);
    assert.equal(typeof preset.depth, 'string', `${id} has a depth label`);
  }
  assert.deepEqual(Object.keys(verification.reviewDepth).sort(), ['description', 'lightPaths', 'singleRisks']);
  // No reader takes a seat count from a `depths` map any more.
  const reviewDir = path.join(REPO, 'src', 'runtime', 'review');
  for (const file of fs.readdirSync(reviewDir).filter((name: any) => name.endsWith('.ts'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(reviewDir, file), 'utf8'), /\.depths\b/, `${file} reads a depths map`);
  }
});

test('G62.a do-code-review SKILL.md names `review --action start`', () => {
  assert.match(fs.readFileSync(SKILL, 'utf8'), /review --action start/);
});

test('G62.c review start proceeds only on exit 0 with ok:true and keeps risk only from a record', () => {
  const text = fs.readFileSync(SKILL, 'utf8');
  assert.match(text, /Exit 0 with `ok:true`: run `seats` seats/);
  assert.match(text, /Any other exit: stop and report it/);
  assert.match(text, /`risk` only if `riskSource` is `record`/);
  assert.doesNotMatch(text, /Exit 1: stop/);
});

test('G62.b no file under core/shared/ states a single-depth rule', () => {
  const offenders: any = [];
  for (const file of filesUnder(SHARED)) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const hit of singleDepthRules(text)) offenders.push(`${path.relative(REPO, file)}: ${hit}`);
  }
  assert.deepEqual(offenders, [], `single-depth rule outside the registry:\n  ${offenders.join('\n  ')}`);
});

test('G62.b detector flags a single-depth rule and passes plain prose', () => {
  assert.ok(singleDepthRules('single seat when LOW').length > 0);
  assert.ok(singleDepthRules('single reviewer for edits to docs/ only').length > 0);
  assert.equal(singleDepthRules('Deep reviews use the verb. A single seat is chosen by it.').length, 0);
  assert.ok(singleDepthRules('A single seat is enough when risk is LOW.').length > 0);
  assert.ok(singleDepthRules('Use one seat when LOW.').length > 0);
  assert.ok(singleDepthRules('one reviewer for edits to docs/ only').length > 0);
  assert.equal(singleDepthRules('Report, before any tier runs: <LOW|MEDIUM>').length, 0);
});
