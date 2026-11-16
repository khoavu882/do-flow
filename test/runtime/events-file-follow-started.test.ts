'use strict';

// Row 165 C-5 (owner gate), D8, R4: a started session's output reaches a `file:<pk>:<fk>` follower while the session
// runs. The follower is the events command's real control loop (real `fs.watch`, real timers, the real project index), the log is the masked
// `worker-output/<runId>.out.log` of a `kind: 'main-session'` run in `started-sessions.json`, and the key is the one
// the start reply carries (`fileKeyOf`). The log grows in two steps with the record still `running`; each step must
// arrive as its own `append` frame. A second case reads the prompt file (`session-prompt`) through the same lane, masked.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { cwdHash } = require('../../src/runtime/context/identity.ts');
const { fileKeyOf, scanArtifacts } = require('../../src/runtime/events/artifacts.ts');
const { handleEventsCommand } = require('../../src/runtime/events/command.ts');
const { createProjectsIndex } = require('../../src/runtime/events/projects-index.ts');
const { readRuns } = require('../../src/runtime/worker/run-store.ts');

const WIN = process.platform === 'win32';
const DEADLINE_MS = 20000;
const RUN_ID = 'w-5555555555ee';
const GH = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV },
  });
  assert.equal(r.status, 0, r.stderr);
}

