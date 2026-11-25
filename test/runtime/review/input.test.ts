'use strict';

// 181 D.4 (IC-011): `review --action input` prints what ran on the head commit, then the flows not run.
// It exits 0 whenever git answers, 1 when the head or base cannot be resolved, 2 for usage, and writes nothing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../../helper/tmp.ts');
const { REPO_ROOT } = require('../../../src/helper/repo-root.ts');
const { EvidenceLedger } = require('../../../src/runtime/evidence-ledger.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const SLUG = '181-input';

function envFor(dir: any) {
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.config', 'doflow'), { recursive: true });
  return {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV,
    FORCE_COLOR: '', DOFLOW_TELEMETRY: 'off',
  };
}

function git(cwd: any, env: any, args: any) {
  const res = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, env, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.trim();
}

const put = (root: any, rel: any, text: any) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

/** A scratch repository with a base commit and one change commit; `.doflow/` is excluded as in a real checkout. */
function repo(t: any, { flows = true, evidence = true }: any = {}) {
  const dir = tempDir(t, 'doflow-review-input-');
  const cwd = path.join(dir, 'work');
  fs.mkdirSync(cwd);
  const env: any = envFor(dir);
  git(cwd, env, ['init', '-q', '-b', 'main']);
  put(cwd, '.git/info/exclude', '.doflow/\n');
  put(cwd, 'README.md', 'base\n');
  git(cwd, env, ['add', '-A']);
  git(cwd, env, ['commit', '-q', '-m', 'base']);
  const base = git(cwd, env, ['rev-parse', 'HEAD']);
  put(cwd, 'src/a.ts', 'export {};\n');
  git(cwd, env, ['add', '-A']);
  git(cwd, env, ['commit', '-q', '-m', 'change']);
  const head = git(cwd, env, ['rev-parse', 'HEAD']);
  put(cwd, `.doflow/state/verification/runs/${SLUG}.jsonl`, `${JSON.stringify({
    schema: 2, taskId: SLUG, head, clean: true, verdict: 'PASS', risk: 'LOW',
    checks: [{ tier: 'build', role: 'build', command: 'npm run build', status: 'PASS', exitCode: 0, log: null }],
    at: '2026-11-25T10:00:00.000Z', reportSha256: 'sha256:x',
  })}\n`);
  if (flows) put(cwd, '.doflow/feature-map.json', JSON.stringify({ version: 1, flows: [
    { id: 'login', title: 'A user logs in', expect: 'the dashboard shows' }, { id: 'export', title: 'A user exports', expect: 'a file is written' } ] }));
  if (evidence) {
    const ledger = new EvidenceLedger({ repoRoot: cwd, slug: SLUG });
    ledger.addEvidence({ taskId: SLUG, kind: 'runtime-observation', provenance: 'extracted', source: { provider: 'doflow', capability: 'feature-map' },
      locator: { path: '.doflow/state/verification/logs/login.log' }, content: 'login ran', establishes: ['flow:login'],
      observation: { command: 'node login.js', exitCode: 0 }, freshness: { gitCommit: head } });
    ledger.save(SLUG);
  }
  return { dir, cwd, env, base, head };
}

function input(r: any, args: string[] = []) {
  return spawnSync(process.execPath, [CLI, 'review', '--action', 'input', '--slug', SLUG, ...args], { cwd: r.cwd, env: r.env, encoding: 'utf8' });
}

function snapshot(root: any, out: any = {}, base: any = root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) snapshot(full, out, base);
    else out[path.relative(base, full)] = fs.readFileSync(full, 'latin1');
  }
  return out;
}

test('--json answers head, base, whatRan and notRun, and exits 0', (t) => {
  const r = repo(t);
  const res = input(r, ['--base', r.base, '--json']);
  assert.equal(res.status, 0, res.stderr);
  const json = JSON.parse(res.stdout);
  assert.deepEqual(Object.keys(json), ['ok', 'action', 'head', 'base', 'whatRan', 'notRun', 'workarounds']);
  assert.deepEqual(json.workarounds, { file: 'absent', matches: [], truncated: false, findings: [] });
  assert.deepEqual([json.ok, json.action, json.head, json.base], [true, 'input', r.head, r.base]);
  assert.equal(json.whatRan.head, r.head);
  assert.deepEqual(json.whatRan.verify.checks.map((c: any) => c.command), ['npm run build']);
  assert.deepEqual(json.whatRan.flows.map((f: any) => [f.id, f.status]), [['login', 'passed'], ['export', 'not-run']]);
  assert.deepEqual(json.notRun, [{ id: 'export', title: 'A user exports' }]);
});

test('text prints What ran, then Not run, each item with its command, result and commit', (t) => {
  const r = repo(t);
  const res = input(r, ['--base', r.base]);
  assert.equal(res.status, 0, res.stderr);
  const short = r.head.slice(0, 8);
  const lines = res.stdout.split('\n');
  assert.equal(lines[0], `What ran on ${short} (base ${r.base.slice(0, 8)}):`);
  assert.ok(lines.includes(`- build · npm run build · PASS · exit 0 · commit ${short}`));
  assert.ok(lines.includes(`- flow login · node login.js · passed · login ran · .doflow/state/verification/logs/login.log · commit ${short}`));
  assert.ok(lines.indexOf('Not run:') > lines.findIndex((l: string) => l.startsWith('- flow login')));
  assert.ok(lines.includes(`- Flow export (A user exports): not run on ${short}`));
  assert.ok(!lines.some((l: string) => l.startsWith('- Flow login')), 'a flow that ran is not listed as not run');
});

