'use strict';

// 151 A.3 (IC-001, IC-002, IC-024; FR-015, FR-016, FR-025, NFR-001, NFR-002): the read-only
// `advice-picks` verb, called in-process over records written with `appendPick`, `appendMiss` and
// `appendOutcome` (and raw lines where a record must be malformed) under an injected clock. Covered:
// the window and its 91 days, `read` against `unknown` days, kind narrowing, the newest 50 and
// `notShown`, ties, modes, the `ANSWER` rule after masking, the latest outcome, `skipped`, the kinds
// bound, the never-fields, the exit codes, the modules it loads and a byte-for-byte tree comparison.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { maskBody } = require('../../src/runtime/mask.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../src/runtime/storage/roots.ts');
const { appendPick, appendMiss, appendOutcome } = require('../../src/runtime/advice/record.ts');
const { buildReport } = require('../../src/runtime/advice/report.ts');
const {
  handleAdvicePicksCommand, advicePicksBody, MAX_AGE_DAYS, PICKS_LIMIT, PICK_KINDS_LIMIT,
} = require('../../src/runtime/advice/picks.ts');

const STORAGE = loadStorageRegistry({ repoRoot: REPO_ROOT });
const NOW = () => new Date('2026-06-10T12:00:00.000Z');
const FROM = '2026-03-12';
const TO = '2026-06-10';
const REGISTRY_KINDS = ['tier', 'task-class', 'verify-risk', 'review-depth', 'mcp-need', 'followup-triage', 'rerank', 'claim-support'];
const BODY_KEYS = ['v', 'window', 'kind', 'kinds', 'stores', 'days', 'picks', 'limits'];
const DAY_KEYS = ['day', 'coverage', 'unreadableLines', 'picks'];
const PICK_KEYS = ['pickId', 'kind', 'at', 'mode', 'pick', 'static', 'agree', 'outcome'];
const OUTCOME_KEYS = ['actual', 'at', 'agree'];
const LIMIT_KEYS = ['shown', 'notShown', 'skipped'];
const NEVER_FIELDS = [
  'question', 'qtype', 'options', 'instructions', 'strength', 'between', 'probabilities', 'confidence', 'provider', 'model',
  'stateDigest', 'stateBytes', 'caller', 'taskId', 'durationMs', 'elevated', 'rerank', 'claimSupport', 'criteria', 'pickIndex',
  'score', 'source',
];
const ANSWER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const WITHHELD = '(withheld)';

function fixture(t: any) {
  const home = fs.realpathSync(tempDir(t, 'doflow-picks-home-'));
  const project = fs.realpathSync(tempDir(t, 'doflow-picks-project-'));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') };
  const roots = resolveRoots({ registry: STORAGE, projectRoot: project, global: false, env });
  return { home, project, env, roots };
}

const picksDir = (fx: any, store = 'project-state') => path.join(fx.roots[store], 'advice', 'picks');

const ANSWER_BASE = { name: 'which-class', type: 'choice', pick: 'feature', probabilities: { feature: 0.8, bug: 0.2 }, confidence: 0.7, strength: { word: 'clear', between: null } };
const QUESTION_BASE = { name: 'which-class', type: 'choice', options: { feature: 'a feature', bug: 'a bug' } };

/** One pick through `appendPick` at `at`; returns its pickId. */
function pick(fx: any, at: string, o: any = {}): string {
  const { pick: chosen = 'feature', answer = {}, question = {}, kind = 'task-class', staticAnswer = 'bug', ...rest } = o;
  const written = appendPick({
    roots: fx.roots, now: () => new Date(at), kind, answer: { ...ANSWER_BASE, pick: chosen, ...answer },
    question: { ...QUESTION_BASE, ...question }, staticAnswer, state: 'private state text', caller: 'advise', ...rest,
  });
  assert.ok(written, `the pick at ${at} was written`);
  return written.pickId;
}

function outcome(fx: any, at: string, pickId: string, actual: string) {
  assert.ok(appendOutcome({ roots: fx.roots, now: () => new Date(at), pickId, actual, source: 'caller' }), 'the outcome was written');
}

