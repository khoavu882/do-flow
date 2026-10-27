'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { mergeRoadmapRow, readOpenIntents, cleanupFeature } = require('../../src/runtime/roadmap/merge.ts');

function fixture(t: any, conflict: any = false) {
  const dir = tempDir(t, 'doflow-roadmap-merge-');
  const root = path.join(dir, 'main'), develop = path.join(dir, 'develop'), feature = path.join(dir, 'feature');
  fs.mkdirSync(root);
  const env: any = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV, GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.test', GIT_COMMITTER_NAME: 'Owner',
    GIT_COMMITTER_EMAIL: 'owner@example.test', GIT_AUTHOR_DATE: '1792400000 +0700', GIT_COMMITTER_DATE: '1792400000 +0700' };
  const git = (cwd: any, ...args: any[]) => cp.execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Develop Owner');
  git(root, 'config', 'user.email', 'develop@example.test');
  git(root, 'config', 'core.hooksPath', '/dev/null');
  fs.writeFileSync(path.join(root, '.gitignore'), '.doflow/\nagent-docs/\n');
  fs.writeFileSync(path.join(root, 'shared.txt'), 'base\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'base');
  git(root, 'worktree', 'add', '-qb', 'develop', develop);
  git(root, 'worktree', 'add', '-qb', 'feat/113-toy', feature);
  fs.writeFileSync(path.join(feature, conflict ? 'shared.txt' : 'feature.txt'), 'feature\n');
  git(feature, 'add', '.'); git(feature, 'commit', '-qm', 'feature');
  fs.writeFileSync(path.join(develop, conflict ? 'shared.txt' : 'develop.txt'), 'develop\n');
  git(develop, 'add', '.'); git(develop, 'commit', '-qm', 'develop');
  const featureHead = git(feature, 'rev-parse', 'HEAD'), developHead = git(develop, 'rev-parse', 'HEAD');
  const row: any = { id: '113', slug: '113-toy', title: 'Toy', class: 'feature', needs: [], writeSet: ['feature.txt'] };
  const seed = path.join(root, 'agent-docs', 'roadmap'); fs.mkdirSync(seed, { recursive: true });
  fs.writeFileSync(path.join(seed, 'rows.json'), JSON.stringify({ schema: 1, rows: [row] }));
  const options: any = { root, row, runId: 'rl-test', approvedHead: featureHead, developWorktree: develop,
    featureWorktree: feature, gate: { id: 'gate-b', digest: `sha256:${'a'.repeat(64)}` }, env,
    now: () => 1792400000000, postMergeCheck: () => ({ ok: true }) };
  return { dir, root, develop, feature, git, options, featureHead, developHead };
}

test('merge rejects a missing, empty, or multi-line row title', async (t) => {
  const f = fixture(t);
  for (const title of [undefined, '', '  ', 'Line one\nLine two', 'Line one\rLine two']) {
    await assert.rejects(mergeRoadmapRow({ ...f.options, row: { ...f.options.row, title } }), /invalid merge row/);
  }
});