test('with no evidence and no feature map it still exits 0 and says so', (t) => {
  const r = repo(t, { flows: false, evidence: false });
  fs.rmSync(path.join(r.cwd, '.doflow/state/verification'), { recursive: true });
  const res = input(r, ['--base', r.base]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /- none recorded\n/);
  assert.match(res.stdout, /No feature map: no user-facing flow is shown as run\./);
  const json = JSON.parse(input(r, ['--base', r.base, '--json']).stdout);
  assert.deepEqual([json.whatRan.verify, json.whatRan.flows, json.whatRan.featureMap, json.notRun], [null, [], 'absent', []]);
});

test('a verify run on another head shows no checks and says so', (t) => {
  const r = repo(t);
  const file = path.join(r.cwd, `.doflow/state/verification/runs/${SLUG}.jsonl`);
  const line = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, `${JSON.stringify({ ...line, head: r.base })}\n`);
  const res = input(r, ['--base', r.base]);
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stdout, /npm run build/);
  assert.match(res.stdout, /The latest verify run is not on the head commit; its checks are not shown as evidence for this head\./);
});

test('--base defaults to the merge base with the integration branch', (t) => {
  const r = repo(t);
  git(r.cwd, r.env, ['branch', 'develop', r.head]);
  git(r.cwd, r.env, ['checkout', '-q', '-b', 'feat/x', r.head]);
  put(r.cwd, 'src/b.ts', 'export {};\n');
  git(r.cwd, r.env, ['add', '-A']);
  git(r.cwd, r.env, ['commit', '-q', '-m', 'more']);
  const res = input(r, ['--json']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const json = JSON.parse(res.stdout);
  assert.equal(json.base, r.head, 'the merge base of feat/x and develop');
  assert.notEqual(json.head, r.head);
});

test('exit 1 when the base or the head cannot be resolved, 2 for usage', (t) => {
  const r = repo(t);
  const bad = input(r, ['--base', 'no-such-ref', '--json']);
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).error, 'base-unresolved');

  const empty = tempDir(t, 'doflow-review-input-empty-');
  const noHead = spawnSync(process.execPath, [CLI, 'review', '--action', 'input', '--slug', SLUG, '--base', 'main', '--json'], { cwd: empty, env: r.env, encoding: 'utf8' });
  assert.equal(noHead.status, 1);
  assert.equal(JSON.parse(noHead.stdout).error, 'head-unresolved');

  for (const args of [['--path', 'x.json'], ['--preset', 'review-deep'], ['--slug', '../x'], ['--seats', 'a.json']]) {
    const res = spawnSync(process.execPath, [CLI, 'review', '--action', 'input', ...(args[0] === '--slug' ? [] : ['--slug', SLUG]), ...args, '--json'], { cwd: r.cwd, env: r.env, encoding: 'utf8' });
    assert.equal(res.status, 2, `${args.join(' ')}: ${res.stdout}`);
    assert.ok(['usage', 'invalid-slug'].includes(JSON.parse(res.stdout).error), res.stdout);
  }
  const noSlug = spawnSync(process.execPath, [CLI, 'review', '--action', 'input', '--json'], { cwd: r.cwd, env: r.env, encoding: 'utf8' });
  assert.equal(noSlug.status, 2);
});

const MARKS = { version: 1, marks: [{ id: 'any-cast', pattern: 'as any', paths: ['src/**/*.ts'], reason: 'a cast hides the type error', alternative: 'narrow the type', since: '2026-11-01' }] };

test('a copied workaround pattern is listed after Not run, with file, line, reason and alternative', (t) => {
  const r = repo(t);
  put(r.cwd, 'src/c.ts', 'const a = 1;\nconst b = x as any;\n');
  git(r.cwd, r.env, ['add', '-A']);
  git(r.cwd, r.env, ['commit', '-q', '-m', 'copy']);
  put(r.cwd, '.doflow/workarounds.json', JSON.stringify(MARKS));
  const res = input(r, ['--base', r.base]);
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.split('\n');
  const at = lines.indexOf('Workaround copies:');
  assert.ok(at > lines.indexOf('Not run:'), res.stdout);
  assert.equal(lines[at + 1], '- src/c.ts:2 · any-cast · a cast hides the type error · use instead: narrow the type');
  const json = JSON.parse(input(r, ['--base', r.base, '--json']).stdout);
  assert.deepEqual(json.workarounds.matches.map((m: any) => [m.mark, m.path, m.line, m.reason, m.alternative]),
    [['any-cast', 'src/c.ts', 2, 'a cast hides the type error', 'narrow the type']]);
  assert.equal(json.workarounds.file, 'present');
});

test('a project with no marks reports none; a bad mark shows as a finding and the exit stays 0', (t) => {
  const r = repo(t);
  const quiet = input(r, ['--base', r.base]);
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.match(quiet.stdout, /Workaround copies:\n- none\n?/);
  put(r.cwd, '.doflow/workarounds.json', JSON.stringify({ version: 1, marks: [{ id: 'bad', pattern: '(', paths: ['src/**'], reason: 'r', alternative: 'a', since: '2026-11-01' }] }));
  const res = input(r, ['--base', r.base]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /- Workaround marks: mark 'bad': pattern does not compile/);
});

test('it writes nothing', (t) => {
  const r = repo(t);
  const before = snapshot(r.cwd);
  for (const args of [['--base', r.base], ['--base', r.base, '--json']]) assert.equal(input(r, args).status, 0);
  assert.deepEqual(snapshot(r.cwd), before);
});