function rawLine(fx: any, day: string, value: any, store = 'project-state') {
  const file = path.join(picksDir(fx, store), `${day}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value)}\n`);
}

/** Runs the handler with captured writers; restores `process.exitCode`. */
function call(fx: any, options: any = {}) {
  const out = { text: '', write(s: string) { this.text += s; } };
  const err = { text: '', write(s: string) { this.text += s; } };
  const saved = process.exitCode;
  let exit: number;
  try {
    exit = handleAdvicePicksCommand({
      json: true, flags: ['--json'], positional: [], cwd: fx.project, env: fx.env, now: NOW, ...options, stdout: out, stderr: err,
    });
  } finally {
    process.exitCode = saved;
  }
  assert.equal(out.text.indexOf('\n'), out.text.length - 1, 'stdout is one line');
  assert.equal(out.text, `${JSON.stringify(JSON.parse(out.text))}\n`, 'the line is compact JSON');
  return { exit, out: out.text, err: err.text, json: JSON.parse(out.text) };
}

/** A successful body: exit 0, no stderr. */
function body(fx: any, options: any = {}) {
  const r = call(fx, options);
  assert.equal(r.exit, 0, r.out + r.err);
  assert.equal(r.err, '');
  return r.json;
}

const dayOf = (b: any, day: string) => b.days.find((d: any) => d.day === day);

/** Every key of a JSON value, except the kind ids that key `days[].picks`. */
function keysOf(value: any, out: string[] = [], underDayPicks = false): string[] {
  if (Array.isArray(value)) { for (const item of value) keysOf(item, out); return out; }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (!underDayPicks) out.push(key);
      keysOf(value[key], out, false);
    }
  }
  return out;
}

// ── Window and days ──────────────────────────────────────────────────────────────────────────────

test('the window is 90 days from the clock, as the report has it, and days lists its 91 dates oldest first', (t) => {
  const fx = fixture(t);
  const b = body(fx);
  assert.deepEqual(Object.keys(b), BODY_KEYS);
  assert.equal(b.v, 1);
  assert.equal(MAX_AGE_DAYS, 90);
  assert.deepEqual(b.window, { from: FROM, to: TO, maxAgeDays: 90 });
  assert.deepEqual(b.window, buildReport({ roots: fx.roots, kinds: ['tier'], now: NOW }).window);
  assert.equal(b.days.length, 91);
  assert.equal(b.days[0].day, FROM);
  assert.equal(b.days[90].day, TO);
  for (let i = 1; i < b.days.length; i += 1) {
    assert.equal(Date.parse(`${b.days[i].day}T00:00:00Z`) - Date.parse(`${b.days[i - 1].day}T00:00:00Z`), 86400000);
  }
  for (const d of b.days) assert.deepEqual(Object.keys(d), DAY_KEYS);
  assert.equal(b.kind, null);
  assert.deepEqual(b.kinds, REGISTRY_KINDS);
  assert.deepEqual(b.stores, { 'project-state': 'absent', 'user-state': 'absent' });
  // No store exists: every day was read (nothing to read) and holds no pick.
  assert.ok(b.days.every((d: any) => d.coverage === 'read' && d.unreadableLines === 0 && Object.keys(d.picks).length === 0));
  assert.deepEqual(b.picks, []);
  assert.deepEqual(b.limits, { shown: 0, notShown: 0, skipped: 0 });
});

