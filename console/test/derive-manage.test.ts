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
const ADVICE_KINDS: string[] = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'advice.json'), 'utf8')).kinds.map((k: any) => k.id);
const SHIPPED_VERDICTS: any[] = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'advice-verdicts.json'), 'utf8')).verdicts;

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
  assert.equal(REGISTRY_KEYS.length >= 47, true, 'the registry still lists its keys');
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

// ---- gate sentences (IC-018 section 1, FR-017) ------------------------------------------------------------

const row = (kind: string, model: string, extra: any = {}) => ({ kind, model, arm: null, result: 'pass', stale: false, reason: null, ...extra });

test('gateSentences: over the shipped core/registry/advice-verdicts.json', () => {
  const sentences = advice.gateSentences(ADVICE_KINDS, SHIPPED_VERDICTS);
  if (SHIPPED_VERDICTS.length === 0) {
    assert.deepEqual(sentences, [{ kind: null, text: 'No bench verdict ships for any kind.' }]);
  } else {
    const shippedKinds = new Set(SHIPPED_VERDICTS.map((v: any) => v.kind));
    for (const kind of ADVICE_KINDS) {
      const mine = sentences.filter((s: any) => s.kind === kind);
      assert.equal(mine.length >= 1, true, kind);
      if (!shippedKinds.has(kind)) assert.deepEqual(mine.map((s: any) => s.text), [`No bench verdict ships for ${kind}.`]);
    }
  }
});

test('gateSentences: planted pass and stale rows, and a kind with no row', () => {
  const verdicts = [
    row('tier', 'qwen3-8b'),
    row('task-class', 'qwen3-8b', { stale: true, reason: 'verdict stale: the bench corpus changed' }),
    row('rerank', 'bge-m3', { result: 'pass', stale: true, reason: 'verdict stale: criteria digest differs' }),
  ];
  const sentences = advice.gateSentences(['tier', 'task-class', 'verify-risk', 'rerank'], verdicts);
  assert.deepEqual(sentences, [
    { kind: 'tier', text: 'A passing verdict ships for tier with qwen3-8b.' },
    { kind: 'task-class', text: 'verdict stale: the bench corpus changed' },
    { kind: 'verify-risk', text: 'No bench verdict ships for verify-risk.' },
    { kind: 'rerank', text: 'verdict stale: criteria digest differs' },
  ]);
});

test('gateSentences: a row that is not a pass is no passing verdict; kinds come as ids or report rows; a verdict kind not listed still reads', () => {
  const sentences = advice.gateSentences([{ kind: 'tier' }, 'mcp-need'], [row('tier', 'm1', { result: 'fail' }), row('adhoc', 'm2')]);
  assert.deepEqual(sentences, [
    { kind: 'tier', text: 'No passing bench verdict ships for tier: m1 reads fail.' },
    { kind: 'mcp-need', text: 'No bench verdict ships for mcp-need.' },
    { kind: 'adhoc', text: 'A passing verdict ships for adhoc with m2.' },
  ]);
  assert.deepEqual(advice.gateSentences(['tier'], [row('tier', 'm1', { result: null })]), [{ kind: 'tier', text: 'No passing bench verdict ships for tier: m1 reads unknown.' }]);
  assert.deepEqual(advice.gateSentences(['tier'], [row('tier', 'm1', { stale: true, reason: null })]), [{ kind: 'tier', text: 'The bench verdict for tier with m1 is stale.' }]);
  assert.deepEqual(advice.gateSentences([], []), [{ kind: null, text: 'No bench verdict ships for any kind.' }]);
  assert.deepEqual(advice.gateSentences(['tier'], null), [{ kind: null, text: 'No bench verdict ships for any kind.' }]);
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
