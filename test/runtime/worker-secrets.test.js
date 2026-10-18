'use strict';

// Feature 081 D.4 (IC-030; DEC-003, DEC-045; FR-004, NFR-006): credential and secret obligations.
//
// One flow runs in process under a fixture HOME holding `.claude/.credentials.json`,
// `.codex/auth.json` and `.config/gh/hosts.yml`: discover, probe, superviseRun of a worker that
// prints a provider-shaped key and reports it in its summary, and cancelRun of a second, running
// worker. An `fs` spy wraps every path-taking call of `node:fs` and `node:fs/promises` for the whole
// flow and records each path with the innermost `src/` frame that asked for it.
//
// XDG_CONFIG_HOME is unset, so `stateDir()` (the session-env store) and `sessions.log` sit under the
// fixture HOME, the layout a user without XDG_CONFIG_HOME has. The worker env is the caller's,
// inherited unchanged (DEC-045), so both secrets reach the worker; DoFlow must never write them.
//
// No real harness runs (NFR-002): the only binaries on the child PATH are a scratch bin/ holding the
// fake CLI as `fake-claude` and `fake-slow`, plus `node` and `git` linked by absolute path. The node
// directory itself is never on the child PATH, because on a developer machine it can hold real
// harness CLIs. Every DOFLOW_* identity variable is set or deleted explicitly. POSIX only (DEC-008).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { fileURLToPath } = require('node:url');
const { tempDir } = require('../helper/tmp.js');
const { IDENTITY_VARS, linkBin, writeScenario, readLog } = require('../helper/fake-harness-cli.js');
const DESCRIPTORS = require('../fixtures/worker/descriptors.json');

const REPO = path.join(__dirname, '..', '..');
const SRC_ROOT = `${path.join(REPO, 'src')}${path.sep}`;
const WORKER_SRC = `${path.join(REPO, 'src', 'runtime', 'worker')}${path.sep}`;
const SRC = path.join(REPO, 'src', 'runtime');
const { discover, probe } = require(path.join(SRC, 'worker', 'readiness.ts'));
const { superviseRun } = require(path.join(SRC, 'worker', 'supervisor.ts'));
const { cancelRun } = require(path.join(SRC, 'worker', 'cancel.ts'));
const { storeFileFor, newRunId, insertRun, readRuns } = require(path.join(SRC, 'worker', 'run-store.ts'));
const { ENV_SET, launchEnv, launchRecord } = require(path.join(SRC, 'worker', 'launch.ts'));
const attempts = require(path.join(SRC, 'task-attempts.ts'));
const { runKeyFor } = require(path.join(SRC, 'task-run.ts'));
const { stateDir } = require(path.join(SRC, 'context', 'identity.ts'));

const SLUG = 'feat-secrets';
const POSIX = { skip: process.platform === 'win32' && 'worker process control is unverified on win32 (DEC-008)' };
const PLAN = ['# Plan', '', '**Task graph:** v1', '', '## Tasks', '', '### Phase A', '',
  '- [ ] A.1 first task; owner: core-implementer; files: a.js', ''].join('\n');
const CREDENTIAL_FILES = ['.claude/.credentials.json', '.codex/auth.json', '.config/gh/hosts.yml'];
/** `sk-` plus 24 alphanumerics: a shape the mask knows (IC-030). */
const KNOWN = `sk-${crypto.randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, '').padEnd(24, 'Q').slice(0, 24)}`;
/** A value of no known shape: lowercase words around a short number, nothing a mask rule reaches. */
const UNSHAPED = `plum-velvet-${crypto.randomInt(1000, 9999)}-orchard`;

/** The git binary this test process resolves, by absolute path. */
const GIT = (process.env.PATH || '').split(path.delimiter).map((dir) => path.join(dir, 'git'))
  .find((candidate) => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function gitEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  return env;
}

