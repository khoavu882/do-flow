'use strict';

// 180 K4 (design section 8, IC-180-G2, AC-7 (e)): the `captured-state` case source joins a routing kind's captured lines
// to its picks (`static` is the rule) and their outcomes (`actual` is the label). Scratch roots only.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../../../../helper/tmp.ts');
const { REPO_ROOT } = require('../../../../../src/helper/repo-root.ts');
const { loadStorageRegistry } = require('../../../../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../../../../src/runtime/storage/roots.ts');
const { appendPick, appendOutcome } = require('../../../../../src/runtime/advice/record.ts');
const { captureState, resetCaptureSetting } = require('../../../../../src/runtime/advice/state-text.ts');
const { SOURCE_IDS, getSource, buildCases } = require('../../../../../src/runtime/advice/replay/sources/index.ts');
const capturedState = require('../../../../../src/runtime/advice/replay/sources/captured-state.ts');

const { source, build } = capturedState;
const STORAGE = loadStorageRegistry({ repoRoot: REPO_ROOT });
const TIER = { id: 'tier' };
const QUESTION = { name: 'tier', type: 'choice', instructions: 'Choose a tier.', options: { light: 'Light', standard: 'Normal', frontier: 'Frontier' } };
const ANSWER = { name: 'tier', type: 'choice', pick: 'light', probabilities: { light: 0.7, standard: 0.2, frontier: 0.1 }, confidence: 0.7 };
const sha16 = (text: string) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

function fixture(t: any, { capture = true } = {}) {
  resetCaptureSetting();
  const home = tempDir(t, 'doflow-captured-home-');
  const projectRoot = tempDir(t, 'doflow-captured-project-');
  const roots = resolveRoots({ registry: STORAGE, projectRoot, env: { HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') } });
  const settings = path.join(roots['config-home'], 'settings.json');
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ schema: 1, 'advice.capture.state-text': capture }));
  /** A recorded tier pick with `state` and rule answer `rule`, captured with `captured` (the same state by default). */
  const pick = (state: string, { rule = 'standard' as string | null, captured = state as string | null, kind = 'tier' } = {}) => {
    const written = appendPick({ roots, kind, answer: { ...ANSWER, name: kind }, question: { ...QUESTION, name: kind }, staticAnswer: rule, state, caller: 'brief-tools' });
    assert.ok(written);
    if (captured !== null) assert.ok(captureState({ roots, pickId: written.pickId, kind, state: captured, store: written.store }));
    return written.pickId as string;
  };
  const label = (pickId: string, actual: string) => assert.ok(appendOutcome({ roots, pickId, actual, source: 'orchestrator' }));
  return { roots, projectRoot, pick, label, run: () => build({ projectRoot, roots, kind: TIER }) };
}

test('the source is in the seam map, project-origin, not certifying by construction', () => {
  assert.ok(SOURCE_IDS.includes('captured-state'));
  assert.equal(getSource('captured-state'), source);
  assert.deepEqual([source.id, source.origin, source.labelIsRule, source.builderVersion], ['captured-state', 'project', false, 1]);
});

test('(e) one case per captured pick with an outcome: state is the masked text, label is actual, rule is static; each skip reason is counted', (t) => {
  const f = fixture(t);
  const token = `ghp_${'Z9y8X7w6V5'.repeat(4)}`;
  const good = f.pick(`Refactor the parser; token ${token}`);
  f.label(good, 'frontier');
  const relabelled = f.pick('Rename a field');
  f.label(relabelled, 'standard');
  f.label(relabelled, 'light');
  f.pick('No outcome yet');
  const noStatic = f.pick('No rule answer', { rule: null });
  f.label(noStatic, 'light');
  const moved = f.pick('The state the pick hashed', { captured: 'A different state' });
  f.label(moved, 'light');
  // Another routing kind's capture is not a tier case.
  f.pick('A class decision', { kind: 'task-class', rule: null });
  // A captured line whose pick is not in the window.
  assert.ok(captureState({ roots: f.roots, pickId: 'adv-0000000000009-abcdef', kind: 'tier', state: 'orphan', store: 'project-state' }));
  // An unreadable line in a partition.
  const dir = path.join(f.roots['project-state'], 'advice', 'state-text');
  fs.appendFileSync(path.join(dir, fs.readdirSync(dir)[0]), 'not json\n');

  const built = f.run();
  const expected = [
    { id: sha16(good), state: 'Refactor the parser; token <masked>', label: 'frontier', rule: 'standard' },
    { id: sha16(relabelled), state: 'Rename a field', label: 'light', rule: 'standard' },
  ].sort((a, b) => (a.id < b.id ? -1 : 1));
  assert.deepEqual(built.cases, expected);
  assert.ok(!JSON.stringify(built).includes(token));
  assert.deepEqual(built.skipped, { unreadable: 1, 'no-label': 1, 'no-static': 1, 'digest-mismatch': 1, 'no-pick': 1 });
});

test('(e) a case whose label is not an option of the question is left out as bad-label by the seam', (t) => {
  const f = fixture(t);
  f.label(f.pick('A task'), 'enormous');
  const built = buildCases(source, { projectRoot: f.projectRoot, roots: f.roots, kind: TIER }, ['light', 'standard', 'frontier']);
  assert.deepEqual(built.cases, []);
  assert.deepEqual(built.skipped, { 'bad-label': 1 });
});

test('(e) with no captured line for the kind the one skip reason says capture is off or empty, and nothing is written', (t) => {
  const f = fixture(t, { capture: false });
  f.label(f.pick('Not captured', { captured: null }), 'light');
  const before = fs.readdirSync(path.join(f.roots['project-state'], 'advice'));
  assert.deepEqual(f.run(), { cases: [], skipped: { 'capture-off-or-empty': 1 } });
  assert.deepEqual(fs.readdirSync(path.join(f.roots['project-state'], 'advice')), before);
});
