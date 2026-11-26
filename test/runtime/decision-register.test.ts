'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tempDir, suiteTempDir } = require('../helper/tmp.ts');
const {
  runDecision, addDecisions, initRegister, listDecisions, readRegister, renderLiveView, renderArchive,
  registerFile, handleDecisionCommand, humanLines, STATEMENT_MAX,
  linkDecisions, retireDecisions, compactDecisions, decisionState, inLiveView, LINK_KINDS, DECISION_STATES, COMPACT_MODES,
} = require('../../src/runtime/decision-register.ts');

const SLUG = '001-demo';
const FIXED: any = new Date('2026-10-03T09:12:44.120Z');

function git(cwd: any, ...args: any[]) {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'ignore' });
}

/** A temp git repo on feat/001-demo; the feature folder exists only when `files` names something. */
function repo(files: any = {}) {
  const root = suiteTempDir('doflow-decision-register-');
  git(root, 'init', '-q');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(root, 'checkout', '-q', '-b', `feat/${SLUG}`);
  const featureDir = path.join(root, 'agent-docs', 'doflow', SLUG);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(featureDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(featureDir, rel), content);
  }
  return { root, featureDir };
}

function initialised() {
  const r = repo();
  assert.equal(runDecision({ action: 'init', projectRoot: r.root, now: FIXED }).exitCode, 0);
  return r;
}

const item = (over: any = {}) => ({
  topic: 'wire-id', statement: 'The wire carries the UUID.', channel: 'question', stage: 'design', rationale: 'Because.', ...over,
});

function add(r: any, items: any, extra: any = {}) {
  const file = path.join(r.root, `batch-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(items));
  return runDecision({ action: 'add', projectRoot: r.root, flags: { batch: file }, now: FIXED, ...extra });
}

const snapshot = (featureDir: any) => {
  const out: any = {};
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p); else out[path.relative(featureDir, p)] = fs.readFileSync(p, 'utf8');
    }
  }(featureDir));
  return out;
};

// ── init (FR-001, FR-016) ──────────────────────────────────────────────────────────────────────

test('init creates the register and both views for a new feature', () => {
  const r = repo();
  const run = runDecision({ action: 'init', projectRoot: r.root, now: FIXED });
  assert.equal(run.exitCode, 0);
  assert.deepEqual(run.result, { action: 'init', slug: SLUG, featureDir: r.featureDir, created: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(registerFile(r.featureDir), 'utf8')), { version: 1, slug: SLUG, nextId: 1, decisions: [] });
  const live = fs.readFileSync(path.join(r.featureDir, 'decisions.md'), 'utf8');
  assert.ok(live.startsWith(`# Decisions: ${SLUG}\n`));
  assert.ok(live.includes('No live decisions yet.'));
  assert.ok(!live.includes('| ID |'));
  const archive = fs.readFileSync(path.join(r.featureDir, 'decisions', 'archive.md'), 'utf8');
  assert.ok(archive.startsWith(`# Decision archive: ${SLUG}\n`));
  assert.ok(!fs.existsSync(`${registerFile(r.featureDir)}.lock`));
});

test('init on an existing register writes nothing and reports created: false', () => {
  const r = initialised();
  add(r, [item()]);
  const before = snapshot(r.featureDir);
  const run = runDecision({ action: 'init', projectRoot: r.root, now: FIXED });
  assert.equal(run.exitCode, 0);
  assert.equal(run.result.created, false);
  assert.equal(run.result.finding, undefined);
  assert.deepEqual(snapshot(r.featureDir), before);
});

for (const rel of ['intention/requirement.md', 'design/design.md', 'plan.md']) {
  test(`init refuses a folder that already holds ${rel}`, () => {
    const r = repo({ [rel]: '# existing\n' });
    const before = snapshot(r.featureDir);
    const run = runDecision({ action: 'init', projectRoot: r.root, now: FIXED });
    assert.equal(run.exitCode, 1);
    assert.equal(run.result.finding, 'predates-register');
    assert.match(run.result.message, new RegExp(rel.replace('.', '\\.')));
    assert.deepEqual(snapshot(r.featureDir), before);
  });
}

test('every verb leaves a folder that predates the register untouched', () => {
  const r = repo({ 'intention/requirement.md': '# r\n', 'plan.md': '# p\n\n## 9. History\n\n| a |\n' });
  const before = snapshot(r.featureDir);
  const outcomes: any = [
    runDecision({ action: 'init', projectRoot: r.root }),
    runDecision({ action: 'list', projectRoot: r.root }),
    runDecision({ action: 'compact', projectRoot: r.root }),
    add(r, [item()]),
  ];
  assert.deepEqual(outcomes.map((o: any) => [o.exitCode, o.result.finding]), [
    [1, 'predates-register'], [1, 'no-register'], [1, 'no-register'], [1, 'no-register'],
  ]);
  assert.deepEqual(snapshot(r.featureDir), before);
});

// ── add: channels, ids, ownership (FR-003, FR-004) ─────────────────────────────────────────────

test('channels map to who decided; the caller never sets decidedBy', () => {
  const r = initialised();
  const channels: any = ['question', 'gate', 'prompt', 'default', 'resolution'];
  const run = add(r, channels.map((c: any) => item({ topic: `t-${c}`, channel: c })));
  assert.equal(run.exitCode, 0);
  const byTopic = Object.fromEntries(readRegister(r.featureDir).decisions.map((d: any) => [d.channel, d.decidedBy]));
  assert.deepEqual(byTopic, { question: 'user', gate: 'user', prompt: 'user', default: 'agent', resolution: 'agent' });

  const before = snapshot(r.featureDir);
  const forged = add(r, [item({ topic: 'other', decidedBy: 'user' })]);
  assert.equal(forged.exitCode, 2);
  assert.match(forged.usage, /decidedBy/);
  assert.deepEqual(snapshot(r.featureDir), before);
});

test('ids are sequential from nextId, stamped by the runtime, and never reused after supersession', () => {
  const r = initialised();
  const first = add(r, [item({ topic: 'a' }), item({ topic: 'b' })]);
  assert.deepEqual(first.result.added, [{ id: 'DEC-001', topic: 'a' }, { id: 'DEC-002', topic: 'b' }]);
  const second = add(r, [item({ topic: 'a', supersedes: ['DEC-001'], statement: 'a, revised' })]);
  assert.deepEqual(second.result.added, [{ id: 'DEC-003', topic: 'a' }]);
  assert.deepEqual(second.result.superseded, [{ id: 'DEC-001', by: 'DEC-003' }]);
  const register = readRegister(r.featureDir);
  assert.equal(register.nextId, 4);
  const [d1, , d3] = register.decisions;
  assert.equal(d1.status, 'superseded');
  assert.equal(d1.supersededBy, 'DEC-003');
  assert.deepEqual(d3.supersedes, ['DEC-001']);
  assert.equal(d3.supersededBy, null);
  assert.equal(d3.date, '2026-10-03');
  assert.equal(d3.at, '2026-10-03T09:12:44.120Z');
});

test('ids past DEC-999 widen instead of wrapping', () => {
  const r = initialised();
  const reg = readRegister(r.featureDir);
  reg.nextId = 1000;
  fs.writeFileSync(registerFile(r.featureDir), JSON.stringify(reg));
  assert.equal(add(r, [item()]).result.added[0].id, 'DEC-1000');
});

test('the single form reads flags, splits comma lists, and records source and refs', () => {
  const r = initialised();
  const run = runDecision({
    action: 'add', projectRoot: r.root, now: FIXED,
    flags: { ...item({ topic: 'x' }), refs: 'FR-001, IC-002', source: 'design/design-02-question.md#question-1' },
  });
  assert.equal(run.exitCode, 0);
  const [d] = readRegister(r.featureDir).decisions;
  assert.deepEqual(d.refs, ['FR-001', 'IC-002']);
  assert.equal(d.source, 'design/design-02-question.md#question-1');
  assert.deepEqual(d.supersedes, []);
});

test('the single form names the missing flag', () => {
  const r = initialised();
  const run = runDecision({ action: 'add', projectRoot: r.root, flags: { topic: 'x', statement: 's', channel: 'question', stage: 'design' } });
  assert.equal(run.exitCode, 2);
  assert.match(run.usage, /--rationale/);
});

// ── add: validation, all-or-nothing (FR-005) ───────────────────────────────────────────────────

test('one invalid item refuses the whole batch and writes nothing', () => {
  const r = initialised();
  const before = snapshot(r.featureDir);
  const bad: any = [item({ topic: 'good' }), item({ topic: 'Bad Topic' })];
  const run = add(r, bad);
  assert.equal(run.exitCode, 2);
  assert.match(run.usage, /item 2/);
  assert.deepEqual(snapshot(r.featureDir), before);
});

for (const [name, patch, pattern] of [
  ['an uppercase topic', { topic: 'Wire' }, /topic/],
  ['a topic over 48 characters', { topic: 'a'.repeat(49) }, /topic/],
  ['a statement over 280 characters', { statement: 'x'.repeat(STATEMENT_MAX + 1) }, /280/],
  ['a multi-line statement', { statement: 'one\ntwo' }, /one line/],
  ['a statement with U+2028', { statement: 'one\u2028two' }, /one line/],
  ['a statement with U+2029', { statement: 'one\u2029two' }, /one line/],
  ['a statement with U+0085', { statement: 'one\u0085two' }, /one line/],
  ['a topic with U+2028', { topic: 'one\u2028two' }, /one line/],
  ['an unknown channel', { channel: 'chat' }, /channel/],
  ['an unknown stage', { stage: 'testing' }, /stage/],
  ['a missing rationale', { rationale: '' }, /rationale/],
  ['a malformed ref', { refs: ['not an id'] }, /refs/],
  ['a malformed supersedes id', { supersedes: ['DEC-1'] }, /supersedes/],
  ['an unknown key', { extra: 1 }, /extra/],
]) {
  test(`add refuses ${name}`, () => {
    const r = initialised();
    const before = snapshot(r.featureDir);
    const run = add(r, [item(patch)]);
    assert.equal(run.exitCode, 2);
    assert.match(run.usage, pattern);
    assert.deepEqual(snapshot(r.featureDir), before);
  });
}

test('a 280-character statement is accepted', () => {
  const r = initialised();
  assert.equal(add(r, [item({ statement: 'x'.repeat(STATEMENT_MAX) })]).exitCode, 0);
});

test('a topic may appear once per batch', () => {
  const r = initialised();
  const run = add(r, [item(), item({ statement: 'again' })]);
  assert.equal(run.exitCode, 2);
  assert.match(run.usage, /more than once/);
});

test('a batch that is not an array, not JSON, or unreadable is a usage error', () => {
  const r = initialised();
  const file = path.join(r.root, 'b.json');
  fs.writeFileSync(file, '{"topic":"x"}');
  assert.equal(runDecision({ action: 'add', projectRoot: r.root, flags: { batch: file } }).exitCode, 2);
  fs.writeFileSync(file, 'nope');
  assert.equal(runDecision({ action: 'add', projectRoot: r.root, flags: { batch: file } }).exitCode, 2);
  assert.equal(runDecision({ action: 'add', projectRoot: r.root, flags: { batch: path.join(r.root, 'missing.json') } }).exitCode, 2);
});

test('an empty batch is answered without taking the lock or rewriting the register', () => {
  const r = initialised();
  const before = snapshot(r.featureDir);
  const stat = fs.statSync(registerFile(r.featureDir));
  let touched = false;
  const spying: any = { ...fs };
  for (const fn of ['writeFileSync', 'renameSync', 'mkdirSync']) spying[fn] = (...a: any[]) => { touched = true; return fs[fn](...a); };
  const run = add(r, [], { fsImpl: spying });
  assert.equal(run.exitCode, 0);
  assert.deepEqual(run.result.added, []);
  assert.equal(touched, false);
  assert.deepEqual(snapshot(r.featureDir), before);
  const after = fs.statSync(registerFile(r.featureDir));
  assert.equal(after.mtimeMs, stat.mtimeMs);
  assert.equal(after.ino, stat.ino);
});