test('a read day counts its picks per kind; a read day with none reads 0 by holding no entry', (t) => {
  const fx = fixture(t);
  pick(fx, '2026-06-08T09:00:00.000Z');
  pick(fx, '2026-06-08T10:00:00.000Z');
  pick(fx, '2026-06-08T11:00:00.000Z', { kind: 'tier', pick: 'standard', staticAnswer: 'light' });
  assert.ok(appendMiss({ roots: fx.roots, now: () => new Date('2026-06-08T12:00:00.000Z'), kind: 'tier', caller: 'advise', reason: 'timeout' }));
  pick(fx, '2026-03-12T01:00:00.000Z');
  // Before the window: not read, not counted.
  pick(fx, '2026-03-11T23:00:00.000Z');
  const b = body(fx);
  assert.deepEqual(b.stores, { 'project-state': 'read', 'user-state': 'absent' });
  assert.deepEqual(dayOf(b, '2026-06-08'), { day: '2026-06-08', coverage: 'read', unreadableLines: 0, picks: { tier: 1, 'task-class': 2 } });
  assert.deepEqual(dayOf(b, '2026-06-09'), { day: '2026-06-09', coverage: 'read', unreadableLines: 0, picks: {} });
  assert.deepEqual(dayOf(b, FROM).picks, { 'task-class': 1 });
  assert.equal(b.picks.length, 4);
  assert.deepEqual(b.limits, { shown: 4, notShown: 0, skipped: 0 });
});

test('a partition that cannot be read makes its day unknown; a bad line is counted on a day still read', (t) => {
  const fx = fixture(t);
  pick(fx, '2026-06-04T09:00:00.000Z');
  fs.mkdirSync(path.join(picksDir(fx), '2026-06-05.jsonl'));
  rawLine(fx, '2026-06-06', 'not json at all');
  rawLine(fx, '2026-06-06', '[1, 2]');
  const b = body(fx);
  assert.deepEqual(b.stores, { 'project-state': 'read', 'user-state': 'absent' });
  assert.deepEqual(dayOf(b, '2026-06-05'), { day: '2026-06-05', coverage: 'unknown', unreadableLines: 0, picks: {} });
  assert.deepEqual(dayOf(b, '2026-06-06'), { day: '2026-06-06', coverage: 'read', unreadableLines: 2, picks: {} });
  assert.deepEqual(dayOf(b, '2026-06-04'), { day: '2026-06-04', coverage: 'read', unreadableLines: 0, picks: { 'task-class': 1 } });
  assert.equal(b.days.filter((d: any) => d.coverage === 'unknown').length, 1);
});

test('a store that cannot be listed makes every day unknown; the other store is still read', (t) => {
  const fx = fixture(t);
  pick(fx, '2026-06-04T09:00:00.000Z');
  const denied = picksDir(fx, 'user-state');
  const fsImpl = {
    ...fs,
    readdirSync(target: any, ...rest: any[]) {
      if (path.resolve(String(target)) === denied) { const error: any = new Error('permission denied'); error.code = 'EACCES'; throw error; }
      return fs.readdirSync(target, ...rest);
    },
  };
  const b = body(fx, { fsImpl });
  assert.deepEqual(b.stores, { 'project-state': 'read', 'user-state': 'unreadable' });
  assert.ok(b.days.every((d: any) => d.coverage === 'unknown'));
  assert.deepEqual(dayOf(b, '2026-06-04').picks, { 'task-class': 1 });
  assert.equal(b.picks.length, 1);
});

// ── Kinds ────────────────────────────────────────────────────────────────────────────────────────

test('--kind task-class and --kind adhoc narrow kinds, days[].picks and picks', (t) => {
  const fx = fixture(t);
  pick(fx, '2026-06-08T09:00:00.000Z');
  pick(fx, '2026-06-08T10:00:00.000Z', { kind: 'tier', pick: 'standard', staticAnswer: 'light' });
  pick(fx, '2026-06-08T11:00:00.000Z', { kind: 'adhoc', pick: 'yes', staticAnswer: null, question: { instructions: 'answer plainly' } });

  const all = body(fx);
  assert.deepEqual(all.kinds, [...REGISTRY_KINDS, 'adhoc']);
  assert.deepEqual(dayOf(all, '2026-06-08').picks, { tier: 1, 'task-class': 1, adhoc: 1 });
  assert.equal(all.picks.length, 3);

  const taskClass = body(fx, { kind: 'task-class', flags: ['--kind', '--json'] });
  assert.equal(taskClass.kind, 'task-class');
  assert.deepEqual(taskClass.kinds, ['task-class']);
  assert.deepEqual(dayOf(taskClass, '2026-06-08').picks, { 'task-class': 1 });
  assert.deepEqual(taskClass.picks.map((p: any) => p.kind), ['task-class']);
  assert.deepEqual(taskClass.limits, { shown: 1, notShown: 0, skipped: 0 });

  const adhoc = body(fx, { kind: 'adhoc', flags: ['--kind=adhoc'] });
  assert.equal(adhoc.kind, 'adhoc');
  assert.deepEqual(adhoc.kinds, ['adhoc']);
  assert.deepEqual(dayOf(adhoc, '2026-06-08').picks, { adhoc: 1 });
  assert.deepEqual(adhoc.picks.map((p: any) => [p.kind, p.pick, p.static, p.agree]), [['adhoc', 'yes', null, null]]);
});

