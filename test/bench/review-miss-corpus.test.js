'use strict';

// Feature 095b A.4 (IC-008): the review-miss `corpus` and `lint` verbs. The git history is a scratch
// repo built here (three commits); the records are written into a scratch directory. Nothing reads
// the checkout's own agent-docs, runs a model, or writes under the checkout's bench/runs.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createScratch } = require('../helper/scratch-env');

const scratch = createScratch('doflow-review-miss-corpus-');
// The corpus reads git in-process; applying the scratch environment keeps it off the developer's
// HOME and git config.
scratch.apply();
after(() => {
  scratch.restore();
  scratch.remove();
});

const corpus = require('../../bench/review-miss/corpus.js');
const runner = require('../../bench/review-miss/runner.js');
const benchRunner = require('../../bench/runner.js');

const FORBIDDEN_KEYS = ['fixedIn', 'summary', 'evidence', 'fix', 'proof', 'from'];

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: scratch.env() });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Three commits: c1 adds a.js and b.js, c2 changes a.js, c3 changes a.js and adds new.js. */
function buildRepo(name) {
  const dir = path.join(scratch.dir, name);
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  const lines = (tag) => Array.from({ length: 10 }, (_, i) => `// ${tag} line ${i + 1}`).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), lines('one'));
  fs.writeFileSync(path.join(dir, 'src', 'b.js'), lines('b'));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'c1');
  const c1 = git(dir, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), lines('two'));
  git(dir, 'commit', '-q', '-am', 'c2');
  const c2 = git(dir, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), lines('three'));
  fs.writeFileSync(path.join(dir, 'src', 'new.js'), lines('new'));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'c3');
  const c3 = git(dir, 'rev-parse', 'HEAD');
  return { dir, c1, c2, c3 };
}

const conv = (id, severity, status, locator, extra = {}) => ({ id, from: [`s-${id}`], severity, status, locator, ...extra });
const seatOf = (converged) => [{
  id: 'seat',
  findings: converged.map((f) => ({ id: `s-${f.id}`, severity: f.severity, locator: f.locator, summary: `SUMMARY-TEXT-${f.id}` })),
}];

function record(row, slug, head, converged) {
  return { schema: 1, row, slug, reviewedHead: head, seats: seatOf(converged), converged };
}

function writeRecord(root, slug, rec, nested = '') {
  const dir = path.join(root, slug, 'review', nested);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'findings.json'), `${JSON.stringify(rec, null, 2)}\n`);
}

const sha8 = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 8);

function keysDeep(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysDeep(v, out);
    }
  }
  return out;
}

function capture() {
  const out = [];
  const err = [];
  return { out, err, io: { out: (m) => out.push(m), err: (m) => err.push(m) } };
}

let repoSeq = 0;
/** The plan's fixture: one eligible case, one skip per reason the plan names, one invalid record. */
function fixture() {
  const repo = buildRepo(`repo-${++repoSeq}`);
  const records = path.join(scratch.dir, `records-${repoSeq}`);
  const converged = [
    conv('B-1', 'blocker', 'fixed', 'src/a.js:3-5', { fixedIn: repo.c3 }),
    conv('N-1', 'note', 'fixed', 'src/a.js:2', { fixedIn: repo.c3 }),
    conv('S-1', 'should-fix', 'open', 'src/b.js:1'),
    conv('B-2', 'blocker', 'fixed', 'src/a.js:1-2; src/b.js:3', { fixedIn: repo.c3 }),
  ];
  writeRecord(records, '001-good-record', record('001', '001-good-record', repo.c2, converged));
  writeRecord(records, '002-bad-record', { schema: 2, row: '002' });
  return { ...repo, records };
}

function runCorpus(f, extra = []) {
  const cap = capture();
  const code = runner.main(['corpus', '--records', f.records, ...extra], { repoRoot: f.dir, ...cap.io });
  return { code, ...cap };
}

test('IC-008: a record with mixed findings yields one case, the skip counts and the scope rule', () => {
  const f = fixture();
  const out = path.join(scratch.dir, 'out-1.json');
  const r = runCorpus(f, ['--out', out]);
  assert.equal(r.code, 0, r.err.join('\n'));
  const c = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(c.schema, 1);
  assert.equal(c.kind, 'review-miss');
  assert.equal(c.records, 1);
  assert.deepEqual(c.skipped, { 'record-invalid': ['002-bad-record'], 'not-fixed': 1, severity: 1, locator: 1, 'no-parent': 0, 'path-absent': 0 });
  assert.equal(c.cases.length, 1);
  const [one] = c.cases;
  assert.equal(one.id, '001-b-1');
  assert.deepEqual(one.source, { row: '001', slug: '001-good-record', finding: 'B-1' });
  assert.equal(one.rev, f.c2, 'rev is the parent of the fix');
  assert.deepEqual(one.scope, ['src/a.js', 'src/b.js'], 'scope: sorted unique paths of every parseable converged locator');
  assert.deepEqual(one.expected, { path: 'src/a.js', startLine: 3, endLine: 5, severity: 'blocker' });
});