test('--batch - reads the batch from stdin, as the evidence verb does', () => {
  const r = initialised();
  const stdin = (text: any) => ({ ...fs, readFileSync: (p: any, enc: any) => (p === 0 ? text : fs.readFileSync(p, enc)) });
  const run = runDecision({ action: 'add', projectRoot: r.root, flags: { batch: '-' }, now: FIXED, fsImpl: stdin(JSON.stringify([item()])) });
  assert.equal(run.exitCode, 0);
  assert.deepEqual(run.result.added, [{ id: 'DEC-001', topic: 'wire-id' }]);
  const bad = runDecision({ action: 'add', projectRoot: r.root, flags: { batch: '-' }, fsImpl: stdin('not json') });
  assert.equal(bad.exitCode, 2);
  assert.match(bad.usage, /not valid JSON/);
});

// ── supersession (FR-006) ──────────────────────────────────────────────────────────────────────

test('a live decision on the topic that is not named exits 1 as topic-conflict and writes nothing', () => {
  const r = initialised();
  add(r, [item()]);
  const before = snapshot(r.featureDir);
  const run = add(r, [item({ statement: 'Replacement' })]);
  assert.equal(run.exitCode, 1);
  assert.equal(run.result.finding, 'topic-conflict');
  assert.match(run.result.message, /DEC-001/);
  assert.deepEqual(snapshot(r.featureDir), before);
});

test('a conflict anywhere in a batch writes none of the batch', () => {
  const r = initialised();
  add(r, [item()]);
  const before = snapshot(r.featureDir);
  const run = add(r, [item({ topic: 'fresh' }), item({ statement: 'Replacement' })]);
  assert.equal(run.exitCode, 1);
  assert.deepEqual(snapshot(r.featureDir), before);
});

test('supersedes must name live decisions that exist', () => {
  const r = initialised();
  add(r, [item()]);
  assert.equal(add(r, [item({ supersedes: ['DEC-009'] })]).exitCode, 2);
  add(r, [item({ supersedes: ['DEC-001'], statement: 'v2' })]);
  const stale = add(r, [item({ supersedes: ['DEC-001'], statement: 'v3' })]);
  assert.equal(stale.exitCode, 2);
  assert.match(stale.usage, /not live/);
});

test('a decision may supersede a live decision on another topic, leaving that topic without one', () => {
  const r = initialised();
  add(r, [item({ topic: 'old-topic' })]);
  const run = add(r, [item({ topic: 'new-topic', supersedes: ['DEC-001'] })]);
  assert.equal(run.exitCode, 0);
  const live = listDecisions({ featureDir: r.featureDir, slug: SLUG }).decisions;
  assert.deepEqual(live.map((d: any) => d.topic), ['new-topic']);
});

test('within a batch, an earlier item freeing a topic lets a later item take it', () => {
  const r = initialised();
  add(r, [item({ topic: 'old-topic' })]);
  const run = add(r, [item({ topic: 'a', supersedes: ['DEC-001'] }), item({ topic: 'old-topic', statement: 'taken over' })]);
  assert.equal(run.exitCode, 0);
  assert.deepEqual(run.result.added.map((a: any) => a.id), ['DEC-002', 'DEC-003']);
});

