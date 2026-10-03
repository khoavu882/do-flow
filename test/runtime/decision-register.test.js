'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  runDecision, addDecisions, initRegister, listDecisions, readRegister, renderLiveView, renderArchive,
  registerFile, handleDecisionCommand, STATEMENT_MAX,
} = require('../../src/runtime/decision-register');

const SLUG = '001-demo';
const FIXED = new Date('2026-10-03T09:12:44.120Z');

function git(cwd, ...args) {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'ignore' });
}

/** A temp git repo on feat/001-demo; the feature folder exists only when `files` names something. */
function repo(files = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-decision-')));
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

const item = (over = {}) => ({
  topic: 'wire-id', statement: 'The wire carries the UUID.', channel: 'question', stage: 'design', rationale: 'Because.', ...over,
});

function add(r, items, extra = {}) {
  const file = path.join(r.root, `batch-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(items));
  return runDecision({ action: 'add', projectRoot: r.root, flags: { batch: file }, now: FIXED, ...extra });
}

const snapshot = (featureDir) => {
  const out = {};
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

for (const rel of ['intention/requirement.md', 'requirement.md', 'design/design.md', 'design.md', 'plan.md']) {
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
  const outcomes = [
    runDecision({ action: 'init', projectRoot: r.root }),
    runDecision({ action: 'list', projectRoot: r.root }),
    runDecision({ action: 'compact', projectRoot: r.root }),
    add(r, [item()]),
  ];
  assert.deepEqual(outcomes.map((o) => [o.exitCode, o.result.finding]), [
    [1, 'predates-register'], [1, 'no-register'], [1, 'no-register'], [1, 'no-register'],
  ]);
  assert.deepEqual(snapshot(r.featureDir), before);
});

// ── add: channels, ids, ownership (FR-003, FR-004) ─────────────────────────────────────────────

test('channels map to who decided; the caller never sets decidedBy', () => {
  const r = initialised();
  const channels = ['question', 'gate', 'prompt', 'default', 'resolution'];
  const run = add(r, channels.map((c) => item({ topic: `t-${c}`, channel: c })));
  assert.equal(run.exitCode, 0);
  const byTopic = Object.fromEntries(readRegister(r.featureDir).decisions.map((d) => [d.channel, d.decidedBy]));
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
  const bad = [item({ topic: 'good' }), item({ topic: 'Bad Topic' })];
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
  const spying = { ...fs };
  for (const fn of ['writeFileSync', 'renameSync', 'mkdirSync']) spying[fn] = (...a) => { touched = true; return fs[fn](...a); };
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
  const stdin = (text) => ({ ...fs, readFileSync: (p, enc) => (p === 0 ? text : fs.readFileSync(p, enc)) });
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
  assert.deepEqual(live.map((d) => d.topic), ['new-topic']);
});

test('within a batch, an earlier item freeing a topic lets a later item take it', () => {
  const r = initialised();
  add(r, [item({ topic: 'old-topic' })]);
  const run = add(r, [item({ topic: 'a', supersedes: ['DEC-001'] }), item({ topic: 'old-topic', statement: 'taken over' })]);
  assert.equal(run.exitCode, 0);
  assert.deepEqual(run.result.added.map((a) => a.id), ['DEC-002', 'DEC-003']);
});

test('50 supersessions on one topic leave one live row in the live view', () => {
  const r = initialised();
  let prev = null;
  for (let i = 0; i < 50; i += 1) {
    const result = addDecisions({
      featureDir: r.featureDir, slug: SLUG, now: FIXED,
      items: [item({ statement: `version ${i}`, supersedes: prev ? [prev] : [] })],
    });
    prev = result.added[0].id;
  }
  const live = fs.readFileSync(path.join(r.featureDir, 'decisions.md'), 'utf8');
  assert.equal(live.split('\n').filter((l) => l.startsWith('| DEC-')).length, 1);
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
  assert.deepEqual(live.result.decisions.map((d) => d.id), ['DEC-002', 'DEC-003']);
  assert.deepEqual(runDecision({ action: 'status', projectRoot: r.root }).result, live.result);
  const all = runDecision({ action: 'list', projectRoot: r.root, flags: { all: true } });
  assert.deepEqual(all.result.decisions.map((d) => d.id), ['DEC-001', 'DEC-002', 'DEC-003']);
  assert.equal(all.result.slug, SLUG);
  assert.equal(all.result.featureDir, r.featureDir);
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
  const failing = { ...fs, renameSync: (from, to) => { if (to === archive) throw new Error('disk full'); return fs.renameSync(from, to); } };
  const run = runDecision({ action: 'compact', projectRoot: r.root, now: FIXED, fsImpl: failing });
  assert.equal(run.exitCode, 1);
  assert.equal(run.result.finding, 'compaction-failed');
  assert.equal(run.result.artifact, 'plan.md');
  assert.equal(fs.readFileSync(path.join(r.featureDir, 'plan.md'), 'utf8'), PLAN);
  assert.ok(!fs.existsSync(`${registerFile(r.featureDir)}.lock`));
});

// ── usage and resolution ───────────────────────────────────────────────────────────────────────

test('an unknown action and an unresolvable feature are usage errors', () => {
  const r = initialised();
  const unknown = runDecision({ action: 'purge', projectRoot: r.root });
  assert.equal(unknown.exitCode, 2);
  assert.match(unknown.usage, /init, add, list, compact/);
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-decision-bare-')));
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

function captured(fn) {
  const logs = [];
  const errs = [];
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
    fs.rmdirSync(`${registerFile(r.featureDir)}.lock`);
  }
  assert.deepEqual(snapshot(r.featureDir), before);
});

// ── live-view cells keep a statement as one row showing the text as written (IC-007, FR-004) ──────

/** Splits a table row the strict way (a pipe is escaped only after an odd run of backslashes) and
 * decodes each cell, as a renderer would. */
function renderedCells(row) {
  const cells = [];
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
  const statements = ['a\\|b', 'C:\\temp\\', 'x \\\\| y', 'end with slash \\', 'plain | pipe <!-- not a comment'];
  add(r, statements.map((statement, n) => item({ topic: `t${n}`, statement })));
  const live = fs.readFileSync(path.join(r.featureDir, 'decisions.md'), 'utf8');
  const rows = live.split('\n').filter((l) => l.startsWith('| DEC-'));
  assert.equal(rows.length, statements.length, 'one row per statement');
  rows.forEach((row, n) => {
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
  fs.writeFileSync(path.join(r.featureDir, 'design.md'), design);
  const run = runDecision({ action: 'compact', projectRoot: r.root, now: FIXED });
  assert.equal(run.exitCode, 1);
  assert.equal(run.result.finding, 'compaction-failed');
  assert.equal(run.result.status, 'partial');
  assert.deepEqual(run.result.moved.map((m) => m.artifact), ['plan.md']);
  assert.deepEqual(run.result.failed.map((f) => f.artifact), ['design.md']);
  assert.equal(fs.readFileSync(path.join(r.featureDir, 'design.md'), 'utf8'), design);
  assert.ok(fs.readFileSync(path.join(r.featureDir, 'plan.md'), 'utf8').includes('Earlier entries:'));
});
