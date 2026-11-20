'use strict';

// The `followup-duplicates` case source (180 IC-180-H2, design section 9). The recorded decisions are the follow-up store's
// `--duplicate-of` labels, read as links: items in one linked component (siblings and chains included) are `yes` pairs. A
// `no` pair is a rule candidate pair of items that were both settled (dismissed or done) once the first label existed and
// sit in different components: from then on people were marking duplicates, so two similar items left unlinked read as
// "not the same issue".
// Before the first label there is no such evidence, so no `no` pair is built. The label is a person's judgement, not the
// rule's answer, so `labelIsRule` is false.
//
// Read-only: the follow-up store is folded (`readFold`), nothing is written. A label whose target is not a known item is
// skipped as `unknown-target`. The kind's case builder (`buildKindCases`) prefixes this source's ids with its id, so no other source collides with them.
//
// Pin: `CODE_DIGEST` fixes the code a case set depends on: `same-issue/rule.ts` (which pairs are asked and the rule's
// answer), `advice/batch.ts` and this file, the way `review-findings` pins its own. It is carried as the source's `params`,
// which `builderDigest` folds in, so a moved pin makes every stored result of the kind stale. Guard G89.2 compares the
// constant with `computeCodeDigest()`; the digest reads this file without the line that holds the constant.

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { REPO_ROOT } = require('../../../../helper/repo-root.ts');
const { readFold } = require('../../../lifecycle/event-store.ts');
const { itemText, candidatePairs, pairState, score } = require('../../same-issue/rule.ts');

const CODE_FILES = ['src/runtime/advice/same-issue/rule.ts', 'src/runtime/advice/batch.ts'];
const SELF_FILE = 'src/runtime/advice/replay/sources/followup-duplicates.ts';
const SOURCE_ID = 'followup-duplicates';

const CODE_DIGEST = '7205b325c3a139742b747f29d4eda9abeaa23a10149a9e6b4aebb83175c0e6aa';

/** Lowercase hex over the two code files' bytes, then this file's text without its pin line; null when one is unreadable. */
function computeCodeDigest(fsImpl: any = nodeFs): string | null {
  try {
    const hash = crypto.createHash('sha256');
    for (const file of CODE_FILES) hash.update(fsImpl.readFileSync(path.join(REPO_ROOT, file)));
    const self = fsImpl.readFileSync(path.join(REPO_ROOT, SELF_FILE), 'utf8');
    return hash.update(self.split('\n').filter((line: string) => !line.includes('CODE_DIGEST =')).join('\n')).digest('hex');
  } catch { return null; }
}

function caseId(a: string, b: string): string {
  const [low, high] = a < b ? [a, b] : [b, a];
  return crypto.createHash('sha256').update(`${low}\n${high}`).digest('hex').slice(0, 16);
}

/** When the settling event of `item` was written: its last history entry, which is the settlement for a settled item. */
const settledAt = (item: any): number => Date.parse(item.history[item.history.length - 1]?.at);

function build({ projectRoot, kind, fsImpl = nodeFs }: any = {}): { cases: any[]; skipped: Record<string, number> } {
  const skipped: Record<string, number> = {};
  const skip = (reason: string, n = 1) => { skipped[reason] = (skipped[reason] || 0) + n; };
  let fold: any;
  try { fold = readFold(projectRoot, { fsImpl }); } catch { return { cases: [], skipped }; }
  const items = new Map<string, any>(fold.followups.map((item: any) => [item.id, item]));
  const asItem = (item: any) => ({ id: item.id, text: itemText(item.statement, kind.params.itemBytes) });
  const pairs = new Map<string, any>();

  // Union-find over the labels: items in one component are the same issue, so siblings (b and c both duplicates of a) and
  // chains (a of b, b of c) are `yes` pairs too, not only the pair a label names directly.
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root) as string;
    parent.set(id, root);
    return root;
  };
  const labelled = fold.followups.filter((item: any) => item.state === 'dismissed' && typeof item.duplicateOf === 'string');
  for (const item of labelled) {
    if (!items.has(item.duplicateOf)) { skip('unknown-target'); continue; }
    parent.set(find(item.id), find(item.duplicateOf));
  }
  const components = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    components.set(root, [...(components.get(root) || []), id]);
  }
  for (const members of components.values()) {
    members.sort();
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = asItem(items.get(members[i])), b = asItem(items.get(members[j]));
        pairs.set(caseId(a.id, b.id), {
          id: caseId(a.id, b.id), state: pairState(a, b), label: 'yes',
          rule: score(a, b, kind.params) >= kind.params.flagAtPct / 100 ? 'yes' : 'no',
        });
      }
    }
  }
  const first = Math.min(...labelled.map(settledAt));
  const settled = fold.followups.filter((item: any) => (item.state === 'dismissed' || item.state === 'done') && settledAt(item) >= first).map(asItem);
  for (const pair of candidatePairs(settled, kind.params)) {
    if (find(pair.a) === find(pair.b)) continue;
    const id = caseId(pair.a, pair.b);
    pairs.set(id, { id, state: pairState(settled.find((item: any) => item.id === pair.a), settled.find((item: any) => item.id === pair.b)), label: 'no', rule: pair.rule });
  }
  const cases = [...pairs.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { cases, skipped };
}

const source = { id: SOURCE_ID, builderVersion: 1, labelIsRule: false, origin: 'project' as const, params: { codeDigest: CODE_DIGEST }, build };

module.exports = { source, build, CODE_DIGEST, computeCodeDigest };
