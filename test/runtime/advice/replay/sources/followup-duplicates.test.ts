'use strict';

// 180 K5 (design section 9, IC-180-H2): the `followup-duplicates` case source. Each test builds a follow-up store in a
// scratch folder with the real add and settle verbs, at chosen times, and reads it through the source; the real checkout
// is never read.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../../../../helper/tmp.ts');
const { addFollowups, settleFollowups } = require('../../../../../src/runtime/lifecycle/followup.ts');
const { itemText, pairState } = require('../../../../../src/runtime/advice/same-issue/rule.ts');
const { SOURCE_IDS, getSource } = require('../../../../../src/runtime/advice/replay/sources/index.ts');
const { source, build, CODE_DIGEST, computeCodeDigest } = require('../../../../../src/runtime/advice/replay/sources/followup-duplicates.ts');

const KIND = {
  id: 'same-issue',
  params: { itemBytes: 512, questionsPerCall: 8, maxPairs: 32, perItem: 2, candidateAtPct: 15, flagAtPct: 40, locatorBonusPct: 15, maxCompare: 2000 },
};
const at = (minute: number) => new Date(Date.UTC(2026, 10, 20, 9, minute));
const caseId = (a: string, b: string) => {
  const [low, high] = a < b ? [a, b] : [b, a];
  return crypto.createHash('sha256').update(`${low}\n${high}`).digest('hex').slice(0, 16);
};

/** A project root with the named follow-ups added at minute 0; `ids` maps each name to its id. */
function project(t: any, statements: Record<string, string>) {
  const root = tempDir(t, 'doflow-advice-replay-followups-');
  const added = addFollowups({ root, cwd: root, items: Object.values(statements).map((statement) => ({ statement })), defaults: { source: 'manual', batch: true }, now: at(0) });
  const ids = Object.fromEntries(Object.keys(statements).map((name, i) => [name, added.created[i].id]));
  return { root, ids };
}
const settle = (root: string, ids: string, minute: number, extra: any = {}) =>
  assert.equal(settleFollowups({ root, ids, as: 'dismissed', reason: 'noise', ...extra, now: at(minute) }).ok, true);
const textOf = (statements: Record<string, string>, name: string) => itemText(statements[name], KIND.params.itemBytes);

const STATEMENTS = {
  x1: 'alpha beta gamma parser drops the trailing newline',
  x2: 'alpha beta gamma parser drops the trailing newline again',
  a: 'omicron rho sigma cache never expires stale entries',
  t: 'omicron rho sigma cache never expires its stale entries',
  p1: 'delta epsilon zeta installer ignores the proxy setting',
  p2: 'delta epsilon zeta installer ignores the proxy setting on windows',
  q: 'delta epsilon zeta installer ignores the proxy variable',
  far: 'unrelated words about something else entirely',
};

test('180 (e) the source: yes for (labelled item, target); no for similar pairs settled after the first label; none before', (t) => {
  const { root, ids } = project(t, STATEMENTS);
  settle(root, `${ids.x1},${ids.x2}`, 1);                              // before the first label: never a no
  settle(root, ids.a, 2, { duplicateOf: ids.t });                       // the first label
  settle(root, `${ids.p1},${ids.p2}`, 3);                              // after: similar, unlinked
  assert.equal(settleFollowups({ root, ids: ids.q, as: 'done', evidence: 'commit abc1234', now: at(4) }).ok, true);
  settle(root, ids.far, 5);

  const { cases, skipped } = build({ projectRoot: root, kind: KIND });
  assert.deepEqual(skipped, {});
  const byId = new Map(cases.map((c: any) => [c.id, c]));
  const expected: Array<[string, string, string]> = [['a', 't', 'yes'], ['p1', 'p2', 'no'], ['p1', 'q', 'no'], ['p2', 'q', 'no']];
  for (const [left, right, label] of expected) {
    const [first, second] = ids[left] < ids[right] ? [left, right] : [right, left];
    const found: any = byId.get(caseId(ids[left], ids[right]));
    assert.ok(found, `${left}/${right} is a case`);
    assert.equal(found.label, label);
    assert.equal(found.state, pairState({ id: ids[first], text: textOf(STATEMENTS, first) }, { id: ids[second], text: textOf(STATEMENTS, second) }));
  }
  assert.equal((byId.get(caseId(ids.a, ids.t)) as any).rule, 'yes');
  assert.equal(cases.length, expected.length, 'no pair of x1/x2 (settled before the label), none with far, none unlinked with a or t');
  assert.deepEqual(cases.map((c: any) => c.id), [...cases.map((c: any) => c.id)].sort(), 'sorted by id');
  assert.ok(cases.every((c: any) => /^[0-9a-f]{16}$/.test(c.id)));
});

test('180 (e) the source: no label gives no case at all, and a pair that names each other is only the yes case', (t) => {
  const { root, ids } = project(t, STATEMENTS);
  settle(root, `${ids.x1},${ids.x2}`, 1);
  assert.deepEqual(build({ projectRoot: root, kind: KIND }), { cases: [], skipped: {} });
  assert.deepEqual(build({ projectRoot: path.join(root, 'no-such-folder'), kind: KIND }), { cases: [], skipped: {} });

  settle(root, ids.p1, 2, { duplicateOf: ids.p2 });
  settle(root, ids.p2, 3);
  const { cases } = build({ projectRoot: root, kind: KIND });
  assert.deepEqual(cases.map((c: any) => [c.id, c.label]), [[caseId(ids.p1, ids.p2), 'yes']]);
});

test('180 (e) the source reads only: the store is byte for byte the same after a build', (t) => {
  const { root, ids } = project(t, STATEMENTS);
  settle(root, ids.a, 2, { duplicateOf: ids.t });
  const files = (dir: string): any => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e: any) => e.isFile()).map((e: any) => path.join(e.parentPath || e.path, e.name)).sort();
  const snapshot = () => files(root).map((f: string) => [f, fs.readFileSync(f, 'utf8')]);
  const before = snapshot();
  build({ projectRoot: root, kind: KIND });
  assert.deepEqual(snapshot(), before);
});

test('180 (e) pin: CODE_DIGEST equals computeCodeDigest(), is carried as the source params, and the source is registered and not the rule\'s own label', () => {
  assert.equal(CODE_DIGEST, computeCodeDigest());
  assert.deepEqual(source.params, { codeDigest: CODE_DIGEST });
  assert.equal(source.labelIsRule, false);
  assert.equal(source.id, 'followup-duplicates');
  assert.ok(SOURCE_IDS.includes('followup-duplicates'));
  assert.equal(getSource('followup-duplicates'), source);
});