test(`33 kinds give the first ${32}; the records of the kind past the bound are counted in skipped`, (t) => {
  const fx = fixture(t);
  assert.equal(PICK_KINDS_LIMIT, 32);
  const extras = Array.from({ length: 25 }, (_, i) => `extra-${String(i + 1).padStart(2, '0')}`);
  extras.forEach((kind, i) => pick(fx, `2026-06-08T10:${String(i).padStart(2, '0')}:00.000Z`, { kind }));
  pick(fx, '2026-06-08T11:00:00.000Z', { kind: 'extra-25' });
  const b = body(fx);
  assert.equal(REGISTRY_KINDS.length + extras.length, 33);
  assert.equal(b.kinds.length, 32);
  assert.deepEqual(b.kinds, [...REGISTRY_KINDS, ...extras.slice(0, 24)]);
  assert.equal(b.picks.some((p: any) => p.kind === 'extra-25'), false);
  assert.equal(Object.hasOwn(dayOf(b, '2026-06-08').picks, 'extra-25'), false);
  assert.equal(b.limits.skipped, 2);
  assert.deepEqual(b.limits, { shown: 24, notShown: 0, skipped: 2 });
});

// ── Picks ────────────────────────────────────────────────────────────────────────────────────────

test(`52 picks give the newest ${50}, newest first, and notShown 2`, (t) => {
  const fx = fixture(t);
  assert.equal(PICKS_LIMIT, 50);
  const at = (i: number) => new Date(Date.parse('2026-06-01T00:00:00.000Z') + i * 60000).toISOString();
  for (let i = 0; i < 52; i += 1) pick(fx, at(i));
  const b = body(fx);
  assert.equal(b.picks.length, 50);
  assert.deepEqual(b.picks.map((p: any) => p.at), Array.from({ length: 50 }, (_, i) => at(51 - i)));
  assert.deepEqual(b.limits, { shown: 50, notShown: 2, skipped: 0 });
  assert.deepEqual(dayOf(b, '2026-06-01').picks, { 'task-class': 52 });
  for (const p of b.picks) assert.deepEqual(Object.keys(p), PICK_KEYS);
});

test('picks of the same time are ordered by pickId descending; a pickId that is not one reads null', (t) => {
  const fx = fixture(t);
  const at = '2026-06-08T09:00:00.000Z';
  const ms = String(Date.parse(at));
  for (const suffix of ['aaaaaa', 'cccccc', 'bbbbbb']) pick(fx, at, { pickId: `adv-${ms}-${suffix}` });
  rawLine(fx, '2026-06-07', { schema: 1, type: 'pick', pickId: 'not-an-id', at: '2026-06-07T09:00:00.000Z', kind: 'task-class', pick: 'feature', static: 'feature' });
  const b = body(fx);
  assert.deepEqual(b.picks.map((p: any) => p.pickId), [`adv-${ms}-cccccc`, `adv-${ms}-bbbbbb`, `adv-${ms}-aaaaaa`, null]);
  assert.equal(b.picks[3].agree, true);
});

test('mode is shadow or act as recorded, and unrecorded for no mode or an unknown one', (t) => {
  const fx = fixture(t);
  pick(fx, '2026-06-08T04:00:00.000Z', { mode: 'shadow' });
  pick(fx, '2026-06-08T03:00:00.000Z', { mode: 'act' });
  pick(fx, '2026-06-08T02:00:00.000Z');
  pick(fx, '2026-06-08T01:00:00.000Z', { mode: 'sideways' });
  assert.deepEqual(body(fx).picks.map((p: any) => p.mode), ['shadow', 'act', 'unrecorded', 'unrecorded']);
});

