'use strict';

// The Settings and Advice derivations (feature 151, plan task C.2; IC-017, IC-018; FR-004, FR-015, FR-017, FR-026,
// DEC-003). Pure functions over the projected bodies of `config-list`, `advise-report` and `advice-picks`
// (console/src/project.ts, IC-007, IC-008): no DOM and no fetch. Controls: a groupOf that sends `team.` to Other turns the
// registry case red; a dayRows that counts an unknown day as 0 turns the unknown case red.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const WEB_ROOT = path.join(__dirname, '..', 'web');
const REPO_ROOT = path.join(__dirname, '..', '..');
const SETTINGS_FILE = path.join(WEB_ROOT, 'derive', 'settings.js');
const ADVICE_FILE = path.join(WEB_ROOT, 'derive', 'advice.js');

// `keys` is an object keyed by setting name, in registry order.
const REGISTRY_KEYS: string[] = Object.keys(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'settings.json'), 'utf8')).keys);

const scratch: string[] = [];
let settings: any;
let advice: any;

/** A copy of one derive module (optionally rewritten), as an ES module a CommonJS package can import. */
async function load(file: string, source: string = fs.readFileSync(file, 'utf8')): Promise<any> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-manage-'));
  scratch.push(dir);
  fs.mkdirSync(path.join(dir, 'derive'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  const target = path.join(dir, 'derive', path.basename(file));
  fs.writeFileSync(target, source);
  return import(pathToFileURL(target).href);
}

before(async () => {
  settings = await load(SETTINGS_FILE);
  advice = await load(ADVICE_FILE);
});
after(() => { for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true }); });

// ---- settings groups (IC-017, FR-004, DEC-003) ----------------------------------------------------------

const prefixOf = (key: string) => key.split('.')[0];
const OTHER_PREFIXES = ['storage', 'failure', 'autopilot', 'hooks', 'verify', 'primary', 'models', 'packages'];

const registryCase = (mod: any) => {
  const rows = REGISTRY_KEYS.map((key) => ({ key, views: [], meta: {} }));
  const groups = mod.groupKeys(rows);
  const listed = groups.flatMap((g: any) => g.keys.map((row: any) => row.key));
  assert.equal(listed.length, REGISTRY_KEYS.length, 'no key missing or listed twice');
  assert.deepEqual([...listed].sort(), [...REGISTRY_KEYS].sort());
  assert.equal(new Set(listed).size, listed.length);
  const byGroup = Object.fromEntries(groups.map((g: any) => [g.group, g.keys.map((row: any) => row.key)]));
  assert.deepEqual(Object.keys(byGroup), ['Workers', 'Advice and shadow', 'Review and debate', 'Rollout', 'Other']);
  for (const [group, prefixes] of [['Workers', ['workers', 'dispatch', 'team']], ['Advice and shadow', ['advice']], ['Review and debate', ['review', 'debate']], ['Rollout', ['rollout']]] as const) {
    assert.deepEqual([...new Set(byGroup[group].map(prefixOf))].sort(), [...prefixes].sort(), group);
  }
  assert.deepEqual([...new Set(byGroup.Other.map(prefixOf))].sort(), [...OTHER_PREFIXES].sort());
  // Registry order inside each group.
  for (const keys of Object.values(byGroup) as string[][]) {
    assert.deepEqual(keys, REGISTRY_KEYS.filter((key) => keys.includes(key)));
  }
  for (const key of REGISTRY_KEYS) assert.equal(byGroup[mod.groupOf(key)].includes(key), true, key);
};

test('groupKeys: every key of core/registry/settings.json is in exactly one group, in registry order, Other holding the eight remaining prefixes', () => {
  assert.equal(REGISTRY_KEYS.length >= 42, true, 'the registry still lists its keys');
  registryCase(settings);
});

test('control: a groupOf that sends team. to Other turns the registry case red', async () => {
  const source = fs.readFileSync(SETTINGS_FILE, 'utf8');
  const broken = source.replace("'team.'", "'team-not.'");
  assert.notEqual(broken, source, 'the control found the team prefix');
  const mod = await load(SETTINGS_FILE, broken);
  assert.throws(() => registryCase(mod));
});

test('groupOf: the IC-017 prefixes, and a prefix the registry gains later lands in Other', () => {
  assert.equal(settings.groupOf('workers.enabled'), 'Workers');
  assert.equal(settings.groupOf('dispatch.fallback'), 'Workers');
  assert.equal(settings.groupOf('team.writerCap'), 'Workers');
  assert.equal(settings.groupOf('advice.kinds.tier'), 'Advice and shadow');
  assert.equal(settings.groupOf('review.rounds'), 'Review and debate');
  assert.equal(settings.groupOf('debate.preset'), 'Review and debate');
  assert.equal(settings.groupOf('rollout.profile'), 'Rollout');
  assert.equal(settings.groupOf('telemetry.sink'), 'Other');
  assert.equal(settings.groupOf('workersx.enabled'), 'Other', 'a prefix match is on the whole first segment');
  assert.equal(settings.groupOf('advice'), 'Other');
  assert.equal(settings.groupOf(7), 'Other');
  const groups = settings.groupKeys([...REGISTRY_KEYS, 'telemetry.sink']);
  const other = groups.find((g: any) => g.group === 'Other');
  assert.equal(other.keys[other.keys.length - 1], 'telemetry.sink', 'plain key strings work too, and the new key keeps its place');
});

