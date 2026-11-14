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
const main = (model: string | null, extra: any = {}) => ({ harness: 'codex', model, state: 'observed', ...extra });

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
  const other = resolveOrchestratorModel({ harness: 'codex', bindings, primary: { harness: 'claude', model: 'session-1', state: 'observed' }, descriptor });
  assert.equal(other.source, 'frontier-binding');
  assert.equal(other.model, 'front-1');
});

test('an unknown, refused or model-less main session is not used', () => {
  const bindings = set({ codex: { frontier: 'front-1' } });
  for (const primary of [main('s', { state: 'unknown' }), main('s', { state: 'refused' }), main('s', { state: 'not-primary' }), main(null), main(''), null]) {
    const out = resolveOrchestratorModel({ harness: 'codex', bindings, primary, descriptor });
    assert.equal(out.source, 'frontier-binding', JSON.stringify(primary));
    assert.equal(out.model, 'front-1');
  }
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
  const primary = { harness: 'claude', model: 'session-1', state: 'observed' };
  const lead = dispatchModelFor({ mode: 'subagent', harness: 'claude', tier: 'frontier', owner: 'delivery-lead', resolvedTier: { tier: 'frontier', source: 'owner' }, bindings, primary });
  assert.deepEqual(lead.model, { tier: 'frontier', requested: 'session-1', source: 'main-session' });
  const noSession = dispatchModelFor({ mode: 'subagent', harness: 'claude', tier: 'frontier', owner: 'delivery-lead', resolvedTier: { tier: 'frontier', source: 'owner' }, bindings, primary: null });
  assert.deepEqual(noSession.model, { tier: 'frontier', requested: 'front-1', source: 'frontier-binding' });
  const bound = dispatchModelFor({ mode: 'subagent', harness: 'claude', tier: 'frontier', owner: 'delivery-lead', resolvedTier: { tier: 'frontier', source: 'owner' }, bindings: set({ claude: { orchestrator: 'o-1' } }), primary });
  assert.deepEqual(bound.model, { tier: 'frontier', requested: 'o-1', source: 'binding' });
  const tierOnly = dispatchModelFor({ mode: 'subagent', harness: 'claude', tier: 'frontier', bindings, primary });
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
  assert.ok(session.markdown.includes("Model: `session-1` on `codex` (the main session's model)."), session.markdown);
  assert.deepEqual(session.record.model, { harness: 'codex', id: 'session-1', source: 'main-session' });
  const frontier = briefFor('delivery-lead');
  assert.ok(frontier.markdown.includes('Model: `front-1` on `codex` (frontier binding, user layer).'));
  assert.equal(frontier.record.model.source, 'frontier-binding');
  const bound = briefFor('delivery-lead', { bindings: set({ codex: { orchestrator: 'o-1', frontier: 'front-1' } }), primary: main('session-1') });
  assert.ok(bound.markdown.includes('Model: `o-1` on `codex` (binding, user layer).'));
  const none = briefFor('delivery-lead', { bindings: { state: 'unset', map: null, reason: null } });
  assert.ok(none.markdown.includes('Model: harness default on `codex`.'));
  const other = briefFor('core-implementer', { primary: main('session-1'), bindings: set({ codex: { standard: 'std-1', orchestrator: 'o-1' } }) });
  assert.ok(other.markdown.includes('Model: `std-1` on `codex` (binding, user layer).'), 'only delivery-lead takes the orchestrator model');
});