test('caller text is withheld; a static that is not a string is null; agree only between two shown answers', (t) => {
  const fx = fixture(t);
  pick(fx, '2026-06-08T05:00:00.000Z', { pick: 'the caller wrote this sentence', staticAnswer: 'bug' });
  pick(fx, '2026-06-08T04:00:00.000Z', { pick: 'feature', staticAnswer: 'also free text!' });
  pick(fx, '2026-06-08T03:00:00.000Z', { pick: 'feature', staticAnswer: 'feature' });
  pick(fx, '2026-06-08T02:00:00.000Z', { pick: 'feature', staticAnswer: 'bug' });
  rawLine(fx, '2026-06-08', { schema: 1, type: 'pick', pickId: 'adv-1780880000000-0a0a0a', at: '2026-06-08T01:00:00.000Z', kind: 'task-class', pick: 'feature', static: 3 });
  const r = call(fx);
  assert.equal(r.exit, 0);
  assert.deepEqual(r.json.picks.map((p: any) => [p.pick, p.static, p.agree]), [
    [WITHHELD, 'bug', null],
    ['feature', WITHHELD, null],
    ['feature', 'feature', true],
    ['feature', 'bug', false],
    ['feature', null, null],
  ]);
  assert.equal(r.out.includes('the caller wrote this sentence'), false);
  assert.equal(r.out.includes('also free text'), false);
});

test('agree is null when static is null', (t) => {
  const fx = fixture(t);
  pick(fx, '2026-06-08T05:00:00.000Z', { staticAnswer: null });
  const [p] = body(fx).picks;
  assert.equal(p.static, null);
  assert.equal(p.agree, null);
});

test('a planted secret shaped like a label is masked first and then withheld, in pick, static and actual', (t) => {
  const fx = fixture(t);
  const secret = 'AKIAIOSFODNN7EXAMPLE';
  assert.ok(ANSWER.test(secret), 'the secret is label-shaped');
  assert.notEqual(maskBody(secret).text, secret, 'the mask replaces it');
  const id = pick(fx, '2026-06-08T05:00:00.000Z', { pick: secret, staticAnswer: secret });
  outcome(fx, '2026-06-08T06:00:00.000Z', id, secret);
  const r = call(fx);
  assert.equal(r.exit, 0);
  assert.deepEqual(r.json.picks[0], {
    pickId: id, kind: 'task-class', at: '2026-06-08T05:00:00.000Z', mode: 'unrecorded',
    pick: WITHHELD, static: WITHHELD, agree: null, outcome: { actual: WITHHELD, at: '2026-06-08T06:00:00.000Z', agree: null },
  });
  assert.equal(r.out.includes(secret), false);
  assert.equal(r.out.includes('<masked>'), false);
});

test('the outcome is the latest by at of those naming the pick; none reads null', (t) => {
  const fx = fixture(t);
  const id = pick(fx, '2026-06-08T10:00:00.000Z', { pick: 'feature', staticAnswer: 'bug' });
  const other = pick(fx, '2026-06-08T09:00:00.000Z', { pick: 'bug', staticAnswer: 'bug' });
  // Written later in the partition but earlier by `at`: the first line wins.
  outcome(fx, '2026-06-08T13:00:00.000Z', id, 'feature');
  outcome(fx, '2026-06-08T11:00:00.000Z', id, 'bug');
  const b = body(fx);
  assert.deepEqual(b.picks.map((p: any) => p.pickId), [id, other]);
  assert.deepEqual(b.picks[0].outcome, { actual: 'feature', at: '2026-06-08T13:00:00.000Z', agree: true });
  assert.deepEqual(Object.keys(b.picks[0].outcome), OUTCOME_KEYS);
  assert.equal(b.picks[1].outcome, null);
  assert.deepEqual(dayOf(b, '2026-06-08').picks, { 'task-class': 2 });
});

