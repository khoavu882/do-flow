'use strict';

// The odd-numbered histories of the derivation differential (see lifecycle-derivation-differential.test.js
// and test/helper/lifecycle-derivation-reference.js), and the spawn budget of the overview and the
// release preview. Services run in process under a scratch HOME, XDG_CONFIG_HOME and git config (DEC-041).
//
// The spawn budget counts the processes the services start, through a counter wrapped around
// `child_process` here, before any module that destructures it is loaded. Production code counts
// nothing. The counter sees `bash do-git-state.sh` as one process; the git calls that script makes are
// its own, a fixed number per call.

const childProcess = require('node:child_process');

const spawned = { counting: false, calls: [] };
for (const name of ['execFileSync', 'spawnSync', 'execSync', 'spawn', 'execFile', 'exec', 'fork']) {
  const original = childProcess[name];
  childProcess[name] = function counted(...args) {
    if (spawned.counting) spawned.calls.push(Array.isArray(args[1]) ? `${args[0]} ${args[1][0]}` : String(args[0]));
    return original.apply(this, args);
  };
}

const test = require('node:test');
const assert = require('node:assert/strict');
const { createScratch } = require('../helper/scratch-env');
const { historyBuilder } = require('../helper/lifecycle-git-fixtures');
const { compareHistories, writeEvents, OUTCOMES, HISTORIES, CLOCK } = require('../helper/lifecycle-derivation-reference');
const { releaseFeatures } = require('../../src/runtime/lifecycle/release');
const { buildOverview } = require('../../src/runtime/lifecycle/overview');

const scratch = createScratch('doflow-differential-odd-');
test.before(() => scratch.apply());
test.after(() => { scratch.restore(); scratch.remove(); });

test(`differential: the odd-numbered of ${HISTORIES} generated histories derive the same statuses and release preview as the reference`, () => {
  const { outcomes } = compareHistories(scratch, { part: 1, parts: 2 });
  assert.deepEqual(OUTCOMES.filter((o) => !outcomes.has(o)), [], `the half is not trivial; outcomes seen: ${[...outcomes].sort().join(' ')}`);
});

// ── the spawn budget ───────────────────────────────────────────────────────────────────────────

/** The processes `fn` starts, by command and first argument. */
function spawnsOf(fn) {
  spawned.calls = [];
  spawned.counting = true;
  try { fn(); } finally { spawned.counting = false; }
  return spawned.calls;
}

/**
 * `count` features each merged with --no-ff into develop, all tracked before any work: v0.9.0 is cut at
 * a quarter and v1.0.0 at half, so v1.0.0 lies behind the tip.
 */
function manyFeatures(count) {
  const h = historyBuilder();
  h.commit('develop', 'init');
  const slugs = Array.from({ length: count }, (_, i) => `${String(300 + i)}-many`);
  const events = slugs.map((slug) => ({ type: 'feature.tracked', data: { slug }, at: h.iso() }));
  h.wait(60);
  slugs.forEach((slug, i) => {
    h.branch(`feat/${slug}`, 'develop').commit(`feat/${slug}`, `work on ${slug}`).merge('develop', `feat/${slug}`);
    if (i + 1 === Math.floor(count / 4)) h.tag('v0.9.0', 'develop');
    if (i + 1 === Math.floor(count / 2)) h.tag('v1.0.0', 'develop', { annotated: true });
  });
  const repo = h.write(scratch, `many-${count}`);
  writeEvents(repo.dir, events);
  return { repo, slugs };
}

test('spawn budget: the overview and the release preview start a fixed number of processes, whatever the number of features', () => {
  const RELEASE_TAGS = 3;
  const budget = 30 + 3 * RELEASE_TAGS;
  const measured = {};
  for (const count of [8, 40]) {
    const { repo, slugs } = manyFeatures(count);
    const root = repo.dir;
    const overview = () => buildOverview({ root, now: CLOCK });
    const counts = {};
    let preview;
    counts.overview = spawnsOf(overview);
    counts['preview behind the tip'] = spawnsOf(() => { preview = releaseFeatures({ root, tag: 'v1.0.0', now: CLOCK }); });
    assert.deepEqual(preview.candidates.map((c) => c.slug), slugs.slice(count / 4, count / 2), 'v1.0.0 ships what merged after v0.9.0, which finishes the earlier ones');
    assert.deepEqual(preview.notDetected, slugs.slice(count / 2), 'every later merge was searched for and lies after the tag');
    repo.git('tag', 'v1.1.0', 'develop');
    counts['preview at the tip'] = spawnsOf(() => { preview = releaseFeatures({ root, tag: 'v1.1.0', now: CLOCK }); });
    assert.deepEqual(preview.candidates.map((c) => c.slug), slugs.slice(count / 2));
    writeEvents(root, [{ type: 'release.recorded', data: { tag: 'v1.0.0', commit: 'c', features: slugs.slice(0, count / 2).map((slug) => ({ slug, evidence: 'branch', ref: 'r' })), excluded: [] }, at: '2026-12-01T00:00:00.000Z' }]);
    counts['overview after a record'] = spawnsOf(overview);
    for (const [name, calls] of Object.entries(counts)) {
      assert.ok(calls.length <= budget, `${name} with ${count} features started ${calls.length} processes (budget ${budget}): ${calls.join(', ')}`);
    }
    measured[count] = Object.fromEntries(Object.entries(counts).map(([name, calls]) => [name, calls.length]));
  }
  assert.deepEqual(measured[40], measured[8], 'five times the features start no more processes');
});