test('groupKeys: a group with no key is left out; the order of the groups stays fixed', () => {
  const groups = settings.groupKeys(['rollout.profile', 'advice.enabled', 'storage.prune']);
  assert.deepEqual(groups.map((g: any) => g.group), ['Advice and shadow', 'Rollout', 'Other']);
  assert.deepEqual(settings.groupKeys([]), []);
  assert.deepEqual(settings.groupKeys(null), []);
});

// ---- local results, followed counts and agreement (175 IC-010, over the advise-report projection) ----------

const result = (extra: any = {}) => ({
  kind: 'tier', provider: 'local-runtime', model: 'model-a:8b', modelDigest: `sha256:${'0123456789abcdef'.repeat(4)}`, runAt: '2026-11-18T09:30:00.000Z',
  replayed: 40, eligible: 52, standing: 'act', failedChecks: [], stale: [], caseSet: 'same', ...extra,
});
const HEAD = 'tier with model-a:8b (local-runtime, sha256:01234567…), replayed 2026-11-18 on 40 of 52 cases';

test('localResultSentences: one sentence per stored result, the standing re-judged now with its failed checks, and the case-set state', () => {
  const sentences = advice.localResultSentences([
    result(),
    result({ standing: 'show', failedChecks: ['min-cases', 'kappa-gain-lower'], caseSet: 'changed' }),
    result({ standing: 'below-show', failedChecks: ['kappa-lower'], caseSet: 'other-project' }),
    result({ standing: 'below-minimum', failedChecks: ['min-cases'], caseSet: 'not-checked' }),
    result({ standing: 'measure-only' }),
    result({ standing: 'unknown' }),
  ]);
  assert.deepEqual(sentences, [
    { kind: 'tier', text: `${HEAD}: passes the show and act bars. Case set unchanged.` },
    { kind: 'tier', text: `${HEAD}: passes the show bar, not the act bar (failed: min-cases, kappa-gain-lower). The case set changed since: replay again.` },
    { kind: 'tier', text: `${HEAD}: below the show bar (failed: kappa-lower). Measured in another project.` },
    { kind: 'tier', text: `${HEAD}: too few cases to judge (failed: min-cases). Case set not checked here.` },
    { kind: 'tier', text: `${HEAD}: measures only: its cases are labelled with the rule's answer, so it never passes. Case set unchanged.` },
    { kind: 'tier', text: `${HEAD}: cannot be judged now; doflow advise --action report says why. Case set unchanged.` },
  ]);
});

test('localResultSentences: a stale result names the digests that moved; a short digest is kept whole; no result reads as one sentence', () => {
  const one = (extra: any) => advice.localResultSentences([result(extra)])[0].text;
  assert.equal(one({ standing: 'stale', stale: ['question'] }), `${HEAD}: stale: the question changed since the replay; replay again. Case set unchanged.`);
  assert.equal(one({ standing: 'stale', stale: ['question', 'bars'] }), `${HEAD}: stale: the question and bars changed since the replay; replay again. Case set unchanged.`);
  assert.equal(one({ standing: 'stale', stale: ['question', 'builder', 'bars'] }), `${HEAD}: stale: the question, builder and bars changed since the replay; replay again. Case set unchanged.`);
  assert.equal(one({ standing: 'stale', stale: [] }), `${HEAD}: stale: replay again. Case set unchanged.`);
  assert.equal(one({ kind: 'rerank', modelDigest: 'sha256:abc' }), 'rerank with model-a:8b (local-runtime, sha256:abc), replayed 2026-11-18 on 40 of 52 cases: passes the show and act bars. Case set unchanged.');
  assert.deepEqual(advice.localResultSentences([]), [{ kind: null, text: 'No local result is stored for the kinds shown.' }]);
  assert.deepEqual(advice.localResultSentences(null), [{ kind: null, text: 'No local result is stored for the kinds shown.' }]);
});

test('followedText and agreementText: counts and figures with their n; null is n=0, never a bare 0', () => {
  assert.equal(advice.followedText({ n: 4, followed: 2, partly: 1, overruled: 0 }), 'followed 2, partly 1, overruled 0, n=4 shown picks');
  assert.equal(advice.followedText(null), 'no shown pick (n=0)');
  const figures = { n: 3, accuracy: { model: 0.6667, rule: 1 }, kappa: { model: -0.25, rule: 1, lower: null }, worse: 1, better: 0 };
  const none = { partly: 0, overruledWithoutActual: 0, noStaticAnswer: 0 };
  assert.equal(advice.agreementText({ n: 3, counted: none, figures }), 'accuracy model 0.67, rule 1.00; kappa model -0.25 (lower unknown), rule 1.00; worse 1, better 0; n=3');
  assert.equal(advice.agreementText({ n: 3, counted: { partly: 1, overruledWithoutActual: 0, noStaticAnswer: 2 }, figures }),
    'accuracy model 0.67, rule 1.00; kappa model -0.25 (lower unknown), rule 1.00; worse 1, better 0; n=3; counted, not scored: partly 1, overruled with no answer named 0, no rule answer 2');
  assert.equal(advice.agreementText({ n: 0, counted: { partly: 1, overruledWithoutActual: 0, noStaticAnswer: 0 }, figures: null }), 'no data (n=0); counted, not scored: partly 1, overruled with no answer named 0, no rule answer 0');
  assert.equal(advice.agreementText(null), 'no data (n=0)');
});