test('records with no usable type, kind or at are skipped and counted; a non-object line is an unreadable line', (t) => {
  const fx = fixture(t);
  pick(fx, '2026-06-08T05:00:00.000Z');
  rawLine(fx, '2026-06-08', { schema: 1, type: 'pick', pickId: 'adv-1780880000000-0b0b0b', kind: 'tier', pick: 'light', static: 'light' });
  rawLine(fx, '2026-06-08', { schema: 1, type: 'pick', at: 'yesterday', kind: 'tier', pick: 'light' });
  rawLine(fx, '2026-06-08', { schema: 1, type: 'weird', at: '2026-06-08T06:00:00.000Z', kind: 'tier' });
  rawLine(fx, '2026-06-08', { schema: 1, type: 'pick', at: '2026-06-08T07:00:00.000Z', kind: 'Not A Kind', pick: 'light' });
  rawLine(fx, '2026-06-08', '[1, 2]');
  const b = body(fx);
  assert.equal(b.picks.length, 1);
  assert.deepEqual(b.limits, { shown: 1, notShown: 0, skipped: 4 });
  assert.deepEqual(dayOf(b, '2026-06-08'), { day: '2026-06-08', coverage: 'read', unreadableLines: 1, picks: { 'task-class': 1 } });
  assert.deepEqual(b.kinds, REGISTRY_KINDS);
});

test('a partition dated after the clock is outside the window', (t) => {
  const fx = fixture(t);
  pick(fx, '2026-06-11T05:00:00.000Z');
  pick(fx, '2026-06-10T05:00:00.000Z');
  const b = body(fx);
  assert.deepEqual(b.picks.map((p: any) => p.at), ['2026-06-10T05:00:00.000Z']);
  assert.deepEqual(b.limits, { shown: 1, notShown: 0, skipped: 0 });
  assert.equal(b.days.at(-1).day, TO);
});

// ── Privacy ──────────────────────────────────────────────────────────────────────────────────────

test('no never-field of any record reaches the body, by key or by value', (t) => {
  const fx = fixture(t);
  const planted = (name: string) => `planted-${name.toLowerCase()}-value`;
  const id = pick(fx, '2026-06-08T05:00:00.000Z', {
    kind: 'adhoc', pick: 'planted-option-a', staticAnswer: 'planted-option-b', mode: 'shadow', elevated: true,
    answer: { name: planted('question'), probabilities: { [planted('probabilities')]: 0.5 }, confidence: 0.4321, strength: { word: planted('strength'), between: [planted('between')] } },
    question: { name: planted('question'), instructions: planted('instructions'), options: { 'planted-option-a': planted('options'), 'planted-option-b': 'b' } },
    provider: planted('provider'), model: planted('model'), caller: planted('caller'), taskId: planted('taskid'), durationMs: 987654321, state: planted('state'),
  });
  pick(fx, '2026-06-08T04:00:00.000Z', {
    kind: 'review-depth', pick: 'deep', staticAnswer: 'light',
    answer: { type: 'score', pickIndex: 7, score: 0.123456 }, question: { type: 'score', criteria: [planted('criteria')] },
  });
  const raw: any = { schema: 1, type: 'pick', pickId: 'adv-1780880000000-0c0c0c', at: '2026-06-08T03:00:00.000Z', kind: 'tier', pick: 'light', static: 'standard', mode: 'act' };
  for (const field of NEVER_FIELDS) raw[field] = planted(field);
  rawLine(fx, '2026-06-08', raw);
  outcome(fx, '2026-06-08T06:00:00.000Z', id, 'planted-option-a');
  rawLine(fx, '2026-06-08', { schema: 1, type: 'outcome', pickId: 'adv-1780880000000-0c0c0c', at: '2026-06-08T07:00:00.000Z', actual: 'light', source: planted('source'), question: planted('question') });
  const state = crypto.createHash('sha256').update(planted('state'), 'utf8').digest('hex');

  for (const options of [{}, { kind: 'adhoc', flags: ['--kind'] }, { kind: 'tier', flags: ['--kind'] }]) {
    const r = call(fx, options);
    assert.equal(r.exit, 0);
    assert.doesNotMatch(r.out, /planted-[a-z]+-value/, 'no planted value');
    assert.equal(r.out.includes(state), false);
    assert.equal(r.out.includes('987654321'), false);
    assert.equal(r.out.includes('0.4321'), false);
    assert.equal(r.out.includes('0.123456'), false);
    for (const field of NEVER_FIELDS) assert.equal(r.out.includes(`"${field}":`), false, field);
    const keys = new Set(keysOf(r.json));
    for (const field of NEVER_FIELDS) assert.equal(keys.has(field), false, field);
  }
  const b = body(fx);
  assert.deepEqual(b.picks.map((p: any) => [p.kind, p.pick, p.static, p.mode, p.outcome?.actual ?? null]), [
    ['adhoc', 'planted-option-a', 'planted-option-b', 'shadow', 'planted-option-a'],
    ['review-depth', 'deep', 'light', 'unrecorded', null],
    ['tier', 'light', 'standard', 'act', 'light'],
  ]);
});

