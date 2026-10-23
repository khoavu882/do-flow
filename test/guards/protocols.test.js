'use strict';

// G66 — the review/debate protocol registry is consistent with itself and with the class seat
// floors (feature 119, design C7, IC-001).
//
// `checkProtocols(protocols, gates)` returns offender strings for:
//   (b) a seat lens id that is not in the lens catalogue;
//   (c) `review-deep` having fewer seats than any class's `gate-b.minSeats` in
//       core/registry/gates.json, or the strictest review preset in `order.review` not being
//       `review-deep` (the floor is met by that one preset alone; no other review preset is
//       needed to meet it);
//   (d) a preset whose `rounds.default` exceeds `hardRoundCap`;
//   (e) no invariants, or an invariant with an empty `enforcedBy`.
// Two checks read the shipped file directly: (a) preset ids are unique in the raw text (parsed JSON
// hides a duplicate key; `loadProtocols` scans the text, so the check does not depend on formatting), and (f) the shipped file passes `validateProtocols` with zero errors.
//
// Phase B adds "every settings valuesRef into protocols resolves": no settings key references
// protocols yet, so that check is not here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');
const { validateProtocols, loadProtocols } = require(path.join(REPO, 'src', 'runtime', 'review', 'protocols.ts'));
const { suiteTempDir } = require('../helper/tmp');

const PROTOCOLS_TEXT = fs.readFileSync(path.join(REPO, 'core', 'registry', 'protocols.json'), 'utf8');
const protocols = JSON.parse(PROTOCOLS_TEXT);
const gates = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'gates.json'), 'utf8'));

const PROTOCOLS_FILE = path.join(REPO, 'core', 'registry', 'protocols.json');

/** Duplicate-key errors `loadProtocols` reports for `text`, written to a temp file. */
function duplicateKeyErrors(text) {
  const file = path.join(suiteTempDir('doflow-g66-'), 'protocols.json');
  fs.writeFileSync(file, text);
  return loadProtocols({ file }).errors.filter((e) => e.startsWith('duplicate key'));
}

function checkProtocols(p, g) {
  const offenders = [];
  const lensIds = new Set((p.lenses ?? []).map((lens) => lens.id));
  for (const [id, preset] of Object.entries(p.presets ?? {})) {
    for (const seat of preset.seats ?? []) {
      for (const lens of seat.lenses ?? []) {
        if (!lensIds.has(lens)) offenders.push(`${id}.${seat.id} names lens '${lens}' outside the catalogue`);
      }
    }
    if (preset.rounds && preset.rounds.default > p.hardRoundCap) {
      offenders.push(`${id}.rounds.default ${preset.rounds.default} exceeds hardRoundCap ${p.hardRoundCap}`);
    }
  }

  const floor = Math.max(0, ...Object.values(g.classes ?? {}).map((cls) => cls?.['gate-b']?.minSeats ?? 0));
  const strictest = (p.order?.review ?? [])[0];
  if (strictest !== 'review-deep') offenders.push(`strictest review preset is '${strictest}', expected 'review-deep'`);
  const deepSeats = (p.presets?.['review-deep']?.seats ?? []).length;
  if (deepSeats < floor) offenders.push(`review-deep has ${deepSeats} seat(s), below the class floor ${floor}`);
  for (const id of p.order?.review ?? []) {
    const seats = (p.presets?.[id]?.seats ?? []).length;
    if (seats > deepSeats) offenders.push(`${id} has ${seats} seats, more than the strictest review preset's ${deepSeats}`);
  }

  if (!Array.isArray(p.invariants) || p.invariants.length === 0) offenders.push('invariants is empty');
  else for (const inv of p.invariants) {
    if (typeof inv.enforcedBy !== 'string' || inv.enforcedBy.length === 0) offenders.push(`invariant ${inv.id} has no enforcedBy`);
  }
  return offenders;
}

const clone = () => structuredClone(protocols);

test('G66.a preset ids are unique in the raw file', () => {
  assert.deepEqual(duplicateKeyErrors(PROTOCOLS_TEXT), []);
  assert.equal(loadProtocols({ file: PROTOCOLS_FILE }).ok, true);
});

test('G66.b-e the shipped registry is consistent with the class seat floors', () => {
  assert.ok(gates.classes.feature['gate-b'].minSeats >= 2, 'the gate floor was found');
  assert.deepEqual(checkProtocols(protocols, gates), []);
});

test('G66.f the shipped registry passes validateProtocols', () => {
  assert.deepEqual(validateProtocols(protocols).errors, []);
});

test('G66 control: a one-seat review-deep is red against the class floor', () => {
  const bad = clone();
  bad.presets['review-deep'].seats = bad.presets['review-deep'].seats.slice(0, 1);
  assert.ok(checkProtocols(bad, gates).some((o) => /review-deep has 1 seat/.test(o)));
});

test('G66 control: an unknown lens is red', () => {
  const bad = clone();
  bad.presets['review-deep'].seats[0].lenses.push('no-such-lens');
  assert.ok(checkProtocols(bad, gates).some((o) => /no-such-lens/.test(o)));
});

test('G66 control: rounds above hardRoundCap are red', () => {
  const bad = clone();
  bad.presets['debate-3'].rounds.default = bad.hardRoundCap + 1;
  assert.ok(checkProtocols(bad, gates).some((o) => /exceeds hardRoundCap/.test(o)));
});

test('G66 control: an invariant without enforcedBy, or no invariants, is red', () => {
  const bad = clone();
  bad.invariants[0].enforcedBy = '';
  assert.ok(checkProtocols(bad, gates).some((o) => /INV-1 has no enforcedBy/.test(o)));
  bad.invariants = [];
  assert.ok(checkProtocols(bad, gates).some((o) => /invariants is empty/.test(o)));
});

test('G66 control: a strictest review preset that is not review-deep is red', () => {
  const bad = clone();
  bad.order.review = ['review-single', 'review-deep'];
  assert.ok(checkProtocols(bad, gates).some((o) => /strictest review preset is 'review-single'/.test(o)));
});

test('G66 control: a duplicate preset id in the raw text is red, whatever the formatting', () => {
  const dup = PROTOCOLS_TEXT.replace('    "review-single": {', '    "review-deep": {\n      "kind": "review"\n    },\n    "review-single": {');
  assert.notEqual(dup, PROTOCOLS_TEXT);
  assert.deepEqual(duplicateKeyErrors(dup), ["duplicate key 'review-deep' in presets"]);
  const minified = JSON.stringify(protocols).replace('"review-single":{', '"review-deep":{"kind":"review"},"review-single":{');
  assert.ok(minified.includes('"review-deep":{"kind":"review"}'));
  assert.deepEqual(duplicateKeyErrors(minified), ["duplicate key 'review-deep' in presets"]);
});

test('G66 control: the shipped registry gives no offender', () => {
  assert.deepEqual(checkProtocols(clone(), gates), []);
  assert.deepEqual(duplicateKeyErrors(PROTOCOLS_TEXT), []);
});
