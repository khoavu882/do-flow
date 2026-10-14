'use strict';

// 078 B.1 (IC-001 decision half, IC-002, IC-022 renderer corpus): the emission rules as data, the
// pure arbitrate(), and the TypeScript renderer against test/fixtures/emission/render-corpus.json,
// whose expected bytes were written from the IC-002 templates and which policies/emission.jq must
// reproduce too (B.3).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  EMISSION_RULES, INPUT_DOMAINS, arbitrate, renderEmission, ruleAction, ruleVector, utf8Bytes,
} = require('../../src/runtime/context/arbitrate.ts');
const contextPack = require('../../src/runtime/context-pack.ts');

const REPO = path.resolve(__dirname, '../..');
const CORPUS = JSON.parse(fs.readFileSync(path.join(REPO, 'test/fixtures/emission/render-corpus.json'), 'utf8'));

// IC-002 transcribed by hand: every non-skip combination, braces and `*` expanded. Anything absent is `skip`.
const RULE_INPUTS = {
  'prompt.slot': ['bootstrapped'],
  'prompt.git': ['role', 'bootstrapped'],
  'prompt.summary': ['role', 'lineageKind', 'subagent', 'bootstrapped', 'ownSummary'],
  'prompt.warning': ['role', 'subagent', 'bootstrapped', 'warning'],
  'prompt.grant': ['subagent', 'grant', 'refusedSeen'],
  'prompt.nudge': ['role', 'nudge'],
  'legacy-adopt.legacy': ['role', 'lineageKind', 'subagent', 'bootstrapped', 'legacy'],
  'launch.slot': ['bootstrapped'],
  'launch.pack': ['bootstrapped'],
  'launch.summary': ['role', 'bootstrapped', 'ownSummary'],
  'launch.grant': ['grant', 'refusedSeen'],
  'delta.pack': ['bootstrapped'],
  'compact-store.summary': ['role', 'lineageKind'],
  'compact-meta.meta': ['role', 'lineageKind'],
  'compact-instructions.instructions': ['role'],
};
const NON_SKIP = new Map([
  ['prompt.slot|false', 'claim'],
  ['prompt.git|main:false', 'include'],
  ['prompt.summary|main:default-main:false:false:pending', 'truncate'],
  ['prompt.summary|main:launched:false:false:pending', 'truncate'],
  ['prompt.summary|worker:launched:false:false:pending', 'truncate'],
  ['prompt.warning|main:false:false:true', 'include'],
  ['prompt.grant|false:fits:false', 'whole'],
  ['prompt.grant|false:fits:true', 'whole'],
  ['prompt.grant|false:over:false', 'pointer'],
  ['prompt.nudge|main:nudge', 'include'],
  ['legacy-adopt.legacy|main:default-main:false:false:true', 'adopt'],
  ['launch.slot|false', 'claim'],
  ['launch.pack|false', 'include'],
  ['launch.summary|main:false:pending', 'truncate'],
  ['launch.summary|worker:false:pending', 'truncate'],
  ['launch.grant|fits:false', 'whole'],
  ['launch.grant|fits:true', 'whole'],
  ['launch.grant|over:false', 'pointer'],
  ['delta.pack|true', 'include'],
  ['compact-store.summary|main:default-main', 'write'],
  ['compact-store.summary|main:launched', 'write'],
  ['compact-store.summary|worker:launched', 'write'],
  ['compact-meta.meta|main:default-main', 'write'],
  ['compact-instructions.instructions|main', 'include'],
  ['compact-instructions.instructions|worker', 'include'],
]);
const CLASSES = {
  'prompt.git': 'optional', 'prompt.summary': 'optional', 'prompt.warning': 'optional', 'prompt.nudge': 'optional',
  'prompt.grant': 'mandatory', 'launch.grant': 'mandatory', 'launch.summary': 'optional',
  'launch.pack': 'per-item', 'delta.pack': 'per-item', 'compact-instructions.instructions': 'optional',
};

const DEFAULT_STATE = {
  bootstrapped: false, subagent: false, ownSummary: 'none', legacy: false,
  grant: 'none', refusedSeen: false, warning: false, nudge: 'none',
};

function request(event, values = {}) {
  const state = { ...DEFAULT_STATE };
  const identity = { role: 'main', lineageKind: 'default-main', run: 'local', lineage: 'main', attempt: '', unitId: 's-1' };
  for (const [name, value] of Object.entries(values)) {
    if (name === 'role' || name === 'lineageKind') identity[name] = value;
    else state[name] = value === 'true' ? true : value === 'false' ? false : value;
  }
  return { event, identity, state, budget: { maxBytes: 16384, source: 'default' } };
}