test('plumbing makes a two-parent owner merge, renders once, cleans non-force, and never changes remote refs', async (t): Promise<any> => {
  const f = fixture(t), remote = path.join(f.dir, 'remote.git');
  f.git(f.root, 'init', '--bare', '-q', remote);
  f.git(f.root, 'remote', 'add', 'origin', `file://${remote}`);
  const refs = f.git(remote, 'for-each-ref');
  const calls: any = [], phases: any = [];
  const result = await mergeRoadmapRow({ ...f.options, onPhase: (p: any) => phases.push(p),
    execFileSync(binary: any, args: any, opts: any) { calls.push(args); return cp.execFileSync(binary, args, opts); },
    postMergeCheck(input: any) {
      assert.equal(input.cwd, f.develop); assert.equal(input.head, f.git(f.develop, 'rev-parse', 'HEAD'));
      // The check reads a verify record for this head; the merge passes nothing else.
      assert.deepEqual(Object.keys(input).sort(), ['cwd', 'head']);
      assert.ok(!fs.existsSync(path.join(f.root, 'agent-docs/roadmap/ROADMAP.md')));
      assert.ok(fs.existsSync(f.feature)); return { ok: true };
    } });
  assert.equal(result.outcome, 'merged');
  assert.equal(f.git(f.develop, 'show', '-s', '--format=%P', result.commit), `${f.developHead} ${f.featureHead}`);
  assert.match(f.git(f.develop, 'show', '-s', '--format=%B', result.commit), /DoFlow-Row: 113\nDoFlow-Policy: gate-b@sha256:a+/);
  assert.equal(f.git(f.develop, 'show', '-s', '--format=%an <%ae>|%cn <%ce>', result.commit),
    'Develop Owner <develop@example.test>|Develop Owner <develop@example.test>');
  assert.doesNotMatch(f.git(f.develop, 'show', '-s', '--format=%B', result.commit), /co-authored-by/i);
  assert.deepEqual(phases, ['intent', 'built', 'ff-started', 'ff-done', 'rendered', 'cleaned']);
  assert.equal(result.fileWrites, 1); assert.equal(fs.existsSync(f.feature), false);
  const archivedIntent = path.join(f.root, '.doflow/state/roadmap/done/113.json');
  assert.equal(fs.existsSync(archivedIntent), true, 'cleaned intents move to the sibling done namespace');
  assert.equal(fs.existsSync(path.join(f.root, '.doflow/state/roadmap/intents/done/113.json')), false);
  assert.equal(JSON.parse(fs.readFileSync(archivedIntent, 'utf8')).phase, 'cleaned');
  assert.ok(calls.some((args: any) => args.includes('branch') && args.includes('-d')));
  assert.ok(!calls.flat().some((arg: any) => ['-D', '--force', '-f', 'push', 'fetch', 'pull'].includes(arg)));
  assert.equal(f.git(remote, 'for-each-ref'), refs);
  assert.deepEqual(readOpenIntents({ root: f.root }), []);
  const again = await mergeRoadmapRow(f.options);
  assert.equal(again.commit, result.commit); assert.equal(again.fileWrites, 0);
  assert.equal(f.git(f.develop, 'rev-list', '--first-parent', '--count', '--merges', 'HEAD'), '1');
});

test('conflict leaves both heads and develop porcelain byte-equal', async (t) => {
  const f = fixture(t, true);
  const snapshot = () => [f.git(f.develop, 'rev-parse', 'HEAD'), f.git(f.feature, 'rev-parse', 'HEAD'),
    cp.execFileSync('git', ['-C', f.develop, 'status', '--porcelain', '--untracked-files=all'])];
  const before = snapshot();
  assert.equal((await mergeRoadmapRow(f.options)).reason, 'merge-conflict');
  assert.deepEqual(snapshot(), before);
});

for (const reason of ['develop-dirty', 'develop-wrong-branch', 'develop-moved', 'head-moved', 'git-too-old', 'no-develop-worktree']) {
  test(`merge denies ${reason} and keeps the feature`, async (t) => {
    const f = fixture(t); let options: any = { ...f.options };
    if (reason === 'develop-dirty') fs.writeFileSync(path.join(f.develop, 'dirty'), 'owner bytes');
    if (reason === 'develop-wrong-branch') options.developWorktree = f.root;
    if (reason === 'head-moved') options.approvedHead = f.developHead;
    if (reason === 'no-develop-worktree') options.developWorktree = path.join(f.dir, 'missing');
    if (reason === 'git-too-old') options.execFileSync = (bin: any, args: any, opts: any) => args.includes('--version') ? 'git version 2.37.9\n' : cp.execFileSync(bin, args, opts);
    if (reason === 'develop-moved') options.onPhase = (phase: any) => {
      if (phase === 'built') f.git(f.develop, 'commit', '--allow-empty', '-qm', 'moved');
    };
    assert.equal((await mergeRoadmapRow(options)).reason, reason);
    assert.ok(fs.existsSync(f.feature));
  });
}

