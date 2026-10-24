'use strict';
// 081 IC-029 (DEC-036): the fake harness CLI and the fake worker descriptors every worker test
// uses. No case starts a real harness (NFR-002): each child's PATH is a scratch bin/ holding only
// the links this file made plus the directory of process.execPath (RK9), and each child env sets
// or omits the five DOFLOW_* identity variables explicitly.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { IDENTITY_VARS, kindOf, linkBin, writeScenario, readLog } = require('../helper/fake-harness-cli.ts');
const { validateWorker, WORKER_KEYS, WORKER_CAPABILITIES } = require('../../src/registry/index.ts');
const DESCRIPTORS = require('../fixtures/worker/descriptors.json');
const HARNESSES = require('../../core/registry/harnesses.json');

const POSIX_ONLY: any = { skip: process.platform === 'win32' && 'the fake CLI is linked by symlink and shebang on POSIX' };
const IDENTITY: any = {
  DOFLOW_RUN_ID: 'abcdef012345', DOFLOW_LINEAGE_ID: 'main', DOFLOW_ATTEMPT: '1', DOFLOW_SESSION_ROLE: 'worker', DOFLOW_WORKTREE: '/fake/worktree',
};

/** A scratch dir with bin/ holding `names`, a scenario and a log; `run()` invokes one name. */
function fixture(t: any, scenario: any, names: any = ['fake-claude']) {
  const dir = tempDir(t, 'doflow-fakecli-');
  const bin = path.join(dir, 'bin');
  const childPath = linkBin(bin, names);
  const log = path.join(dir, 'log.jsonl');
  const scenarioFile = writeScenario(dir, scenario);
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  const env = (identity: any = IDENTITY) => {
    const next: any = { PATH: childPath, HOME: dir, FAKE_HARNESS_SCENARIO: scenarioFile, FAKE_HARNESS_LOG: log };
    for (const key of IDENTITY_VARS) if (identity[key] !== undefined) next[key] = identity[key];
    return next;
  };
  const run = (name: any, argv: any, { identity, cwd = work }: any = {}) => spawnSync(name, argv, { cwd, env: env(identity), encoding: 'utf8', timeout: 10000 });
  return { dir, bin, childPath, log, work, env, run };
}

/** Spawns asynchronously, resolving `{ code, signal }` at exit. */
function spawnAsync(name: any, argv: any, options: any) {
  const child = spawn(name, argv, { ...options, stdio: 'ignore' });
  const done: any = new Promise((resolve) => child.on('exit', (code: any, signal: any) => resolve({ code, signal })));
  return { child, done };
}