/** Every vector of a rule's inputs over their domains. */
function vectors(inputs) {
  return inputs.reduce((acc, name) => acc.flatMap((prefix) => INPUT_DOMAINS[name].map((v) => [...prefix, v])), [[]]);
}

test('IC-002: the rules name exactly the table rows, inputs in vector order, classes as listed', () => {
  const keys = EMISSION_RULES.map((r) => `${r.event}.${r.segment}`);
  assert.deepEqual([...keys].sort(), Object.keys(RULE_INPUTS).sort());
  for (const r of EMISSION_RULES) {
    const key = `${r.event}.${r.segment}`;
    assert.deepEqual(r.inputs, RULE_INPUTS[key], key);
    assert.equal(r.class, CLASSES[key] ?? 'n/a', key);
  }
  assert.ok(Object.isFrozen(EMISSION_RULES) && Object.isFrozen(EMISSION_RULES[0].arms[0].when));
});

test('IC-002: every listed combination gives its action and every unlisted combination is skip', () => {
  let checked = 0;
  for (const r of EMISSION_RULES) {
    const key = `${r.event}.${r.segment}`;
    for (const vector of vectors(r.inputs)) {
      const expected = NON_SKIP.get(`${key}|${vector.join(':')}`) ?? 'skip';
      assert.equal(ruleAction(r, vector), expected, `${key}|${vector.join(':')}`);
      const values = Object.fromEntries(r.inputs.map((name, i) => [name, vector[i]]));
      const req = request(r.event, values);
      assert.deepEqual(ruleVector(r, req), vector);
      assert.equal(arbitrate(req).actions[r.segment], expected, `arbitrate ${key}|${vector.join(':')}`);
      checked += 1;
    }
  }
  assert.ok(checked > 100, `enumerated ${checked} vectors`);
});

test('IC-001: arbitrate() is pure and deterministic, and names one action per rule of its event', () => {
  const req = request('prompt', { grant: 'fits', warning: 'true', ownSummary: 'pending', nudge: 'nudge' });
  const before = JSON.stringify(req);
  const first = arbitrate(req);
  assert.equal(JSON.stringify(req), before, 'request not mutated');
  assert.deepEqual(arbitrate(JSON.parse(before)), first, 'equal requests give equal decisions');
  assert.deepEqual(Object.keys(first.actions).sort(), ['git', 'grant', 'nudge', 'slot', 'summary', 'warning']);
  assert.deepEqual(first, {
    emit: true,
    reason: 'emit',
    actions: { slot: 'claim', git: 'include', summary: 'truncate', warning: 'include', grant: 'whole', nudge: 'include' },
    claims: ['slot', 'summary', 'grant', 'warning'],
    ledger: null,
  });
  const legacy = arbitrate(request('legacy-adopt', { legacy: 'true' }));
  assert.deepEqual(legacy, { emit: false, reason: 'act', actions: { legacy: 'adopt' }, claims: ['legacy'], ledger: null });
});

test('IC-001: silence reasons, and values outside the IC-002 domain are refused', () => {
  const settled = arbitrate(request('prompt', { bootstrapped: 'true' }));
  assert.equal(settled.emit, false);
  assert.equal(settled.reason, 'silent:already-bootstrapped');
  assert.deepEqual(settled.claims, []);
  assert.equal(arbitrate(request('delta')).reason, 'silent:unchanged');
  assert.equal(arbitrate(request('compact-meta', { role: 'worker', lineageKind: 'solo' })).reason, 'silent:unchanged');
  assert.equal(arbitrate(request('prompt', { role: 'worker', lineageKind: 'solo' })).reason, 'act', 'worker claims the slot and renders nothing');
  assert.throws(() => arbitrate(request('stop')), TypeError);
  assert.throws(() => arbitrate(request('prompt', { role: 'admin' })), TypeError);
  assert.throws(() => arbitrate(request('prompt', { grant: 'maybe' })), TypeError);
  assert.throws(() => arbitrate({ ...request('prompt'), state: { ...DEFAULT_STATE, bootstrapped: 'yes' } }), TypeError);
});

