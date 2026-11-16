'use strict';

// Feature 085 (H1): the rollout profile caps the advisor (shadow-dispatcher)
// only when a profile was chosen (env or settings), a rollback is active or the profile value is invalid. A
// project that sets no profile (resolve origin registry-default) keeps advice as it was.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { interceptDecisionPoint } = require('../../src/runtime/advice/shadow-dispatcher.ts');
const { profileAdvisorCap, capMode, unsetKindPath } = require('../../src/runtime/advice/mode.ts');

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
  'no profile (registry default)': { expectAdvisor: 'act' },
  'settings rollout.profile baseline': { settings: { rollout: { profile: 'baseline' } }, expectAdvisor: 'off' },
  'env DOFLOW_ROLLOUT_PROFILE=baseline': { env: { DOFLOW_ROLLOUT_PROFILE: 'baseline' }, expectAdvisor: 'off' },
  'active rollback sentinel': { sentinel: { active: true, reason: 'manual' }, expectAdvisor: 'off' },
  'invalid profile value': { settings: { rollout: { profile: 'bogus' } }, expectAdvisor: 'off' },
  'settings rollout.profile canary': { settings: { rollout: { profile: 'canary' } }, expectAdvisor: 'shadow' },
  'settings rollout.profile staged': { settings: { rollout: { profile: 'staged' } }, expectAdvisor: 'shadow' },
  'settings rollout.profile full': { settings: { rollout: { profile: 'full' } }, expectAdvisor: 'act' },
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
      shadowConfig: { kind: 'tier', mode: 'act', model: 'm' },
      // The bar passes here, so what the case tests is the profile cap, not the gate.
      benchGate: async () => ({ passed: true, reason: 'test' }),
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
    // Only act asks: off asks nothing, and shadow with record:false asks nothing since nothing could be kept.
    assert.equal(asked, c.expectAdvisor === 'act' ? 1 : 0);
  });
}

// 084 C-6 (D2): the profile's cap as mode.ts reads it from the project, for a set kind (configured act) and an unset one.
const CAP_CASES: any = {
  'no profile (registry default)': { cap: null, setAct: 'act', unset: 'legacy' },
  'settings rollout.profile baseline': { settings: { rollout: { profile: 'baseline' } }, cap: 'off', setAct: 'off', unset: 'off' },
  'env DOFLOW_ROLLOUT_PROFILE=baseline': { env: { DOFLOW_ROLLOUT_PROFILE: 'baseline' }, cap: 'off', setAct: 'off', unset: 'off' },
  'active rollback sentinel': { sentinel: { active: true, reason: 'manual' }, cap: 'off', setAct: 'off', unset: 'off' },
  'invalid profile value': { settings: { rollout: { profile: 'bogus' } }, cap: 'off', setAct: 'off', unset: 'off' },
  'settings rollout.profile canary': { settings: { rollout: { profile: 'canary' } }, cap: 'shadow', setAct: 'shadow', unset: 'shadow' },
  'settings rollout.profile staged': { settings: { rollout: { profile: 'staged' } }, cap: 'staged', setAct: 'shadow', unset: 'shadow' },
  'settings rollout.profile full': { settings: { rollout: { profile: 'full' } }, cap: 'act', setAct: 'act', unset: 'legacy' },
};
for (const [name, c] of Object.entries(CAP_CASES) as any) {
  test(`084 C-6 mode: ${name} caps a configured act to ${c.setAct} and routes an unset kind to ${c.unset}`, (t) => {
    const p = project(t, c);
    const cap = profileAdvisorCap({ projectRoot: p.root, env: { ...p.env, ...(c.env || {}) } });
    assert.equal(cap, c.cap);
    assert.equal(capMode(cap, 'act'), c.setAct);
    assert.equal(unsetKindPath(cap), c.unset);
  });
}
