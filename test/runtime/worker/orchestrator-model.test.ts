'use strict';
// The orchestrator slot: one resolver (first match wins: bound orchestrator, the main session's model on its own
// harness, bound frontier, harness default) and the one helper every dispatch path uses for owner delivery-lead.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { renderBriefTools } = require('../../../src/runtime/brief-tools.ts');
const { dispatchModelFor } = require('../../../src/runtime/dispatch/admission.ts');
const { loadRegistry } = require('../../../src/registry/index.ts');
const { CapabilityRouter } = require('../../../src/runtime/capability-router.ts');
const {
  resolveOrchestratorModel, usesOrchestratorModel, resolveTaskModel, bindingGap, ORCHESTRATOR_OWNER,
} = require('../../../src/runtime/worker/models.ts');

const REPO = path.resolve(__dirname, '../../..');
const registry = loadRegistry({ repoRoot: REPO });
const descriptor = registry.harnesses.find((h: any) => h.id === 'codex').worker;
const set = (map: any) => ({ state: 'set', map, reason: null });
// A resolvePrimary result: `confirmed` is observed by the hook; the others carry the declaration's origin layer.
const main = (model: string | null, extra: any = {}) => ({ harness: 'codex', model, state: 'confirmed', declared: null, ...extra });
const declared = (state: string, layer: string, model = 'session-1') => ({
  harness: 'codex', model, state, declared: { harness: 'codex', model, origin: { harness: layer, model: layer } },
});

test('a bound orchestrator wins over the main session and the frontier binding', () => {
  const out = resolveOrchestratorModel({ harness: 'codex', bindings: set({ codex: { orchestrator: 'orch-1', frontier: 'front-1' } }), primary: main('session-1'), descriptor });
  assert.equal(out.model, 'orch-1');
  assert.equal(out.source, 'binding');
});

test('without an orchestrator binding the main session model wins, on the primary harness only', () => {
  const bindings = set({ codex: { frontier: 'front-1' } });
  const same = resolveOrchestratorModel({ harness: 'codex', bindings, primary: main('session-1'), descriptor });
  assert.equal(same.model, 'session-1');
  assert.equal(same.source, 'main-session');
  assert.equal(same.flag, 'supported');
  const other = resolveOrchestratorModel({ harness: 'codex', bindings, primary: { harness: 'claude', model: 'session-1', state: 'confirmed' }, descriptor });
  assert.equal(other.source, 'frontier-binding');
  assert.equal(other.model, 'front-1');
});

test('the main session model counts when confirmed by the hook, or declared in the user layer', () => {
  const bindings = set({ codex: { frontier: 'front-1' } });
  const pick = (primary: any) => resolveOrchestratorModel({ harness: 'codex', bindings, primary, descriptor });
  for (const primary of [main('session-1'), declared('declared-only', 'user'), declared('unconfirmed', 'user')]) {
    const out = pick(primary);
    assert.deepEqual([out.model, out.source], ['session-1', 'main-session'], JSON.stringify(primary));
  }
});

test('a declaration from a project, local or env origin, or from no origin, never picks the orchestrator model', () => {
  const bindings = set({ codex: { frontier: 'front-1' } });
  const cases: any[] = [];
  for (const state of ['declared-only', 'unconfirmed']) {
    for (const layer of ['project', 'local', 'env', 'default']) cases.push(declared(state, layer));
    cases.push({ harness: 'codex', model: 'session-1', state, declared: null }, { harness: 'codex', model: 'session-1', state });
  }
  for (const primary of cases) {
    const out = resolveOrchestratorModel({ harness: 'codex', bindings, primary, descriptor });
    assert.deepEqual([out.model, out.source], ['front-1', 'frontier-binding'], JSON.stringify(primary));
  }
});

test('contradicted, refused, unknown and not-primary states, and a model-less or invalid primary, fall through to the frontier binding', () => {
  const bindings = set({ codex: { frontier: 'front-1' } });
  const cases = [
    ...['contradicted', 'refused', 'unknown', 'not-primary'].map((state) => declared(state, 'user')),
    main(null), main(''), main('-rf'), main('a model; rm -rf'), { ...declared('declared-only', 'user'), harness: 'claude' }, null,
  ];
  for (const primary of cases) {
    const out = resolveOrchestratorModel({ harness: 'codex', bindings, primary, descriptor });
    assert.deepEqual([out.model, out.source], ['front-1', 'frontier-binding'], JSON.stringify(primary));
  }
});

test("the review repro: a user frontier binding plus a project's primary.model resolves to the user's frontier binding", () => {
  const out = resolveOrchestratorModel({
    harness: 'codex', bindings: set({ codex: { frontier: 'user-frontier' } }), primary: declared('declared-only', 'project', 'project-picked-model'), descriptor,
  });
  assert.deepEqual([out.model, out.source], ['user-frontier', 'frontier-binding']);
  const none = resolveOrchestratorModel({ harness: 'codex', bindings: { state: 'unset', map: null, reason: null }, primary: declared('declared-only', 'project'), descriptor });
  assert.deepEqual([none.model, none.source], [null, 'harness-default']);
});