/** A real git repository with one commit, a run's execution worktree. */
function gitRepo(t) {
  const dir = tempDir(t, 'doflow-worker-secrets-wt-');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: dir, env: gitEnv(), stdio: 'ignore' });
  git('init', '-q');
  fs.writeFileSync(path.join(dir, 'README.md'), 'readme\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(dir, '.doflow', 'state'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.doflow', 'state', '.gitignore'), '*\n');
  return dir;
}

/** The fixture HOME with the three credential files, each holding a sentinel nobody may read. */
function fixtureHome(base) {
  const home = path.join(base, 'home');
  for (const rel of CREDENTIAL_FILES) {
    const file = path.join(home, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `credential-sentinel ${rel}\n`, { mode: 0o600 });
  }
  return home;
}

/**
 * A project with an active subagent attempt on A.1, a scratch bin/ holding only fake CLIs and the
 * node and git links, and a caller env with both secrets and every identity variable decided here.
 */
function project(t, base, name, scenario) {
  const home = path.join(base, 'home');
  const dir = path.join(base, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  const planFile = path.join(dir, 'agent-docs', 'doflow', SLUG, 'plan.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, PLAN);
  const bin = path.join(dir, 'bin');
  linkBin(bin, ['fake-claude', 'fake-slow']); // its returned PATH (bin plus the node dir) is not used
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.symlinkSync(GIT, path.join(bin, 'git'));
  const scratch = path.join(dir, 'scratch');
  fs.mkdirSync(scratch);
  const env = {
    PATH: bin,
    HOME: home,
    TMPDIR: process.env.TMPDIR || '/tmp',
    FAKE_HARNESS_SCENARIO: writeScenario(scratch, scenario),
    FAKE_HARNESS_LOG: path.join(scratch, 'log.jsonl'),
    FAKE_API_KEY: KNOWN,
    UNSHAPED_SECRET: UNSHAPED,
    DOFLOW_RUN_ID: 'r1',
    DOFLOW_LINEAGE_ID: 'main',
    DOFLOW_SESSION_ROLE: 'main',
    DOFLOW_ROLE: 'main',
    DOFLOW_WORKTREE: dir,
  };
  delete env.DOFLOW_ATTEMPT;
  delete env.XDG_CONFIG_HOME;
  const execWorktree = gitRepo(t);
  const key = runKeyFor(env, dir);
  const ledger = attempts.storeFile(dir, SLUG);
  const common = { file: ledger, fsImpl: fs, roots: [dir], slug: SLUG, env, cwd: dir };
  assert.equal(attempts.start({ ...common, by: 'main' }).disposition, 'started');
  const claimed = attempts.claim({ ...common, task: 'A.1', owner: 'core-implementer', mode: 'subagent', epoch: 1, execWorktree });
  assert.equal(claimed.disposition, 'claimed');
  const store = storeFileFor(dir, SLUG);
  const token = claimed.token;

  /** Inserts a `starting` run on the claim with `binary` as the worker, the way the run command does. */
  const seed = (binary) => {
    const runId = newRunId();
    const descriptor = structuredClone(DESCRIPTORS.claude);
    descriptor.cli.binary = binary;
    const prompt = 'review the task';
    const { identity } = launchEnv({ env, runKey: key.runKey, token, execWorktree, runId });
    const promptFile = path.join(scratch, `prompt-${runId}.md`);
    fs.writeFileSync(promptFile, prompt);
    assert.equal(insertRun(store, {
      runId, task: 'A.1', token, harness: 'claude', phase: 'starting', execWorktree,
      createdAt: new Date().toISOString(), timeoutSeconds: 60,
      caller: { cwd: dir, runKey: key.runKey, run: key.identity.run, lineage: key.identity.lineage, attempt: null, role: 'main', lineageKind: key.identity.lineageKind },
      ...launchRecord(descriptor, identity, prompt),
      descriptor,
      prompt: { path: promptFile, sha256: crypto.createHash('sha256').update(prompt).digest('hex'), bytes: Buffer.byteLength(prompt) },
      needs: [],
    }).applied, true);
    return runId;
  };
  return { dir, home, env, store, execWorktree, scratch, seed, run: (id) => readRuns(store)[id] };
}

// ── The fs spy ────────────────────────────────────────────────────────────────────────────────

const SYNC = ['openSync', 'readFileSync', 'statSync', 'lstatSync', 'accessSync', 'existsSync', 'readdirSync', 'readlinkSync',
  'opendirSync', 'writeFileSync', 'appendFileSync', 'mkdirSync', 'mkdtempSync', 'renameSync', 'copyFileSync', 'symlinkSync',
  'linkSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'chmodSync', 'utimesSync', 'truncateSync', 'statfsSync',
  'open', 'readFile', 'stat', 'lstat', 'access', 'readdir', 'readlink', 'opendir', 'writeFile', 'appendFile', 'mkdir',
  'rename', 'copyFile', 'unlink', 'rm', 'rmdir', 'createReadStream', 'createWriteStream'];
const PROMISES = ['open', 'readFile', 'stat', 'lstat', 'access', 'readdir', 'readlink', 'opendir', 'writeFile', 'appendFile',
  'mkdir', 'rename', 'copyFile', 'unlink', 'rm', 'rmdir', 'realpath'];
const TWO_PATHS = new Set(['renameSync', 'copyFileSync', 'symlinkSync', 'linkSync', 'rename', 'copyFile']);

function asPath(value) {
  if (typeof value === 'string') return path.resolve(value);
  if (Buffer.isBuffer(value)) return path.resolve(value.toString('utf8'));
  if (value instanceof URL && value.protocol === 'file:') return fileURLToPath(value);
  return null;
}

/** The innermost frame of this repository's `src/` in the current stack, as a repo-relative file. */
function srcFrame() {
  for (const line of new Error().stack.split('\n').slice(1)) {
    const match = /\(?(file:\/\/[^()]*?|(?:\/|[A-Za-z]:\\)[^()]*?):\d+:\d+\)?\s*$/.exec(line);
    if (!match) continue;
    const file = match[1].startsWith('file:') ? fileURLToPath(match[1]) : match[1];
    if (file.startsWith(SRC_ROOT)) return path.relative(REPO, file);
  }
  return null;
}

/** Wraps every path-taking call of `node:fs` and `node:fs/promises`; returns `{ hits, restore }`. */
function spyFs() {
  const hits = [];
  const undo = [];
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 64;
  const wrap = (owner, name, label) => {
    const original = owner[name];
    if (typeof original !== 'function') return;
    const wrapped = function spied(...args) {
      const from = srcFrame();
      for (const arg of TWO_PATHS.has(name) ? args.slice(0, 2) : args.slice(0, 1)) {
        const p = asPath(arg);
        if (p) hits.push({ op: label, path: p, from });
      }
      return original.apply(this, args);
    };
    Object.defineProperties(wrapped, Object.getOwnPropertyDescriptors(original));
    owner[name] = wrapped;
    undo.push(() => { owner[name] = original; });
  };
  for (const name of SYNC) wrap(fs, name, name);
  for (const name of ['realpathSync', 'realpath']) {
    const nativeOriginal = fs[name].native;
    wrap(fs, name, name);
    fs[name].native = nativeOriginal;
    wrap(fs[name], 'native', `${name}.native`);
  }
  for (const name of PROMISES) wrap(fs.promises, name, `promises.${name}`);
  return {
    hits,
    restore() {
      for (const step of undo.reverse()) step();
      Error.stackTraceLimit = limit;
    },
  };
}

const under = (p, dir) => p === dir || p.startsWith(`${dir}${path.sep}`);

/** Every regular file under `dir`, recursively; [] when it does not exist. */
function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    if (entry.isFile()) out.push(full);
  }
  return out;
}