test('50 supersessions on one topic leave one live row in the live view', () => {
  const r = initialised();
  let prev = null;
  for (let i = 0; i < 50; i += 1) {
    const result: any = addDecisions({
      featureDir: r.featureDir, slug: SLUG, now: FIXED,
      items: [item({ statement: `version ${i}`, supersedes: prev ? [prev] : [] })],
    });
    prev = result.added[0].id;
  }
  const live = fs.readFileSync(path.join(r.featureDir, 'decisions.md'), 'utf8');
  assert.equal(live.split('\n').filter((l: any) => l.startsWith('| DEC-')).length, 1);
  assert.ok(live.includes('version 49'));
  const archive = fs.readFileSync(path.join(r.featureDir, 'decisions', 'archive.md'), 'utf8');
  assert.equal(archive.match(/^### DEC-/gm).length, 50);
  assert.ok(archive.includes('version 0'));
});

// ── views (FR-007) ─────────────────────────────────────────────────────────────────────────────

test('the live view lists live rows only, by topic; the archive lists every decision by id with rationale', () => {
  const r = initialised();
  add(r, [
    item({ topic: 'zeta', statement: 'Z one', stage: 'design' }),
    item({ topic: 'alpha', statement: 'A | pipe', channel: 'default', rationale: 'line one\nline two', refs: ['IC-004'], source: 'design/x.md#q1' }),
  ]);
  add(r, [item({ topic: 'zeta', statement: 'Z two', supersedes: ['DEC-001'] })]);
  const live = fs.readFileSync(path.join(r.featureDir, 'decisions.md'), 'utf8');
  assert.equal(live, [
    `# Decisions: ${SLUG}`,
    '',
    '> Generated from `decisions/register.json` by `doflow-run decision`. Do not edit this file. Superseded decisions and rationale are in `decisions/archive.md`.',
    '',
    '| ID | Topic | Decision | By | Stage | Date |',
    '|---|---|---|---|---|---|',
    '| DEC-002 | alpha | A \\| pipe | agent | design | 2026-10-03 |',
    '| DEC-003 | zeta | Z two | user | design | 2026-10-03 |',
    '',
  ].join('\n'));
  assert.ok(!live.includes('Z one'));
  assert.ok(!live.includes('Rationale'));

  const archive = fs.readFileSync(path.join(r.featureDir, 'decisions', 'archive.md'), 'utf8');
  assert.ok(archive.indexOf('### DEC-001: zeta') < archive.indexOf('### DEC-002: alpha'));
  assert.ok(archive.includes('### DEC-001: zeta\n\n- **Status:** Superseded → DEC-003\n- **Decision:** Z one\n- **By:** user (question) · **Stage:** design · **Date:** 2026-10-03\n- **Rationale:** Because.'));
  assert.ok(archive.includes('- **Status:** Live'));
  assert.ok(archive.includes('- **Supersedes:** DEC-001'));
  assert.ok(archive.includes('- **Refs:** IC-004'));
  assert.ok(archive.includes('- **Source:** design/x.md#q1'));
  assert.ok(archive.includes('- **Rationale:**\n  > line one\n  > line two'));
  // Empty Supersedes / Refs / Source lines are omitted.
  assert.equal((archive.match(/\*\*Supersedes:\*\*/g) || []).length, 1);
  assert.equal((archive.match(/\*\*Source:\*\*/g) || []).length, 1);
});

test('rendering is a pure function of the register', () => {
  const r = initialised();
  add(r, [item()]);
  const register = readRegister(r.featureDir);
  assert.equal(renderLiveView(register), renderLiveView(JSON.parse(JSON.stringify(register))));
  assert.equal(renderArchive(register), fs.readFileSync(path.join(r.featureDir, 'decisions', 'archive.md'), 'utf8'));
});

// ── list ───────────────────────────────────────────────────────────────────────────────────────

test('list returns live decisions by topic, --all returns every decision by id, status is a synonym', () => {
  const r = initialised();
  add(r, [item({ topic: 'zeta' }), item({ topic: 'alpha' })]);
  add(r, [item({ topic: 'zeta', supersedes: ['DEC-001'], statement: 'v2' })]);
  const live = runDecision({ action: 'list', projectRoot: r.root });
  assert.equal(live.exitCode, 0);
  assert.deepEqual(live.result.decisions.map((d: any) => d.id), ['DEC-002', 'DEC-003']);
  assert.deepEqual(runDecision({ action: 'status', projectRoot: r.root }).result, live.result);
  const all = runDecision({ action: 'list', projectRoot: r.root, flags: { all: true } });
  assert.deepEqual(all.result.decisions.map((d: any) => d.id), ['DEC-001', 'DEC-002', 'DEC-003']);
  assert.equal(all.result.slug, SLUG);
  assert.equal(all.result.featureDir, r.featureDir);
});

test('list --by keeps the decisions whose decider is named, in the result object', () => {
  const r = initialised();
  add(r, [item({ topic: 'a-user' }), item({ topic: 'b-agent', channel: 'default' })]);
  // `policy` is reserved to the in-process gate path, so the autopilot row goes through addDecisions.
  addDecisions({ featureDir: r.featureDir, slug: SLUG, now: FIXED, items: [item({ topic: 'c-gate', channel: 'policy' })] });
  const by = (value: any) => runDecision({ action: 'list', projectRoot: r.root, flags: { by: value } });
  assert.deepEqual(by('agent').result.decisions.map((d: any) => d.topic), ['b-agent']);
  assert.deepEqual(by('autopilot').result.decisions.map((d: any) => d.topic), ['c-gate']);
  assert.deepEqual(by('user').result.decisions.map((d: any) => d.topic), ['a-user']);
  assert.deepEqual(by('agent,autopilot').result.decisions.map((d: any) => d.topic), ['b-agent', 'c-gate']);
  assert.equal(runDecision({ action: 'list', projectRoot: r.root }).result.decisions.length, 3);
});

test('list --by with an unknown value is a usage error naming the valid set', () => {
  const r = initialised();
  for (const value of ['robot', 'agent,robot', '']) {
    const run = runDecision({ action: 'list', projectRoot: r.root, flags: { by: value } });
    assert.equal(run.exitCode, 2, value);
    assert.match(run.usage, /valid values are user, agent, autopilot/);
  }
});

// ── undo ───────────────────────────────────────────────────────────────────────────────────────

test('a default adopted unattended needs an undo line; the refusal says what to add and writes nothing', () => {
  const r = initialised();
  const before = snapshot(r.featureDir);
  const unattended = item({ channel: 'default', rationale: 'unattended:recommended-option' });
  for (const over of [{}, { undo: '   ' }]) {
    const run = add(r, [{ ...unattended, ...over }]);
    assert.equal(run.exitCode, 2);
    assert.match(run.usage, /needs 'undo'/);
  }
  assert.deepEqual(snapshot(r.featureDir), before);
  // Only that exact combination is bound: a person's answer, or an agent default with another rationale, needs none.
  assert.equal(add(r, [item({ topic: 'one', channel: 'question', rationale: 'unattended:x' }), item({ topic: 'two', channel: 'default', rationale: 'simplest' })]).exitCode, 0);
});

test('the undo requirement holds for spelling, spacing, case, zero-width prefixes and the resolution channel', () => {
  const r = initialised();
  const before = snapshot(r.featureDir);
  const rationales = ['Unattended:x', 'UNATTENDED: x', 'unattended : x', '  unattended:x', '\u200bunattended:x', 'un\u200battended:x', '\ufeffUnattended :x'];
  for (const channel of ['default', 'resolution']) {
    for (const rationale of rationales) {
      const run = add(r, [item({ channel, rationale })]);
      assert.equal(run.exitCode, 2, `${channel} ${JSON.stringify(rationale)}`);
      assert.match(run.usage, /needs 'undo'/);
    }
  }
  assert.deepEqual(snapshot(r.featureDir), before);
  // An unrelated word that only contains the text, or a person's channel, still needs none.
  assert.equal(add(r, [item({ topic: 'one', channel: 'default', rationale: 'not unattended: x' }), item({ topic: 'two', channel: 'gate', rationale: 'Unattended:x' })]).exitCode, 0);
});

test('list text output shows the undo line under a decision that has one, and only then', () => {
  const r = initialised();
  add(r, [item({ topic: 'with', channel: 'default', rationale: 'unattended:x', undo: 'Supersede it.' }), item({ topic: 'without' })]);
  const lines = humanLines(runDecision({ action: 'list', projectRoot: r.root }).result);
  assert.equal(lines.filter((l: string) => /^ +undo: /.test(l)).length, 1);
  assert.equal(lines[lines.findIndex((l: string) => l.includes('  with  ')) + 1], '    undo: Supersede it.');
});

test('undo is stored in the register and shown in the archive beside the rationale', () => {
  const r = initialised();
  const run = add(r, [item({ channel: 'default', rationale: 'unattended:recommended-option', undo: 'Supersede DEC-001 with the old wire id.' })]);
  assert.equal(run.exitCode, 0);
  assert.equal(readRegister(r.featureDir).decisions[0].undo, 'Supersede DEC-001 with the old wire id.');
  assert.match(fs.readFileSync(path.join(r.featureDir, 'decisions', 'archive.md'), 'utf8'),
    /- \*\*Rationale:\*\* unattended:recommended-option\n- \*\*Undo:\*\* Supersede DEC-001 with the old wire id\./);
});

test('undo must be one line within the statement cap; a register without it still loads and lists', () => {
  const r = initialised();
  assert.equal(add(r, [item({ undo: 'two\nlines' })]).exitCode, 2);
  assert.equal(add(r, [item({ undo: 'x'.repeat(STATEMENT_MAX + 1) })]).exitCode, 2);
  assert.equal(add(r, [item()]).exitCode, 0);
  const stored = readRegister(r.featureDir).decisions[0];
  assert.equal('undo' in stored, false);
  assert.doesNotMatch(fs.readFileSync(path.join(r.featureDir, 'decisions', 'archive.md'), 'utf8'), /Undo/);
  assert.equal(runDecision({ action: 'list', projectRoot: r.root }).exitCode, 0);
});

test('list on an empty register answers with an empty array', () => {
  const r = initialised();
  const run = runDecision({ action: 'list', projectRoot: r.root });
  assert.equal(run.exitCode, 0);
  assert.deepEqual(run.result.decisions, []);
});

// ── compact (IC-005) ───────────────────────────────────────────────────────────────────────────

const PLAN = '# Plan\n\n## 9. History\n\n| Date | ID | Change |\n|---|---|---|\n| 2026-08-01 | T-1 | x |\n';

test('compact moves History into the archive, re-renders the views, and a second run is unchanged', () => {
  const r = repo();
  assert.equal(runDecision({ action: 'init', projectRoot: r.root, now: FIXED }).exitCode, 0);
  fs.writeFileSync(path.join(r.featureDir, 'plan.md'), PLAN);
  const first = runDecision({ action: 'compact', projectRoot: r.root, now: FIXED });
  assert.equal(first.exitCode, 0);
  assert.equal(first.result.status, 'compacted');
  assert.deepEqual(first.result.moved, [{ artifact: 'plan.md', path: 'plan.md', archive: 'decisions/history/plan.md', lines: 3 }]);
  assert.ok(fs.readFileSync(path.join(r.featureDir, 'plan.md'), 'utf8').includes('Earlier entries:'));
  const before = snapshot(r.featureDir);
  const second = runDecision({ action: 'compact', projectRoot: r.root, now: FIXED });
  assert.equal(second.exitCode, 0);
  assert.equal(second.result.status, 'unchanged');
  assert.deepEqual(second.result.moved, []);
  assert.deepEqual(snapshot(r.featureDir), before);
});

test('a compaction failure exits 1 as compaction-failed, names the artifact, and leaves it unchanged', () => {
  const r = repo();
  runDecision({ action: 'init', projectRoot: r.root, now: FIXED });
  fs.writeFileSync(path.join(r.featureDir, 'plan.md'), PLAN);
  const archive = path.join(r.featureDir, 'decisions', 'history', 'plan.md');
  const failing: any = { ...fs, renameSync: (from: any, to: any) => { if (to === archive) throw new Error('disk full'); return fs.renameSync(from, to); } };
  const run = runDecision({ action: 'compact', projectRoot: r.root, now: FIXED, fsImpl: failing });
  assert.equal(run.exitCode, 1);
  assert.equal(run.result.finding, 'compaction-failed');
  assert.equal(run.result.artifact, 'plan.md');
  assert.equal(fs.readFileSync(path.join(r.featureDir, 'plan.md'), 'utf8'), PLAN);
  assert.ok(!fs.existsSync(`${registerFile(r.featureDir)}.lock`));
});

// ── usage and resolution ───────────────────────────────────────────────────────────────────────

test('an unknown action and an unresolvable feature are usage errors', (t) => {
  const r = initialised();
  const unknown = runDecision({ action: 'purge', projectRoot: r.root });
  assert.equal(unknown.exitCode, 2);
  assert.match(unknown.usage, /init, add, list, compact/);
  const bare = tempDir(t, 'doflow-decision-register-bare-');
  git(bare, 'init', '-q');
  git(bare, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(bare, 'checkout', '-q', '-B', 'main');
  const none = runDecision({ action: 'list', projectRoot: bare });
  assert.equal(none.exitCode, 2);
  assert.ok(none.usage);
});

test('--slug selects the feature regardless of the branch', () => {
  const r = repo();
  fs.mkdirSync(path.join(r.root, 'agent-docs', 'doflow', '002-other'), { recursive: true });
  const run = runDecision({ action: 'init', projectRoot: r.root, slug: '002-other', now: FIXED });
  assert.equal(run.exitCode, 0);
  assert.equal(run.result.slug, '002-other');
  assert.ok(fs.existsSync(path.join(r.root, 'agent-docs', 'doflow', '002-other', 'decisions', 'register.json')));
});

test('a corrupt register is a usage error naming the file, never silently replaced', () => {
  const r = initialised();
  fs.writeFileSync(registerFile(r.featureDir), '{ torn');
  const run = runDecision({ action: 'list', projectRoot: r.root });
  assert.equal(run.exitCode, 2);
  assert.match(run.usage, /register\.json/);
  assert.equal(fs.readFileSync(registerFile(r.featureDir), 'utf8'), '{ torn');
});

test('no lock directory is left behind after a refused write', () => {
  const r = initialised();
  add(r, [item()]);
  add(r, [item({ statement: 'conflict' })]);
  add(r, [item({ topic: 'BAD' })]);
  assert.ok(!fs.existsSync(`${registerFile(r.featureDir)}.lock`));
});

// ── handler output ─────────────────────────────────────────────────────────────────────────────

function captured(fn: any): any {
  const logs: any = [];
  const errs: any = [];
  const log = console.log;
  const err = console.error;
  const code = process.exitCode;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => errs.push(a.join(' '));
  try {
    const returned = fn();
    return { returned, logs, errs, exitCode: process.exitCode };
  } finally {
    console.log = log;
    console.error = err;
    process.exitCode = code;
  }
}

test('--json prints the result object unmodified and sets the exit code', () => {
  const r = initialised();
  const out = captured(() => handleDecisionCommand({ action: 'list', projectRoot: r.root, json: true }));
  assert.equal(out.returned, 0);
  assert.deepEqual(JSON.parse(out.logs.join('\n')), { action: 'list', slug: SLUG, featureDir: r.featureDir, decisions: [] });

  const conflict = path.join(r.root, 'c.json');
  fs.writeFileSync(conflict, JSON.stringify([item()]));
  captured(() => handleDecisionCommand({ action: 'add', projectRoot: r.root, flags: { batch: conflict }, json: true }));
  const second = captured(() => handleDecisionCommand({ action: 'add', projectRoot: r.root, flags: { batch: conflict }, json: true }));
  assert.equal(second.returned, 1);
  const body = JSON.parse(second.logs.join('\n'));
  assert.equal(body.finding, 'topic-conflict');
  assert.equal(body.action, 'add');
});

test('a usage error prints the shared usage shape and exits 2', () => {
  const r = initialised();
  const out = captured(() => handleDecisionCommand({ action: 'nope', projectRoot: r.root, json: true }));
  assert.equal(out.returned, 2);
  const body = JSON.parse(out.logs.join('\n'));
  assert.equal(body.ok, false);
  assert.equal(body.status, 'USAGE');
  assert.equal(body.exitCode, 2);
});

test('without --json each changed item prints one human line', () => {
  const r = initialised();
  const batch = path.join(r.root, 'h.json');
  fs.writeFileSync(batch, JSON.stringify([item({ topic: 'a' }), item({ topic: 'b' })]));
  const out = captured(() => handleDecisionCommand({ action: 'add', projectRoot: r.root, flags: { batch } }));
  assert.deepEqual(out.logs, ['added DEC-001 (a)', 'added DEC-002 (b)']);
});

test('initRegister is safe to call twice from the library', () => {
  const r = repo();
  const slug = SLUG;
  assert.equal(initRegister({ featureDir: r.featureDir, slug }).created, true);
  assert.equal(initRegister({ featureDir: r.featureDir, slug }).created, false);
});

// ── hostile text in views ──────────────────────────────────────────────────────────────────────

test('a "<" in a statement cannot open an HTML comment that hides later rows', () => {
  const r = initialised();
  add(r, [item({ topic: 'a', statement: 'x <!-- hide' }), item({ topic: 'b', statement: 'later row' })]);
  const live = fs.readFileSync(path.join(r.featureDir, 'decisions.md'), 'utf8');
  assert.doesNotMatch(live, /(?<!\\)<!--/);
  assert.ok(live.includes('x \\<!-- hide'));
  assert.ok(live.includes('| later row |'));
  const archive = fs.readFileSync(path.join(r.featureDir, 'decisions', 'archive.md'), 'utf8');
  assert.doesNotMatch(archive, /(?<!\\)<!--/);
});

test('a multi-line rationale cannot add headings or fake entry bullets to the archive', () => {
  const r = initialised();
  add(r, [item({ rationale: 'first\n### DEC-999: forged\n- **Status:** Live\n\nlast' })]);
  const archive = fs.readFileSync(path.join(r.featureDir, 'decisions', 'archive.md'), 'utf8');
  assert.equal(archive.match(/^### /gm).length, 1);
  assert.equal(archive.match(/^- \*\*Status:\*\*/gm).length, 1);
  assert.ok(archive.includes('- **Rationale:**\n  > first\n  > ### DEC-999: forged\n  > - **Status:** Live\n  >\n  > last\n'));
});

// ── lock timeout ───────────────────────────────────────────────────────────────────────────────

test('a register lock that never frees exits 1 as register-locked, not as a usage error', { timeout: 30000 }, () => {
  const r = initialised();
  const before = snapshot(r.featureDir);
  // A lock held by someone else: the lock directory exists and stays fresh.
  fs.mkdirSync(`${registerFile(r.featureDir)}.lock`);
  try {
    const run = add(r, [item()]);
    assert.equal(run.exitCode, 1);
    assert.equal(run.result.finding, 'register-locked');
    assert.equal(run.result.action, 'add');
    assert.equal(run.result.slug, SLUG);
    assert.match(run.result.message, /Could not lock/);
    assert.equal(run.usage, undefined);
  } finally {
    const lockDir = `${registerFile(r.featureDir)}.lock`;
    assert.ok(fs.existsSync(lockDir), 'the other writer\'s lock must survive the refused writer');
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
  assert.deepEqual(snapshot(r.featureDir), before);
});

// ── live-view cells keep a statement as one row showing the text as written (IC-007, FR-004) ──────

/** Splits a table row the strict way (a pipe is escaped only after an odd run of backslashes) and
 * decodes each cell, as a renderer would. */
function renderedCells(row: any) {
  const cells: any = [];
  let current = '';
  const body = row.slice(1, -1);
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '\\' && i + 1 < body.length) { current += body[i + 1]; i += 1; continue; }
    if (body[i] === '|') { cells.push(current.trim()); current = ''; continue; }
    current += body[i];
  }
  cells.push(current.trim());
  return cells;
}

test('a statement with backslashes and pipes renders as one row that shows the statement as written', () => {
  const r = initialised();
  const statements: any = ['a\\|b', 'C:\\temp\\', 'x \\\\| y', 'end with slash \\', 'plain | pipe <!-- not a comment'];
  add(r, statements.map((statement: any, n: any) => item({ topic: `t${n}`, statement })));
  const live = fs.readFileSync(path.join(r.featureDir, 'decisions.md'), 'utf8');
  const rows = live.split('\n').filter((l: any) => l.startsWith('| DEC-'));
  assert.equal(rows.length, statements.length, 'one row per statement');
  rows.forEach((row: any, n: any) => {
    const cells = renderedCells(row);
    assert.equal(cells.length, 6, `row ${n} keeps six cells: ${row}`);
    assert.equal(cells[2], statements[n]);
  });
});

// ── a compaction that refuses one artifact still reports what the others did (IC-005) ───────────

test('compact reports compaction-failed with failed[] and still carries moved and re-renders views', () => {
  const r = repo();
  assert.equal(runDecision({ action: 'init', projectRoot: r.root, now: FIXED }).exitCode, 0);
  fs.writeFileSync(path.join(r.featureDir, 'plan.md'), PLAN);
  const design = '# Design\n\n## 9. History\n\n- entry\n\n<!-- never closed\n';
  fs.mkdirSync(path.join(r.featureDir, 'design'), { recursive: true });
  fs.writeFileSync(path.join(r.featureDir, 'design/design.md'), design);
  const run = runDecision({ action: 'compact', projectRoot: r.root, now: FIXED });
  assert.equal(run.exitCode, 1);
  assert.equal(run.result.finding, 'compaction-failed');
  assert.equal(run.result.status, 'partial');
  assert.deepEqual(run.result.moved.map((m: any) => m.artifact), ['plan.md']);
  assert.deepEqual(run.result.failed.map((f: any) => f.artifact), ['design.md']);
  assert.equal(fs.readFileSync(path.join(r.featureDir, 'design/design.md'), 'utf8'), design);
  assert.ok(fs.readFileSync(path.join(r.featureDir, 'plan.md'), 'utf8').includes('Earlier entries:'));
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
// Decision register lifecycle (IC-001 to IC-013). Written from design/specs.md alone.
// ══════════════════════════════════════════════════════════════════════════════════════════════

const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'decision-register', 'golden-views.json'), 'utf8'));

/** n live decisions on topics t1..tn: DEC-001 is t1, and so on. */
function seed(r: any, n: any = 4) {
  const run = add(r, Array.from({ length: n }, (_: any, i: any) => item({ topic: `t${i + 1}`, statement: `Statement ${i + 1}` })));
  assert.equal(run.exitCode, 0);
  return r;
}
const seeded = (n: any = 4) => seed(initialised(), n);
const link = (r: any, from: any, to: any, kind: any, extra: any = {}) => runDecision({ action: 'link', projectRoot: r.root, flags: { from, to, kind }, now: FIXED, ...extra });
const retire = (r: any, ids: any, reason: any = 'Out of scope', extra: any = {}) => runDecision({ action: 'retire', projectRoot: r.root, flags: { ids, reason }, now: FIXED, ...extra });
const dec = (r: any, id: any) => readRegister(r.featureDir).decisions.find((d: any) => d.id === id);
const tick = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);

/** A usage error naming `fragment`; nothing under the feature folder changed. */
function assertUsage(r: any, run: any, fragment: any, before: any = snapshot(r.featureDir)) {
  assert.equal(run.exitCode, 2, JSON.stringify(run));
  assert.equal(run.result, undefined);
  assert.ok(String(run.usage).includes(fragment), `usage "${run.usage}" should include "${fragment}"`);
  assert.deepEqual(snapshot(r.featureDir), before);
}
function assertFinding(r: any, run: any, finding: any, before: any = snapshot(r.featureDir)) {
  assert.equal(run.exitCode, 1, JSON.stringify(run));
  assert.equal(run.result.finding, finding);
  assert.deepEqual(snapshot(r.featureDir), before);
}

// ── library surface (IC-005) ───────────────────────────────────────────────────────────────────

test('IC-005: the new constants and state helpers exist with the contracted values', () => {
  assert.deepEqual([...LINK_KINDS], ['supersedes', 'narrows', 'reopens']);
  assert.deepEqual([...DECISION_STATES], ['live', 'superseded', 'retired']);
  assert.deepEqual([...COMPACT_MODES], ['history', 'closed-points']);
  const retired = { date: '2026-10-03', at: '2026-10-03T00:00:00.000Z', reason: 'r' };
  assert.equal(decisionState({ status: 'live' } as any), 'live');
  assert.equal(decisionState({ status: 'live', retired } as any), 'retired');
  assert.equal(decisionState({ status: 'superseded' } as any), 'superseded');
  assert.equal(decisionState({ status: 'superseded', retired } as any), 'superseded');
  assert.equal(inLiveView({ status: 'live' } as any), true);
  assert.equal(inLiveView({ status: 'live', retired } as any), false);
  assert.equal(inLiveView({ status: 'superseded' } as any), false);
});

test('IC-005: the unknown-action message lists link and retire', () => {
  const r = initialised();
  const run = runDecision({ action: 'purge', projectRoot: r.root });
  assert.equal(run.exitCode, 2);
  assert.match(run.usage, /init, add, list, compact, link, retire/);
});

// ── link: each kind's effect (IC-001) ──────────────────────────────────────────────────────────

test('IC-001: link supersedes records the link on the source, supersedes the target, allocates no id, and renders both views', () => {
  const r = seeded();
  const before = readRegister(r.featureDir);
  const run = link(r, 'DEC-002', 'DEC-001', 'supersedes');
  assert.equal(run.exitCode, 0);
  assert.deepEqual(run.result, {
    action: 'link', slug: SLUG, featureDir: r.featureDir, from: 'DEC-002', to: 'DEC-001', kind: 'supersedes',
    changed: true, superseded: [{ id: 'DEC-001', by: 'DEC-002' }], replaced: null,
  });
  const after = readRegister(r.featureDir);
  assert.equal(after.nextId, before.nextId);
  assert.equal(after.decisions.length, before.decisions.length);
  assert.deepEqual(dec(r, 'DEC-002').supersedes, ['DEC-001']);
  assert.equal(dec(r, 'DEC-002').narrows, undefined);
  assert.equal(dec(r, 'DEC-001').status, 'superseded');
  assert.equal(dec(r, 'DEC-001').supersededBy, 'DEC-002');
  // Nothing else changed on either decision.
  for (const id of ['DEC-001', 'DEC-002']) {
    const a = dec(r, id);
    const b = before.decisions.find((d: any) => d.id === id);
    for (const key of ['topic', 'statement', 'date', 'at', 'decidedBy', 'stage', 'rationale']) assert.equal(a[key], b[key], `${id}.${key}`);
  }
  const live = fs.readFileSync(path.join(r.featureDir, 'decisions.md'), 'utf8');
  assert.ok(!live.includes('| DEC-001 |'));
  assert.ok(live.includes('| DEC-002 |'));
  const archive = fs.readFileSync(path.join(r.featureDir, 'decisions', 'archive.md'), 'utf8');
  assert.ok(archive.includes('- **Status:** Superseded → DEC-002\n'));
  assert.ok(archive.includes('- **Supersedes:** DEC-001'));
  assert.equal(renderLiveView(after), live);
  assert.equal(renderArchive(after), archive);
});

test('IC-001: link reopens records reopens (not supersedes), supersedes the target, and the archive says reopened', () => {
  const r = seeded();
  const run = link(r, 'DEC-002', 'DEC-001', 'reopens');
  assert.equal(run.exitCode, 0);
  assert.deepEqual(run.result.superseded, [{ id: 'DEC-001', by: 'DEC-002' }]);
  assert.equal(run.result.replaced, null);
  assert.deepEqual(dec(r, 'DEC-002').reopens, ['DEC-001']);
  assert.deepEqual(dec(r, 'DEC-002').supersedes, []);
  assert.equal(dec(r, 'DEC-001').status, 'superseded');
  assert.equal(dec(r, 'DEC-001').supersededBy, 'DEC-002');
  const archive = fs.readFileSync(path.join(r.featureDir, 'decisions', 'archive.md'), 'utf8');
  assert.ok(archive.includes('- **Status:** Superseded → DEC-002 (reopened)\n'));
  assert.ok(archive.includes('- **Reopens:** DEC-001'));
});

test('IC-001: link narrows keeps both decisions live, records narrows, and the live view shows the narrowed block', () => {
  const r = seeded();
  const run = link(r, 'DEC-002', 'DEC-001', 'narrows');
  assert.equal(run.exitCode, 0);
  assert.deepEqual(run.result, {
    action: 'link', slug: SLUG, featureDir: r.featureDir, from: 'DEC-002', to: 'DEC-001', kind: 'narrows',
    changed: true, superseded: [], replaced: null,
  });
  assert.deepEqual(dec(r, 'DEC-002').narrows, ['DEC-001']);
  assert.equal(dec(r, 'DEC-001').status, 'live');
  assert.equal(dec(r, 'DEC-001').supersededBy, null);
  const live = fs.readFileSync(path.join(r.featureDir, 'decisions.md'), 'utf8');
  assert.ok(live.includes('| DEC-001 |') && live.includes('| DEC-002 |'));
  assert.ok(live.includes('\n\nNarrowed in part:\n\n- DEC-001 is narrowed by DEC-002.\n'));
  const archive = fs.readFileSync(path.join(r.featureDir, 'decisions', 'archive.md'), 'utf8');
  assert.ok(archive.includes('- **Narrows:** DEC-001'));
  assert.ok(archive.includes('- **Narrowed by:** DEC-002'));
});

test('IC-001: the text output names the link, then each superseded decision; a repeat says nothing was written', () => {
  const r = seeded();
  assert.deepEqual(humanLines(link(r, 'DEC-002', 'DEC-001', 'supersedes').result), ['linked DEC-002 supersedes DEC-001', 'superseded DEC-001 by DEC-002']);
  assert.deepEqual(humanLines(link(r, 'DEC-003', 'DEC-004', 'narrows').result), ['linked DEC-003 narrows DEC-004']);
  assert.deepEqual(humanLines(link(r, 'DEC-003', 'DEC-004', 'narrows').result), ['DEC-003 already narrows DEC-004; nothing written']);
  const cycle = link(r, 'DEC-004', 'DEC-003', 'supersedes');
  assert.equal(humanLines(cycle.result)[0], `link-cycle: ${cycle.result.message}`);
});

test('IC-001: the ids are trimmed before they are checked and used', () => {
  const r = seeded();
  const run = link(r, ' DEC-002 ', '\tDEC-001', 'supersedes');
  assert.equal(run.exitCode, 0);
  assert.equal(run.result.from, 'DEC-002');
  assert.equal(run.result.to, 'DEC-001');
  assert.deepEqual(dec(r, 'DEC-002').supersedes, ['DEC-001']);
});

test('IC-001: a link across topics is fine and leaves topics alone; a source that is itself superseded is refused for every kind', () => {
  const r = seeded();
  assert.equal(link(r, 'DEC-002', 'DEC-001', 'supersedes').exitCode, 0);
  assert.equal(dec(r, 'DEC-001').topic, 't1');
  assert.equal(dec(r, 'DEC-002').topic, 't2');
  // DEC-001 is now superseded: it may no longer be recorded as replacing, reopening or narrowing anything.
  const before = snapshot(r.featureDir);
  for (const kind of ['supersedes', 'reopens']) {
    assertUsage(r, link(r, 'DEC-001', 'DEC-003', kind), '--from DEC-001 is not live (it was superseded by DEC-002)', before);
  }
  assertUsage(r, link(r, 'DEC-001', 'DEC-003', 'narrows'), '--from DEC-001 is not live (it was superseded by DEC-002)', before);
  assert.deepEqual(dec(r, 'DEC-001').supersedes, []);
  assert.equal(dec(r, 'DEC-003').status, 'live');
});

test('IC-001: a retired --from is refused for supersedes and reopens, naming the retirement', () => {
  const r = seeded();
  assert.equal(retire(r, 'DEC-001').exitCode, 0);
  const before = snapshot(r.featureDir);
  for (const kind of ['supersedes', 'reopens']) {
    assertUsage(r, link(r, 'DEC-001', 'DEC-003', kind), '--from DEC-001 is retired', before);
  }
  assert.equal(dec(r, 'DEC-003').status, 'live');
});

test('IC-001: a repeat of a recorded link, of every kind, is changed: false and writes no file', () => {
  const r = seeded();
  for (const [kind, to] of [['supersedes', 'DEC-001'], ['narrows', 'DEC-003'], ['reopens', 'DEC-004']] as any) {
    assert.equal(link(r, 'DEC-002', to, kind).exitCode, 0);
  }
  const before = snapshot(r.featureDir);
  const times = ['register.json', 'archive.md'].map((n: any) => fs.statSync(path.join(r.featureDir, 'decisions', n)).mtimeMs);
  tick();
  for (const [kind, to] of [['supersedes', 'DEC-001'], ['narrows', 'DEC-003'], ['reopens', 'DEC-004']] as any) {
    const run = link(r, 'DEC-002', to, kind);
    assert.equal(run.exitCode, 0);
    assert.equal(run.result.changed, false);
    assert.deepEqual(run.result.superseded, []);
    assert.equal(run.result.replaced, null);
    assert.equal(run.result.kind, kind);
  }
  assert.deepEqual(snapshot(r.featureDir), before);
  assert.deepEqual(['register.json', 'archive.md'].map((n: any) => fs.statSync(path.join(r.featureDir, 'decisions', n)).mtimeMs), times);
});

test('IC-001: a supersedes link made by add counts as recorded, so the same link is a no-op', () => {
  const r = seeded(2);
  assert.equal(add(r, [item({ topic: 't3', supersedes: ['DEC-001'] })]).exitCode, 0);
  const before = snapshot(r.featureDir);
  const run = link(r, 'DEC-003', 'DEC-001', 'supersedes');
  assert.equal(run.exitCode, 0);
  assert.equal(run.result.changed, false);
  assert.deepEqual(snapshot(r.featureDir), before);
});

for (const kind of ['supersedes', 'reopens']) {
  test(`IC-001: link ${kind} replaces a narrows link on the same pair and reports replaced: 'narrows'`, () => {
    const r = seeded();
    assert.equal(link(r, 'DEC-002', 'DEC-001', 'narrows').exitCode, 0);
    const run = link(r, 'DEC-002', 'DEC-001', kind);
    assert.equal(run.exitCode, 0);
    assert.equal(run.result.changed, true);
    assert.equal(run.result.replaced, 'narrows');
    assert.deepEqual(run.result.superseded, [{ id: 'DEC-001', by: 'DEC-002' }]);
    const d = dec(r, 'DEC-002');
    assert.ok(!('narrows' in d), 'the emptied narrows key is dropped');
    assert.deepEqual(d[kind], ['DEC-001']);
    assert.equal(dec(r, 'DEC-001').status, 'superseded');
    const live = fs.readFileSync(path.join(r.featureDir, 'decisions.md'), 'utf8');
    assert.ok(!live.includes('Narrowed in part'));
  });
}

test('IC-001: replacing a narrows link keeps the other narrows entries', () => {
  const r = seeded();
  assert.equal(link(r, 'DEC-002', 'DEC-001', 'narrows').exitCode, 0);
  assert.equal(link(r, 'DEC-002', 'DEC-003', 'narrows').exitCode, 0);
  assert.deepEqual(dec(r, 'DEC-002').narrows, ['DEC-001', 'DEC-003']);
  assert.equal(link(r, 'DEC-002', 'DEC-001', 'supersedes').result.replaced, 'narrows');
  assert.deepEqual(dec(r, 'DEC-002').narrows, ['DEC-003']);
});

test('IC-001: a link that replaces nothing reports replaced: null', () => {
  const r = seeded();
  assert.equal(link(r, 'DEC-002', 'DEC-001', 'narrows').result.replaced, null);
  assert.equal(link(r, 'DEC-003', 'DEC-004', 'supersedes').result.replaced, null);
});

// ── link: checks, in order, each writing nothing (IC-001 rows 1 to 13) ──────────────────────────

test('IC-001 row 1: --from, --to and --kind are required, named in that order', () => {
  const r = seeded();
  const call = (flags: any) => runDecision({ action: 'link', projectRoot: r.root, flags, now: FIXED });
  assertUsage(r, call({}), '--from is required for --action link');
  assertUsage(r, call({ kind: 'supersedes' }), '--from is required for --action link');
  assertUsage(r, call({ from: 'DEC-001' }), '--to is required for --action link');
  assertUsage(r, call({ from: 'DEC-001', to: 'DEC-002' }), '--kind is required for --action link');
  // A missing flag is named before a malformed id.
  assertUsage(r, call({ from: 'nope', to: 'DEC-002' }), '--kind is required for --action link');
});

test('IC-001 row 2: --from and --to must be DEC-### ids', () => {
  const r = seeded();
  assertUsage(r, link(r, 'dec-001', 'DEC-002', 'supersedes'), "--from 'dec-001' is not a DEC-### id");
  assertUsage(r, link(r, 'DEC-001', 'DEC-1', 'supersedes'), "--to 'DEC-1' is not a DEC-### id");
  assertUsage(r, link(r, 'DEC-001', 'DEC-002x', 'supersedes'), "--to 'DEC-002x' is not a DEC-### id");
  // An id is checked before the kind.
  assertUsage(r, link(r, 'x', 'DEC-002', 'bogus'), "--from 'x' is not a DEC-### id");
});

test('IC-001 row 3: --kind must be supersedes, narrows or reopens', () => {
  const r = seeded();
  assertUsage(r, link(r, 'DEC-002', 'DEC-001', 'replaces'), "--kind 'replaces' must be one of supersedes, narrows, reopens");
  assertUsage(r, link(r, 'DEC-002', 'DEC-001', 'Supersedes'), "--kind 'Supersedes' must be one of supersedes, narrows, reopens");
  // The kind is checked before the same-id rule.
  assertUsage(r, link(r, 'DEC-001', 'DEC-001', 'bogus'), "--kind 'bogus' must be one of");
});

test('IC-001 row 4: a decision cannot be linked to itself', () => {
  const r = seeded();
  assertUsage(r, link(r, 'DEC-001', 'DEC-001', 'narrows'), '--from and --to name the same decision DEC-001');
});

test('IC-001 row 5: an unresolvable feature is a usage error', () => {
  const bare = suiteTempDir('doflow-decision-register-bare-');
  git(bare, 'init', '-q');
  git(bare, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(bare, 'checkout', '-q', '-B', 'main');
  const run = runDecision({ action: 'link', projectRoot: bare, flags: { from: 'DEC-001', to: 'DEC-002', kind: 'supersedes' } });
  assert.equal(run.exitCode, 2);
  assert.ok(run.usage);
  assert.doesNotMatch(run.usage, /unknown --action/, 'link is a known action');
});

test('IC-001 row 6: no register is the no-register finding with the init hint', () => {
  const r = repo({ 'plan.md': '# p\n' });
  const before = snapshot(r.featureDir);
  const run = link(r, 'DEC-002', 'DEC-001', 'supersedes');
  assertFinding(r, run, 'no-register', before);
  assert.equal(run.result.message, `${r.featureDir} has no decisions/register.json; run \`decision --action init\` when the feature is created`);
  assert.equal(run.result.action, 'link');
});

test('IC-001 row 8: an id that is not in the register is named, the source first', () => {
  const r = seeded(2);
  assertUsage(r, link(r, 'DEC-009', 'DEC-001', 'supersedes'), 'DEC-009 is not a decision in this register');
  assertUsage(r, link(r, 'DEC-001', 'DEC-009', 'supersedes'), 'DEC-009 is not a decision in this register');
  assertUsage(r, link(r, 'DEC-008', 'DEC-009', 'supersedes'), 'DEC-008 is not a decision in this register');
});

test('IC-001 row 10: a target that is already superseded is refused, naming who superseded it, for every kind', () => {
  const r = seeded();
  assert.equal(link(r, 'DEC-002', 'DEC-001', 'supersedes').exitCode, 0);
  for (const kind of ['supersedes', 'narrows', 'reopens']) {
    assertUsage(r, link(r, 'DEC-003', 'DEC-001', kind), 'DEC-001 is not live (it was superseded by DEC-002)');
  }
});

test('IC-001 row 11: narrows needs a live source, refused as for every kind', () => {
  const r = seeded();
  assert.equal(link(r, 'DEC-002', 'DEC-001', 'supersedes').exitCode, 0);
  assertUsage(r, link(r, 'DEC-001', 'DEC-003', 'narrows'), '--from DEC-001 is not live (it was superseded by DEC-002)');
});

test('IC-001 row 12: narrows needs a retired-free target; a retired source is refused first as --from', () => {
  const r = seeded();
  assert.equal(retire(r, 'DEC-001').exitCode, 0);
  assertUsage(r, link(r, 'DEC-002', 'DEC-001', 'narrows'), '--kind narrows needs both decisions in the live view; DEC-001 is retired');
  assertUsage(r, link(r, 'DEC-001', 'DEC-002', 'narrows'), '--from DEC-001 is retired (in force, out of the live view)');
  assert.equal(retire(r, 'DEC-002').exitCode, 0);
  assertUsage(r, link(r, 'DEC-002', 'DEC-001', 'narrows'), '--from DEC-002 is retired (in force, out of the live view)');
});

test('IC-001: a retired decision can still be the target of supersedes and reopens, and stays retired', () => {
  const r = seeded();
  assert.equal(retire(r, 'DEC-001').exitCode, 0);
  assert.equal(link(r, 'DEC-002', 'DEC-001', 'supersedes').exitCode, 0);
  assert.equal(dec(r, 'DEC-001').status, 'superseded');
  assert.ok(dec(r, 'DEC-001').retired);
  assert.equal(decisionState(dec(r, 'DEC-001')), 'superseded');
  assert.equal(link(r, 'DEC-003', 'DEC-004', 'reopens').exitCode, 0);
});

// ── cycles (IC-012, IC-001 row 13) ─────────────────────────────────────────────────────────────

test('IC-012: a direct reverse link is link-cycle with the path in order, and nothing is written', () => {
  const r = seeded(2);
  // Both decisions stay live: DEC-002 narrows DEC-001, so a cycle can only close through a live source.
  assert.equal(link(r, 'DEC-002', 'DEC-001', 'narrows').exitCode, 0);
  const before = snapshot(r.featureDir);
  const run = link(r, 'DEC-001', 'DEC-002', 'supersedes');
  assertFinding(r, run, 'link-cycle', before);
  assert.deepEqual(run.result.cycle, ['DEC-002', 'DEC-001']);
  assert.ok(run.result.message.startsWith('linking DEC-001 to DEC-002 would close a cycle: '), run.result.message);
  assert.ok(run.result.message.endsWith(' already exists. Nothing was written'), run.result.message);
  assert.ok(run.result.message.includes('DEC-002') && run.result.message.includes('DEC-001'));
  assert.equal(run.result.action, 'link');
  assert.equal(run.result.slug, SLUG);
});

test('IC-012: a two-step reverse link, through an intermediate decision, is link-cycle with the whole path', () => {
  const r = seeded(3);
  assert.equal(link(r, 'DEC-002', 'DEC-001', 'narrows').exitCode, 0);
  assert.equal(link(r, 'DEC-003', 'DEC-002', 'narrows').exitCode, 0);
  const before = snapshot(r.featureDir);
  const run = link(r, 'DEC-001', 'DEC-003', 'supersedes');
  assertFinding(r, run, 'link-cycle', before);
  assert.deepEqual(run.result.cycle, ['DEC-003', 'DEC-002', 'DEC-001']);
  assert.ok(run.result.message.startsWith('linking DEC-001 to DEC-003 would close a cycle: '), run.result.message);
  assert.ok(run.result.message.endsWith(' already exists. Nothing was written'));
  for (const id of run.result.cycle) assert.ok(run.result.message.includes(id), `message names ${id}`);
  assert.equal(readRegister(r.featureDir).nextId, 4);
});

test('IC-012: edges made by add (supersedes) count, and reopens and narrows edges count too', () => {
  const r = seeded(3);
  assert.equal(link(r, 'DEC-001', 'DEC-003', 'narrows').exitCode, 0);
  assert.equal(add(r, [item({ topic: 't4', supersedes: ['DEC-001'] })]).exitCode, 0);
  // DEC-004 -> DEC-001 (made by add) -> DEC-003 exists; linking DEC-003 -> DEC-004 would close it.
  const run = link(r, 'DEC-003', 'DEC-004', 'reopens');
  assertFinding(r, run, 'link-cycle');
  assert.deepEqual(run.result.cycle, ['DEC-004', 'DEC-001', 'DEC-003']);
  const r2 = seeded(3);
  assert.equal(link(r2, 'DEC-002', 'DEC-003', 'narrows').exitCode, 0);
  assert.equal(link(r2, 'DEC-001', 'DEC-002', 'reopens').exitCode, 0);
  assert.deepEqual(link(r2, 'DEC-003', 'DEC-001', 'supersedes').result.cycle, ['DEC-001', 'DEC-002', 'DEC-003']);
});

test('IC-012: a superseded --from whose link would also close a cycle is refused as not live (exit 2), not link-cycle', () => {
  const r = seeded(2);
  assert.equal(link(r, 'DEC-002', 'DEC-001', 'supersedes').exitCode, 0);
  for (const kind of ['supersedes', 'narrows', 'reopens']) {
    assertUsage(r, link(r, 'DEC-001', 'DEC-002', kind), '--from DEC-001 is not live (it was superseded by DEC-002)');
  }
});

test('IC-012: a link that only shares a target with an existing link is not a cycle', () => {
  const r = seeded(3);
  assert.equal(link(r, 'DEC-002', 'DEC-001', 'narrows').exitCode, 0);
  assert.equal(link(r, 'DEC-003', 'DEC-001', 'narrows').exitCode, 0);
  assert.deepEqual(dec(r, 'DEC-003').narrows, ['DEC-001']);
});

// ── retire (IC-002) ────────────────────────────────────────────────────────────────────────────

test('IC-002: retire keeps status live, records the retirement from now, and moves the decision out of the live view', () => {
  const r = seeded();
  const before = readRegister(r.featureDir);
  const run = retire(r, 'DEC-002', '  Out of scope now  ');
  assert.equal(run.exitCode, 0);
  assert.deepEqual(run.result, { action: 'retire', slug: SLUG, featureDir: r.featureDir, retired: [{ id: 'DEC-002', topic: 't2' }], unchanged: [] });
  const d = dec(r, 'DEC-002');
  assert.equal(d.status, 'live');
  assert.equal(d.supersededBy, null);
  assert.deepEqual(d.retired, { date: '2026-10-03', at: '2026-10-03T09:12:44.120Z', reason: 'Out of scope now' });
  assert.equal(decisionState(d), 'retired');
  assert.equal(readRegister(r.featureDir).nextId, before.nextId);
  assert.equal(dec(r, 'DEC-001').retired, undefined);
  const live = fs.readFileSync(path.join(r.featureDir, 'decisions.md'), 'utf8');
  assert.ok(!live.includes('| DEC-002 |') && live.includes('| DEC-001 |'));
  const archive = fs.readFileSync(path.join(r.featureDir, 'decisions', 'archive.md'), 'utf8');
  assert.ok(archive.includes('- **Status:** Live\n- **Retired:** 2026-10-03 · Out of scope now\n- **Decision:** Statement 2\n'));
  assert.deepEqual(humanLines(run.result), ['retired DEC-002 (t2)']);
});

test('IC-002: several ids retire together and both result arrays follow --ids order', () => {
  const r = seeded();
  assert.equal(retire(r, 'DEC-003').exitCode, 0);
  const run = retire(r, ' DEC-004 , DEC-003 ,DEC-001');
  assert.equal(run.exitCode, 0);
  assert.deepEqual(run.result.retired, [{ id: 'DEC-004', topic: 't4' }, { id: 'DEC-001', topic: 't1' }]);
  assert.deepEqual(run.result.unchanged, ['DEC-003']);
  assert.deepEqual(humanLines(run.result), ['retired DEC-004 (t4)', 'retired DEC-001 (t1)', 'DEC-003 already retired; nothing written']);
});

test('IC-002: an id that is already retired keeps its first retirement; when nothing changes nothing is written', () => {
  const r = seeded();
  assert.equal(retire(r, 'DEC-001', 'first reason').exitCode, 0);
  const first = dec(r, 'DEC-001').retired;
  const later: any = new Date('2026-11-01T00:00:00.000Z');
  const mixed = retire(r, 'DEC-001,DEC-002', 'second reason', { now: later });
  assert.deepEqual(mixed.result.unchanged, ['DEC-001']);
  assert.deepEqual(mixed.result.retired, [{ id: 'DEC-002', topic: 't2' }]);
  assert.deepEqual(dec(r, 'DEC-001').retired, first);
  assert.equal(dec(r, 'DEC-002').retired.reason, 'second reason');
  assert.equal(dec(r, 'DEC-002').retired.date, '2026-11-01');

  const before = snapshot(r.featureDir);
  const mtime = fs.statSync(registerFile(r.featureDir)).mtimeMs;
  tick();
  const again = retire(r, 'DEC-001,DEC-002', 'third');
  assert.equal(again.exitCode, 0);
  assert.deepEqual(again.result.retired, []);
  assert.deepEqual(again.result.unchanged, ['DEC-001', 'DEC-002']);
  assert.deepEqual(snapshot(r.featureDir), before);
  assert.equal(fs.statSync(registerFile(r.featureDir)).mtimeMs, mtime);
});

test('IC-002 rows 1 to 3: --ids is required, each entry must be a DEC-### id, and an id may be named once', () => {
  const r = seeded();
  const call = (ids: any) => runDecision({ action: 'retire', projectRoot: r.root, flags: { ids, reason: 'why' }, now: FIXED });
  assertUsage(r, runDecision({ action: 'retire', projectRoot: r.root, flags: { reason: 'why' } }), '--ids is required for --action retire');
  assertUsage(r, call(''), '--ids is required for --action retire');
  assertUsage(r, call(' , ,'), '--ids is required for --action retire');
  assertUsage(r, call('DEC-001,DEC-1'), "--ids entry 'DEC-1' is not a DEC-### id");
  assertUsage(r, call('foo'), "--ids entry 'foo' is not a DEC-### id");
  assertUsage(r, call('DEC-001,DEC-002,DEC-001'), '--ids names DEC-001 twice');
  // --ids is checked before --reason.
  assertUsage(r, runDecision({ action: 'retire', projectRoot: r.root, flags: {} }), '--ids is required for --action retire');
});

test('IC-002 rows 4 to 6: --reason is required, one line, and at most 280 characters', () => {
  const r = seeded();
  const call = (reason: any) => runDecision({ action: 'retire', projectRoot: r.root, flags: { ids: 'DEC-001', reason }, now: FIXED });
  const need = '--reason is required for --action retire: one line saying why the decision leaves the live view';
  assertUsage(r, runDecision({ action: 'retire', projectRoot: r.root, flags: { ids: 'DEC-001' } }), need);
  assertUsage(r, call(''), need);
  assertUsage(r, call('   '), need);
  assertUsage(r, call('line one\nline two'), '--reason must be one line');
  assertUsage(r, call('line one\r\nline two'), '--reason must be one line');
  assertUsage(r, call('x'.repeat(281)), '--reason is 281 characters; the limit is 280');
  assertUsage(r, call(`${'x'.repeat(281)}\nmore`), '--reason must be one line');
  assert.equal(call(`  ${'x'.repeat(280)}  `).exitCode, 0);
  assert.equal(dec(r, 'DEC-001').retired.reason.length, 280);
});

test('IC-002 row 7: no register is the no-register finding', () => {
  const r = repo({ 'plan.md': '# p\n' });
  const before = snapshot(r.featureDir);
  const run = retire(r, 'DEC-001');
  assertFinding(r, run, 'no-register', before);
  assert.equal(run.result.action, 'retire');
});

test('IC-002 row 8: an id that is not in the register is named, the first of --ids; nothing is retired', () => {
  const r = seeded();
  assertUsage(r, retire(r, 'DEC-001,DEC-009,DEC-010'), 'DEC-009 is not a decision in this register');
});

test('IC-002 row 9: a superseded decision cannot be retired, and the whole call is all-or-nothing', () => {
  const r = seeded();
  assert.equal(link(r, 'DEC-002', 'DEC-001', 'supersedes').exitCode, 0);
  assertUsage(r, retire(r, 'DEC-003,DEC-001'), 'DEC-001 is superseded by DEC-002; it is already out of the live view');
  assert.equal(dec(r, 'DEC-003').retired, undefined);
});

test('IC-002 row 10: a decision narrowed by a live-view decision cannot be retired alone; the finding names the pair', () => {
  const r = seeded();
  assert.equal(link(r, 'DEC-002', 'DEC-001', 'narrows').exitCode, 0);
  const before = snapshot(r.featureDir);
  const narrowedBy = retire(r, 'DEC-001');
  assertFinding(r, narrowedBy, 'linked-from-live', before);
  assert.equal(narrowedBy.result.message, 'DEC-001 is narrowed by DEC-002, which stays in the live view. Retire them together in one call (--ids DEC-001,DEC-002) or record a decision that supersedes one of them. Nothing was written');
  assert.deepEqual(narrowedBy.result.blocking, [{ id: 'DEC-001', other: 'DEC-002', direction: 'narrowed-by' }]);

  const narrows = retire(r, 'DEC-002');
  assertFinding(r, narrows, 'linked-from-live', before);
  assert.equal(narrows.result.message, 'DEC-002 narrows DEC-001, which stays in the live view. Retire them together in one call (--ids DEC-002,DEC-001) or record a decision that supersedes one of them. Nothing was written');
  assert.deepEqual(narrows.result.blocking, [{ id: 'DEC-002', other: 'DEC-001', direction: 'narrows' }]);
});

test('IC-002 row 10: with several blocking pairs every pair is named and the finding still writes nothing', () => {
  const r = seeded();
  assert.equal(link(r, 'DEC-002', 'DEC-001', 'narrows').exitCode, 0);
  assert.equal(link(r, 'DEC-003', 'DEC-001', 'narrows').exitCode, 0);
  const run = retire(r, 'DEC-001');
  assertFinding(r, run, 'linked-from-live');
  assert.deepEqual(run.result.blocking.map((b: any) => [b.id, b.other, b.direction]).sort(), [
    ['DEC-001', 'DEC-002', 'narrowed-by'], ['DEC-001', 'DEC-003', 'narrowed-by'],
  ]);
  assert.ok(run.result.message.includes('DEC-001 is narrowed by DEC-002, which stays in the live view'));
  assert.ok(run.result.message.includes('DEC-001 is narrowed by DEC-003, which stays in the live view'));
  assert.ok(run.result.message.endsWith('Nothing was written'));
});

test('IC-002: retiring a narrows pair in one call works, and an empty live view says where the retired ones are', () => {
  const r = seeded(2);
  assert.equal(link(r, 'DEC-002', 'DEC-001', 'narrows').exitCode, 0);
  const run = retire(r, 'DEC-001,DEC-002');
  assert.equal(run.exitCode, 0);
  assert.deepEqual(run.result.retired.map((x: any) => x.id), ['DEC-001', 'DEC-002']);
  const live = fs.readFileSync(path.join(r.featureDir, 'decisions.md'), 'utf8');
  assert.ok(live.includes('No decisions in the live view; retired ones are in `decisions/archive.md`.'));
  assert.ok(!live.includes('No live decisions yet.'));
  assert.ok(!live.includes('| ID |'));
  assert.ok(!live.includes('Narrowed in part'));
});

test('IC-002: a narrowing decision that is no longer live does not block the retire', () => {
  const r = seeded();
  assert.equal(link(r, 'DEC-002', 'DEC-001', 'narrows').exitCode, 0);
  assert.equal(link(r, 'DEC-003', 'DEC-002', 'supersedes').exitCode, 0);
  assert.equal(retire(r, 'DEC-001').exitCode, 0);
});

test('IC-002: the topic-conflict on a retired decision says it is retired and names both ways forward; a plain live one keeps the old message', () => {
  const r = seeded(2);
  assert.equal(retire(r, 'DEC-001').exitCode, 0);
  const before = snapshot(r.featureDir);
  const run = add(r, [item({ topic: 't1', statement: 'again' })]);
  assert.equal(run.exitCode, 1);
  assert.equal(run.result.finding, 'topic-conflict');
  assert.equal(run.result.message, "topic 't1' is held by DEC-001, which is retired (in force, out of the live view); to replace it, name it in supersedes or run decision --action link --from <new id> --to DEC-001 --kind supersedes. Nothing was written");
  assert.deepEqual(snapshot(r.featureDir), before);
  const plain = add(r, [item({ topic: 't2', statement: 'again' })]);
  assert.equal(plain.result.message, "topic 't2' already has live decision DEC-002; name it in supersedes to replace it. Nothing was written");
});

test('IC-002: a retired decision still holds its topic and can be superseded by add and by link', () => {
  const r = seeded();
  assert.equal(retire(r, 'DEC-001').exitCode, 0);
  const conflict = add(r, [item({ topic: 't1', statement: 'again' })]);
  assert.equal(conflict.exitCode, 1);
  assert.equal(conflict.result.finding, 'topic-conflict');
  assert.match(conflict.result.message, /DEC-001/);
  const by = add(r, [item({ topic: 't1', statement: 'again', supersedes: ['DEC-001'] })]);
  assert.equal(by.exitCode, 0);
  assert.equal(dec(r, 'DEC-001').status, 'superseded');
  assert.ok(dec(r, 'DEC-001').retired, 'the retirement is kept');

  assert.equal(retire(r, 'DEC-002').exitCode, 0);
  assert.equal(link(r, 'DEC-003', 'DEC-002', 'supersedes').exitCode, 0);
  assert.equal(dec(r, 'DEC-002').status, 'superseded');
  assert.ok(dec(r, 'DEC-002').retired);
  const archive = fs.readFileSync(path.join(r.featureDir, 'decisions', 'archive.md'), 'utf8');
  const entry = archive.slice(archive.indexOf('### DEC-002'), archive.indexOf('### DEC-003'));
  assert.ok(entry.includes('- **Status:** Superseded → DEC-003\n- **Retired:'));
});

test('IC-002: the library takes ids as an array or a string and throws a usage error for rows 1 to 6 before reading the register', () => {
  const r = seeded();
  const base = { featureDir: r.featureDir, slug: SLUG, now: FIXED };
  assert.throws(() => retireDecisions({ ...base, ids: [], reason: 'why' }), /--ids is required for --action retire/);
  assert.throws(() => retireDecisions({ ...base, ids: ['DEC-001'], reason: '' }), /--reason is required/);
  assert.throws(() => retireDecisions({ ...base, ids: 'DEC-009', reason: 'why' }), /DEC-009 is not a decision in this register/);
  const run: any = retireDecisions({ ...base, ids: ['DEC-001', 'DEC-002'], reason: 'why' });
  assert.deepEqual(run.retired.map((x: any) => x.id), ['DEC-001', 'DEC-002']);
  const out: any = linkDecisions({ ...base, from: 'DEC-003', to: 'DEC-004', kind: 'narrows' });
  assert.equal(out.changed, true);
  assert.throws(() => linkDecisions({ ...base, from: 'DEC-003', to: 'DEC-003', kind: 'narrows' }), /name the same decision/);
});

// ── list --status (IC-003) ─────────────────────────────────────────────────────────────────────

/** DEC-001 alpha (live, user), DEC-002 beta (superseded by DEC-003), DEC-003 beta (live, agent), DEC-004 delta (retired, user). */
function listFixture() {
  const r = initialised();
  add(r, [item({ topic: 'alpha' }), item({ topic: 'beta', statement: 'beta v1' }), item({ topic: 'delta' })]);
  add(r, [item({ topic: 'beta', statement: 'beta v2', channel: 'default', rationale: 'unattended:x', undo: 'Supersede it.', supersedes: ['DEC-002'] })]);
  assert.equal(retire(r, 'DEC-003').exitCode, 0, 'DEC-003 is delta here');
  return r;
}

test('IC-003: the default list leaves out retired decisions; --all still returns every decision by id', () => {
  const r = listFixture();
  // ids: 001 alpha, 002 beta (superseded), 003 delta (retired), 004 beta (live)
  const live = runDecision({ action: 'list', projectRoot: r.root });
  assert.deepEqual(live.result.decisions.map((d: any) => d.id), ['DEC-001', 'DEC-004']);
  const all = runDecision({ action: 'list', projectRoot: r.root, flags: { all: true } });
  assert.deepEqual(all.result.decisions.map((d: any) => d.id), ['DEC-001', 'DEC-002', 'DEC-003', 'DEC-004']);
});

test('IC-003: --status selects by state, by id, alone and combined', () => {
  const r = listFixture();
  const by = (status: any, extra: any = {}) => runDecision({ action: 'list', projectRoot: r.root, flags: { status, ...extra } });
  const ids = (run: any) => run.result.decisions.map((d: any) => d.id);
  assert.deepEqual(ids(by('live')), ['DEC-001', 'DEC-004']);
  assert.deepEqual(ids(by('superseded')), ['DEC-002']);
  assert.deepEqual(ids(by('retired')), ['DEC-003']);
  assert.deepEqual(ids(by('retired,live')), ['DEC-001', 'DEC-003', 'DEC-004']);
  assert.deepEqual(ids(by(' superseded , retired ')), ['DEC-002', 'DEC-003']);
  assert.deepEqual(ids(by('live,superseded,retired')), ['DEC-001', 'DEC-002', 'DEC-003', 'DEC-004']);
  assert.deepEqual(ids(by('retired', { all: true })), ['DEC-003'], '--status wins over --all');
  const run = by('retired');
  assert.equal(run.exitCode, 0);
  assert.deepEqual(Object.keys(run.result).sort(), ['action', 'decisions', 'featureDir', 'slug']);
  assert.deepEqual(run.result.decisions[0], dec(r, 'DEC-003'), 'each decision is the register object as stored');
});

test('IC-003: --by filters the --status selection afterwards', () => {
  const r = listFixture();
  const by = (status: any, who: any) => runDecision({ action: 'list', projectRoot: r.root, flags: { status, by: who } }).result.decisions.map((d: any) => d.id);
  assert.deepEqual(by('live,retired', 'agent'), ['DEC-004']);
  assert.deepEqual(by('live,retired', 'user'), ['DEC-001', 'DEC-003']);
  assert.deepEqual(by('superseded', 'agent'), []);
});

test('IC-003: unknown or empty --status values are usage errors that name the valid set', () => {
  const r = listFixture();
  const before = snapshot(r.featureDir);
  const call = (status: any) => runDecision({ action: 'list', projectRoot: r.root, flags: { status } });
  assertUsage(r, call('robot'), "--status 'robot': valid values are live, superseded, retired", before);
  assertUsage(r, call('live,robot,x'), "--status 'robot,x': valid values are live, superseded, retired", before);
  assertUsage(r, call(''), '--status is empty: valid values are live, superseded, retired', before);
  assertUsage(r, call(' , '), '--status is empty: valid values are live, superseded, retired', before);
});

test('IC-003: the library list takes status as an array', () => {
  const r = listFixture();
  const out: any = listDecisions({ featureDir: r.featureDir, slug: SLUG, status: ['retired', 'superseded'] });
  assert.deepEqual(out.decisions.map((d: any) => d.id), ['DEC-002', 'DEC-003']);
});

test('IC-003: the text line shows superseded by, retired, or nothing after the stage', () => {
  const r = listFixture();
  const lines = humanLines(runDecision({ action: 'list', projectRoot: r.root, flags: { status: 'live,superseded,retired' } }).result);
  assert.deepEqual(lines.filter((l: any) => !/^ +undo:/.test(l)), [
    'DEC-001  alpha  The wire carries the UUID.  [user, design]',
    'DEC-002  beta  beta v1  [user, design, superseded by DEC-004]',
    'DEC-003  delta  The wire carries the UUID.  [user, design, retired]',
    'DEC-004  beta  beta v2  [agent, design]',
  ]);
  assert.ok(lines.includes('    undo: Supersede it.'));
});

// ── views (IC-006, IC-007) ─────────────────────────────────────────────────────────────────────

const LIVE_HEAD = [
  '# Decisions: 001-demo', '',
  '> Generated from `decisions/register.json` by `doflow-run decision`. Do not edit this file. Superseded decisions and rationale are in `decisions/archive.md`.', '',
];

test('IC-006: the narrowed block follows the table exactly, one line per narrowed decision, narrowers by id', () => {
  const r = initialised();
  add(r, [item({ topic: 'cache-policy', statement: 'Cache for 60 s' }), item({ topic: 'cache-bypass', statement: 'Admin reads bypass the cache' }), item({ topic: 'cache-ttl', statement: 'TTL is 60 s' }), item({ topic: 'other', statement: 'Other' })]);
  assert.equal(link(r, 'DEC-002', 'DEC-001', 'narrows').exitCode, 0);
  assert.equal(link(r, 'DEC-003', 'DEC-001', 'narrows').exitCode, 0);
  assert.equal(link(r, 'DEC-004', 'DEC-003', 'narrows').exitCode, 0);
  const live = fs.readFileSync(path.join(r.featureDir, 'decisions.md'), 'utf8');
  assert.equal(live, [
    ...LIVE_HEAD,
    '| ID | Topic | Decision | By | Stage | Date |',
    '|---|---|---|---|---|---|',
    '| DEC-002 | cache-bypass | Admin reads bypass the cache | user | design | 2026-10-03 |',
    '| DEC-001 | cache-policy | Cache for 60 s | user | design | 2026-10-03 |',
    '| DEC-003 | cache-ttl | TTL is 60 s | user | design | 2026-10-03 |',
    '| DEC-004 | other | Other | user | design | 2026-10-03 |',
    '',
    'Narrowed in part:',
    '',
    '- DEC-001 is narrowed by DEC-002, DEC-003.',
    '- DEC-003 is narrowed by DEC-004.',
    '',
  ].join('\n'));
});

test('IC-006: only narrowers that are in the live view are listed, and no block appears when none is', () => {
  const r = seeded();
  assert.equal(link(r, 'DEC-002', 'DEC-001', 'narrows').exitCode, 0);
  assert.equal(link(r, 'DEC-003', 'DEC-001', 'narrows').exitCode, 0);
  assert.equal(add(r, [item({ topic: 't5', supersedes: ['DEC-003'] })]).exitCode, 0);
  const live = fs.readFileSync(path.join(r.featureDir, 'decisions.md'), 'utf8');
  assert.ok(live.endsWith('\n\nNarrowed in part:\n\n- DEC-001 is narrowed by DEC-002.\n'), live);

  const none = seeded();
  assert.ok(!fs.readFileSync(path.join(none.featureDir, 'decisions.md'), 'utf8').includes('Narrowed in part'));
  assert.equal(link(none, 'DEC-002', 'DEC-001', 'supersedes').exitCode, 0);
  assert.ok(!fs.readFileSync(path.join(none.featureDir, 'decisions.md'), 'utf8').includes('Narrowed in part'));
});

test('IC-006: an empty live view says "No live decisions yet." unless something is retired', () => {
  assert.ok(fs.readFileSync(path.join(initialised().featureDir, 'decisions.md'), 'utf8').includes('No live decisions yet.'));
  const r = seeded(1);
  assert.equal(retire(r, 'DEC-001').exitCode, 0);
  assert.equal(fs.readFileSync(path.join(r.featureDir, 'decisions.md'), 'utf8'), [
    ...LIVE_HEAD, 'No decisions in the live view; retired ones are in `decisions/archive.md`.', '',
  ].join('\n'));
});

test('IC-006, IC-007: a register without retired, narrows or reopens renders byte-identically to the previous renderer', () => {
  assert.equal(renderLiveView(GOLDEN.register), GOLDEN.live);
  assert.equal(renderArchive(GOLDEN.register), GOLDEN.archive);
});

test('IC-007: every archive line appears under its condition and in the contracted order', () => {
  const r = initialised();
  add(r, [item({ topic: 'a1', statement: 'one' }), item({ topic: 'a2', statement: 'two' }), item({ topic: 'a3', statement: 'three' }), item({ topic: 'a4', statement: 'four' }), item({ topic: 'a5', statement: 'five' })]);
  add(r, [item({ topic: 'omega', statement: 'omega', channel: 'default', rationale: 'unattended:x', undo: 'Supersede it.', refs: ['IC-004'], source: 'design/x.md#q1', supersedes: ['DEC-001'] })]);
  // DEC-006 supersedes DEC-001, narrows DEC-002, reopens DEC-003, and is narrowed by DEC-004.
  assert.equal(link(r, 'DEC-006', 'DEC-002', 'narrows').exitCode, 0);
  assert.equal(link(r, 'DEC-006', 'DEC-003', 'reopens').exitCode, 0);
  assert.equal(link(r, 'DEC-004', 'DEC-006', 'narrows').exitCode, 0);
  assert.equal(retire(r, 'DEC-005', 'No longer relevant').exitCode, 0);
  // DEC-007 narrows DEC-004, then is itself superseded: "Narrowed by" counts any status.
  add(r, [item({ topic: 'a7', statement: 'seven' })]);
  assert.equal(link(r, 'DEC-007', 'DEC-004', 'narrows').exitCode, 0);
  assert.equal(add(r, [item({ topic: 'a8', statement: 'eight', supersedes: ['DEC-007'] })]).exitCode, 0);

  const archive = fs.readFileSync(path.join(r.featureDir, 'decisions', 'archive.md'), 'utf8');
  const entry = (id: any) => {
    const start = archive.indexOf(`### ${id}:`);
    const next = archive.indexOf('\n### DEC-', start + 1);
    return archive.slice(start, next === -1 ? undefined : next);
  };
  const labels = (id: any) => entry(id).split('\n').map((l: any) => /^- \*\*([^*:]+):\*\*/.exec(l)).filter(Boolean).map((m: any) => m[1]);

  assert.deepEqual(labels('DEC-006'), ['Status', 'Decision', 'By', 'Supersedes', 'Narrows', 'Reopens', 'Narrowed by', 'Refs', 'Source', 'Rationale', 'Undo']);
  assert.ok(entry('DEC-006').includes('- **Supersedes:** DEC-001\n- **Narrows:** DEC-002\n- **Reopens:** DEC-003\n- **Narrowed by:** DEC-004\n'));
  assert.ok(entry('DEC-006').includes('- **Status:** Live\n'));

  assert.ok(entry('DEC-001').includes('- **Status:** Superseded → DEC-006\n'));
  assert.ok(!entry('DEC-001').includes('(reopened)'));
  assert.ok(entry('DEC-003').includes('- **Status:** Superseded → DEC-006 (reopened)\n'));

  assert.deepEqual(labels('DEC-005'), ['Status', 'Retired', 'Decision', 'By', 'Rationale']);
  assert.ok(entry('DEC-005').includes('- **Status:** Live\n- **Retired:** 2026-10-03 · No longer relevant\n- **Decision:** five\n'));

  // DEC-004 is narrowed by DEC-007, which is superseded by DEC-008: still listed.
  assert.ok(entry('DEC-004').includes('- **Narrowed by:** DEC-007\n'));
  assert.ok(entry('DEC-007').includes('- **Status:** Superseded → DEC-008\n'));
  assert.ok(entry('DEC-007').includes('- **Narrows:** DEC-004\n'));
  assert.ok(entry('DEC-008').includes('- **Supersedes:** DEC-007\n'));
  assert.ok(entry('DEC-002').includes('- **Narrowed by:** DEC-006\n'));
  // A decision with no links carries none of the new lines.
  assert.deepEqual(labels('DEC-005').filter((l: any) => ['Narrows', 'Reopens', 'Narrowed by', 'Supersedes'].includes(l)), []);
});

// ── compact closed-points text output (IC-004) ─────────────────────────────────────────────────

test('IC-004: the closed-points text output counts items and lines with plurals; unchanged says nothing to compact', () => {
  const lines = humanLines({ action: 'compact', mode: 'closed-points', status: 'compacted', moved: [
    { artifact: 'design.md', path: 'design/design.md', archive: 'decisions/history/design-closed.md', lines: 3, items: 2 },
    { artifact: 'specs.md', path: 'design/specs.md', archive: 'decisions/history/specs-closed.md', lines: 1, items: 1 },
  ], failed: [] });
  assert.deepEqual(lines, [
    'moved 2 closed points (3 lines) from design/design.md to decisions/history/design-closed.md',
    'moved 1 closed point (1 line) from design/specs.md to decisions/history/specs-closed.md',
  ]);
  assert.deepEqual(humanLines({ action: 'compact', mode: 'closed-points', status: 'unchanged', moved: [], failed: [] }), ['nothing to compact']);
  // History mode keeps its existing wording.
  assert.deepEqual(humanLines({ action: 'compact', mode: 'history', status: 'compacted', moved: [{ artifact: 'plan.md', path: 'plan.md', archive: 'decisions/history/plan.md', lines: 5 }], failed: [] }),
    ['moved 5 lines from plan.md to decisions/history/plan.md']);
});

// ── lock and atomic writes (IC-010) ────────────────────────────────────────────────────────────

for (const [label, call] of [
  ['link', (r: any) => link(r, 'DEC-002', 'DEC-001', 'supersedes')],
  ['retire', (r: any) => retire(r, 'DEC-001')],
] as any) {
  test(`IC-010: ${label} with the register lock held by another writer exits 1 as register-locked and changes no byte`, { timeout: 30000 }, () => {
    const r = seeded();
    fs.mkdirSync(path.join(r.featureDir, 'design'), { recursive: true });
    fs.writeFileSync(path.join(r.featureDir, 'design', 'design.md'), '# D\n\n## 7. Open Points for Review\n\n- **Decided:** a.\n');
    const lockDir = `${registerFile(r.featureDir)}.lock`;
    fs.mkdirSync(lockDir);
    const before = snapshot(r.featureDir);
    try {
      const run = call(r);
      assert.equal(run.exitCode, 1);
      assert.equal(run.result.finding, 'register-locked');
      assert.equal(run.usage, undefined);
      assert.match(run.result.message, /Could not lock/);
    } finally {
      assert.ok(fs.existsSync(lockDir), 'the other writer\'s lock survives');
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
    assert.deepEqual(snapshot(r.featureDir), before);
  });
}

test('IC-010: link and retire leave no lock directory and no temp file behind', () => {
  const r = seeded();
  assert.equal(link(r, 'DEC-002', 'DEC-001', 'supersedes').exitCode, 0);
  assert.equal(retire(r, 'DEC-003').exitCode, 0);
  assert.ok(!fs.existsSync(`${registerFile(r.featureDir)}.lock`));
  assert.deepEqual(Object.keys(snapshot(r.featureDir)).filter((n: any) => n.endsWith('.tmp') || /\.tmp$/.test(n)), []);
});

/** An fs whose renameSync into a path ending `suffix` throws, as a full disk would; `seen` counts the attempts. */
function failingRenameTo(suffix: any) {
  const double: any = {
    ...fs,
    seen: 0,
    renameSync(from: any, to: any) { if (String(to).endsWith(suffix)) { double.seen += 1; throw new Error('disk full'); } return fs.renameSync(from, to); },
  };
  return double;
}
function attempt(fn: any) { try { return fn(); } catch (error: any) { return { threw: error }; } }

test('IC-010: compact --mode closed-points runs under the register lock, and writes through the atomic path', () => {
  const r = seeded(1);
  fs.mkdirSync(path.join(r.featureDir, 'design'), { recursive: true });
  const design = path.join(r.featureDir, 'design', 'design.md');
  fs.writeFileSync(design, '# D\n\n## 7. Open Points for Review\n\n- **Decided:** a.\n- keep\n');
  const lockDir = `${registerFile(r.featureDir)}.lock`;
  const lockSeenOnWrite: any = [];
  const spy: any = {
    ...fs,
    writeFileSync(p: any, ...rest: any[]) { lockSeenOnWrite.push(fs.existsSync(lockDir)); return fs.writeFileSync(p, ...rest); },
    renameSync(from: any, to: any) { lockSeenOnWrite.push(fs.existsSync(lockDir)); return fs.renameSync(from, to); },
  };
  const paths = { design: path.relative(r.root, design) };
  const result: any = compactDecisions({ featureDir: r.featureDir, slug: SLUG, repoRoot: r.root, paths, now: FIXED, mode: 'closed-points', fsImpl: spy });
  assert.equal(result.status, 'compacted');
  assert.equal(result.mode, 'closed-points');
  assert.ok(lockSeenOnWrite.length >= 2, 'the archive and the artifact were both written');
  assert.ok(lockSeenOnWrite.every(Boolean), 'every write happened while the register lock was held');
  assert.ok(!fs.existsSync(lockDir), 'the lock is released afterwards');
});

for (const [label, call] of [
  ['link', (r: any, fsImpl: any) => linkDecisions({ featureDir: r.featureDir, slug: SLUG, from: 'DEC-002', to: 'DEC-001', kind: 'supersedes', fsImpl })],
  ['retire', (r: any, fsImpl: any) => retireDecisions({ featureDir: r.featureDir, slug: SLUG, ids: ['DEC-001'], reason: 'why', now: FIXED, fsImpl })],
] as any) {
  test(`IC-010: ${label} writes the register atomically, so a failed rename leaves every file as it was`, () => {
    const r = seeded();
    const before = snapshot(r.featureDir);
    const double = failingRenameTo(`${path.sep}register.json`);
    const out = attempt(() => call(r, double));
    assert.ok(double.seen >= 1, 'the register is written by renaming a temp file into place');
    if (out && out.threw) assert.match(out.threw.message, /disk full/);
    assert.deepEqual(snapshot(r.featureDir), before);
    assert.ok(!fs.existsSync(`${registerFile(r.featureDir)}.lock`), 'the lock is released after the failure');
  });

  test(`IC-010: ${label} writes the register before the views, so a failed view write leaves the register changed and the views stale`, () => {
    const r = seeded();
    const beforeRegister = fs.readFileSync(registerFile(r.featureDir), 'utf8');
    const beforeLive = fs.readFileSync(path.join(r.featureDir, 'decisions.md'), 'utf8');
    attempt(() => call(r, failingRenameTo(`${path.sep}decisions.md`)));
    assert.notEqual(fs.readFileSync(registerFile(r.featureDir), 'utf8'), beforeRegister, 'the register was written first');
    assert.equal(fs.readFileSync(path.join(r.featureDir, 'decisions.md'), 'utf8'), beforeLive);
  });
}

// ── compat: existing registers and add (IC-005) ────────────────────────────────────────────────

test('IC-005: a register written before this feature still loads, lists and links', () => {
  const r = seeded(2);
  const file = registerFile(r.featureDir);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(raw.decisions.every((d: any) => !('retired' in d) && !('narrows' in d) && !('reopens' in d)));
  assert.equal(raw.version, 1);
  assert.equal(link(r, 'DEC-002', 'DEC-001', 'narrows').exitCode, 0);
  assert.equal(readRegister(r.featureDir).version, 1);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).decisions[0].retired, undefined);
});

// ── a register whose optional lifecycle fields have the wrong shape is refused per decision ────

test('readRegister refuses a bad retired, narrows or reopens, naming the file, the decision and the field', () => {
  const good = { date: '2026-10-03', at: '2026-10-03T00:00:00.000Z', reason: 'r' };
  const cases: Array<[string, any]> = [
    ['retired', 'yes'], ['retired', null], ['retired', []], ['retired', { ...good, reason: 7 }], ['retired', { date: good.date, at: good.at }],
    ['narrows', 'DEC-001'], ['narrows', ['nope']], ['narrows', [1]],
    ['reopens', {}], ['reopens', ['DEC-1']], ['reopens', [null]],
  ];
  for (const [field, value] of cases) {
    const r = seeded(2);
    const file = registerFile(r.featureDir);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.decisions[1][field] = value;
    fs.writeFileSync(file, JSON.stringify(data));
    assert.throws(() => readRegister(r.featureDir), (e: any) => e.message.includes(file) && e.message.includes('decision DEC-002') && e.message.includes(`'${field}'`), `${field}=${JSON.stringify(value)}`);
  }
});

test('readRegister accepts well-formed retired, narrows and reopens', () => {
  const r = seeded(3);
  assert.equal(link(r, 'DEC-002', 'DEC-001', 'narrows').exitCode, 0);
  assert.equal(link(r, 'DEC-003', 'DEC-002', 'reopens').exitCode, 0);
  assert.equal(retire(r, 'DEC-001').exitCode, 0);
  assert.equal(readRegister(r.featureDir).decisions.length, 3);
});
