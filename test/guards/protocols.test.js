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
//   (e) no invariants, or an invariant with an empty `enforcedBy`;
//   (g) a review preset seat whose agent has no spec with `access: read-only` (a review seat is read-only);
//   (i) an adjacent pair of `order.review` or `order.debate` where the stricter preset does not
//       `dominates` the next one (122 IC-014; the tiers are models.json `dispatchTiers.tiers`).
// Two checks read the shipped file directly: (a) preset ids are unique in the raw text (parsed JSON
// hides a duplicate key; `loadProtocols` scans the text, so the check does not depend on formatting), and (f) the shipped file passes `validateProtocols` with zero errors.
//
// `checkDerivations(settings, telemetry, protocols)` (h, C-9) returns offenders for a preset or lens id
// copied out of protocols.json: the settings keys that choose among presets and lenses must point at
// their refs (refs.ts; `review.preset` ranks by `orderRef`, never a literal `order`), and no settings
// literal or telemetry vocabulary may list a preset id (telemetry reads `protocol` from protocols.json,
// telemetry.ts DERIVED_VOCABULARIES). The shipped settings registry must load with those refs resolved.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');
const { validateProtocols, loadProtocols } = require(path.join(REPO, 'src', 'runtime', 'review', 'protocols.ts'));
const { dominates } = require(path.join(REPO, 'src', 'runtime', 'review', 'dominance.ts'));
const { suiteTempDir } = require('../helper/tmp');
const { loadSettingsRegistry } = require(path.join(REPO, 'src', 'runtime', 'settings', 'registry.ts'));
const { derivedVocabularies } = require(path.join(REPO, 'src', 'runtime', 'trace', 'telemetry.ts'));

const PROTOCOLS_TEXT = fs.readFileSync(path.join(REPO, 'core', 'registry', 'protocols.json'), 'utf8');
// 122 A.6: debate-3 is contributed by the bundled package `doflow`, so the registry every check below reads is the
// merged (effective) view; `core` is the file as authored.
const core = JSON.parse(PROTOCOLS_TEXT);
const protocols = structuredClone(loadProtocols().registry);
const gates = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'gates.json'), 'utf8'));
const TIERS = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'models.json'), 'utf8')).dispatchTiers.tiers;

const PROTOCOLS_FILE = path.join(REPO, 'core', 'registry', 'protocols.json');

/** Duplicate-key errors `loadProtocols` reports for `text`, written to a temp file. */
function duplicateKeyErrors(text) {
  const file = path.join(suiteTempDir('doflow-g66-'), 'protocols.json');
  fs.writeFileSync(file, text);
  return loadProtocols({ file }).errors.filter((e) => e.startsWith('duplicate key'));
}

const SPEC_DIR = path.join(REPO, 'core', 'shared', 'agent-specs');

/** The `access:` frontmatter value of the agent spec named `agent`, or null when there is no such spec or value. */
function specAccess(agent) {
  const file = path.join(SPEC_DIR, `${agent}.md`);
  if (!fs.existsSync(file)) return null;
  const front = fs.readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return front?.[1].match(/^access:\s*(\S+)\s*$/m)?.[1] ?? null;
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

  // (g) a review seat is read-only (INV-2): its agent names an existing spec whose `access` is `read-only`.
  for (const id of p.order?.review ?? []) {
    for (const seat of p.presets?.[id]?.seats ?? []) {
      const access = specAccess(seat.agent);
      if (access !== 'read-only') offenders.push(`${id}.${seat.id} seats agent '${seat.agent}' whose spec access is ${access ?? 'missing'}, not read-only`);
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

  // (i) each adjacent pair of the authored order dominates (strictest first).
  for (const kind of ['review', 'debate']) {
    const list = p.order?.[kind] ?? [];
    for (let i = 0; i + 1 < list.length; i++) {
      if (!dominates(p.presets?.[list[i]], p.presets?.[list[i + 1]], { tiers: TIERS, synthesizerStrength: p.synthesizerStrength })) {
        offenders.push(`order.${kind}: '${list[i]}' does not dominate '${list[i + 1]}'`);
      }
    }
  }

  if (!Array.isArray(p.invariants) || p.invariants.length === 0) offenders.push('invariants is empty');
  else for (const inv of p.invariants) {
    if (typeof inv.enforcedBy !== 'string' || inv.enforcedBy.length === 0) offenders.push(`invariant ${inv.id} has no enforcedBy`);
  }
  return offenders;
}

const clone = () => structuredClone(protocols);

const SETTINGS = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'settings.json'), 'utf8'));
const TELEMETRY = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'telemetry.json'), 'utf8'));
/** The settings keys that choose among protocols.json ids, and the refs they must use. */
const DERIVED_KEYS = {
  'review.preset': { valuesRef: 'protocols.reviewPresetIds', orderRef: 'protocols.reviewPresetOrder' },
  'debate.preset': { valuesRef: 'protocols.debatePresetIds' },
  'review.extraLenses': { valuesRef: 'protocols.lensIds' },
};