test('IC-008: the key is the sha8 of {rev, scope, expected}, and split follows the id digest', () => {
  const f = fixture();
  const out = path.join(scratch.dir, 'out-2.json');
  assert.equal(runCorpus(f, ['--out', out]).code, 0);
  const [one] = JSON.parse(fs.readFileSync(out, 'utf8')).cases;
  assert.equal(one.key, `review-miss/${one.id}@${sha8({ rev: one.rev, scope: one.scope, expected: one.expected })}`);
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'bench', 'review-miss', 'config.json'), 'utf8'));
  const digit = parseInt(crypto.createHash('sha256').update(one.id).digest('hex')[0], 16);
  assert.equal(one.split, digit < parseInt(config.heldoutBelow, 16) ? 'heldout' : 'train');
  assert.equal(corpus.splitOf('117-c-1', config), parseInt(crypto.createHash('sha256').update('117-c-1').digest('hex')[0], 16) < 3 ? 'heldout' : 'train');
  // A changed truth changes the key.
  const moved = corpus.caseKey({ id: one.id, rev: one.rev, scope: one.scope, expected: { ...one.expected, endLine: 6 } });
  assert.notEqual(moved, one.key);
});

test('IC-008 negative control: a case holds none of fixedIn, summary, evidence, fix, proof, from or seat text', () => {
  const f = fixture();
  const out = path.join(scratch.dir, 'out-3.json');
  assert.equal(runCorpus(f, ['--out', out]).code, 0);
  const text = fs.readFileSync(out, 'utf8');
  const c = JSON.parse(text);
  const keys = keysDeep(c);
  for (const k of FORBIDDEN_KEYS) assert.equal(keys.has(k), false, `no ${k} key anywhere in the corpus`);
  assert.deepEqual(Object.keys(c.cases[0]).sort(), ['expected', 'id', 'key', 'rev', 'scope', 'source', 'split']);
  assert.equal(text.includes('SUMMARY-TEXT'), false, 'no seat text');
  assert.equal(text.includes(f.c3), false, 'the fix commit is not in the corpus');
});

test('IC-008: two runs over the same records are byte-identical', () => {
  const f = fixture();
  const a = path.join(scratch.dir, 'out-4a.json');
  const b = path.join(scratch.dir, 'out-4b.json');
  assert.equal(runCorpus(f, ['--out', a]).code, 0);
  assert.equal(runCorpus(f, ['--out', b]).code, 0);
  assert.equal(Buffer.compare(fs.readFileSync(a), fs.readFileSync(b)), 0);
});

test('IC-008: a fix with no parent counts no-parent, a path absent at the parent counts path-absent', () => {
  const f = fixture();
  const records = path.join(scratch.dir, `records-extra-${repoSeq}`);
  writeRecord(records, '003-extra', record('003', '003-extra', f.c2, [
    conv('R-1', 'blocker', 'fixed', 'src/a.js:1', { fixedIn: f.c1 }),
    conv('P-1', 'should-fix', 'fixed', 'src/new.js:1-2', { fixedIn: f.c3 }),
    conv('U-1', 'should-fix', 'fixed', 'src/a.js:4,7,9', { fixedIn: f.c3 }),
  ]));
  // A nested record (review/<phase>/findings.json) is read, and its id does not collide with the top one.
  writeRecord(records, '003-extra', record('003', '003-extra', f.c2, [
    conv('U-1', 'blocker', 'fixed', 'src/b.js:2', { fixedIn: f.c3 }),
  ]), 'phase-c');
  const out = path.join(scratch.dir, 'out-5.json');
  const cap = capture();
  assert.equal(runner.main(['corpus', '--records', records, '--out', out], { repoRoot: f.dir, ...cap.io }), 0, cap.err.join('\n'));
  const c = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(c.records, 2);
  assert.equal(c.skipped['no-parent'], 1);
  assert.equal(c.skipped['path-absent'], 1);
  assert.deepEqual(c.cases.map((x) => x.id), ['003-phase-c-u-1', '003-u-1']);
  assert.deepEqual(c.cases[1].expected, { path: 'src/a.js', startLine: 4, endLine: 9, severity: 'should-fix' }, 'a comma list spans its lowest to highest line');
});

test('IC-008: corpus exits 1 when no case is eligible, 2 for an unreadable records root or a bad flag', () => {
  const f = fixture();
  const empty = path.join(scratch.dir, `records-empty-${repoSeq}`);
  fs.mkdirSync(empty);
  const out = path.join(scratch.dir, 'out-6.json');
  const cap = capture();
  assert.equal(runner.main(['corpus', '--records', empty, '--out', out], { repoRoot: f.dir, ...cap.io }), 1);
  assert.equal(fs.existsSync(out), false, 'nothing is written when no case is eligible');
  assert.equal(runner.main(['corpus', '--records', path.join(scratch.dir, 'no-such-dir')], { repoRoot: f.dir, ...capture().io }), 2);
  assert.equal(runner.main(['corpus', '--bogus'], { repoRoot: f.dir, ...capture().io }), 2);
  assert.equal(runner.main(['grade'], { repoRoot: f.dir, ...capture().io }), 2, 'a verb this task does not own is unknown');
  assert.equal(runner.main([], { repoRoot: f.dir, ...capture().io }), 2);
});