async function waitFor(predicate: any, ms: any = 5000) {
  const until = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function alive(pid: any) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('fake cli: argv selects the invocation kind', () => {
  assert.equal(kindOf(['--version']), 'version');
  for (const kind of ['runnable', 'hooks', 'guidance', 'login']) assert.equal(kindOf(['probe', kind]), kind);
  assert.equal(kindOf(['probe', 'hooks', '--skip-front-doors']), 'hooks');
  assert.equal(kindOf(['model-check', 'hooks-roundtrip']), 'model-check:hooks-roundtrip');
  assert.equal(kindOf(['--read-only', '--no-spawn', '--jsonl', 'run', 'do it']), 'run');
  assert.equal(kindOf(['probe', 'unheard-of']), 'run');
});

test('fake cli: print, emit and exit run in order; a kind with no steps exits 0', POSIX_ONLY, (t) => {
  const f = fixture(t, {
    version: [{ print: 'fake 1.0' }],
    run: [{ print: 'hello' }, { emit: [{ type: 'usage', tokens: 3 }, { type: 'result', status: 'success', summary: 'ok' }] }, { exit: 3 }, { print: 'never' }],
  });
  const version = f.run('fake-claude', ['--version']);
  assert.equal(version.status, 0);
  assert.equal(version.stdout, 'fake 1.0\n');
  const run = f.run('fake-claude', ['run', 'x']);
  assert.equal(run.status, 3);
  assert.deepEqual(run.stdout.split('\n'), ['hello', '{"type":"usage","tokens":3}', '{"type":"result","status":"success","summary":"ok"}', '']);
  const login = f.run('fake-claude', ['probe', 'login']);
  assert.equal(login.status, 0);
  assert.equal(login.stdout, '');
});

test('fake cli: byBinary steps win over the top-level kind for that name only', POSIX_ONLY, (t) => {
  const f = fixture(t, { hooks: [{ print: 'shared' }], byBinary: { 'fake-codex': { hooks: [{ exit: 4 }] } } }, ['fake-claude', 'fake-codex']);
  assert.equal(f.run('fake-claude', ['probe', 'hooks']).stdout, 'shared\n');
  const codex = f.run('fake-codex', ['probe', 'hooks']);
  assert.equal(codex.status, 4);
  assert.equal(codex.stdout, '');
});

test('fake cli: write creates a file under cwd and refuses a path that leaves it', POSIX_ONLY, (t) => {
  const f = fixture(t, { run: [{ write: { path: 'out/a.txt', content: 'A' } }, { write: 'empty.txt' }], login: [{ write: '../escape.txt' }] });
  assert.equal(f.run('fake-claude', ['run']).status, 0);
  assert.equal(fs.readFileSync(path.join(f.work, 'out', 'a.txt'), 'utf8'), 'A');
  assert.equal(fs.readFileSync(path.join(f.work, 'empty.txt'), 'utf8'), '');
  const escape = f.run('fake-claude', ['probe', 'login']);
  assert.equal(escape.status, 97);
  assert.match(escape.stderr, /leaves cwd/);
  assert.equal(fs.existsSync(path.join(f.dir, 'escape.txt')), false);
});

test('fake cli: sleep waits the given milliseconds', POSIX_ONLY, (t) => {
  const f = fixture(t, { run: [{ sleep: 300 }, { print: 'woke' }] });
  const start = Date.now();
  const r = f.run('fake-claude', ['run']);
  assert.equal(r.stdout, 'woke\n');
  assert.ok(Date.now() - start >= 300, 'the sleep step must hold the process');
});

test('fake cli: spawnChild leaves a sleeping child, in a new group when asked', POSIX_ONLY, (t) => {
  const f = fixture(t, { run: [{ spawnChild: { pidFile: 'same.pid', ms: 20000 } }, { spawnChild: { newGroup: true, pidFile: 'new.pid', ms: 20000 } }] });
  const r = f.run('fake-claude', ['run']);
  assert.equal(r.status, 0, r.stderr);
  const same = Number(fs.readFileSync(path.join(f.work, 'same.pid'), 'utf8'));
  const own = Number(fs.readFileSync(path.join(f.work, 'new.pid'), 'utf8'));
  t.after(() => { for (const pid of [same, own]) try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } });
  assert.ok(alive(same) && alive(own), 'both children outlive the fake CLI');
  const pgid = (pid: any) => Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim());
  assert.equal(pgid(own), own, 'newGroup makes the child its own group leader');
  assert.notEqual(pgid(same), same, 'without newGroup the child stays in the fake CLI group');
});

test('fake cli: ignoreTerm survives SIGTERM until SIGKILL', POSIX_ONLY, async (t) => {
  const f = fixture(t, { run: [{ ignoreTerm: true }, { write: 'ready' }, { sleep: 20000 }] });
  const { child, done } = spawnAsync('fake-claude', ['run'], { cwd: f.work, env: f.env() });
  t.after(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  await waitFor(() => fs.existsSync(path.join(f.work, 'ready')));
  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(alive(child.pid), 'SIGTERM is ignored');
  child.kill('SIGKILL');
  assert.deepEqual(await done, { code: null, signal: 'SIGKILL' });
});

test('fake cli: frontDoors runs both scripts with the inherited env, strips DOFLOW_* or skips on request', POSIX_ONLY, (t) => {
  const f = fixture(t, {
    hooks: [{ frontDoors: { mirror: 'MIRROR', harness: 'claude', out: 'doors.json' } }],
    byBinary: { 'fake-codex': { hooks: [{ frontDoors: { mirror: 'MIRROR', harness: 'claude', out: 'doors.json', stripEnv: true } }] } },
  }, ['fake-claude', 'fake-codex']);
  const mirror = path.join(f.dir, 'mirror');
  const hooks = path.join(mirror, '.claude', 'hooks');
  fs.mkdirSync(hooks, { recursive: true });
  // Builtins only: the child PATH has no coreutils.
  fs.writeFileSync(path.join(hooks, 'session-start.sh'), 'read -r line; echo "start run=${DOFLOW_RUN_ID:-unset}"\n');
  fs.writeFileSync(path.join(hooks, 'user-prompt-submit.sh'), 'read -r line; echo "prompt run=${DOFLOW_RUN_ID:-unset} $line"\n');
  const scenario = JSON.parse(fs.readFileSync(path.join(f.dir, 'scenario.json'), 'utf8').replaceAll('MIRROR', mirror.replaceAll('\\', '\\\\')));
  writeScenario(f.dir, scenario);
  const doors = path.join(f.work, 'doors.json');

  assert.equal(f.run('fake-claude', ['probe', 'hooks']).status, 0);
  const kept = JSON.parse(fs.readFileSync(doors, 'utf8'));
  assert.deepEqual(kept.sessionStart, { status: 0, stdout: 'start run=abcdef012345\n' });
  assert.equal(kept.userPromptSubmit.status, 0);
  assert.match(kept.userPromptSubmit.stdout, /^prompt run=abcdef012345 \{.*"hook_event_name":"UserPromptSubmit".*"prompt":"continue".*\}\n$/);

  fs.rmSync(doors);
  assert.equal(f.run('fake-codex', ['probe', 'hooks']).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(doors, 'utf8')).sessionStart.stdout, 'start run=unset\n');

  fs.rmSync(doors);
  assert.equal(f.run('fake-claude', ['probe', 'hooks', '--skip-front-doors']).status, 0);
  assert.equal(fs.existsSync(doors), false, '--skip-front-doors runs no front door');
});

