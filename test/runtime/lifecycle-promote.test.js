'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createScratch } = require('../helper/scratch-env');
const { REPO_ROOT } = require('../../src/helper/repo-root');
const followup = require('../../src/runtime/lifecycle/followup');
const store = require('../../src/runtime/lifecycle/event-store');
const { INTENT_SECTIONS, kebabTitle, renderIntent } = require('../../src/runtime/lifecycle/intent-writer');

const scratch = createScratch('doflow-promote-');
test.before(() => scratch.apply());
test.after(() => { scratch.restore(); scratch.remove(); });

const NOW = new Date('2026-10-07T10:15:00.000Z');
let counter = 0;
function plainRoot() {
  counter += 1;
  const dir = path.join(scratch.dir, `root-${counter}`);
  fs.mkdirSync(dir);
  return dir;
}
function addItem(root, statement, source = { stage: 'review', slug: '049-cart-fix' }, now = NOW) {
  return followup.addFollowups({ root, cwd: root, items: [{ statement }], defaults: source, now }).created[0].id;
}
const intentDir = (root) => path.join(root, 'agent-docs', 'intent');
const eventCount = (root) => fs.readdirSync(path.join(root, store.EVENTS_REL)).length;

test('the intent headings fixed in code match the intent template, in order', () => {
  const template = fs.readFileSync(path.join(REPO_ROOT, 'core', 'shared', 'templates', 'doflow', 'intent-template.md'), 'utf8');
  const headings = [...template.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(INTENT_SECTIONS.map((s) => s.heading), headings);
  assert.equal(INTENT_SECTIONS.length, 5);
  assert.match(template, /^# Intent: /m);
  assert.match(template, /^\*\*Raised by:\*\* .* · \*\*Date:\*\* /m);
});

test('promote writes the IC-024 file exactly, then one followup.promoted event', () => {
  const root = plainRoot();
  const a = followup.addFollowups({
    root, cwd: root, now: NOW,
    items: [{ statement: 'Checkout crashes when the cart holds a removed product', source: 'release', stage: 'review' }],
    defaults: { release: 'v2.3.0' },
  }).created[0].id;
  const b = addItem(root, 'Cart total ignores a discount removed mid-session');
  const out = followup.promoteFollowups({ root, ids: [a, b], title: 'Cart robustness', channel: 'question', now: NOW });
  assert.deepEqual([out.ok, out.action, out.intent, out.ids], [true, 'promote', 'agent-docs/intent/cart-robustness.md', [a, b]]);
  assert.equal(out.events.length, 1);
  const expected = [
    '# Intent: Cart robustness',
    '',
    '**Raised by:** user, through doflow-run followup --action promote · **Date:** 2026-10-07',
    '',
    '## 1. Problem',
    '',
    `- ${a}: Checkout crashes when the cart holds a removed product (source: release, v2.3.0)`,
    `- ${b}: Cart total ignores a discount removed mid-session (source: stage, 049-cart-fix, review)`,
    '',
    '## 2. Proposed outcome',
    '',
    '(What would be observably different if this were addressed?)',
    '',
    '## 3. Affected',
    '',
    '(Who and what this touches.)',
    '',
    '## 4. Constraints',
    '',
    '(What already bounds this; write "none known" if nothing does.)',
    '',
    '## 5. Open questions',
    '',
    '(What you do not know yet.)',
    '',
  ].join('\n');
  assert.equal(fs.readFileSync(path.join(root, out.intent), 'utf8'), expected);
  const event = JSON.parse(fs.readFileSync(path.join(root, out.events[0]), 'utf8'));
  assert.deepEqual([event.type, event.by, event.data], ['followup.promoted', 'user', { ids: [a, b], intent: out.intent }]);
});

test('each promoted item shows its intent and stays open', () => {
  const root = plainRoot();
  const a = addItem(root, 'one');
  const b = addItem(root, 'two');
  followup.promoteFollowups({ root, ids: a, title: 'First', now: NOW });
  const items = Object.fromEntries(followup.listFollowups({ root }).items.map((i) => [i.id, i]));
  assert.deepEqual([items[a].state, items[a].intent, items[b].intent], ['open', 'agent-docs/intent/first.md', null]);
});

test('Raised by names the agent for the default channel', () => {
  const root = plainRoot();
  const a = addItem(root, 'one');
  const out = followup.promoteFollowups({ root, ids: a, title: 'Agent raised', now: NOW });
  assert.match(fs.readFileSync(path.join(root, out.intent), 'utf8'), /\*\*Raised by:\*\* agent, through doflow-run followup --action promote/);
});

test('an existing intent file is never touched: intent-exists, nothing written, no event', () => {
  const root = plainRoot();
  const a = addItem(root, 'one');
  fs.mkdirSync(intentDir(root), { recursive: true });
  fs.writeFileSync(path.join(intentDir(root), 'cart-robustness.md'), 'hand written\n');
  const before = eventCount(root);
  const out = followup.promoteFollowups({ root, ids: a, title: 'Cart robustness', now: NOW });
  assert.deepEqual([out.ok, out.action, out.finding], [false, 'promote', 'intent-exists']);
  assert.match(out.message, /Nothing was written/);
  assert.equal(fs.readFileSync(path.join(intentDir(root), 'cart-robustness.md'), 'utf8'), 'hand written\n');
  assert.equal(eventCount(root), before);
  assert.equal(followup.listFollowups({ root }).items[0].intent, null);
});

test('promotion only creates: an item already promoted cannot go to a second intent', () => {
  const root = plainRoot();
  const a = addItem(root, 'one');
  followup.promoteFollowups({ root, ids: a, title: 'First', now: NOW });
  const again = followup.promoteFollowups({ root, ids: a, title: 'Second', now: NOW });
  assert.equal(again.finding, 'intent-exists');
  assert.match(again.message, /already promoted to agent-docs\/intent\/first\.md/);
  assert.deepEqual(fs.readdirSync(intentDir(root)), ['first.md']);
});

test('only open known items can be promoted, and a refusal leaves no file behind', () => {
  const root = plainRoot();
  const a = addItem(root, 'one');
  followup.settleFollowups({ root, ids: a, as: 'dismissed', reason: 'noise' });
  assert.equal(followup.promoteFollowups({ root, ids: a, title: 'X', now: NOW }).finding, 'illegal-transition');
  assert.equal(followup.promoteFollowups({ root, ids: 'FU-zzzzzz', title: 'X', now: NOW }).finding, 'unknown-id');
  assert.equal(fs.existsSync(intentDir(root)), false);
});

test('a title must be one line with a letter or digit; ids and title are required', () => {
  const root = plainRoot();
  const a = addItem(root, 'one');
  const usage = (fn, pattern) => assert.throws(fn, (e) => e instanceof followup.FollowupUsageError && pattern.test(e.message));
  usage(() => followup.promoteFollowups({ root, ids: a, title: '', now: NOW }), /--title is empty/);
  usage(() => followup.promoteFollowups({ root, ids: a, title: 'two\nlines', now: NOW }), /must be one line/);
  usage(() => followup.promoteFollowups({ root, ids: a, title: 'z'.repeat(81), now: NOW }), /limit is 80/);
  usage(() => followup.promoteFollowups({ root, title: 'X', now: NOW }), /--ids is required/);
  const symbols = followup.promoteFollowups({ root, ids: a, title: '!!!', now: NOW });
  assert.equal(symbols.finding, 'invalid-title');
  assert.equal(fs.existsSync(intentDir(root)), false);
});

test('the title is masked before it is written to the file name or heading', () => {
  const root = plainRoot();
  const a = addItem(root, 'one');
  const out = followup.promoteFollowups({ root, ids: a, title: 'Rotate token=ab12cd34 keys', now: NOW });
  assert.equal(out.intent, 'agent-docs/intent/rotate-token-masked-keys.md');
  assert.match(fs.readFileSync(path.join(root, out.intent), 'utf8'), /^# Intent: Rotate token=<masked> keys$/m);
});

test('kebabTitle lower-cases, collapses and trims', () => {
  assert.equal(kebabTitle('  Cart  Robustness: v2!  '), 'cart-robustness-v2');
  assert.equal(kebabTitle('---'), '');
  assert.equal(kebabTitle('a'.repeat(100)).length, 60);
  assert.equal(kebabTitle(`${'a'.repeat(59)} b`), 'a'.repeat(59));
});

test('a promotion whose event write fails removes the intent file it just created', () => {
  const root = plainRoot();
  const a = addItem(root, 'one');
  const heldFs = {
    ...fs,
    mkdirSync: (p, o) => { if (String(p).endsWith('.lock')) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' }); return fs.mkdirSync(p, o); },
    statSync: () => ({ mtimeMs: 0 }),
    rmdirSync: () => {},
  };
  const out = followup.promoteFollowups({ root, ids: a, title: 'Locked out', now: NOW, fsImpl: heldFs });
  assert.deepEqual([out.ok, out.finding], [false, 'store-locked']);
  assert.equal(fs.existsSync(path.join(intentDir(root), 'locked-out.md')), false);
});

test('renderIntent lists a source by its kind and fields', () => {
  const text = renderIntent({
    title: 'T', by: 'agent', date: '2026-10-07',
    items: [
      { id: 'FU-aaaaaa', statement: 's1', source: { kind: 'run', taskClass: 'bug', taskId: 'fix-x', stage: 'review' } },
      { id: 'FU-bbbbbb', statement: 's2', source: { kind: 'manual' } },
      { id: 'FU-cccccc', statement: 's3', source: { kind: 'failure', ref: '3f9a0c21d4e8b7a6' } },
      { id: 'FU-dddddd', statement: 's4', source: { kind: 'report', release: 'v1.0.0', feature: '001-x' } },
    ],
  });
  assert.match(text, /- FU-aaaaaa: s1 \(source: run, bug, fix-x, review\)/);
  assert.match(text, /- FU-bbbbbb: s2 \(source: manual\)/);
  assert.match(text, /- FU-cccccc: s3 \(source: failure, 3f9a0c21d4e8b7a6\)/);
  assert.match(text, /- FU-dddddd: s4 \(source: report, v1.0.0, 001-x\)/);
});