// ── The flow and its obligations ──────────────────────────────────────────────────────────────

test('credentials stay unread and secrets stay out of every DoFlow file (IC-030)', POSIX, async (t) => {
  const base = tempDir(t, 'doflow-worker-secrets-');
  const home = fixtureHome(base);
  const printing = [
    { print: `using key ${KNOWN}` },
    { emit: { type: 'result', status: 'success', summary: `reviewed with ${KNOWN}` } },
  ];
  // `fake-claude` prints the known secret and reports it; `fake-slow` prints it and waits to be cancelled.
  const scenario = {
    version: [{ print: 'fake 1.0' }],
    runnable: [{ print: `runnable ${KNOWN}` }, { exit: 0 }],
    guidance: [{ print: DESCRIPTORS.claude.guidanceProbe.marker }],
    byBinary: { 'fake-slow': { run: [{ print: `waiting with ${KNOWN}` }, { sleep: 30000 }] } },
    run: printing,
  };
  const a = project(t, base, 'project-a', scenario);
  const b = project(t, base, 'project-b', scenario);
  const supervisedId = a.seed('fake-claude');
  const cancelledId = b.seed('fake-slow');
  const S = stateDir(a.env);
  assert.equal(S, path.join(home, '.config', 'doflow', 'session-env'), 'the session-env store sits under the fixture HOME');
  const sessionsLog = path.join(home, '.config', 'doflow', 'sessions.log');
  fs.mkdirSync(path.dirname(sessionsLog), { recursive: true });
  fs.writeFileSync(sessionsLog, '2026-10-15T00:00:00Z START s-old /nowhere\n');

  const spy = spyFs();
  let found;
  let probed;
  let supervised;
  let cancelled;
  let afterCancel;
  try {
    found = discover({ descriptors: { claude: DESCRIPTORS.claude }, env: a.env, cwd: a.dir });
    probed = await probe({ descriptors: { claude: DESCRIPTORS.claude }, env: a.env, cwd: a.dir });
    supervised = await superviseRun({ file: a.store, runId: supervisedId, env: a.env, cwd: a.dir });

    const running = superviseRun({ file: b.store, runId: cancelledId, env: b.env, cwd: b.dir });
    const until = Date.now() + 15000;
    while (!(b.run(cancelledId).phase === 'running' && b.run(cancelledId).worker) && Date.now() < until) await sleep(50);
    t.after(() => { try { process.kill(-b.run(cancelledId).worker.pid, 'SIGKILL'); } catch { /* ended */ } });
    cancelled = await cancelRun({ file: b.store, runId: cancelledId, by: 'main', reason: 'stop the review', env: b.env, cwd: b.dir });
    afterCancel = await running;
  } finally {
    spy.restore();
  }

  // The flow ran as intended, so the obligations below are about real calls.
  assert.equal(found.harnesses[0].present, true);
  assert.equal(probed.disposition, 'probed');
  assert.equal(supervised.end.state, 'exited', JSON.stringify(supervised.process));
  assert.equal(supervised.report.status, 'success');
  assert.equal(cancelled.disposition, 'cancelled', JSON.stringify(cancelled));
  assert.equal(afterCancel.phase, 'ended');
  assert.equal(b.run(cancelledId).end.state, 'cancelled');

  await t.test('no credential path is opened, stat-ed or read, from any caller', () => {
    const forbidden = [home, os.homedir()].flatMap((root) => CREDENTIAL_FILES.map((rel) => path.join(root, rel)));
    const dirs = [home, os.homedir()].flatMap((root) => ['.claude', '.codex', path.join('.config', 'gh')].map((rel) => path.join(root, rel)));
    const touched = spy.hits.filter((hit) => forbidden.includes(hit.path) || dirs.some((dir) => under(hit.path, dir)));
    assert.deepEqual(touched, []);
  });

  await t.test('worker modules touch no HOME path but the unit binding and sessions.log', () => {
    const allowed = (p) => p === sessionsLog || /^[^/\\]+$/.test(path.relative(path.join(S, 'sessions'), path.dirname(p))) && path.basename(p) === 'bound';
    const fromWorker = spy.hits.filter((hit) => hit.from && `${path.join(REPO, hit.from)}`.startsWith(WORKER_SRC) && under(hit.path, home));
    assert.ok(fromWorker.some((hit) => allowed(hit.path) && hit.path !== sessionsLog), 'the spy saw the unit-binding lookup (positive control)');
    assert.ok(fromWorker.some((hit) => hit.path === sessionsLog), 'the spy saw the sessions.log read (positive control)');
    assert.deepEqual(fromWorker.filter((hit) => !allowed(hit.path)), []);
    // Any other HOME access, from any module, stays inside DoFlow's own session-env store.
    assert.deepEqual(spy.hits.filter((hit) => under(hit.path, home) && !under(hit.path, S) && hit.path !== sessionsLog), []);
  });

  await t.test('the known secret is only ever <masked>, and records hold variable names only', () => {
    for (const p of [a, b]) {
      const files = [...filesUnder(path.join(p.dir, '.doflow', 'state')), ...filesUnder(path.join(p.execWorktree, '.doflow', 'state'))];
      assert.ok(files.some((file) => file.includes(`${path.sep}worker-runs${path.sep}`)), 'a run record was written');
      for (const file of files) assert.equal(fs.readFileSync(file, 'utf8').includes(KNOWN), false, file);
    }
    for (const file of filesUnder(home)) assert.equal(fs.readFileSync(file, 'utf8').includes(KNOWN), false, file);
    const outA = fs.readFileSync(path.join(a.dir, '.doflow', 'state', supervised.output.stdout.path), 'utf8');
    assert.match(outA, /using key <masked>/);
    // A cancelled run's record carries no output summary; the sink's file is at its fixed path (IC-018).
    const outB = fs.readFileSync(path.join(b.dir, '.doflow', 'state', 'worker-output', `${cancelledId}.out.log`), 'utf8');
    assert.match(outB, /waiting with <masked>/);
    assert.match(supervised.report.summary, /reviewed with <masked>/);
    assert.ok(fs.existsSync(path.join(a.dir, '.doflow', 'state', 'worker-probes', 'claude.json')), 'the probe record was written');
    for (const run of [supervised, b.run(cancelledId)]) {
      assert.deepEqual(run.envSet, [...ENV_SET]);
      // Five identity variables plus DOFLOW_WORKER_RUN (110), last; the stored identity is not the six.
      assert.deepEqual([...ENV_SET].slice(0, 5).sort(), [...IDENTITY_VARS].sort());
      assert.equal(ENV_SET.at(-1), 'DOFLOW_WORKER_RUN');
      assert.equal(ENV_SET.length, 6);
      assert.equal(run.envInherited, true);
      const text = JSON.stringify(run);
      for (const value of ['FAKE_API_KEY', 'UNSHAPED_SECRET', KNOWN, UNSHAPED, home]) assert.equal(text.includes(value), false, value);
    }
  });

  await t.test('the unshaped secret reaches no project state, session-env store or launch context', () => {
    for (const p of [a, b]) {
      const files = [...filesUnder(path.join(p.dir, '.doflow', 'state')), ...filesUnder(path.join(p.execWorktree, '.doflow', 'state'))];
      for (const file of files) assert.equal(fs.readFileSync(file, 'utf8').includes(UNSHAPED), false, file);
    }
    const store = filesUnder(S);
    assert.ok(store.length > 0, 'the launch emission wrote into the session-env store');
    for (const file of filesUnder(home)) assert.equal(fs.readFileSync(file, 'utf8').includes(UNSHAPED), false, file);
    // The emitted launch context is delivered in the worker's argv (prompt via argv), which the fake logs.
    const runs = [a, b].flatMap((p) => readLog(p.env.FAKE_HARNESS_LOG)).filter((line) => line.argv.includes('--read-only'));
    assert.equal(runs.length, 2);
    for (const line of runs) {
      assert.ok(line.argv.at(-1).endsWith('review the task'), 'the last argv element is the delivered context and brief');
      assert.equal(JSON.stringify(line.argv).includes(UNSHAPED), false);
      assert.equal(JSON.stringify(line.argv).includes(KNOWN), false);
    }
  });
});
