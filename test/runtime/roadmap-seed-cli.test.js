'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { deriveStatus, render, renderRoadmapFile } = require('../../src/runtime/roadmap/rows.ts');

const BIN = path.join(__dirname, '..', '..', 'bin', 'doflow.js');
const GIT_ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.test',
};

/** A throwaway git repo on `develop` with one commit and a seed store; returns the dir. */
function makeRepo(t) {
  const dir = tempDir(t, 'doflow-seed-cli-repo-');
  const git = (...args) => {
    const r = cp.spawnSync('git', args, { cwd: dir, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q', '-b', 'develop');
  const storeDir = path.join(dir, 'agent-docs', 'roadmap');
  fs.mkdirSync(storeDir, { recursive: true });
  const rows = [{ id: '113', slug: '113-toy', title: 'Toy row', class: 'feature', needs: [], writeSet: ['src/toy/'] }];
  const doc = { schema: 1, layout: { worktree: '{mainParent}/{mainName}-{id}', branch: 'feat/{slug}' }, rows };
  fs.writeFileSync(path.join(storeDir, 'rows.json'), JSON.stringify(doc, null, 2) + '\n', 'utf8');
  const { statuses } = deriveStatus(rows, {});
  renderRoadmapFile({ roadmapPath: path.join(storeDir, 'ROADMAP.md'), content: render(rows, statuses) });
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'seed store');
  return dir;
}

function writeDraft(t, rows) {
  const dir = tempDir(t, 'doflow-seed-cli-draft-');
  const file = path.join(dir, 'draft.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 1, rows }), 'utf8');
  return file;
}

/** Run the real CLI with a scratch HOME so nothing touches the machine's own state. */
function run(t, cwd, args) {
  const home = tempDir(t, 'doflow-seed-cli-home-');
  const r = cp.spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), FORCE_COLOR: '' },
  });
  return r;
}

const cleanRow = { id: '114', slug: '114-new', title: 'New row', class: 'feature', needs: ['113'], writeSet: ['src/new/'] };

test('seed check: clean add draft exits 0 with JSON op check, ok true', (t) => {
  const repo = makeRepo(t);
  const draft = writeDraft(t, [cleanRow]);
  const r = run(t, repo, ['roadmap', 'seed', '--action', 'check', '--draft', draft, '--json']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.op, 'check');
  assert.equal(out.ok, true);
});

test('seed check: a finding exits 1 with JSON findings', (t) => {
  const repo = makeRepo(t);
  const draft = writeDraft(t, [{ ...cleanRow, class: 'no-such-class' }]);
  const r = run(t, repo, ['roadmap', 'seed', '--action', 'check', '--draft', draft, '--json']);
  assert.equal(r.status, 1, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.ok(Array.isArray(out.findings) && out.findings.length > 0);
});

test('seed: usage errors exit 2', (t) => {
  const repo = makeRepo(t);
  const draft = writeDraft(t, [cleanRow]);
  const missing = path.join(path.dirname(draft), 'absent.json');
  const cases = {
    'missing --draft': ['roadmap', 'seed', '--action', 'check'],
    'unknown --action': ['roadmap', 'seed', '--action', 'bogus', '--draft', draft],
    'missing --action': ['roadmap', 'seed', '--draft', draft],
    'unreadable draft': ['roadmap', 'seed', '--action', 'check', '--draft', missing],
  };
  for (const [name, args] of Object.entries(cases)) {
    const r = run(t, repo, args);
    assert.equal(r.status, 2, `${name}: ${r.stderr}${r.stdout}`);
  }
});

test('seed is a sub-verb, not the project root: runs from the cwd with no positional', (t) => {
  const repo = makeRepo(t);
  const draft = writeDraft(t, [cleanRow]);
  const r = run(t, repo, ['roadmap', 'seed', '--action', 'check', '--draft', draft, '--json']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(fs.existsSync(path.join(repo, 'seed')), false);
});

test('a positional project root after seed is honoured from another cwd', (t) => {
  const repo = makeRepo(t);
  const draft = writeDraft(t, [cleanRow]);
  const elsewhere = tempDir(t, 'doflow-seed-cli-elsewhere-');
  const r = run(t, elsewhere, ['roadmap', 'seed', repo, '--action', 'check', '--draft', draft, '--json']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(JSON.parse(r.stdout).op, 'check');
});

test('control: roadmap --action render still works in the same repo', (t) => {
  const repo = makeRepo(t);
  const r = run(t, repo, ['roadmap', '--action', 'render']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
});