test('IC-008: the default records root is read through the injected resolver, not hard-coded', () => {
  const f = fixture();
  const asked = [];
  const out = path.join(scratch.dir, 'out-7.json');
  const code = runner.main(['corpus', '--out', out], {
    repoRoot: f.dir,
    resolveRecordsRoot: (root) => { asked.push(root); return f.records; },
    ...capture().io,
  });
  assert.equal(code, 0);
  assert.deepEqual(asked, [f.dir]);
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).cases.length, 1);
});

test('IC-008: --json prints the corpus on stdout', () => {
  const f = fixture();
  const out = path.join(scratch.dir, 'out-8.json');
  const r = runCorpus(f, ['--out', out, '--json']);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out.join('\n')), JSON.parse(fs.readFileSync(out, 'utf8')));
});

// ---- lint -------------------------------------------------------------------------------------

function goodCorpus() {
  const f = fixture();
  const out = path.join(scratch.dir, `lint-base-${repoSeq}.json`);
  assert.equal(runCorpus(f, ['--out', out]).code, 0);
  return { f, file: out, data: JSON.parse(fs.readFileSync(out, 'utf8')) };
}

function lint(f, data, extra = []) {
  const file = path.join(scratch.dir, `lint-${++repoSeq}.json`);
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  const cap = capture();
  const code = runner.main(['lint', '--corpus', file, ...extra], { repoRoot: f.dir, ...cap.io });
  return { code, ...cap };
}

const clone = (x) => JSON.parse(JSON.stringify(x));
const rekey = (c) => { c.key = corpus.caseKey(c); return c; };

test('IC-008 negative control: the unmodified corpus lints clean', () => {
  const { f, file, data } = goodCorpus();
  const cap = capture();
  assert.equal(runner.main(['lint', '--corpus', file], { repoRoot: f.dir, ...cap.io }), 0, cap.err.join('\n'));
  assert.deepEqual(cap.err, []);
  assert.equal(lint(f, data, ['--json']).code, 0);
});

const MUTATIONS = [
  ['a key outside the case shape', (d) => { d.cases[0].fixedIn = 'x'; }, /key/],
  ['a key outside the expected shape', (d) => { d.cases[0].expected.fix = 'x'; }, /key/],
  ['a duplicate id', (d) => { d.cases.push(clone(d.cases[0])); }, /duplicate/],
  ['a key that does not match its digest', (d) => { d.cases[0].key = 'review-miss/001-b-1@00000000'; }, /digest/],
  ['a rev that is not 40-hex', (d) => { d.cases[0].rev = 'HEAD'; rekey(d.cases[0]); }, /40-hex/],
  ['a rev that does not resolve', (d) => { d.cases[0].rev = 'a'.repeat(40); rekey(d.cases[0]); }, /resolve/],
  ['an expected.path outside scope', (d) => { d.cases[0].expected.path = 'src/new.js'; rekey(d.cases[0]); }, /scope/],
  ['startLine below 1', (d) => { d.cases[0].expected.startLine = 0; rekey(d.cases[0]); }, /startLine/],
  ['endLine below startLine', (d) => { d.cases[0].expected.endLine = 2; rekey(d.cases[0]); }, /endLine/],
  ['a severity outside the config', (d) => { d.cases[0].expected.severity = 'note'; rekey(d.cases[0]); }, /severity/],
  ['zero heldout cases with at least 5 cases', (d) => {
    d.cases = Array.from({ length: 5 }, (_, i) => rekey({ ...clone(d.cases[0]), id: `x-${i}`, split: 'train' }));
  }, /heldout/],
];

for (const [name, mutate, pattern] of MUTATIONS) {
  test(`IC-008 lint refuses ${name}`, () => {
    const { f, data } = goodCorpus();
    const bad = clone(data);
    mutate(bad);
    const r = lint(f, bad);
    assert.equal(r.code, 1, `exit 1: ${r.err.join(' | ')}`);
    assert.ok(r.err.length >= 1 && r.err.some((line) => pattern.test(line)), `a line matches ${pattern}: ${r.err.join(' | ')}`);
    assert.ok(r.err.every((line) => !line.includes('\n')), 'one line per problem');
  });
}

test('IC-008: lint exits 2 for an unreadable or unparseable corpus file and an unknown flag', () => {
  const { f } = goodCorpus();
  assert.equal(runner.main(['lint', '--corpus', path.join(scratch.dir, 'absent.json')], { repoRoot: f.dir, ...capture().io }), 2);
  assert.equal(lint(f, '{not json').code, 2);
  assert.equal(runner.main(['lint', '--bogus'], { repoRoot: f.dir, ...capture().io }), 2);
});

test('IC-008: bench/runner.js routes review-miss and lists it in USAGE', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'bench', 'runner.js'), 'utf8');
  assert.match(src, /argv\[0\] === 'review-miss'/);
  assert.match(src, /bench\/runner\.js review-miss <verb>/);
  assert.equal(typeof benchRunner.main, 'function');
});