/** A project with one open started session: the record, its (empty-so-far) out log and its prompt file. */
function world(t: any) {
  const root = fs.realpathSync(tempDir(t, 'doflow-follow-started-'));
  const main = path.join(root, 'proj');
  const home = path.join(root, 'home');
  const config = path.join(root, 'config');
  for (const d of [home, config, main]) fs.mkdirSync(d, { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(main, 'a.txt'), 'a\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'first');
  fs.mkdirSync(path.join(home, '.doflow', 'state'), { recursive: true });
  fs.appendFileSync(path.join(home, '.doflow', 'state', 'upkeep-roots'), `${main}\n`); // how the project index learns of a project
  const state = path.join(main, '.doflow', 'state');
  fs.mkdirSync(path.join(state, 'worker-runs'), { recursive: true });
  fs.mkdirSync(path.join(state, 'worker-output'), { recursive: true });
  fs.mkdirSync(path.join(state, 'session-prompts'), { recursive: true });
  fs.writeFileSync(path.join(state, 'worker-runs', 'started-sessions.json'), JSON.stringify({
    version: 1, revision: 1, slug: 'started-sessions', runs: {
      [RUN_ID]: {
        runId: RUN_ID, kind: 'main-session', task: 'main-session', token: 1, seq: 1, request: 'r'.repeat(22), childOf: null, harness: 'claude', phase: 'running',
        createdAt: new Date().toISOString(), startedBy: 'console', project: { projectKey: cwdHash(main), worktreeKey: cwdHash(main) },
        binding: { model: 'claude-fixture-9', source: 'catalogue' }, supervisor: { pid: process.pid, start: 'x' },
      },
    },
  }));
  const out = path.join(state, 'worker-output', `${RUN_ID}.out.log`);
  const prompt = path.join(state, 'session-prompts', `${RUN_ID}.prompt.txt`);
  fs.writeFileSync(out, 'boot line\n');
  fs.writeFileSync(prompt, `Use the DoFlow do skill for this request:\n\nrotate ${GH} please\n`, { mode: 0o600 });
  const env = {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV,
    DOFLOW_TELEMETRY: 'off', DOFLOW_FAILURE_CAPTURE: 'off', DOFLOW_UPKEEP: 'off',
  };
  const rel = (dir: string, name: string) => `.doflow/state/${dir}/${name}`;
  return {
    root, main, env, out, prompt, pk: cwdHash(main),
    outKey: fileKeyOf(main, rel('worker-output', `${RUN_ID}.out.log`)), promptKey: fileKeyOf(main, rel('session-prompts', `${RUN_ID}.prompt.txt`)),
  };
}

/**
 * An in-process follower of `ch` through the events command's real control loop, with the real clock, real `fs.watch`
 * and the real project index (the scratch folder is listed because `scratchName` is not in any path here). It ends when
 * the test ends.
 */
function follow(t: any, w: any, ch: string) {
  const saved = process.exitCode;
  const stdin: any = new EventEmitter();
  stdin.pause = () => {};
  stdin.destroy = () => {};
  const s: any = { out: '', err: '', waiters: [] as Array<() => void> };
  const poke = () => { for (const fn of s.waiters.splice(0)) fn(); };
  const sink = (key: 'out' | 'err') => ({ write(chunk: string) { s[key] += chunk; poke(); return true; } });
  const done = handleEventsCommand({
    follow: true, control: 'stdin', json: true, flags: ['--follow', '--control', '--json'], positional: [], cwd: w.main, env: w.env,
    stdin, stdout: sink('out'), stderr: sink('err'), signals: new EventEmitter(),
    projectsIndex: createProjectsIndex({ env: w.env, cwd: w.main, tempRoots: [], scratchName: 'scratch.noindex' }),
  });
  let ended = false;
  s.stop = async () => { if (!ended) { ended = true; stdin.emit('end'); } return done; };
  t.after(async () => { await s.stop(); process.exitCode = saved; });
  stdin.emit('data', Buffer.from(`${JSON.stringify({ op: 'sub', ch })}\n`, 'utf8'));
  s.frames = () => s.out.split('\n').filter((l: string) => l !== '').map((l: string) => JSON.parse(l)).filter((x: any) => x.ch === ch);
  s.until = (what: string, predicate: () => boolean) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}; stdout ${s.out} stderr ${s.err}`)), DEADLINE_MS);
    const check = () => { if (predicate()) { clearTimeout(timer); resolve(); } else s.waiters.push(check); };
    check();
  });
  return s;
}

const texts = (frames: any[]) => frames.flatMap((x: any) => x.data.pieces ?? []).map((p: any) => p.text);

test('165 C-5: the artifact index lists a started session\'s out log and prompt under the keys the start reply carries', (t) => {
  const w = world(t);
  const items = scanArtifacts([w.main]).items;
  const out = items.find((i: any) => i.kind === 'worker-out');
  const prompt = items.find((i: any) => i.kind === 'session-prompt');
  assert.deepEqual([out.fileKey, out.runId], [w.outKey, RUN_ID]);
  assert.deepEqual([prompt.fileKey, prompt.runId], [w.promptKey, RUN_ID]);
});

test('165 C-5: a growing started-session out log reaches a file: follower, line by line, while the run is still running', { skip: WIN }, async (t) => {
  const w = world(t);
  const ch = `file:${w.pk}:${w.outKey}`;
  const f = follow(t, w, ch);
  await f.until('the first snapshot', () => f.frames().some((x: any) => x.type === 'snapshot'));
  const [snap] = f.frames();
  assert.deepEqual([snap.data.log, texts([snap])], ['open', ['boot line']]);

  // Step 1: a new line, the run still running.
  fs.appendFileSync(w.out, 'second line\n');
  await f.until('the second line', () => texts(f.frames().filter((x: any) => x.type === 'append')).includes('second line'));
  assert.equal(readRuns(path.join(w.main, '.doflow', 'state', 'worker-runs', 'started-sessions.json'))[RUN_ID].phase, 'running');

  // Step 2: another line (with a secret), then a partial line completed in a later write; every one arrives, masked.
  fs.appendFileSync(w.out, `third line ${GH}\npart`);
  await f.until('the third line', () => f.frames().some((x: any) => x.type === 'append' && texts([x]).some((line: string) => line.startsWith('third line'))));
  fs.appendFileSync(w.out, 'ial\n');
  await f.until('the completed partial line', () => texts(f.frames().filter((x: any) => x.type === 'append')).includes('partial'));

  const appends = f.frames().filter((x: any) => x.type === 'append');
  assert.ok(appends.length >= 2, `each step is its own frame: ${appends.length}`);
  assert.deepEqual(texts(appends).filter((x: string) => !x.startsWith('third')), ['second line', 'partial']);
  assert.ok(!f.out.includes(GH), 'the secret never reaches the follower');
  assert.ok(!f.out.includes(w.root), 'no path reaches the follower');
  assert.equal(f.frames().filter((x: any) => x.type === 'gone' || x.type === 'error').length, 0, f.out);
  // Bytes are contiguous: each append starts where the previous frame ended.
  const frames = f.frames();
  for (let i = 1; i < frames.length; i += 1) if (frames[i].type === 'append') assert.equal(frames[i].data.from, frames[i - 1].data.to, 'contiguous cursor');
  await f.stop();
});

test('165 D8: the session prompt is followed through the same lane, masked', { skip: WIN }, async (t) => {
  const w = world(t);
  const ch = `file:${w.pk}:${w.promptKey}`;
  const f = follow(t, w, ch);
  await f.until('the prompt snapshot', () => f.frames().some((x: any) => x.type === 'snapshot'));
  const [snap] = f.frames();
  assert.equal(snap.data.log, 'open');
  assert.deepEqual(texts([snap]), ['Use the DoFlow do skill for this request:', '', 'rotate <masked> please']);
  assert.ok(!f.out.includes(GH), 'the secret in a prompt is masked');
  await f.stop();
});