test('IC-002 / DEC-015: a mandatory grant over budget is refused and every mandatory segment becomes pointer', () => {
  for (const [event, values] of [['prompt', {}], ['launch', { lineageKind: 'launched', role: 'worker' }]]) {
    const decision = arbitrate(request(event, { ...values, grant: 'over' }));
    const mandatory = EMISSION_RULES.filter((r) => r.event === event && r.class === 'mandatory').map((r) => r.segment);
    assert.ok(mandatory.length > 0);
    for (const segment of mandatory) assert.equal(decision.actions[segment], 'pointer', `${event}.${segment}`);
    assert.equal(decision.reason, 'refused:mandatory-over-budget', event);
    assert.equal(decision.emit, true);
    assert.ok(!decision.claims.includes('grant'), 'a pointer leaves the grant in place');
    assert.deepEqual(decision.ledger, { kind: 'grant', key: '@grant', outcome: 'refused:mandatory-over-budget' });
    const seen = arbitrate(request(event, { ...values, grant: 'over', refusedSeen: 'true', bootstrapped: 'true' }));
    assert.equal(seen.actions.grant, 'skip', 'a recorded refusal is silent next time');
    assert.equal(seen.ledger, null);
  }
  const corpusCase = CORPUS.cases.find((c) => c.name === 'grant-mandatory-over-budget-refused');
  const rendered = renderEmission(corpusCase);
  assert.equal(rendered.refused, true);
  assert.match(rendered.text, /^\[Granted summary s-\S+ withheld: 90 bytes exceed the 100-byte context budget\]$/);
  assert.ok(!rendered.text.includes('h'.repeat(10)), 'mandatory content is never cut');
});

test('IC-002: an optional segment that does not fit is dropped whole and named', () => {
  const c = CORPUS.cases.find((x) => x.name === 'budget-exactly-at-max');
  const rendered = renderEmission(c);
  assert.deepEqual(rendered.dropped, ['summary', 'nudge']);
  assert.deepEqual(rendered.segments, ['git', 'warning']);
  assert.equal(rendered.bytes, c.maxBytes);
  assert.ok(!rendered.text.includes('S'), 'no part of the dropped summary renders');
});

test('FR-013: a worker launch never renders git, nudge or warning', () => {
  const launch = EMISSION_RULES.filter((r) => r.event === 'launch');
  const inputs = [...new Set(launch.flatMap((r) => r.inputs))];
  const allInputs = { git: '{"is_git_repo":true,"branch":"b"}', warning: 'w', nudge: 'n', summary: '---\nx: y\n---\n\nbody\n', grant: '---\nsummary_id: s-1\n---\n\ng\n' };
  for (const lineageKind of INPUT_DOMAINS.lineageKind) {
    for (const vector of vectors(inputs.filter((n) => n !== 'role'))) {
      const values = { role: 'worker', lineageKind, ...Object.fromEntries(inputs.filter((n) => n !== 'role').map((n, i) => [n, vector[i]])) };
      const decision = arbitrate(request('launch', values));
      for (const segment of ['git', 'nudge', 'warning']) assert.equal(decision.actions[segment], undefined);
      const text = renderEmission({ actions: decision.actions, maxBytes: 16384, inputs: allInputs }).text ?? '';
      assert.ok(!/Git context|Not a git|Prior session warning/.test(text) && !text.endsWith('\n\nn'), text);
    }
  }
});

test('IC-022 corpus: covers every segment and the edge classes the parity contract names', () => {
  const covers = new Set(CORPUS.cases.flatMap((c) => c.covers));
  for (const tag of ['git', 'summary', 'warning', 'grant', 'pointer', 'nudge', 'join', 'budget', 'multibyte', 'crlf', 'oversized', 'empty', 'cap', 'refusal', 'DEC-022']) {
    assert.ok(covers.has(tag), `corpus covers ${tag}`);
  }
  const names = CORPUS.cases.map((c) => c.name);
  assert.equal(new Set(names).size, names.length, 'case names are unique');
});

for (const c of CORPUS.cases) {
  test(`IC-022 corpus: TypeScript render of ${c.name} equals the expected bytes`, () => {
    const rendered = renderEmission(c);
    assert.equal(rendered.text, c.expected.text);
    assert.equal(rendered.bytes, c.expected.bytes);
    assert.equal(rendered.refused, c.expected.refused);
    assert.deepEqual(rendered.dropped, c.expected.dropped);
    if (rendered.text !== null) assert.equal(utf8Bytes(rendered.text), Buffer.byteLength(rendered.text, 'utf8'));
  });
}

test('IC-001: context-pack.ts re-exports arbitrate', () => {
  assert.equal(contextPack.arbitrate, arbitrate);
});
