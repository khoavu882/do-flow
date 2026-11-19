'use strict';

// Row 176 T6 (design §11, IC-009, AC-5): `followup --action add` names the open and taken follow-ups that look like each
// item it just filed, by the rule stage alone: at most three `{ id, score }` per created item, compared with the newest
// `maxCompare` of the fold and the other created items, in under 50 ms per created item on 2,000 items (a batch add has no
// item cap). Nothing is refused or merged, and no model is asked: the fake decision server counts no request while `add`
// runs, even with the kind set to show.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { bashPath } = require('../helper/bash-locator.ts');
const { createScratch } = require('../helper/scratch-env.ts');
const { makeRepo } = require('../helper/lifecycle-git-fixtures.ts');
const { startFakeServer, answering } = require('../helper/fake-decision-server.ts');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../src/runtime/storage/roots.ts');
const { loadAdviceRegistry } = require('../../src/runtime/advice/registry.ts');
const { itemText, score } = require('../../src/runtime/advice/same-issue/rule.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const followup = require('../../src/runtime/lifecycle/followup.ts');
const store = require('../../src/runtime/lifecycle/event-store.ts');

const RUN = path.join(REPO_ROOT, 'core/shared/scripts/doflow/bin/doflow-run');
const BIN = path.join(REPO_ROOT, 'bin/doflow.js');
const PARAMS = loadAdviceRegistry({ repoRoot: REPO_ROOT }).registry.kinds.find((kind: any) => kind.id === 'same-issue').params;

const scratch = createScratch('doflow-followup-add-similar-');
before(() => scratch.apply());
after(() => { scratch.restore(); scratch.remove(); });

let counter = 0;
function plainRoot() {
  counter += 1;
  const dir = path.join(scratch.dir, `root-${counter}`);
  fs.mkdirSync(dir);
  return dir;
}
const add = (root: string, statements: string[]) => followup.addFollowups({
  root, cwd: root, items: statements.map((statement) => ({ statement })), defaults: { source: 'manual', batch: statements.length > 1 },
});

const UPLOAD = 'Upload client retry loop ignores the server timeout header';
const LIKE_UPLOAD = [
  'The upload client retry loop ignores the server timeout header',
  'Upload client retry loop ignores a timeout header from the server proxy',
  'Upload retry loop ignores the timeout header of the server',
  'Upload client ignores the timeout header',
];
const LEDGER = 'Ledger lock is never released after a crash';

test('the params add reads are the same-issue params of core/registry/advice.json', () => {
  assert.deepEqual(followup.sameIssueParams(), PARAMS);
});

test('(a) a created item like open ones gets at most 3 rule matches, best first; an unlike one gets none; nothing is refused or merged', () => {
  const root = plainRoot();
  const seeded = add(root, [...LIKE_UPLOAD, LEDGER]).created;
  const dismissed = add(root, [UPLOAD]).created[0].id;
  assert.equal(followup.settleFollowups({ root, ids: dismissed, as: 'dismissed', reason: 'test' }).ok, true);

  const out = add(root, [UPLOAD]);
  assert.equal(out.ok, true);
  const [created] = out.created;
  const like = new Map(seeded.slice(0, 4).map((item: any) => [item.id, item.statement]));
  assert.equal(created.similar.length, 3);
  for (const match of created.similar) {
    assert.ok(like.has(match.id), `${match.id} is one of the like items, never the dismissed one`);
    const exact = score({ id: created.id, text: itemText(UPLOAD, PARAMS.itemBytes) }, { id: match.id, text: itemText(like.get(match.id), PARAMS.itemBytes) }, PARAMS);
    assert.ok(exact >= PARAMS.flagAtPct / 100);
    assert.equal(match.score, Math.round(exact * 100) / 100);
  }
  const scores = created.similar.map((match: any) => match.score);
  assert.deepEqual(scores, [...scores].sort((left, right) => right - left));

  const unlike = add(root, ['Docs site build drops the sidebar on narrow screens']).created[0];
  assert.deepEqual(unlike.similar, []);
  const listed = followup.listFollowups({ root, state: 'all' });
  assert.equal(listed.count, 8, 'every item was written, none merged');
  assert.equal(listed.items.filter((item: any) => item.state === 'open').length, 7);
});

test('(a) a taken item is compared too', () => {
  const root = plainRoot();
  const [first] = add(root, [LIKE_UPLOAD[0]]).created;
  assert.equal(store.appendEvents(root, [{ type: 'feature.tracked', by: 'agent', data: { slug: '176-demo' } }]).ok, true);
  assert.equal(followup.takeFollowups({ root, ids: first.id, slug: '176-demo' }).ok, true);
  assert.deepEqual(add(root, [UPLOAD]).created[0].similar.map((match: any) => match.id), [first.id]);
});

test('(b) a batch compares its new items with each other', () => {
  const root = plainRoot();
  const [one, two, three] = add(root, [UPLOAD, LIKE_UPLOAD[0], LEDGER]).created;
  assert.deepEqual(one.similar.map((match: any) => match.id), [two.id]);
  assert.deepEqual(two.similar.map((match: any) => match.id), [one.id]);
  assert.deepEqual(three.similar, []);
});

test('(c) only the newest maxCompare open and taken items are compared', () => {
  const followups = [
    { id: 'FU-old000', statement: LIKE_UPLOAD[0], state: 'open' },
    { id: 'FU-mid000', statement: LIKE_UPLOAD[1], state: 'open' },
    { id: 'FU-done00', statement: LIKE_UPLOAD[2], state: 'done' },
    { id: 'FU-new000', statement: LIKE_UPLOAD[2], state: 'taken' },
  ];
  const created = [{ id: 'FU-add000', statement: UPLOAD }];
  const all = followup.ruleMatchesOnAdd({ created, followups, params: PARAMS }).get('FU-add000').map((match: any) => match.id).sort();
  assert.deepEqual(all, ['FU-mid000', 'FU-new000', 'FU-old000']);
  const newest = followup.ruleMatchesOnAdd({ created, followups, params: { ...PARAMS, maxCompare: 2 } }).get('FU-add000').map((match: any) => match.id).sort();
  assert.deepEqual(newest, ['FU-mid000', 'FU-new000']);
});

test('(d) ruleMatchesOnAdd over 2,000 open items: the median of 15 in-process runs is under 50 ms for one created item', () => {
  const words = 'cache ttl constant wrong module retry upload client timeout parser config window token budget guard ledger report store event fold lock'.split(' ');
  const followups = Array.from({ length: 2000 }, (_, n) => ({
    id: `FU-${String(n).padStart(6, '0')}`, state: 'open',
    statement: Array.from({ length: 20 }, (_w, k) => `${words[(n * 7 + k * 3) % words.length]}${k % 4 === 0 ? n : ''}`).join(' '),
  }));
  const created = [{ id: 'FU-add000', statement: 'the cache ttl constant is wrong in the upload client retry window' }];
  const times: number[] = [];
  for (let run = 0; run < 15; run += 1) {
    const started = process.hrtime.bigint();
    followup.ruleMatchesOnAdd({ created, followups, params: PARAMS });
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  const median = times.sort((left, right) => left - right)[7];
  assert.ok(median < 50, `median ${median.toFixed(1)} ms`);
});

/** Runs the verb through the dispatcher without blocking this process, so the fake server here can answer. */
function runVerb(cwd: string, args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(bashPath(), [RUN, 'followup', ...args], { cwd, env: scratch.env({ DOFLOW_CLI: BIN }), encoding: 'utf8' }, (error: any, stdout: string, stderr: string) => {
      resolve({ status: error ? error.code : 0, stdout, stderr });
    });
  });
}

