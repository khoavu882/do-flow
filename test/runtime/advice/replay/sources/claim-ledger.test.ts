'use strict';

// 175 T2 (IC-002): the case-source seam and the `claim-ledger` source. The fixture under
// test/fixtures/advice-replay/claim-ledger/evidence is copied into a scratch project's `.doflow/state/evidence` (the
// `task-evidence` store), so the real checkout and the real ~/.doflow are never read.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../../../../helper/tmp.ts');
const { loadStorageRegistry } = require('../../../../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../../../../src/runtime/storage/roots.ts');
const { loadAdviceRegistry } = require('../../../../../src/runtime/advice/registry.ts');
const { buildClaimSupportState } = require('../../../../../src/runtime/advice/claim-support.ts');
const { REPO_ROOT } = require('../../../../../src/helper/repo-root.ts');
const { SOURCE_IDS, SOURCES, getSource } = require('../../../../../src/runtime/advice/replay/sources/index.ts');
const claimLedger = require('../../../../../src/runtime/advice/replay/sources/claim-ledger.ts');

const FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'advice-replay', 'claim-ledger', 'evidence');
const STORAGE = loadStorageRegistry({ repoRoot: REPO_ROOT });
const KIND = loadAdviceRegistry({ repoRoot: REPO_ROOT }).registry.kinds.find((entry: any) => entry.id === 'claim-support');

/** A scratch project whose task-evidence store is a copy of the fixture. */
function project(t: any) {
  const root = tempDir(t, 'doflow-advice-replay-ledger-');
  const store = path.join(root, '.doflow', 'state', 'evidence');
  fs.mkdirSync(path.dirname(store), { recursive: true });
  fs.cpSync(FIXTURE, store, { recursive: true });
  return { root, store, roots: resolveRoots({ registry: STORAGE, projectRoot: root, env: { HOME: path.join(root, 'home') } }) };
}

function build(p: any, extra: any = {}) {
  return claimLedger.build({ projectRoot: p.root, roots: p.roots, kind: KIND, ...extra });
}

const idOf = (task: string, claim: string, evidence: string) => crypto.createHash('sha256').update(`${task}\n${claim}\n${evidence}`).digest('hex').slice(0, 16);
const A1 = idOf('T1', 'claim_alpha_1', 'ev_alpha_1'); // supports
const A2 = idOf('T1', 'claim_alpha_2', 'ev_alpha_2'); // contradicts
const B1 = idOf('T1', 'claim_beta_1', 'ev_beta_1'); // supports, same task id in another feature namespace

