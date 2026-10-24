'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const verify = require('../../bench/retrieval/lib/verbs/verify.ts');
const runner = require('../../bench/retrieval/runner.ts');
const snap = require('../../bench/retrieval/lib/snapshot.ts');
const { tempDir } = require('../helper/tmp.ts');

const gitIn = (dir, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', dir, ...args], { encoding: 'utf8' }).trim();
const NODE_TOOL = { id: 'git', versionCommand: [process.execPath, '--version'], versionLine: process.version, state: 'present' };
const GHOST = { id: 'fd', versionCommand: ['doflow-no-such-binary-074', '--version'], versionLine: null, state: 'absent' };

function pinned(t, { tools = [NODE_TOOL, GHOST], env } = {}) {
  const repo = tempDir(t, 'doflow-verify-');
  gitIn(repo, 'init', '-q');
  for (const [f, body] of Object.entries({ 'src/a.ts': 'a\n', 'core/shared/guidance/g.md': '# g\n', 'docs/x.md': 'x\n' })) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), body);
  }
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'c');
  const commit = gitIn(repo, 'rev-parse', 'HEAD');
  const outDir = path.join(repo, 'bench', 'retrieval');
  snap.writeInitial({ commit, seed: 1, repoRoot: repo, outDir, tools, env });
  return { repo, commit, snapshotPath: path.join(outDir, 'snapshot.json'), manifestPath: path.join(outDir, 'manifest.json') };
}

const edit = (file, fn) => { const v = JSON.parse(fs.readFileSync(file, 'utf8')); fn(v); fs.writeFileSync(file, JSON.stringify(v, null, 2)); };

test('a pinned snapshot verifies with exit 0 and the IC-002 body', (t) => {
  const p = pinned(t);
  const out = verify.verifySnapshot({ snapshotPath: p.snapshotPath, repoRoot: p.repo });
  assert.equal(out.exitCode, 0);
  assert.equal(out.result.commit, p.commit);
  assert.equal(out.result.manifest.ok, true);
  assert.equal(out.result.manifest.expected, out.result.manifest.actual);
  assert.deepEqual(out.result.tools.map((x) => [x.id, x.ok, x.state]), [['git', true, 'present'], ['fd', true, 'absent']]);
  assert.deepEqual(out.result.env.differs, []);
});

test('a missing commit exits 3 with the fetch-full-history message', (t) => {
  const p = pinned(t);
  edit(p.snapshotPath, (s) => { s.commit = 'e'.repeat(40); });
  const out = verify.verifySnapshot({ snapshotPath: p.snapshotPath, repoRoot: p.repo });
  assert.equal(out.exitCode, 3);
  assert.equal(out.message, `pinned commit ${'e'.repeat(40)} is absent (shallow clone or unfetched); fetch full history`);
});

test('a changed manifest entry exits 3 and lists what moved', (t) => {
  const p = pinned(t);
  edit(p.manifestPath, (m) => { m.entries.find((e) => e.path === 'src/a.ts').blob = '0'.repeat(40); m.entries.push({ path: 'src/ghost.ts', corpus: 'code', blob: '1'.repeat(40), bytes: 1 }); });
  const out = verify.verifySnapshot({ snapshotPath: p.snapshotPath, repoRoot: p.repo });
  assert.equal(out.exitCode, 3);
  assert.equal(out.result.manifest.ok, false);
  assert.deepEqual(out.result.manifest.changed, ['src/a.ts']);
  assert.deepEqual(out.result.manifest.removed, ['src/ghost.ts']);
  fs.rmSync(p.manifestPath);
  assert.match(verify.verifySnapshot({ snapshotPath: p.snapshotPath, repoRoot: p.repo }).message, /manifest file is missing/);
  const p2 = pinned(t);
  edit(p2.snapshotPath, (s) => { s.manifestSha256 = 'f'.repeat(64); });
  assert.equal(verify.verifySnapshot({ snapshotPath: p2.snapshotPath, repoRoot: p2.repo }).exitCode, 3, 'the snapshot digest is checked too');
});