// ---- picks per day (IC-018 section 4, FR-015, FR-026) -----------------------------------------------------

const DAYS = [
  { day: '2026-11-05', coverage: 'read', unreadableLines: 0, picks: { 'task-class': 2 } },
  { day: '2026-11-06', coverage: 'read', unreadableLines: 1, picks: {} },
  { day: '2026-11-07', coverage: 'unknown', unreadableLines: 0, picks: {} },
  { day: '2026-11-08', coverage: 'read', unreadableLines: 0, picks: { 'task-class': 1, tier: 3 } },
  { day: '2026-11-09', coverage: 'unknown', unreadableLines: 0, picks: { tier: 4 } },
];

const unknownCase = (mod: any) => {
  const rows = mod.dayRows(DAYS, ['tier', 'task-class', 'verify-risk']);
  const unknownDays = new Set(DAYS.filter((d) => d.coverage === 'unknown').map((d) => d.day));
  for (const line of rows.table) {
    for (const kind of ['tier', 'task-class', 'verify-risk']) {
      if (unknownDays.has(line.day)) assert.equal(line.counts[kind], null, `${line.day} ${kind} is not known`);
    }
  }
  for (const k of rows.kinds) {
    for (const entry of k.withPicks) assert.equal(unknownDays.has(entry.day), false, `${k.kind} lists no unknown day as a day with picks`);
    assert.equal(k.unknownDays, 2);
  }
};

test('dayRows: per kind the read days with picks, 0 on the other read days, unknown on the days not read', () => {
  const rows = advice.dayRows(DAYS, ['tier', 'task-class', 'verify-risk']);
  assert.deepEqual(rows.kinds, [
    { kind: 'tier', withPicks: [{ day: '2026-11-08', n: 3 }], zeroDays: 2, zeroText: '0 on 2 days read', unknownDays: 2, unknownText: 'unknown on 2 days not read' },
    { kind: 'task-class', withPicks: [{ day: '2026-11-05', n: 2 }, { day: '2026-11-08', n: 1 }], zeroDays: 1, zeroText: '0 on 1 day read', unknownDays: 2, unknownText: 'unknown on 2 days not read' },
    { kind: 'verify-risk', withPicks: [], zeroDays: 3, zeroText: '0 on 3 days read', unknownDays: 2, unknownText: 'unknown on 2 days not read' },
  ]);
  assert.deepEqual(rows.table, [
    { day: '2026-11-05', coverage: 'read', unreadableLines: 0, counts: { tier: 0, 'task-class': 2, 'verify-risk': 0 } },
    { day: '2026-11-06', coverage: 'read', unreadableLines: 1, counts: { tier: 0, 'task-class': 0, 'verify-risk': 0 } },
    { day: '2026-11-07', coverage: 'unknown', unreadableLines: 0, counts: { tier: null, 'task-class': null, 'verify-risk': null } },
    { day: '2026-11-08', coverage: 'read', unreadableLines: 0, counts: { tier: 3, 'task-class': 1, 'verify-risk': 0 } },
    { day: '2026-11-09', coverage: 'unknown', unreadableLines: 0, counts: { tier: null, 'task-class': null, 'verify-risk': null } },
  ]);
  unknownCase(advice);
});

test('control: a dayRows that reads an unknown day as 0 turns the unknown case red', async () => {
  const source = fs.readFileSync(ADVICE_FILE, 'utf8');
  const broken = source.replace("const read = day.coverage === 'read';", 'const read = true;');
  assert.notEqual(broken, source, 'the control found the coverage check');
  const mod = await load(ADVICE_FILE, broken);
  assert.throws(() => unknownCase(mod));
});

test('dayRows: no days, no kinds, and malformed entries', () => {
  assert.deepEqual(advice.dayRows([], ['tier']), { kinds: [{ kind: 'tier', withPicks: [], zeroDays: 0, zeroText: '0 on 0 days read', unknownDays: 0, unknownText: 'unknown on 0 days not read' }], table: [] });
  assert.deepEqual(advice.dayRows(null, null), { kinds: [], table: [] });
  const rows = advice.dayRows([null, { day: '2026-11-01', coverage: 'read', picks: null }], ['tier']);
  assert.deepEqual(rows.table, [{ day: '2026-11-01', coverage: 'read', unreadableLines: 0, counts: { tier: 0 } }]);
});