/** Every file under `dir` with its bytes, so a run can be compared with the tree before it. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}

describe('the case-source seam', () => {
  test('the map is closed and lists its five sources', () => {
    assert.deepEqual(SOURCE_IDS, ['captured-state', 'claim-ledger', 'followup-duplicates', 'instructs-reader-corpus', 'review-findings']);
    assert.equal(getSource('claim-ledger'), claimLedger.source);
    assert.equal(SOURCES['claim-ledger'], claimLedger.source);
    assert.equal(getSource('not-a-source'), null);
    assert.equal(getSource('__proto__'), null);
    assert.equal(getSource('toString'), null);
    assert.ok(Object.isFrozen(SOURCES));
    for (const id of SOURCE_IDS) assert.equal(SOURCES[id].id, id);
  });
});

describe('claim-ledger', () => {
  test('(a) one case per (claim, linked evidence) with the design id, label and rule', (t: any) => {
    const { cases } = build(project(t));
    // Links: alpha_1 supports ev_alpha_1, alpha_2 contradicts ev_alpha_2, beta_1 supports ev_beta_1 (two feature
    // namespaces, both with task id T1). The other three alpha claims are skipped (see (b)).
    assert.deepEqual(cases.map((c: any) => [c.id, c.label, c.rule]).sort(), [
      [A1, 'yes', 'yes'], [A2, 'no', 'no'], [B1, 'yes', 'yes'],
    ].sort());
    assert.ok(cases.every((c: any) => Object.keys(c).sort().join() === 'id,label,rule,state'));
  });

  test('(b) each skip reason is counted', (t: any) => {
    // claim_alpha_3 links an evidence id the ledger does not hold, claim_alpha_4 an empty passage, claim_alpha_5 has a blank claim.
    assert.deepEqual(build(project(t)).skipped, { 'missing-evidence': 1, 'empty-passage': 1, 'empty-claim': 1 });
  });

  test('(b) bad-params: unusable byte caps skip every link whose evidence exists', (t: any) => {
    const { cases, skipped } = build(project(t), { kind: { ...KIND, params: {} } });
    assert.equal(cases.length, 0);
    // The five links with evidence in the ledger; the one missing id is counted as missing, as before.
    assert.deepEqual(skipped, { 'missing-evidence': 1, 'bad-params': 5 });
  });

  test('(b) an unreadable claims file or evidence file is counted once and does not stop the others', (t: any) => {
    const p = project(t);
    fs.mkdirSync(path.join(p.store, 'feature-gamma'));
    fs.writeFileSync(path.join(p.store, 'feature-gamma', 'T9_claims.json'), '{ not json');
    // A claims file whose evidence ledger holds an item with an unknown status is refused by the ledger loader.
    fs.mkdirSync(path.join(p.store, 'feature-delta'));
    fs.copyFileSync(path.join(p.store, 'feature-beta', 'T1_claims.json'), path.join(p.store, 'feature-delta', 'T2_claims.json'));
    const bad = JSON.parse(fs.readFileSync(path.join(p.store, 'feature-beta', 'T1.json'), 'utf8'));
    bad.evidence[0].status = 'mystery';
    fs.writeFileSync(path.join(p.store, 'feature-delta', 'T2.json'), JSON.stringify(bad));
    const { cases, skipped } = build(p);
    assert.equal(skipped['unreadable-file'], 2);
    assert.deepEqual(cases.map((c: any) => c.id).sort(), [A1, A2, B1].sort());
  });

  test('(b) a case reachable twice is dropped as a duplicate rather than counted twice', (t: any) => {
    const p = project(t);
    // The same task id, claim id and evidence id in a third namespace gives the first beta case's id again.
    fs.cpSync(path.join(p.store, 'feature-beta'), path.join(p.store, 'feature-copy'), { recursive: true });
    const { cases, skipped } = build(p);
    assert.deepEqual(cases.map((c: any) => c.id).sort(), [A1, A2].sort());
    assert.equal(skipped['duplicate-case'], 2);
  });

  test('(c) cases are sorted by id and stable across runs', (t: any) => {
    const p = project(t);
    const first = build(p);
    const ids = first.cases.map((c: any) => c.id);
    assert.deepEqual(ids, [...ids].sort());
    assert.deepEqual(build(p), first);
    // Rebuilding the same tree in another creation order gives the same list.
    const q = project(t);
    assert.deepEqual(build(q).cases.map((c: any) => c.id), ids);
  });

  test('(d) the state is what buildClaimSupportState gives under the kind params', (t: any) => {
    const { cases } = build(project(t));
    const expect = (claim: string, passage: string) => buildClaimSupportState({ claim, passage, params: KIND.params });
    const a1 = expect('The session cache is cleared on logout SENTINEL-CLAIM-175', 'logout() calls cache.clear() before the redirect SENTINEL-PASSAGE-175');
    assert.equal(a1.ok, true);
    assert.equal(cases.find((c: any) => c.id === A1).state, a1.state);
    assert.equal(cases.find((c: any) => c.id === A2).state, expect('The retry count is three', 'retries is set to five in the client options').state);
    assert.equal(cases.find((c: any) => c.id === B1).state, expect('The parser rejects a trailing comma', 'parse("[1,]") throws SyntaxError at position 3').state);
    assert.match(a1.state, /^claim: .*SENTINEL-CLAIM-175\npassage: .*SENTINEL-PASSAGE-175$/);
    // A smaller cap changes the state the same way the builder does.
    const small = build(project(t), { kind: { ...KIND, params: { claimBytes: 12, passageBytes: 10 } } });
    assert.equal(small.cases.find((c: any) => c.id === A2).state, buildClaimSupportState({
      claim: 'The retry count is three', passage: 'retries is set to five in the client options', params: { claimBytes: 12, passageBytes: 10 },
    }).state);
  });

  test('(e) files are opened only under the task-evidence store and nothing is written', (t: any) => {
    const p = project(t);
    const before = snapshot(p.root);
    // A feature folder that is a link to a folder outside the store is not followed.
    const outside = tempDir(t, 'doflow-advice-replay-outside-');
    fs.copyFileSync(path.join(p.store, 'feature-beta', 'T1_claims.json'), path.join(outside, 'T1_claims.json'));
    let linked = true;
    try { fs.symlinkSync(outside, path.join(p.store, 'feature-link'), 'dir'); } catch { linked = false; }
    const calls: Array<[string, string]> = [];
    const spy = new Proxy(fs, {
      get(target: any, name: string | symbol) {
        const value = target[name];
        if (typeof value !== 'function' || typeof name !== 'string') return value;
        return (...args: any[]) => {
          if (typeof args[0] === 'string') calls.push([name, args[0]]);
          return value.apply(target, args);
        };
      },
    });
    const { cases } = build(p, { fsImpl: spy });
    assert.deepEqual(cases.map((c: any) => c.id).sort(), [A1, A2, B1].sort());
    assert.ok(calls.length > 0);
    const inside = (file: string) => file === p.store || file.startsWith(p.store + path.sep);
    const writes = /^(write|append|mkdir|rm|rmdir|unlink|rename|copy|truncate|chmod|chown|utimes|symlink|link|mkdtemp|ftruncate|futimes)/;
    for (const [name, file] of calls) {
      assert.ok(!writes.test(name), `${name} is a write`);
      // `lstatSync` of a parent folder is the symlink check on the store path itself; every other call stays inside the store.
      if (name === 'lstatSync' && !inside(file)) assert.ok(p.store.startsWith(file + path.sep), `lstat outside the store: ${file}`);
      else assert.ok(inside(file), `${name} reached ${file}`);
    }
    if (linked) assert.ok(!calls.some(([, file]) => file.startsWith(outside)), 'the linked folder was followed');
    if (linked) fs.unlinkSync(path.join(p.store, 'feature-link'));
    assert.deepEqual(snapshot(p.root), before);
  });

  test('a project with no task-evidence store has no cases and no error', (t: any) => {
    const root = tempDir(t, 'doflow-advice-replay-empty-');
    const roots = resolveRoots({ registry: STORAGE, projectRoot: root, env: { HOME: path.join(root, 'home') } });
    assert.deepEqual(claimLedger.build({ projectRoot: root, roots, kind: KIND }), { cases: [], skipped: {} });
  });

  test('(f) the label is the rule by construction, builder version 1, project origin', () => {
    const s = claimLedger.source;
    assert.equal(s.id, 'claim-ledger');
    assert.equal(s.labelIsRule, true);
    assert.equal(s.builderVersion, 1);
    assert.equal(s.origin, 'project');
    assert.equal(typeof s.build, 'function');
  });

  test('the fixture holds the sentinel strings later tasks look for', () => {
    const text = Object.values(snapshot(FIXTURE)).join('\n');
    assert.ok(text.includes('SENTINEL-CLAIM-175'));
    assert.ok(text.includes('SENTINEL-PASSAGE-175'));
  });
});