test('fake cli: one log line per invocation carrying the five identity values', POSIX_ONLY, (t) => {
  const f = fixture(t, {});
  f.run('fake-claude', ['--version']);
  f.run('fake-claude', ['probe', 'runnable'], { identity: {} });
  f.run('fake-claude', ['run', 'p']);
  const lines = readLog(f.log);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map((line: any) => line.argv), [['--version'], ['probe', 'runnable'], ['run', 'p']]);
  for (const line of lines) {
    assert.deepEqual(Object.keys(line).sort(), ['argv', 'cwd', 'doflowEnv']);
    assert.equal(line.cwd, f.work);
    assert.deepEqual(Object.keys(line.doflowEnv).sort(), [...IDENTITY_VARS].sort());
  }
  assert.deepEqual(lines[0].doflowEnv, IDENTITY);
  assert.deepEqual(lines[1].doflowEnv, Object.fromEntries(IDENTITY_VARS.map((key: any) => [key, null])));
});

test('fake descriptors: registered harness ids, each block passes validateWorker', (): any => {
  const registered: any = new Set(HARNESSES.harnesses.map((h: any) => h.id));
  assert.ok(Object.keys(DESCRIPTORS).length >= 4);
  for (const [id, block] of Object.entries(DESCRIPTORS)) {
    assert.ok(registered.has(id), `${id} is a registered harness id`);
    assert.deepEqual(Object.keys(block).sort(), [...WORKER_KEYS].sort());
    const errors: any = [];
    validateWorker(block, `harness '${id}'`, errors);
    assert.deepEqual(errors, [], `${id}: ${errors.join('; ')}`);
    assert.match(block.cli.binary, /^fake-/, 'a fake name, never a real harness binary');
  }
  const probes: any = ['runnableProbe', 'hooksProbe', 'guidanceProbe', 'loginProbe'];
  const full = DESCRIPTORS.claude;
  for (const key of Object.keys(WORKER_CAPABILITIES).filter((k) => !['persistentSession', 'resume', 'steering'].includes(k))) {
    assert.equal(full[key].status, 'supported', `claude ${key}`);
  }
  assert.equal(full.structuredOutput.parser, 'doflow-jsonl-v1');
  for (const key of probes) assert.ok(Array.isArray(full[key].argv), `claude ${key} argv`);
  assert.equal(kindOf(DESCRIPTORS.codex.hooksProbe.argv), 'hooks');
  assert.ok(DESCRIPTORS.codex.hooksProbe.argv.includes('--skip-front-doors'));
  assert.equal(DESCRIPTORS.gemini.readOnly.status, 'unknown');
  assert.equal(DESCRIPTORS.opencode.modelChecks.length, 1);
  assert.equal(kindOf(DESCRIPTORS.opencode.modelChecks[0].argv), `model-check:${DESCRIPTORS.opencode.modelChecks[0].id}`);
  for (const block of Object.values(DESCRIPTORS)) {
    for (const key of probes) if (block[key].status === 'supported') assert.equal(kindOf(block[key].argv), key.replace('Probe', ''));
  }
});

test('fake descriptors: argv on an unknown entry fails validateWorker (negative control)', (): any => {
  const copy = structuredClone(DESCRIPTORS.gemini);
  copy.readOnly.argv = ['--read-only'];
  const errors: any = [];
  validateWorker(copy, "harness 'gemini'", errors);
  assert.deepEqual(errors, ["harness 'gemini' worker 'readOnly': recipe field 'argv' is allowed only when status is supported"]);
});

test('fake cli: the scratch bin holds only the links this test made (RK9)', POSIX_ONLY, (t) => {
  const names = Object.values(DESCRIPTORS).map((block) => block.cli.binary);
  const f = fixture(t, { version: [{ print: 'fake' }] }, names);
  assert.deepEqual(fs.readdirSync(f.bin).sort(), [...names].sort());
  const entries = f.childPath.split(path.delimiter);
  assert.deepEqual(entries, [f.bin, path.dirname(process.execPath)]);
  for (const name of names) {
    const found = entries.filter((dir: any) => fs.existsSync(path.join(dir, name)));
    assert.deepEqual(found, [f.bin], `${name} resolves only to the scratch bin`);
    assert.equal(f.run(name, ['--version']).stdout, 'fake\n');
  }
});