test('post-ff failure persists merged-unverified, renders nothing and denies cleanup until a successful recheck', async (t) => {
  const f = fixture(t);
  const result = await mergeRoadmapRow({ ...f.options, postMergeCheck: () => ({ ok: false, failed: ['guards'] }) });
  assert.equal(result.status, 'merged-unverified'); assert.equal(result.phase, 'ff-done');
  assert.equal(f.git(f.develop, 'rev-parse', 'HEAD'), result.commit);
  assert.equal(fs.existsSync(path.join(f.root, 'agent-docs/roadmap/ROADMAP.md')), false);
  assert.ok(fs.existsSync(f.feature));
  assert.equal(readOpenIntents({ root: f.root })[0].status, 'merged-unverified');
  const source = `require(${JSON.stringify(path.resolve(__dirname, '../../src/runtime/roadmap/loop.ts'))}).handleRoadmapCommand({ action:'status',json:true,root:process.argv[1] });`;
  const status = JSON.parse(cp.execFileSync(process.execPath, ['-e', source, f.root], { env: f.options.env, encoding: 'utf8' }));
  assert.equal(status.openIntents[0].phase, 'ff-done');
  assert.equal(status.rows[0].status, 'merged-unverified'); assert.equal(status.rowStatus['113'], 'merged-unverified');
  assert.equal((await mergeRoadmapRow(f.options)).outcome, 'merged');
});

test('status names the open intent in JSON and text, and corrupt intent reads fail closed', async (t) => {
  const f = fixture(t);
  await assert.rejects(mergeRoadmapRow({ ...f.options, onPhase: (p: any) => { if (p === 'intent') throw new Error('crash'); } }));
  const modulePath = path.resolve(__dirname, '../../src/runtime/roadmap/loop.ts');
  const invoke = (json: any) => cp.spawnSync(process.execPath, ['-e', `require(${JSON.stringify(modulePath)}).handleRoadmapCommand({action:'status',row:'113',json:${json},root:process.argv[1]});`, f.root], { env: f.options.env, encoding: 'utf8' });
  const status = invoke(true); assert.equal(status.status, 0); assert.equal(JSON.parse(status.stdout).intent.phase, 'intent');
  assert.match(invoke(false).stdout, /Open merge intent: intent/);
  fs.writeFileSync(path.join(f.root, '.doflow/state/roadmap/intents/113.json'), '{bad');
  const broken = invoke(true); assert.equal(broken.status, 1);
  assert.deepEqual(JSON.parse(broken.stdout).sources, ['merge-intents']);
});

test('missing or throwing lean checker fails closed after ff', async (t) => {
  for (const postMergeCheck of [undefined, () => { throw new Error('check unavailable'); }]) {
    const f = fixture(t);
    assert.equal((await mergeRoadmapRow({ ...f.options, postMergeCheck })).status, 'merged-unverified');
    assert.ok(fs.existsSync(f.feature));
  }
});

test('dirty feature is kept after render; no force removal or branch deletion', async (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.feature, 'local'), 'keep');
  const result = await mergeRoadmapRow(f.options);
  assert.equal(result.cleanup, 'cleanup-kept'); assert.ok(fs.existsSync(f.feature));
  assert.equal(f.git(f.root, 'rev-parse', 'refs/heads/feat/113-toy'), f.featureHead);
  assert.equal(readOpenIntents({ root: f.root })[0].phase, 'rendered');
});

test('unreadable facts are named and block render and cleanup', async (t) => {
  const f = fixture(t);
  const result = await mergeRoadmapRow({ ...f.options, gatherFacts: () => ({ unreadable: ['merges'] }) });
  assert.equal(result.error, 'cannot-read-facts'); assert.deepEqual(result.sources, ['merges']);
  assert.ok(fs.existsSync(f.feature));
});

test('intent records keep only declared gate fields and never copy caller text or check output', async (t) => {
  const f = fixture(t), canary = 'CHAT-CANARY-do-not-record';
  await mergeRoadmapRow({ ...f.options, gate: { ...f.options.gate, note: canary },
    env: { ...f.options.env, REQUEST_TEXT: canary }, postMergeCheck: () => ({ ok: false, output: canary }) });
  const file = path.join(f.root, '.doflow/state/roadmap/intents/113.json');
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /CHAT-CANARY/);
  assert.deepEqual(JSON.parse(raw).gate, f.options.gate);
  // win32 reports 0o666 for every writable file; owner-only bits cannot be expressed there
  assert.equal(fs.statSync(file).mode & 0o777, process.platform === 'win32' ? 0o666 : 0o600);
});

