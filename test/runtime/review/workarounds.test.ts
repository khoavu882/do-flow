'use strict';

// 181 F.1 (IC-012, IC-013): the workaround marks file and `scanWorkarounds` over a diff.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../../helper/tmp.ts');
const { scanWorkarounds } = require('../../../src/runtime/review/workarounds.ts');

const MARK = { id: 'raw-sql', pattern: 'db\\.raw\\(', paths: ['src/**/*.ts'], reason: 'raw SQL skips the query builder', alternative: 'use query()', since: '2026-11-01' };

function git(cwd: any, args: string[]) {
  const env = { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_GLOBAL: path.join(cwd, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV };
  const res = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, env, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}

const put = (root: any, rel: any, text: any) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

/** A repository whose base commit holds `base` files and whose head commit holds `change` files on top; `.doflow/` is excluded. */
function repo(t: any, { base = {}, change = {}, marks = { version: 1, marks: [MARK] } }: any = {}) {
  const root = tempDir(t, 'doflow-workarounds-');
  git(root, ['init', '-q', '-b', 'main']);
  put(root, '.git/info/exclude', '.doflow/\n');
  put(root, 'README.md', 'base\n');
  for (const [rel, text] of Object.entries(base)) put(root, rel, text);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'base']);
  const baseSha = git(root, ['rev-parse', 'HEAD']);
  for (const [rel, text] of Object.entries(change)) put(root, rel, text);
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '--allow-empty', '-m', 'change']);
  const head = git(root, ['rev-parse', 'HEAD']);
  if (marks !== null) put(root, '.doflow/workarounds.json', typeof marks === 'string' ? marks : JSON.stringify(marks));
  return { root, base: baseSha, head };
}

const scan = (r: any) => scanWorkarounds({ root: r.root, base: r.base, head: r.head });

test('a copied pattern is listed with file, line, mark, reason and alternative', (t) => {
  const r = repo(t, { base: { 'src/old.ts': 'db.raw(1);\n' }, change: { 'src/a.ts': 'const a = 1;\nconst b = db.raw("x");\n', 'docs/x.md': 'db.raw(\n' } });
  const out = scan(r);
  assert.deepEqual([out.file, out.truncated, out.findings], ['present', false, []]);
  assert.deepEqual(out.matches, [{ mark: 'raw-sql', path: 'src/a.ts', line: 2, text: 'const b = db.raw("x");', reason: MARK.reason, alternative: MARK.alternative }]);
});

test('only added lines count: an old copy, a removed copy and a context line are quiet', (t) => {
  const r = repo(t, { base: { 'src/a.ts': 'db.raw(1);\nkeep();\n' }, change: { 'src/a.ts': 'keep();\nother();\n' } });
  assert.deepEqual(scan(r).matches, []);
});

test('line numbers follow the new file across several hunks', (t) => {
  const body = Array.from({ length: 30 }, (_, i) => `l${i + 1}();`);
  const next = body.slice();
  next[2] = 'db.raw(3);';
  next[24] = 'db.raw(25);';
  const r = repo(t, { base: { 'src/a.ts': `${body.join('\n')}\n` }, change: { 'src/a.ts': `${next.join('\n')}\n` } });
  assert.deepEqual(scan(r).matches.map((m: any) => m.line), [3, 25]);
});

test('an absent file, an empty file and an empty mark set give no finding', (t) => {
  for (const marks of [null, '', '  \n', { version: 1, marks: [] }]) {
    const r = repo(t, { change: { 'src/a.ts': 'db.raw(1);\n' }, marks });
    const out = scan(r);
    assert.deepEqual([out.matches, out.findings, out.truncated], [[], [], false], JSON.stringify(marks));
    assert.equal(out.file, marks === null ? 'absent' : 'present');
  }
});

test('a mark applies only to files its globs select', (t) => {
  const marks = { version: 1, marks: [{ ...MARK, paths: ['src/*.ts', 'lib/**/*.js'] }] };
  const r = repo(t, { change: { 'src/a.ts': 'db.raw(1);\n', 'src/deep/b.ts': 'db.raw(2);\n', 'lib/x.js': 'db.raw(3);\n', 'lib/y/z.js': 'db.raw(4);\n', 'other/c.ts': 'db.raw(5);\n' }, marks });
  assert.deepEqual(scan(r).matches.map((m: any) => m.path).sort(), ['lib/x.js', 'lib/y/z.js', 'src/a.ts']);
});

