'use strict';

// Feature 084, C-1/C-2 (user decision D3 of 2026-10-26): act stays unreachable. The bench gate reads no file in the
// caller's project, so a scored file written there never certifies act, however it is shaped.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { evaluateBenchBar } = require('../../src/runtime/advice/bench-gate.ts');
const { interceptDecisionPoint } = require('../../src/runtime/advice/shadow-dispatcher.ts');

const PASSING = {
  kind: 'tier',
  cases: [
    { id: '1', split: 'heldout', state: 's1', staticPick: 'light', expected: 'standard', modelPicks: { m: 'standard' } },
    { id: '2', split: 'heldout', state: 's2', staticPick: 'light', expected: 'frontier', modelPicks: { m: 'frontier' } },
    { id: '3', split: 'heldout', state: 's3', staticPick: 'light', expected: 'light', modelPicks: { m: 'light' } },
  ],
};

// Each input the old scoring code accepted (or threw on), plus a fully measured passing corpus.
const CORPORA: Record<string, any> = {
  'aggregate-only': { models: { m: { accuracy: 1 } } },
  'train-only cases': { cases: [{ id: '1', split: 'train', state: 's', staticPick: 'light', expected: 'standard', modelPicks: { m: 'standard' } }] },
  'a missing staticPick': { cases: [{ id: '1', split: 'heldout', state: 's', expected: 'standard', modelPicks: { m: 'standard' } }] },
  null: null,
  'accuracy outside [0,1]': { models: { m: { accuracy: 5, staticBaselineAccuracy: 0.5, heldoutCases: 100 } } },
  'non-finite accuracy': { models: { m: { accuracy: 'Infinity', staticBaselineAccuracy: 0.5, heldoutCases: 100 } } },
  'a defaulted baseline': { models: { m: { accuracy: 0.9, heldoutCases: 100 } } },
  'too few heldout cases': { models: { m: { accuracy: 0.9, staticBaselineAccuracy: 0.5, heldoutCases: 0 } } },
  'a fully measured passing corpus': PASSING,
};

function projectWithCorpus(t: any, corpus: any) {
  const root = tempDir(t, 'doflow-bench-gate-');
  const file = path.join(root, 'bench', 'advice', 'tier.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(corpus));
  return root;
}

for (const [name, corpus] of Object.entries(CORPORA)) {
  test(`C-1/D3: a project bench file with ${name} never passes the bar`, async (t) => {
    const repoRoot = projectWithCorpus(t, corpus);
    const res = await evaluateBenchBar('tier', 'm', { repoRoot });
    assert.equal(res.passed, false);
    assert.equal(typeof res.reason, 'string');
  });
}

test('C-2: a passing file in the project plus advice.kinds.tier=act gives shadow with BENCH_BAR_UNMET', async (t) => {
  const root = projectWithCorpus(t, PASSING);
  fs.mkdirSync(path.join(root, '.doflow'), { recursive: true });
  fs.writeFileSync(path.join(root, '.doflow', 'settings.json'), JSON.stringify({ advice: { kinds: { tier: 'act' }, models: { tier: 'm' } } }));
  const home = tempDir(t, 'doflow-bench-gate-home-');
  let asked = 0;
  const res = await interceptDecisionPoint({
    kind: 'tier', caller: 'brief-tools', state: 's', staticPick: 'light', taskId: 't',
    projectRoot: root, env: { HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') }, record: false,
  }, {
    adviceClient: { ask: async () => { asked += 1; return { status: 'answered', model: 'm', answers: [{ name: 'tier', type: 'choice', pick: 'frontier' }] }; } },
  });
  assert.equal(res.mode, 'shadow');
  assert.equal(res.effectiveDecision, 'light');
  assert.equal(res.advisorPick, null);
  assert.match(res.warning, /^BENCH_BAR_UNMET: /);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(asked, 0, 'record:false: the degraded shadow call would record nothing, so it is not made');
});