test('kill switch is re-read before commit, ff, render and cleanup; a recorded ff-started never spawns once off', async (t) => {
  for (const stopAt of ['intent', 'built', 'ff-started', 'ff-done', 'rendered']) {
    const f = fixture(t); let stopped = false;
    const result = await mergeRoadmapRow({ ...f.options, isEnabled: () => ({ enabled: !stopped, switch: 'sentinel' }),
      onPhase: (phase: any) => { if (phase === stopAt) stopped = true; } });
    assert.equal(result.outcome, 'stopped'); assert.equal(result.annotations.switch, 'sentinel');
    if (['ff-started', 'ff-done', 'rendered'].includes(stopAt)) assert.equal(result.phase, stopAt);
    if (stopAt === 'ff-started') assert.equal(f.git(f.develop, 'rev-parse', 'HEAD'), f.developHead, 'no fast-forward begins after the switch went off');
    assert.ok(fs.existsSync(f.feature));
  }
});

/** A killed merge whose intent says ff-started, with a dead child recorded and develop still clean at its old head. */
async function interruptedFf(t: any) {
  const f = fixture(t);
  await assert.rejects(mergeRoadmapRow({ ...f.options, onPhase: (p: any) => { if (p === 'built') throw new Error('crash'); } }), /crash/);
  const file = path.join(f.root, '.doflow/state/roadmap/intents/113.json');
  const intent = JSON.parse(fs.readFileSync(file, 'utf8'));
  intent.phase = 'ff-started'; intent.ff = { pid: 2147483647, start: null, startedAt: '2026-01-01T00:00:00Z' };
  fs.writeFileSync(file, JSON.stringify(intent));
  const indexFile = path.resolve(f.develop, f.git(f.develop, 'rev-parse', '--git-path', 'index'));
  return { ...f, file, intent, indexFile };
}

test('switch off: a started fast-forward on a clean develop at its old head is not begun (C3)', async (t): Promise<any> => {
  const f = await interruptedFf(t);
  const spawned: any = [];
  const options: any = { ...f.options, alive: () => false, isEnabled: () => ({ enabled: false, switch: 'sentinel' }),
    spawn: (...args: any[]) => { spawned.push(args[1]); return cp.spawn(...args); } };
  const out = await mergeRoadmapRow(options);
  assert.deepEqual([out.outcome, out.phase, out.annotations.switch], ['stopped', 'ff-started', 'sentinel']);
  assert.deepEqual(spawned, [], 'no merge --ff-only is spawned under an off switch');
  assert.equal(f.git(f.develop, 'rev-parse', 'HEAD'), f.developHead);
  assert.equal(readOpenIntents({ root: f.root })[0].phase, 'ff-started');
  // Control: HEAD already at the commit (the ff finished before the kill) settles to ff-done, then stops.
  f.git(f.develop, 'merge', '--ff-only', '-q', f.intent.commit);
  const settled = await mergeRoadmapRow(options);
  assert.deepEqual([settled.outcome, settled.phase], ['stopped', 'ff-done']);
  assert.equal(readOpenIntents({ root: f.root })[0].phase, 'ff-done');
  assert.deepEqual(spawned, []);
});

test('switch off: a proven-dead partial fast-forward is still repaired, then stops at ff-done (C3)', async (t) => {
  const f = await interruptedFf(t);
  fs.writeFileSync(path.join(f.develop, 'feature.txt'), 'feature\n');
  const out = await mergeRoadmapRow({ ...f.options, alive: () => false, isEnabled: () => ({ enabled: false, switch: 'sentinel' }) });
  assert.deepEqual([out.outcome, out.phase], ['stopped', 'ff-done']);
  assert.equal(f.git(f.develop, 'rev-parse', 'HEAD'), f.intent.commit);
  assert.equal(f.git(f.develop, 'status', '--porcelain', '--untracked-files=all'), '');
});

test('a recorded fast-forward child that may still run is named ff-running, not develop-dirty (C23)', async (t) => {
  const f = await interruptedFf(t);
  for (const alive of [() => 'unknown', () => true]) {
    assert.equal((await mergeRoadmapRow({ ...f.options, alive })).reason, 'ff-running');
    assert.equal(f.git(f.develop, 'rev-parse', 'HEAD'), f.developHead);
  }
});