test('a bad mark is a finding and skipped while the others still apply', (t) => {
  const bad = [
    { ...MARK, id: 'bad-regex', pattern: '(' },
    { ...MARK, id: 'long-pattern', pattern: 'a'.repeat(201) },
    { ...MARK, id: 'no-paths', paths: [] },
    { ...MARK, id: 'abs-path', paths: ['/src/**'] },
    { ...MARK, id: 'two-lines', reason: 'one\ntwo' },
    { ...MARK, id: 'long-alt', alternative: 'x'.repeat(201) },
    { ...MARK, id: 'bad-date', since: '2026-13-40' },
    { ...MARK, id: 'extra', color: 'red' },
    { ...MARK, id: 'Bad Id' },
    { ...MARK },
    { ...MARK, pattern: 'nothing-here' },
    'not-an-object',
  ];
  const out = scan(repo(t, { change: { 'src/a.ts': 'db.raw(1);\n' }, marks: { version: 1, marks: [...bad, { ...MARK, id: 'good', pattern: 'raw' }] } }));
  assert.deepEqual(out.matches.map((m: any) => m.mark), ['raw-sql', 'good']);
  const text = out.findings.join('\n');
  for (const needle of ["mark 'bad-regex': pattern does not compile", "mark 'long-pattern': pattern must be at most 200", "mark 'no-paths': paths must be",
    "mark 'abs-path': paths must be", "mark 'two-lines': reason must be one line", "mark 'long-alt': alternative must be at most 200",
    "mark 'bad-date': since must be an ISO date", "mark 'extra': has unknown key 'color'", "mark 'Bad Id': id must match", "mark 'raw-sql': id duplicates", 'mark #12: must be an object']) {
    assert.ok(text.includes(needle), `${needle}\n${text}`);
  }
});

test('a pattern that can run super-linearly is a finding and the scan returns promptly with the other marks applied', (t) => {
  const risky = ['^(a+)+$', '(a*)*', '(a|aa)+', '^((a|aa))+$', '(?:x(a|aa))*', '(\\w+\\s?)*', '((a+)b)+', '(a+){2,}', 'a*a*a*a*a*a*b', '.*?.*x',
    '(a)\\1', '(?<x>a)\\k<x>'];
  const marks = [...risky.map((pattern, i) => ({ ...MARK, id: `risky-${i}`, pattern })),
    { ...MARK, id: 'plain', pattern: 'foo\\d+bar' }, { ...MARK, id: 'safe-group', pattern: '(foo|bar)\\d' }, { ...MARK, id: 'escaped', pattern: '\\(a+\\)+' }, { ...MARK, id: 'class', pattern: '[(+]+x' }];
  const r = repo(t, { change: { 'src/a.ts': `${'a'.repeat(30)}b\nfoo123bar\nbar7\n(aaa)+\n(+x\n` }, marks: { version: 1, marks } });
  const started = Date.now();
  const out = scan(r);
  assert.ok(Date.now() - started < 2000, 'the scan returned promptly');
  assert.deepEqual(out.matches.map((m: any) => [m.mark, m.line]), [['plain', 2], ['safe-group', 2], ['safe-group', 3], ['escaped', 4], ['class', 5]]);
  assert.equal(out.findings.length, risky.length, out.findings.join('\n'));
  for (let i = 0; i < risky.length; i += 1) assert.ok(out.findings.some((f: string) => f.startsWith(`mark 'risky-${i}': pattern must not`)), risky[i]);
});

