'use strict';

// Feature 085 (H1): the rollout profile caps the advisor (shadow-dispatcher) and the code graph (graph-fallback)
// only when a profile was chosen (env or settings), a rollback is active or the profile value is invalid. A
// project that sets no profile (resolve origin registry-default) keeps advice and graph as they were.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { interceptDecisionPoint } = require('../../src/runtime/advice/shadow-dispatcher.ts');
const { resolveRelationshipQuery } = require('../../src/runtime/knowledge/graph-fallback.ts');

/** A project with optional settings and rollback sentinel, and an env whose user settings home is empty. */
function project(t: any, { settings, sentinel }: any = {}) {
  const dir = tempDir(t, 'doflow-rollout-gating-');
  const root = path.join(dir, 'proj');
  fs.mkdirSync(path.join(root, '.doflow', 'state'), { recursive: true });
  if (settings) fs.writeFileSync(path.join(root, '.doflow', 'settings.json'), JSON.stringify(settings));
  if (sentinel) fs.writeFileSync(path.join(root, '.doflow', 'state', 'rollback.json'), JSON.stringify(sentinel));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  return { root, env: { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') } };
}

const CASES: any = {
  'no profile (registry default)': { expectAdvisor: 'act', expectGraph: true },
  'settings rollout.profile baseline': { settings: { rollout: { profile: 'baseline' } }, expectAdvisor: 'off', expectGraph: false },
  'env DOFLOW_ROLLOUT_PROFILE=baseline': { env: { DOFLOW_ROLLOUT_PROFILE: 'baseline' }, expectAdvisor: 'off', expectGraph: false },
  'active rollback sentinel': { sentinel: { active: true, reason: 'manual' }, expectAdvisor: 'off', expectGraph: false },
  'invalid profile value': { settings: { rollout: { profile: 'bogus' } }, expectAdvisor: 'off', expectGraph: false },
  'settings rollout.profile canary': { settings: { rollout: { profile: 'canary' } }, expectAdvisor: 'shadow', expectGraph: true },
  'settings rollout.profile full': { settings: { rollout: { profile: 'full' } }, expectAdvisor: 'act', expectGraph: true },
};

for (const [name, c] of Object.entries(CASES) as any) {
  test(`085 H1 advisor: ${name} resolves a configured act to ${c.expectAdvisor}`, async (t) => {
    const p = project(t, c);
    let asked = 0;
    const res = await interceptDecisionPoint({
      kind: 'tier', caller: 'brief-tools', state: 's', staticPick: 'light', taskId: 'x',
      projectRoot: p.root, env: { ...p.env, ...(c.env || {}) }, record: false,
    }, {
      adviceClient: { ask: async () => { asked += 1; return { status: 'answered', answers: [{ pick: 'standard' }] }; } },
      shadowConfig: { kind: 'tier', mode: 'act', model: 'm', benchBarPassed: true },
    });
    assert.equal(res.mode, c.expectAdvisor);
    if (c.expectAdvisor === 'act') {
      assert.equal(res.advisorPick, 'standard');
      assert.equal(res.effectiveDecision, 'standard');
    } else {
      assert.equal(res.advisorPick, null);
      assert.equal(res.effectiveDecision, 'light', 'a capped advisor never changes the decision');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(asked, c.expectAdvisor === 'off' ? 0 : 1, 'off asks the model nothing');
  });

  test(`085 H1 graph: ${name} ${c.expectGraph ? 'keeps' : 'turns off'} a fresh graph`, async (t) => {
    const p = project(t, c);
    const graphData = {
      nodes: [{ id: 'symA', label: 'symA', file: 'src/a.ts', line: 1 }, { id: 'symB', label: 'symB', file: 'src/b.ts', line: 1 }],
      edges: [{ source: 'symB', target: 'symA', relation: 'calls' }],
    };
    fs.mkdirSync(path.join(p.root, 'src'));
    fs.writeFileSync(path.join(p.root, 'src/a.ts'), 'export function symA() {}\n');
    fs.mkdirSync(path.join(p.root, 'graphify-out'));
    fs.writeFileSync(path.join(p.root, 'graphify-out/graph.json'), JSON.stringify(graphData));
    const now = Date.now() / 1000;
    fs.utimesSync(path.join(p.root, 'src/a.ts'), now - 20, now - 20);
    fs.utimesSync(path.join(p.root, 'graphify-out/graph.json'), now, now);
    // graph-fallback resolves the profile from process.env, so the env case is set for this call only.
    const saved = { ...process.env };
    Object.assign(process.env, p.env, c.env || {});
    let res: any;
    try {
      res = await resolveRelationshipQuery({ projectRoot: p.root, symbol: 'symA', intent: 'trace-dependency' }, {
        rgSearchImpl: async () => [{ file: 'src/a.ts', line: 1, content: 'export function symA() {}' }],
      });
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
    assert.equal(res.freshness, 'FRESH');
    if (c.expectGraph) {
      assert.equal(res.provider, 'graphify.query');
      assert.equal(res.status, 'HEALTHY');
    } else {
      assert.equal(res.provider, 'native.rg');
      assert.equal(res.status, 'FALLBACK');
      assert.equal(res.fallbackReason, 'profile-disabled');
      assert.equal(res.isAbsence, false);
    }
  });
}