// ── Exit codes ───────────────────────────────────────────────────────────────────────────────────

test('exit 2 usage for an unknown, repeated or misplaced flag, a positional, an unknown --kind or no clock; one stderr line each', (t) => {
  const fx = fixture(t);
  const cases = [
    { flags: ['--bogus'] }, { flags: ['--slug=x'] }, { flags: ['--json=1'] }, { flags: ['--json', '--json'] },
    { flags: ['--kind', '--kind'], kind: 'tier' }, { flags: ['--kind'], kind: undefined }, { flags: ['--kind'], kind: '' },
    { flags: [], positional: ['tier'] }, { flags: ['--kind'], kind: 'nope' }, { flags: ['--kind'], kind: 'Task-Class' },
    { flags: [], kind: 42 }, { flags: [], now: () => 'not a time' },
  ];
  for (const c of cases) {
    const r = call(fx, c);
    assert.equal(r.exit, 2, JSON.stringify(c));
    assert.deepEqual(r.json, { v: 1, ok: false, error: 'usage' });
    assert.match(r.err, /^doflow advice-picks: [^\n]+\n$/);
    assert.deepEqual(advicePicksBody({ cwd: fx.project, env: fx.env, now: NOW, positional: [], ...c }), { exit: 2, json: { v: 1, ok: false, error: 'usage' } });
  }
});

test('exit 2 registry-invalid when the advice or the storage registry cannot be loaded', (t) => {
  const fx = fixture(t);
  for (const name of ['advice.json', 'storage.json']) {
    const broken = path.join(REPO_ROOT, 'core', 'registry', name);
    const fsImpl = {
      ...fs,
      readFileSync(target: any, ...rest: any[]) {
        if (path.resolve(String(target)) === broken) return '{ not json';
        return fs.readFileSync(target, ...rest);
      },
    };
    const r = call(fx, { fsImpl });
    assert.equal(r.exit, 2, name);
    assert.deepEqual(r.json, { v: 1, ok: false, error: 'registry-invalid' });
    assert.match(r.err, /^doflow advice-picks: [^\n]+\n$/);
    assert.deepEqual(advicePicksBody({ cwd: fx.project, env: fx.env, now: NOW, fsImpl }), { exit: 2, json: { v: 1, ok: false, error: 'registry-invalid' } });
  }
});

test('the body is the same line with or without --json, and advicePicksBody returns it', (t) => {
  const fx = fixture(t);
  pick(fx, '2026-06-08T05:00:00.000Z', { mode: 'shadow' });
  const plain = call(fx, { json: false, flags: [] });
  const json = call(fx, { json: true, flags: ['--json'] });
  assert.equal(plain.exit, 0);
  assert.equal(plain.out, json.out);
  assert.equal(plain.err, '');
  const answer = advicePicksBody({ cwd: fx.project, env: fx.env, now: NOW });
  assert.equal(answer.exit, 0);
  assert.equal(`${JSON.stringify(answer.json)}\n`, json.out);
});

// ── Read-only ────────────────────────────────────────────────────────────────────────────────────