test('a pattern the pre-filter cannot see is stopped by the clock, named, and the marks around it keep their matches', (t) => {
  const marks = [{ ...MARK, id: 'plain', pattern: 'foo\\d+bar' }, { ...MARK, id: 'slow', pattern: '[a]*a*[a]*a*[a]*a*b' }, { ...MARK, id: 'after', pattern: 'oo1' }];
  const r = repo(t, { change: { 'src/a.ts': `foo123bar\n${'a'.repeat(1999)}\n` }, marks: { version: 1, marks } });
  const started = Date.now();
  const out = scanWorkarounds({ root: r.root, base: r.base, head: r.head, budget: { markMs: 500, scanMs: 4000 } });
  assert.ok(Date.now() - started < 3000, `the scan returned within the budget (${Date.now() - started} ms)`);
  assert.deepEqual(out.matches.map((m: any) => [m.mark, m.line]), [['plain', 1], ['after', 1]]);
  // Stopped in its own window, or retried after a slow child start until the scan budget ran out: either way it is named.
  assert.equal(out.findings.length, 1, out.findings.join('\n'));
  assert.match(out.findings[0], /^mark 'slow': (pattern did not finish on the added lines within 500 ms|not checked: the scan's 4000 ms budget ran out)/);
});

test('a glob that would run super-linearly on a file name is stopped by the same clock and the other marks still apply', (t) => {
  const marks = [{ ...MARK, id: 'glob', pattern: 'y', paths: ['**a**a**a**a**a**a**a**a**b'] }, { ...MARK, id: 'plain', pattern: 'raw' }];
  const r = repo(t, { change: { ['a'.repeat(200)]: 'y\n', 'src/a.ts': 'db.raw(1);\n' }, marks: { version: 1, marks } });
  const started = Date.now();
  const out = scanWorkarounds({ root: r.root, base: r.base, head: r.head, budget: { markMs: 500, scanMs: 4000 } });
  assert.ok(Date.now() - started < 3000, `the scan returned within the budget (${Date.now() - started} ms)`);
  assert.deepEqual(out.matches.map((m: any) => [m.mark, m.path]), [['plain', 'src/a.ts']]);
  assert.equal(out.findings.length, 1, out.findings.join('\n'));
  assert.match(out.findings[0], /^mark 'glob': (paths did not finish on the diff's file names within 500 ms|not checked: the scan's 4000 ms budget ran out)/);
});

test('a mark the scan budget never reaches is a finding that names it, never a hang', (t) => {
  const marks = [{ ...MARK, id: 'slow-1', pattern: '[a]*a*[a]*a*[a]*a*b' }, { ...MARK, id: 'slow-2', pattern: 'a*[a]*a*[a]*a*[a]*b' }, { ...MARK, id: 'after', pattern: 'a' }];
  const r = repo(t, { change: { 'src/a.ts': `${'a'.repeat(1999)}\n` }, marks: { version: 1, marks } });
  const started = Date.now();
  const out = scanWorkarounds({ root: r.root, base: r.base, head: r.head, budget: { markMs: 400, scanMs: 600 } });
  assert.ok(Date.now() - started < 2500, `the scan returned within the budget (${Date.now() - started} ms)`);
  assert.deepEqual(out.matches, []);
  for (const id of ['slow-2', 'after']) assert.ok(out.findings.includes(`mark '${id}': not checked: the scan's 600 ms budget ran out`), out.findings.join('\n'));
  assert.ok(out.findings.some((f: string) => f.startsWith("mark 'slow-1': ")), out.findings.join('\n'));
});

test('patterns compile with no flags: matching is case sensitive', (t) => {
  const marks = { version: 1, marks: [{ ...MARK, pattern: 'DB\\.RAW' }] };
  assert.deepEqual(scan(repo(t, { change: { 'src/a.ts': 'db.raw(1);\n' }, marks })).matches, []);
});

test('an unreadable shape is an invalid file with a finding and no matches', (t) => {
  for (const marks of ['{not json', { version: 2, marks: [] }, { version: 1 }, []]) {
    const out = scan(repo(t, { change: { 'src/a.ts': 'db.raw(1);\n' }, marks }));
    assert.equal(out.file, 'invalid', JSON.stringify(marks));
    assert.deepEqual(out.matches, []);
    assert.equal(out.findings.length, 1);
  }
});

test('more than 100 marks reads the first 100 and says so', (t) => {
  const many = Array.from({ length: 101 }, (_, i) => ({ ...MARK, id: `m${i}`, pattern: i === 100 ? 'raw' : 'never-matches' }));
  const out = scan(repo(t, { change: { 'src/a.ts': 'db.raw(1);\n' }, marks: { version: 1, marks: many } }));
  assert.deepEqual(out.matches, []);
  assert.match(out.findings.join('\n'), /101 marks; only the first 100 are read/);
});

test('a line over 2,000 characters is skipped and counted; match text is cut at 200', (t) => {
  const long = `db.raw(${'x'.repeat(2100)})`;
  const mid = `db.raw(${'y'.repeat(300)})`;
  const out = scan(repo(t, { change: { 'src/a.ts': `${long}\n${mid}\n` } }));
  assert.deepEqual(out.matches.map((m: any) => [m.line, m.text.length]), [[2, 200]]);
  assert.deepEqual(out.findings, ['1 added line longer than 2000 characters skipped']);
});

test('the scan stops after 5,000 tested added lines with truncated', (t) => {
  const lines = Array.from({ length: 5002 }, (_, i) => `db.raw(${i});`).join('\n');
  const out = scan(repo(t, { change: { 'src/a.ts': `${lines}\n` } }));
  assert.equal(out.truncated, true);
  assert.equal(out.matches.length, 5000);
  assert.match(out.findings.join('\n'), /stopped after 5000 added lines/);
  const exact = scan(repo(t, { change: { 'src/a.ts': `${Array.from({ length: 5000 }, (_, i) => `db.raw(${i});`).join('\n')}\n` } }));
  assert.deepEqual([exact.truncated, exact.matches.length], [false, 5000]);
});

test('a file name with a space and a deleted file are read correctly', (t) => {
  const r = repo(t, { base: { 'src/gone.ts': 'db.raw(1);\n' }, change: { 'src/with space.ts': 'db.raw(2);\n' } });
  fs.rmSync(path.join(r.root, 'src/gone.ts'));
  assert.deepEqual(scan(r).matches.map((m: any) => m.path), ['src/with space.ts']);
});

test('a diff git cannot produce is a finding, not a throw', (t) => {
  const r = repo(t, { change: { 'src/a.ts': 'db.raw(1);\n' } });
  const out = scanWorkarounds({ root: r.root, base: 'no-such-ref', head: r.head });
  assert.deepEqual(out.matches, []);
  assert.match(out.findings[0], /git diff no-such-ref\.\.\.[0-9a-f]+ failed/);
});