/** Polls (10 s at most) until the shadow slots folder holds no slot file and no handoff file; a missing folder is clear. */
async function slotsCleared(userState: string, ms = 10000): Promise<boolean> {
  const dir = path.join(userState, 'advice', 'shadow-slots');
  const held = () => { try { return fs.readdirSync(dir).some((name: string) => /^slot-.*\.json$/.test(name)); } catch { return false; } };
  const until = Date.now() + ms;
  while (held() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
  return !held();
}

test('(e) add asks no model: the fake server counts no request, with advice on and the kind set to show', async (t) => {
  const repo = makeRepo(scratch, 'add-similar');
  const dir = fs.realpathSync(repo.dir);
  const server: any = await startFakeServer({ routes: { 'POST /v1/systemone': answering(() => 0.9) } });
  t.after(() => server.close());
  const roots = resolveRoots({ registry: loadStorageRegistry({ repoRoot: REPO_ROOT }), projectRoot: dir, env: scratch.env() });
  const file = path.join(roots['config-home'], 'settings.json');
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...settings, 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': server.origin, 'advice.model': 'clef-flash', 'advice.kinds.same-issue': 'show' }));
  t.after(() => fs.writeFileSync(file, JSON.stringify(settings)));

  const first = await runVerb(dir, ['--action', 'add', '--source', 'manual', '--statement', LIKE_UPLOAD[0], '--json']);
  assert.equal(first.status, 0, first.stderr);
  const firstId = JSON.parse(first.stdout).created[0].id;
  const second = await runVerb(dir, ['--action', 'add', '--source', 'manual', '--statement', UPLOAD]);
  assert.equal(second.status, 0, second.stderr);
  const lines = second.stdout.trim().split('\n');
  assert.match(lines[0], /^added FU-[0-9a-z]{6} \(manual\): Upload client retry loop/);
  assert.deepEqual(lines.slice(1), [`  possible duplicate (rule): ${firstId}`]);
  // A shadow child would hold a slot (and its handoff file) from before the verb exits until its last request is done:
  // wait, bounded, until none is left, then count. A fixed pause could end before a slow child had asked.
  assert.equal(await slotsCleared(roots['user-state']), true, 'a shadow child slot or handoff file is still held');
  assert.equal(server.requests.length, 0);
});