function checkDerivations(settings, telemetry, p) {
  const offenders = [];
  const presetIdSet = new Set(Object.keys(p.presets ?? {}));
  for (const [key, refs] of Object.entries(DERIVED_KEYS)) {
    const spec = settings.keys?.[key];
    if (!spec) { offenders.push(`settings key ${key} is missing`); continue; }
    for (const [field, ref] of Object.entries(refs)) {
      if (spec[field] !== ref) offenders.push(`settings ${key}.${field} must be '${ref}'`);
    }
    if (Object.hasOwn(refs, 'orderRef') && Object.hasOwn(spec, 'order')) offenders.push(`settings ${key} copies an order; it ranks by orderRef`);
  }
  for (const [key, spec] of Object.entries(settings.keys ?? {})) {
    for (const field of ['values', 'order', 'default']) {
      const listed = Array.isArray(spec[field]) ? spec[field] : [spec[field]];
      const copy = listed.find((value) => presetIdSet.has(value) && !(field === 'default' && Object.hasOwn(DERIVED_KEYS, key)));
      if (copy !== undefined) offenders.push(`settings ${key}.${field} copies preset id '${copy}'`);
    }
  }
  for (const [name, values] of Object.entries(telemetry.vocabularies ?? {})) {
    const copy = (Array.isArray(values) ? values : []).find((value) => presetIdSet.has(value));
    if (copy !== undefined) offenders.push(`telemetry vocabularies.${name} copies preset id '${copy}'`);
  }
  return offenders;
}

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
  assert.deepEqual(validateProtocols(core).errors, [], 'the file as authored passes too: its order names a first-party id its presets do not hold');
});

test('G66.h preset and lens ids reach settings and telemetry by derivation, not by copy', () => {
  assert.deepEqual(checkDerivations(SETTINGS, TELEMETRY, protocols), []);
  const loaded = loadSettingsRegistry({ verifyRefs: true });
  assert.equal(loaded.ok, true, loaded.detail);
  const deep = protocols.order.review.findIndex((id) => protocols.presets[id].depth === 'deep');
  assert.deepEqual(loaded.registry.keys.get('review.preset').order,
    [...protocols.order.review.slice(0, deep + 1), 'auto', ...protocols.order.review.slice(deep + 1)]);
  assert.deepEqual(loaded.registry.enumValues('debate.preset'), protocols.order.debate);
  assert.deepEqual(derivedVocabularies(), {
    depth: [...protocols.order.review].reverse().map((id) => protocols.presets[id].depth),
    protocol: [...protocols.order.review, 'package'], // 122 IC-024: the one bucket for every contributed preset
  });
});

test('G66 control: a settings literal order, a literal preset list or a telemetry copy is red', () => {
  const literal = structuredClone(SETTINGS);
  delete literal.keys['review.preset'].orderRef;
  literal.keys['review.preset'].order = ['review-deep', 'auto', 'review-single'];
  const found = checkDerivations(literal, TELEMETRY, protocols);
  assert.ok(found.some((o) => /review\.preset\.orderRef must be 'protocols\.reviewPresetOrder'/.test(o)), found.join('\n'));
  assert.ok(found.some((o) => /review\.preset copies an order/.test(o)));
  assert.ok(found.some((o) => /review\.preset\.order copies preset id 'review-deep'/.test(o)));
  const values = structuredClone(SETTINGS);
  delete values.keys['debate.preset'].valuesRef;
  values.keys['debate.preset'].values = ['debate-3', 'debate-2'];
  assert.ok(checkDerivations(values, TELEMETRY, protocols).some((o) => /debate\.preset\.values copies preset id 'debate-3'/.test(o)));
  const vocab = structuredClone(TELEMETRY);
  vocab.vocabularies.protocol = ['review-deep', 'review-single'];
  assert.deepEqual(checkDerivations(SETTINGS, vocab, protocols), ["telemetry vocabularies.protocol copies preset id 'review-deep'"]);
});

test('G66 control: a one-seat review-deep is red against the class floor', () => {
  const bad = clone();
  bad.presets['review-deep'].seats = bad.presets['review-deep'].seats.slice(0, 1);
  assert.ok(checkProtocols(bad, gates).some((o) => /review-deep has 1 seat/.test(o)));
});

test('G66 control: a review seat on a write-access or missing agent is red', () => {
  const bad = clone();
  bad.presets['review-single'].seats[0].agent = 'quality-guardian';
  assert.ok(checkProtocols(bad, gates).some((o) => /review-single\.seat-a seats agent 'quality-guardian' whose spec access is write/.test(o)));
  bad.presets['review-single'].seats[0].agent = 'no-such-agent';
  assert.ok(checkProtocols(bad, gates).some((o) => /whose spec access is missing/.test(o)));
  const debate = clone();
  debate.presets['debate-2'].seats[0].agent = 'system-architect';
  assert.deepEqual(checkProtocols(debate, gates), [], 'a debate seat may be a write-access agent');
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

test('G66 control: an adjacent order pair that does not dominate is red', () => {
  const review = clone();
  review.presets['review-deep'].seats[1].lenses = ['correctness', 'boundaries'];
  assert.deepEqual(checkProtocols(review, gates), ["order.review: 'review-deep' does not dominate 'review-single'"]);
  const debate = clone();
  debate.order.debate = ['debate-2', 'debate-3'];
  assert.deepEqual(checkProtocols(debate, gates), ["order.debate: 'debate-2' does not dominate 'debate-3'"]);
  const lattice = clone(); // the lattice is read from the registry: verifier below none breaks debate-3 over debate-2
  lattice.synthesizerStrength = { separate: 2, verifier: 0, seat: 1, none: 1 };
  assert.deepEqual(checkProtocols(lattice, gates), ["order.debate: 'debate-3' does not dominate 'debate-2'"]);
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