test('a tool version or presence change exits 4; manifest drift still outranks it', (t) => {
  const p = pinned(t);
  edit(p.snapshotPath, (s) => { s.tools[0].versionLine = 'v0.0.0'; });
  const out = verify.verifySnapshot({ snapshotPath: p.snapshotPath, repoRoot: p.repo });
  assert.equal(out.exitCode, 4);
  assert.match(out.message, /tool git: pinned "v0.0.0"/);
  const q = pinned(t);
  edit(q.snapshotPath, (s) => { s.tools[1] = { ...NODE_TOOL, id: 'fd' }; s.tools[1].state = 'absent'; s.tools[1].versionLine = null; });
  assert.equal(verify.verifySnapshot({ snapshotPath: q.snapshotPath, repoRoot: q.repo }).exitCode, 4, 'pinned absent but installed');
  edit(p.manifestPath, (m) => { m.entries = []; });
  assert.equal(verify.verifySnapshot({ snapshotPath: p.snapshotPath, repoRoot: p.repo }).exitCode, 3);
});

test('a different node, os or arch is reported and is not a failure', (t) => {
  const p = pinned(t, { env: { node: 'v0.0.1', os: 'plan9', arch: 'mips' } });
  const out = verify.verifySnapshot({ snapshotPath: p.snapshotPath, repoRoot: p.repo });
  assert.equal(out.exitCode, 0);
  assert.deepEqual(out.result.env.differs, ['node', 'os', 'arch']);
});

test('through the runner: --json carries the header first and the IC-002 fields after', (t) => {
  const p = pinned(t);
  const lines = [];
  const code = runner.main(['verify', '--json', '--snapshot', p.snapshotPath], { repoRoot: p.repo, out: (m) => lines.push(m), err: () => {} });
  assert.equal(code, 0);
  const obj = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(obj), ['verb', 'ok', 'exitCode', 'snapshotId', 'commit', 'manifest', 'tools', 'env']);
  assert.equal(obj.snapshotId, '1');
  edit(p.snapshotPath, (s) => { s.commit = 'd'.repeat(40); });
  const err = [];
  const lines2 = [];
  assert.equal(runner.main(['verify', '--json', '--snapshot', p.snapshotPath], { repoRoot: p.repo, out: (m) => lines2.push(m), err: (m) => err.push(m) }), 3);
  assert.match(JSON.parse(lines2[0]).error, /is absent/);
});

test('verifySnapshot: tool probe child env lacks DOFLOW_HOLDOUT_KEY and *_API_KEY', (t) => {
  const prevHoldout = process.env.DOFLOW_HOLDOUT_KEY;
  const prevApiKey = process.env.TEST_API_KEY;
  process.env.DOFLOW_HOLDOUT_KEY = 'secret-holdout-12345';
  process.env.TEST_API_KEY = 'secret-api-key';
  try {
    const probeTool = {
      id: 'git',
      versionCommand: [
        process.execPath,
        '-e',
        'if (process.env.DOFLOW_HOLDOUT_KEY || process.env.TEST_API_KEY) { console.log("leaked"); } else { console.log("clean"); }',
      ],
      versionLine: 'clean',
      state: 'present',
    };
    const p = pinned(t, { tools: [probeTool] });
    const out = verify.verifySnapshot({ snapshotPath: p.snapshotPath, repoRoot: p.repo });
    assert.equal(out.exitCode, 0);
    assert.equal(out.result.tools[0].ok, true);
    assert.equal(out.result.tools[0].actual, 'clean');
  } finally {
    if (prevHoldout !== undefined) process.env.DOFLOW_HOLDOUT_KEY = prevHoldout; else delete process.env.DOFLOW_HOLDOUT_KEY;
    if (prevApiKey !== undefined) process.env.TEST_API_KEY = prevApiKey; else delete process.env.TEST_API_KEY;
  }
});