test('with nothing bound and no main session the orchestrator gets the harness default', () => {
  for (const bindings of [{ state: 'unset', map: null, reason: null }, set({ codex: { light: 'l-1' } })]) {
    const out = resolveOrchestratorModel({ harness: 'codex', bindings, primary: null, descriptor });
    assert.equal(out.model, null);
    assert.equal(out.source, 'harness-default');
  }
});

test('an unreadable binding setting is invalid, not a silent fallback to the main session', () => {
  const out = resolveOrchestratorModel({ harness: 'codex', bindings: { state: 'invalid', map: null, reason: 'unreadable' }, primary: main('session-1'), descriptor });
  assert.equal(out.source, 'invalid');
  assert.equal(out.model, null);
});

test('the orchestrator model applies to owner delivery-lead on an owner-derived tier only', () => {
  assert.equal(ORCHESTRATOR_OWNER, 'delivery-lead');
  assert.equal(usesOrchestratorModel('delivery-lead', { tier: 'frontier', source: 'owner' }), true);
  assert.equal(usesOrchestratorModel(' Delivery-Lead ', { tier: 'frontier', source: 'owner' }), true);
  assert.equal(usesOrchestratorModel('delivery-lead', { tier: 'light', source: 'task' }), false, 'an explicit task tier still wins');
  assert.equal(usesOrchestratorModel('delivery-lead', { tier: 'standard', source: 'default' }), false);
  assert.equal(usesOrchestratorModel('core-implementer', { tier: 'standard', source: 'owner' }), false);
  assert.equal(usesOrchestratorModel(null, null), false);
});

test('resolveTaskModel gives delivery-lead the orchestrator model and every other dispatch its tier binding', () => {
  const bindings = set({ codex: { frontier: 'front-1', light: 'light-1' } });
  const primary = main('session-1');
  const lead = resolveTaskModel({ worker: 'codex', owner: 'delivery-lead', resolvedTier: { tier: 'frontier', source: 'owner' }, bindings, descriptor, primary });
  assert.deepEqual([lead.model, lead.source], ['session-1', 'main-session']);
  const taskTier = resolveTaskModel({ worker: 'codex', owner: 'delivery-lead', resolvedTier: { tier: 'light', source: 'task' }, bindings, descriptor, primary });
  assert.deepEqual([taskTier.model, taskTier.source], ['light-1', 'binding']);
  const other = resolveTaskModel({ worker: 'codex', owner: 'core-implementer', resolvedTier: { tier: 'frontier', source: 'owner' }, bindings, descriptor, primary });
  assert.deepEqual([other.model, other.source], ['front-1', 'binding']);
});

test('dispatchModelFor records the orchestrator source in the dispatch snapshot', () => {
  const bindings = set({ claude: { frontier: 'front-1' } });
  const primary = { harness: 'claude', model: 'session-1', state: 'confirmed' };
  const lead = dispatchModelFor({ mode: 'subagent', harness: 'claude', tier: 'frontier', owner: 'delivery-lead', resolvedTier: { tier: 'frontier', source: 'owner' }, bindings, primary, descriptor });
  assert.deepEqual(lead.model, { tier: 'frontier', requested: 'session-1', source: 'main-session' });
  const noSession = dispatchModelFor({ mode: 'subagent', harness: 'claude', tier: 'frontier', owner: 'delivery-lead', resolvedTier: { tier: 'frontier', source: 'owner' }, bindings, primary: null, descriptor });
  assert.deepEqual(noSession.model, { tier: 'frontier', requested: 'front-1', source: 'frontier-binding' });
  const bound = dispatchModelFor({ mode: 'subagent', harness: 'claude', tier: 'frontier', owner: 'delivery-lead', resolvedTier: { tier: 'frontier', source: 'owner' }, bindings: set({ claude: { orchestrator: 'o-1' } }), primary, descriptor });
  assert.deepEqual(bound.model, { tier: 'frontier', requested: 'o-1', source: 'binding' });
  const tierOnly = dispatchModelFor({ mode: 'subagent', harness: 'claude', tier: 'frontier', bindings, primary, descriptor });
  assert.deepEqual(tierOnly.model, { tier: 'frontier', requested: 'front-1', source: 'binding' });
});