test('a call loads no advice/cli.ts, advice/client.ts or settings/write.ts', () => {
  const script = [
    "const { handleAdvicePicksCommand } = require('./src/runtime/advice/picks.ts');",
    "const sink = { write() {} };",
    "handleAdvicePicksCommand({ json: true, flags: ['--json'], positional: [], cwd: process.cwd(), env: { HOME: process.cwd() }, stdout: sink, stderr: sink });",
    "handleAdvicePicksCommand({ kind: 'tier', flags: ['--kind'], positional: [], cwd: process.cwd(), env: { HOME: process.cwd() }, stdout: sink, stderr: sink });",
    "const keys = Object.keys(require.cache);",
    "process.stdout.write(JSON.stringify({ loaded: keys.some((k) => k.endsWith('picks.ts')), keys }));",
  ].join('\n');
  const run = spawnSync(process.execPath, ['-e', script], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const { loaded, keys } = JSON.parse(run.stdout);
  assert.equal(loaded, true);
  for (const banned of [['advice', 'cli.ts'], ['advice', 'client.ts'], ['settings', 'write.ts']]) {
    const suffix = path.join('src', 'runtime', ...banned);
    assert.deepEqual(keys.filter((k: string) => k.endsWith(suffix)), [], suffix);
  }
});

/** Every entry under `root`: path, type, size, mtime, inode and a content digest. */
function treeOf(root: string) {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const st = fs.lstatSync(full, { bigint: true });
      const digest = st.isFile() ? crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex') : '-';
      out.push(`${path.relative(root, full)} ${st.isDirectory() ? 'd' : 'f'} ${st.size} ${st.mtimeNs} ${st.ino} ${digest}`);
      if (st.isDirectory()) walk(full);
    }
  }(root));
  return out;
}

test('every call leaves the project and home trees byte for byte unchanged and writes nothing', (t: any) => {
  const fx = fixture(t);
  const id = pick(fx, '2026-06-08T05:00:00.000Z', { mode: 'shadow' });
  outcome(fx, '2026-06-08T06:00:00.000Z', id, 'feature');
  pick(fx, '2026-06-07T05:00:00.000Z', { kind: 'tier', pick: 'light', staticAnswer: 'light' });
  rawLine(fx, '2026-06-06', 'not json');
  rawLine(fx, '2026-06-05', { schema: 1, type: 'pick', at: '2026-06-05T01:00:00.000Z', kind: 'adhoc', pick: 'yes' }, 'user-state');
  fs.mkdirSync(path.join(fx.project, '.doflow'), { recursive: true });
  fs.writeFileSync(path.join(fx.project, '.doflow', 'settings.json'), '{"advice":{"enabled":true}}\n');
  const before = { project: treeOf(fx.project), home: treeOf(fx.home) };
  assert.ok(before.project.length >= 6);
  assert.ok(before.home.length >= 4);

  const touched: any[] = [];
  for (const name of ['openSync', 'mkdirSync', 'writeFileSync', 'appendFileSync', 'renameSync', 'rmSync', 'unlinkSync', 'copyFileSync', 'utimesSync']) {
    const real = fs[name];
    t.mock.method(fs, name, (...args: any[]) => {
      if (name !== 'openSync' || (args[1] !== undefined && args[1] !== 'r')) touched.push([name, String(args[0])]);
      return real.apply(fs, args);
    });
  }
  const answers = [
    call(fx),
    call(fx, { json: false, flags: [] }),
    call(fx, { kind: 'tier', flags: ['--kind'] }),
    call(fx, { kind: 'adhoc', flags: ['--kind'] }),
    call(fx, { flags: ['--bogus'] }),
    call(fx, { kind: 'nope', flags: ['--kind'] }),
  ];
  t.mock.restoreAll();
  assert.deepEqual(touched, []);
  assert.deepEqual({ project: treeOf(fx.project), home: treeOf(fx.home) }, before);
  assert.deepEqual(answers.map((a) => a.exit), [0, 0, 0, 0, 2, 2]);
  assert.equal(answers[0].json.stores['user-state'], 'read');
  assert.deepEqual(answers[3].json.picks.map((p: any) => p.kind), ['adhoc']);
});
