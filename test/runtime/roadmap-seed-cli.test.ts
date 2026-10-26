'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { deriveStatus, render, renderRoadmapFile } = require('../../src/runtime/roadmap/rows.ts');

const BIN = path.join(__dirname, '..', '..', 'bin', 'doflow.js');
const GIT_ENV: any = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.test',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.test',
};

/** A throwaway git repo on `develop` with one commit and a seed store; returns the dir. */
function makeRepo(t: any) {
  const dir = tempDir(t, 'doflow-seed-cli-repo-');
  const git = (...args: any[]) => {
    const r = cp.spawnSync('git', args, { cwd: dir, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q', '-b', 'develop');
  const storeDir = path.join(dir, 'agent-docs', 'roadmap');
  fs.mkdirSync(storeDir, { recursive: true });
  const rows: any = [{ id: '113', slug: '113-toy', title: 'Toy row', class: 'feature', needs: [], writeSet: ['src/toy/'] }];
  const doc: any = { schema: 1, layout: { worktree: '{mainParent}/{mainName}-{id}', branch: 'feat/{slug}' }, rows };
  fs.writeFileSync(path.join(storeDir, 'rows.json'), JSON.stringify(doc, null, 2) + '\n', 'utf8');
  const { statuses } = deriveStatus(rows, {});
  renderRoadmapFile({ roadmapPath: path.join(storeDir, 'ROADMAP.md'), content: render(rows, statuses) });
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'seed store');
  return dir;
}

/** A throwaway git repo on `develop` without an initialized roadmap store. */
function makeRepoWithoutStore(t: any) {
  const dir = tempDir(t, 'doflow-seed-cli-no-store-');
  const git = (...args: any[]) => {
    const r = cp.spawnSync('git', args, { cwd: dir, env: { ...process.env, ...GIT_ENV }, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q', '-b', 'develop');
  fs.writeFileSync(path.join(dir, 'README.md'), 'empty roadmap fixture\n', 'utf8');
  git('add', 'README.md');
  git('-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'initial commit');
  return dir;
}

function writeDraft(t: any, rows: any) {
  const dir = tempDir(t, 'doflow-seed-cli-draft-');
  const file = path.join(dir, 'draft.json');
  fs.writeFileSync(file, JSON.stringify({ schema: 1, rows }), 'utf8');
  return file;
}

/** Run the real CLI with a scratch HOME so nothing touches the machine's own state. */
function run(t: any, cwd: any, args: any, options: any = {}) {
  const home: any = options.home || tempDir(t, 'doflow-seed-cli-home-');
  const baseEnv: any = { ...process.env };
  delete baseEnv.DOFLOW_AUTOPILOT_ENABLED;
  const r: any = cp.spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...baseEnv,
      ...GIT_ENV,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      FORCE_COLOR: '',
      ...options.env,
    },
  });
  return r;
}

const cleanRow: any = { id: '114', slug: '114-new', title: 'New row', class: 'feature', needs: ['113'], writeSet: ['src/new/'] };

test('seed check: clean add draft exits 0 with JSON op check, ok true', (t) => {
  const repo = makeRepo(t);
  const draft = writeDraft(t, [cleanRow]);
  const r = run(t, repo, ['roadmap', 'seed', '--action', 'check', '--draft', draft, '--json']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.op, 'check');
  assert.equal(out.ok, true);
});

test('seed check: missing roadmap store is empty and returns the person-only land command', (t) => {
  const repo = makeRepoWithoutStore(t);
  const draft = writeDraft(t, [{ ...cleanRow, needs: [] }]);
  const storeDir = path.join(repo, 'agent-docs', 'roadmap');
  assert.equal(fs.existsSync(storeDir), false);

  const r = run(t, repo, ['roadmap', 'seed', '--action', 'check', '--draft', draft, '--json']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.seed.sha256, null);
  assert.equal(out.land, `doflow roadmap seed ${repo} --action apply --draft ${draft}`);
  assert.equal(fs.existsSync(storeDir), false, 'check does not create the missing store');
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
  const cases: any = {
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

test('C-7: relative --draft resolves against process cwd, not positional project root', (t) => {
  const repo = makeRepo(t);
  const repoRow: any = { id: '115', slug: '115-repo', title: 'Repo draft row', class: 'feature', needs: ['113'], writeSet: ['src/repo/'] };
  fs.writeFileSync(path.join(repo, 'draft.json'), JSON.stringify({ schema: 1, rows: [repoRow] }), 'utf8');

  const otherDir = tempDir(t, 'doflow-seed-cli-cwd-');
  const cwdRow: any = { id: '116', slug: '116-cwd', title: 'Cwd draft row', class: 'feature', needs: ['113'], writeSet: ['src/cwd/'] };
  fs.writeFileSync(path.join(otherDir, 'draft.json'), JSON.stringify({ schema: 1, rows: [cwdRow] }), 'utf8');

  // Check from otherDir targeting repo: reports draft.path equal to otherDir/draft.json
  const rCheck = run(t, otherDir, ['roadmap', 'seed', repo, '--action', 'check', '--draft', 'draft.json', '--json']);
  assert.equal(rCheck.status, 0, rCheck.stderr + rCheck.stdout);
  const outCheck = JSON.parse(rCheck.stdout);
  assert.equal(fs.realpathSync(outCheck.draft.path), fs.realpathSync(path.join(otherDir, 'draft.json')));

  // Apply from otherDir targeting repo: row in repo's rows.json is the cwd draft's
  const rApply = run(t, otherDir, ['roadmap', 'seed', repo, '--action', 'apply', '--draft', 'draft.json', '--json']);
  assert.equal(rApply.status, 0, rApply.stderr + rApply.stdout);
  const storeDoc = JSON.parse(fs.readFileSync(path.join(repo, 'agent-docs', 'roadmap', 'rows.json'), 'utf8'));
  assert.ok(storeDoc.rows.some((r: any) => r.id === '116'), 'cwd row 116 must be present in rows.json');
  assert.ok(!storeDoc.rows.some((r: any) => r.id === '115'), 'repo row 115 must not be present in rows.json');

  // Third case: relative --draft with no positional still resolves against cwd
  const rNoPos = run(t, repo, ['roadmap', 'seed', '--action', 'check', '--draft', 'draft.json', '--json']);
  assert.equal(rNoPos.status, 0, rNoPos.stderr + rNoPos.stdout);
  const outNoPos = JSON.parse(rNoPos.stdout);
  assert.equal(fs.realpathSync(outNoPos.draft.path), fs.realpathSync(path.join(repo, 'draft.json')));
});

test('C-10 CLI (a): settings on lands an apply proposed; promote from a spawned process is refused needs-person-tty', (t) => {
  // maint-thin (2026-10-26): gating moved from the write to the activation. The write lands proposed; promote needs a person.
  const home = tempDir(t, 'doflow-seed-cli-home-');
  const settingsDir = path.join(home, '.config', 'doflow');
  fs.mkdirSync(settingsDir, { recursive: true });
  const settingsPath = path.join(settingsDir, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify({ schema: 1, 'autopilot.enabled': 'on' }), 'utf8');

  const repo = makeRepo(t);
  const draft = writeDraft(t, [cleanRow]);
  const storePath = path.join(repo, 'agent-docs', 'roadmap', 'rows.json');

  const rJson = run(t, repo, ['roadmap', 'seed', '--action', 'apply', '--draft', draft, '--json'], { home });
  assert.equal(rJson.status, 0, rJson.stderr + rJson.stdout);
  assert.deepEqual(JSON.parse(rJson.stdout).proposed, ['114']);
  assert.equal(JSON.parse(fs.readFileSync(storePath, 'utf8')).rows.find((r: any) => r.id === '114').proposed, true);
  const rCheck = run(t, repo, ['roadmap', '--action', 'render', '--check'], { home });
  assert.equal(rCheck.status, 0, rCheck.stderr + rCheck.stdout);

  // promote is person-only: a spawned CLI has no terminal on stdin, so it is refused needs-person-tty, and an
  // empty or "off" config home (the env redirect a model controls) does not change that.
  const before = fs.readFileSync(storePath, 'utf8');
  const rRefused = run(t, repo, ['roadmap', 'promote', '114', '--json'], { home });
  assert.equal(rRefused.status, 1, rRefused.stderr + rRefused.stdout);
  assert.equal(JSON.parse(rRefused.stdout).reason, 'needs-person-tty');
  fs.writeFileSync(settingsPath, JSON.stringify({ schema: 1, 'autopilot.enabled': 'off' }), 'utf8');
  const rOff = run(t, repo, ['roadmap', 'promote', '114', '--json'], { home });
  assert.equal(rOff.status, 1, rOff.stderr + rOff.stdout);
  assert.equal(JSON.parse(rOff.stdout).reason, 'needs-person-tty');
  const rEmpty = run(t, repo, ['roadmap', 'promote', '114'], { home: tempDir(t, 'doflow-seed-cli-empty-home-') });
  assert.equal(rEmpty.status, 1, rEmpty.stderr + rEmpty.stdout);
  assert.match(rEmpty.stderr, /refused: needs-person-tty/);
  assert.equal(fs.readFileSync(storePath, 'utf8'), before);
  const rCheck2 = run(t, repo, ['roadmap', '--action', 'render', '--check'], { home });
  assert.equal(rCheck2.status, 0, rCheck2.stderr + rCheck2.stdout);
});

test('C-10 CLI (b): settings off allows apply and amend with writes: 2 and passes render --check', (t) => {
  const home = tempDir(t, 'doflow-seed-cli-home-');
  const settingsDir = path.join(home, '.config', 'doflow');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({ schema: 1, 'autopilot.enabled': 'off' }), 'utf8');

  const repo = makeRepo(t);
  const draft = writeDraft(t, [cleanRow]);

  const rApply = run(t, repo, ['roadmap', 'seed', '--action', 'apply', '--draft', draft, '--json'], { home });
  assert.equal(rApply.status, 0, rApply.stderr + rApply.stdout);
  const outApply = JSON.parse(rApply.stdout);
  assert.equal(outApply.writes, 2);

  const rCheck1 = run(t, repo, ['roadmap', '--action', 'render', '--check'], { home });
  assert.equal(rCheck1.status, 0, rCheck1.stderr + rCheck1.stdout);

  const amendRow: any = { ...cleanRow, title: 'Amended title for cleanRow' };
  const amendDraft = writeDraft(t, [amendRow]);
  const rAmend = run(t, repo, ['roadmap', 'seed', '--action', 'amend', '--draft', amendDraft, '--json'], { home });
  assert.equal(rAmend.status, 0, rAmend.stderr + rAmend.stdout);

  const rCheck2 = run(t, repo, ['roadmap', '--action', 'render', '--check'], { home });
  assert.equal(rCheck2.status, 0, rCheck2.stderr + rCheck2.stdout);
});

test('C-10 CLI (b): no settings file allows apply and amend with writes: 2 and passes render --check', (t) => {
  const home = tempDir(t, 'doflow-seed-cli-home-');

  const repo = makeRepo(t);
  const draft = writeDraft(t, [cleanRow]);

  const rApply = run(t, repo, ['roadmap', 'seed', '--action', 'apply', '--draft', draft, '--json'], { home });
  assert.equal(rApply.status, 0, rApply.stderr + rApply.stdout);
  const outApply = JSON.parse(rApply.stdout);
  assert.equal(outApply.writes, 2);

  const rCheck1 = run(t, repo, ['roadmap', '--action', 'render', '--check'], { home });
  assert.equal(rCheck1.status, 0, rCheck1.stderr + rCheck1.stdout);

  const amendRow: any = { ...cleanRow, title: 'Amended title for cleanRow' };
  const amendDraft = writeDraft(t, [amendRow]);
  const rAmend = run(t, repo, ['roadmap', 'seed', '--action', 'amend', '--draft', amendDraft, '--json'], { home });
  assert.equal(rAmend.status, 0, rAmend.stderr + rAmend.stdout);

  const rCheck2 = run(t, repo, ['roadmap', '--action', 'render', '--check'], { home });
  assert.equal(rCheck2.status, 0, rCheck2.stderr + rCheck2.stdout);
});

test('C-10 CLI (c): settings on + env DOFLOW_AUTOPILOT_ENABLED=off still lands proposed (fail closed, closes C-2 end to end)', (t) => {
  const home = tempDir(t, 'doflow-seed-cli-home-');
  const settingsDir = path.join(home, '.config', 'doflow');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({ schema: 1, 'autopilot.enabled': 'on' }), 'utf8');

  const repo = makeRepo(t);
  const draft = writeDraft(t, [cleanRow]);
  const storePath = path.join(repo, 'agent-docs', 'roadmap', 'rows.json');

  const r = run(t, repo, ['roadmap', 'seed', '--action', 'apply', '--draft', draft, '--json'], {
    home,
    env: { DOFLOW_AUTOPILOT_ENABLED: 'off' },
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(JSON.parse(r.stdout).proposed, ['114']);
  assert.equal(JSON.parse(fs.readFileSync(storePath, 'utf8')).rows.find((x: any) => x.id === '114').proposed, true);
});

test('C-10 CLI (d): amend with settings on lands the amended row proposed', (t) => {
  const home = tempDir(t, 'doflow-seed-cli-home-');
  const settingsDir = path.join(home, '.config', 'doflow');
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({ schema: 1, 'autopilot.enabled': 'on' }), 'utf8');

  const repo = makeRepo(t);
  const amendDraft = writeDraft(t, [{ id: '113', slug: '113-toy', title: 'Amended toy row', class: 'feature', needs: [], writeSet: ['src/toy/'] }]);
  const storePath = path.join(repo, 'agent-docs', 'roadmap', 'rows.json');

  const r = run(t, repo, ['roadmap', 'seed', '--action', 'amend', '--draft', amendDraft, '--json'], { home });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(JSON.parse(r.stdout).proposed, ['113']);
  const row = JSON.parse(fs.readFileSync(storePath, 'utf8')).rows.find((x: any) => x.id === '113');
  assert.equal(row.title, 'Amended toy row');
  assert.equal(row.proposed, true);
});

test('maint-thin: a spawned seed apply with an empty config home (reads as off) lands the row proposed, not ready', (t) => {
  const home = tempDir(t, 'doflow-seed-cli-empty-home-');
  const repo = makeRepo(t);
  const draft = writeDraft(t, [cleanRow]);
  const r = run(t, repo, ['roadmap', 'seed', '--action', 'apply', '--draft', draft, '--json'], { home });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.deepEqual(JSON.parse(r.stdout).proposed, ['114']);
  const stored = JSON.parse(fs.readFileSync(path.join(repo, 'agent-docs', 'roadmap', 'rows.json'), 'utf8')).rows.find((x: any) => x.id === '114');
  assert.equal(stored.proposed, true);
});