test('a frontier binding the orchestrator uses is held to the same model-flag evidence rule as a binding', () => {
  const noFlag = { ...descriptor, model: { status: 'unknown', evidence: [], verification: 'x', verifiedOn: '2026-11-15', reason: 'x' } };
  const out = resolveOrchestratorModel({ harness: 'codex', bindings: set({ codex: { frontier: 'front-1' } }), primary: null, descriptor: noFlag });
  assert.equal(out.source, 'frontier-binding');
  assert.deepEqual(bindingGap(out), { requirement: 'binding', result: 'failed', reason: 'model-flag:unevidenced' });
  assert.equal(bindingGap(resolveOrchestratorModel({ harness: 'codex', bindings: set({ codex: { frontier: 'front-1' } }), primary: null, descriptor })), null);
});

function briefFor(owner: string, overrides: any = {}) {
  const router: any = new CapabilityRouter({ repoRoot: REPO, projectRoot: REPO });
  const probes: any = {};
  for (const capability of Object.values<any>(router.capabilities)) for (const provider of capability.providers) probes[provider.id] = { id: provider.id, status: 'HEALTHY' };
  return renderBriefTools({
    registry, router, probes, reach: null, owner, stage: null, harness: 'codex',
    bindings: set({ codex: { frontier: 'front-1' } }), ...overrides,
  });
}

test('the brief Model line for delivery-lead names the resolved orchestrator model and where it came from', () => {
  const session = briefFor('delivery-lead', { primary: main('session-1') });
  assert.ok(session.markdown.includes("Model: `session-1` [model unchecked] on `codex` (the main session's model)."), session.markdown);
  assert.deepEqual(session.record.model, { harness: 'codex', id: 'session-1', provider: null, effort: null, check: { model: 'unchecked', effort: null }, source: 'main-session' });
  const frontier = briefFor('delivery-lead');
  assert.ok(frontier.markdown.includes('Model: `front-1` [model unchecked] on `codex` (frontier binding, user layer).'));
  assert.equal(frontier.record.model.source, 'frontier-binding');
  const bound = briefFor('delivery-lead', { bindings: set({ codex: { orchestrator: 'o-1', frontier: 'front-1' } }), primary: main('session-1') });
  assert.ok(bound.markdown.includes('Model: `o-1` [model unchecked] on `codex` (binding, user layer).'));
  const none = briefFor('delivery-lead', { bindings: { state: 'unset', map: null, reason: null } });
  assert.ok(none.markdown.includes('Model: harness default on `codex`.'));
  const other = briefFor('core-implementer', { primary: main('session-1'), bindings: set({ codex: { standard: 'std-1', orchestrator: 'o-1' } }) });
  assert.ok(other.markdown.includes('Model: `std-1` [model unchecked] on `codex` (binding, user layer).'), 'only delivery-lead takes the orchestrator model');
});

test('169: a slot with a provider and effort resolves to a choice, and the dispatch snapshot keeps both', () => {
  const entry = { status: 'supported', evidence: ['x'], verification: 'v', verifiedOn: '2026-11-16' };
  const piLike = { ...descriptor, provider: { ...entry, via: 'id-prefix', separator: '/' }, effort: { ...entry, via: 'flag', argv: ['--thinking', '{effort}'], levels: ['low', 'high'] } };
  const bindings = set({ codex: { frontier: { model: 'm-1', provider: 'openai', effort: 'high' }, light: 'plain-1' } });
  const frontier = resolveTaskModel({ worker: 'codex', owner: 'core-implementer', resolvedTier: { tier: 'frontier', source: 'owner' }, bindings, descriptor: piLike });
  assert.deepEqual([frontier.model, frontier.choice], ['m-1', { model: 'm-1', provider: 'openai', effort: 'high' }]);
  assert.equal(bindingGap(frontier), null);
  const record = dispatchModelFor({ mode: 'subagent', harness: 'codex', tier: 'frontier', bindings, primary: null, descriptor: piLike });
  assert.deepEqual(record.model, { tier: 'frontier', requested: 'm-1', source: 'binding', provider: 'openai', effort: 'high' });
  const plain = dispatchModelFor({ mode: 'subagent', harness: 'codex', tier: 'light', bindings, primary: null, descriptor: piLike });
  assert.deepEqual(plain.model, { tier: 'light', requested: 'plain-1', source: 'binding' });
  const none = dispatchModelFor({ mode: 'subagent', harness: 'codex', tier: 'standard', bindings, primary: null, descriptor: piLike });
  assert.deepEqual(none.model, { tier: 'standard', requested: null, source: 'harness-default' });
});

test('169: the orchestrator rule carries a bound orchestrator slot as a choice', () => {
  const out = resolveOrchestratorModel({ harness: 'codex', bindings: set({ codex: { orchestrator: { model: 'orch-1', effort: 'high' } } }), primary: null, descriptor });
  assert.deepEqual([out.model, out.source, out.choice], ['orch-1', 'binding', { model: 'orch-1', provider: null, effort: 'high' }]);
  assert.equal(bindingGap(out)?.reason, 'effort:unsupported', 'the shipped codex effort entry is not supported');
});