test('repair refuses a staged blob that is neither head\'s version and leaves the index as it was (C11)', async (t) => {
  const f = await interruptedFf(t);
  fs.writeFileSync(path.join(f.develop, 'feature.txt'), 'third version\n');
  f.git(f.develop, 'add', 'feature.txt');
  // The working file equals the commit's blob, so only the staged blob tells the person's version apart.
  fs.writeFileSync(path.join(f.develop, 'feature.txt'), 'feature\n');
  const staged = f.git(f.develop, 'ls-files', '-s');
  assert.equal((await mergeRoadmapRow({ ...f.options, alive: () => false })).reason, 'develop-dirty');
  assert.equal(f.git(f.develop, 'ls-files', '-s'), staged, 'the staged third version is still in the index');
  assert.equal(f.git(f.develop, 'rev-parse', 'HEAD'), f.developHead);
  assert.equal(f.git(f.develop, 'cat-file', '-p', ':feature.txt'), 'third version');
});

test('control: a staged blob equal to the commit\'s version is repaired (C11)', async (t) => {
  const f = await interruptedFf(t);
  fs.writeFileSync(path.join(f.develop, 'feature.txt'), 'feature\n');
  f.git(f.develop, 'add', 'feature.txt');
  const out = await mergeRoadmapRow({ ...f.options, alive: () => false });
  assert.equal(out.outcome, 'merged');
  assert.equal(f.git(f.develop, 'rev-parse', 'HEAD'), f.intent.commit);
});

test('a failed compare-and-swap leaves the develop index byte-equal to the index before the repair (C12)', async (t) => {
  const f = await interruptedFf(t);
  fs.writeFileSync(path.join(f.develop, 'feature.txt'), 'feature\n');
  let before = null;
  const execFileSync = (bin: any, args: any, opts: any) => {
    if (args.includes('read-tree')) before = fs.readFileSync(f.indexFile);
    // A racer moves develop between the checks and the ref update: the 3-argument update-ref must fail.
    if (args.includes('update-ref')) f.git(f.root, 'update-ref', 'refs/heads/develop', f.featureHead);
    return cp.execFileSync(bin, args, opts);
  };
  await assert.rejects(mergeRoadmapRow({ ...f.options, alive: () => false, execFileSync }));
  assert.ok(before, 'the repair reached read-tree');
  assert.deepEqual(fs.readFileSync(f.indexFile), before);
  assert.equal(f.git(f.root, 'rev-parse', 'refs/heads/develop'), f.featureHead, 'the racer\'s ref is kept');
});

test('cleanup keeps the worktree, its ignored files and the branch when the tip is not on develop (C1)', async (t) => {
  for (const extra of [true, false]) {
    const f = fixture(t);
    f.git(f.develop, 'merge', '--no-ff', '-q', 'feat/113-toy', '-m', 'merge: 113 Toy', '-m', 'DoFlow-Row: 113');
    fs.mkdirSync(path.join(f.feature, 'agent-docs'));
    fs.writeFileSync(path.join(f.feature, 'agent-docs/notes.md'), 'person notes\n');
    if (extra) {
      fs.writeFileSync(path.join(f.feature, 'later.txt'), 'later\n');
      f.git(f.feature, 'add', 'later.txt'); f.git(f.feature, 'commit', '-qm', 'after the merge');
    }
    const tip = f.git(f.root, 'rev-parse', 'refs/heads/feat/113-toy');
    // The loop's no-intent call shape: the branch's current tip is passed as its own expected head.
    const cleaned = cleanupFeature({ intent: { featureWorktree: f.feature, featureBranch: 'feat/113-toy', featureHead: tip },
      root: f.root, develop: f.develop, execFileSync: cp.execFileSync, fsImpl: fs,
      execOptions: { cwd: f.root, encoding: 'utf8', env: f.options.env, stdio: ['pipe', 'pipe', 'pipe'] } });
    if (extra) {
      assert.equal(cleaned, false);
      assert.equal(fs.readFileSync(path.join(f.feature, 'agent-docs/notes.md'), 'utf8'), 'person notes\n');
      assert.equal(f.git(f.root, 'rev-parse', 'refs/heads/feat/113-toy'), tip);
    } else {
      assert.equal(cleaned, true, 'control: a merged tip is cleaned');
      assert.equal(fs.existsSync(f.feature), false);
      assert.equal(f.git(f.root, 'branch', '--list', 'feat/113-toy'), '');
    }
  }
});

module.exports = { fixture };
