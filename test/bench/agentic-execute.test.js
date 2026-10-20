'use strict';

// Feature 097 B.1: agentic config, plan projection and the executor with its cap, stop rule, scratch
// profile and per-arm PATH (IC-003 to IC-006, IC-010). Every spawn is the fake worker
// (test/fixtures/agentic/fake-worker.js) placed first on PATH under a made-up binary name; no model,
// network or credential is touched. The registry here carries made-up harness names, so the
// capability selection is exercised without any real harness id.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../helper/tmp.js');
const execute = require('../../bench/agentic/execute.js');
const { UsageError, buildPrompt, promptSha256 } = require('../../bench/agentic/tasks.js');
const launch = require('../../src/runtime/worker/launch.ts');

const REPO = path.join(__dirname, '..', '..');
const SNAPSHOT = JSON.parse(fs.readFileSync(path.join(REPO, 'bench', 'retrieval', 'snapshot.json'), 'utf8'));
const REAL_CONFIG = execute.loadConfig();
const FAKE_WORKER = path.join(REPO, 'test', 'fixtures', 'agentic', 'fake-worker.js');
const BASIC = path.join(REPO, 'test', 'fixtures', 'agentic', 'scenarios', 'basic.json');
const TMP = suiteTempDir('doflow-agentic-exec-');
const BIN = path.join(TMP, 'bin');
fs.mkdirSync(BIN);
fs.copyFileSync(FAKE_WORKER, path.join(BIN, 'fakeharness-alpha'));
fs.chmodSync(path.join(BIN, 'fakeharness-alpha'), 0o755);

// --- fixtures ---------------------------------------------------------------------------------

const supported = (extra) => ({ status: 'supported', ...extra });
const workerBlock = (binary) => ({
  cli: supported({ binary, versionArgv: ['--version'] }),
  oneShot: supported({ argv: ['--ephemeral', '-'], promptVia: 'stdin' }),
  structuredOutput: supported({ argv: ['--json', '-o', '{lastMessageFile}'], parser: 'codex-exec-json-v1' }),
  readOnly: supported({ argv: ['exec', '-s', 'read-only'] }),
  spawnDenial: supported({ argv: ['--disable', 'multi_agent'] }),
});
const REGISTRY = {
  version: 1,
  harnesses: [
    { id: 'alpha', worker: workerBlock('fakeharness-alpha') },
    { id: 'beta', worker: { cli: supported({ binary: 'fakeharness-beta', versionArgv: ['--version'] }) } },
  ],
};
const AMBIGUOUS = { version: 1, harnesses: [...REGISTRY.harnesses, { id: 'gamma', worker: workerBlock('fakeharness-gamma') }] };

const clone = (v) => JSON.parse(JSON.stringify(v));
function testConfig(mutate) {
  const c = clone(REAL_CONFIG);
  c.model = { label: 'fake:model', argv: ['-m', 'fake-model'] };
  c.home = { env: 'FAKE_HOME', source: '~/.fakehome', copy: ['auth.json'] };
  c.path = ['node', 'git'];
  c.timeoutSeconds = 10;
  c.maxTokensPerRun = 1000;
  if (mutate) mutate(c);
  return c;
}

const TASKS = [
  ['T1', 'where the widget is frobbed'], ['T2', 'how the gadget is wired'], ['T3', 'when the sprocket is spun'],
].map(([id, query], i) => ({
  id, split: i < 2 ? 'train' : 'heldout', kind: 'conceptual-discovery', query, corpus: 'code', expect: {},
  qrels: [{ path: `src/hidden/${id}.js`, startLine: 1, endLine: 5, rel: 2 }], key: `agentic/${id}@0000000${i}`,
}));
const TASK_SET = { tasks: TASKS, snapshot: { commit: 'deadbeef' } };

function fakeMaterialise(commit, dir) {
  const treeRoot = path.join(dir, 'tree');
  fs.mkdirSync(treeRoot, { recursive: true });
  fs.writeFileSync(path.join(treeRoot, 'README.md'), `snapshot ${commit}\n`);
  return { treeRoot, cleanup() {} };
}

function git(cwd, ...args) {
  const r = childProcess.spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

let seq = 0;
/** A one-commit git repo; tests that only read it share a single copy, a test that dirties it asks for its own. */
function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}
let sharedRepo = null;

/** A fresh sandbox: run root, tmp dir, credential source, dump file and default options. */
function setup({ scenario = BASIC, config = testConfig(), withCredential = true, ownRepo = false } = {}) {
  const dir = path.join(TMP, `t${++seq}`);
  fs.mkdirSync(dir);
  const repoRoot = ownRepo ? makeRepo(path.join(dir, 'repo')) : (sharedRepo ??= makeRepo(path.join(TMP, 'shared-repo')));
  const tmpDir = path.join(dir, 'tmp');
  const sourceHome = path.join(dir, 'srchome');
  for (const d of [tmpDir, path.join(sourceHome, '.fakehome')]) fs.mkdirSync(d, { recursive: true });
  if (withCredential) fs.writeFileSync(path.join(sourceHome, '.fakehome', 'auth.json'), '{"token":"credential-body"}');
  const runRoot = path.join(dir, 'runs');
  const dump = path.join(dir, 'dump.jsonl');
  const env = {
    PATH: `${BIN}${path.delimiter}${process.env.PATH}`, HOME: '/nonexistent-caller-home', TMPDIR: tmpDir, LANG: 'C', TERM: 'xterm',
    SECRET_CANARY: 'canary-1', OPENAI_API_KEY: 'sk-canary-2', DOFLOW_HOLDOUT_KEY: 'canary-3',
  };
  const extraEnv = { AGENTIC_FAKE_SCENARIO: scenario, AGENTIC_FAKE_DUMP: dump, AGENTIC_FAKE_HOME_VAR: 'FAKE_HOME' };
  const opts = {
    repoRoot, config, registry: REGISTRY, taskSet: TASK_SET, iteration: 'it1', arm: 'N', cap: 1000000, runRoot, env, extraEnv,
    sourceHome, tmpDir, materialise: fakeMaterialise,
  };
  return { dir, repoRoot, tmpDir, runRoot, dump, env, extraEnv, opts };
}

function writeScenario(s, name, obj) {
  const file = path.join(s.dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

const readDump = (s) => (fs.existsSync(s.dump) ? fs.readFileSync(s.dump, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const runDump = (s) => readDump(s).filter((r) => r.kind === 'run');
const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(...parts), 'utf8'));
const leftovers = (s) => fs.readdirSync(s.tmpDir).filter((n) => n.startsWith('doflow-agentic-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One-task scenario for a behaviour, for task T1 on both arms. */
const oneTask = (spec) => ({ armMarkers: { D: 'retrieval command' }, tasks: { T1: { match: 'widget is frobbed', N: spec, D: spec } } });

function assertRefused(s, result, reason) {
  assert.equal(result.exit, 2);
  assert.equal(result.reason, reason);
  assert.equal(typeof result.refusal, 'string');
  assert.deepEqual(result.ran, []);
  assert.equal(fs.existsSync(path.join(s.runRoot, s.opts.iteration, 'iteration.json')), false, 'no iteration.json after a refusal');
  for (const t of TASKS) assert.equal(fs.existsSync(path.join(s.runRoot, s.opts.iteration, t.id)), s.preexisting?.includes(t.id) === true, `no run directory for ${t.id}`);
  assert.deepEqual(readDump(s), [], 'nothing was spawned (not even --version)');
  assert.deepEqual(leftovers(s), []);
}

// --- config -----------------------------------------------------------------------------------

test('loadConfig: the shipped config has both arms, compilable patterns and the IC-003 defaults', () => {
  const c = REAL_CONFIG;
  assert.deepEqual(Object.keys(c.arms).sort(), ['D', 'N']);
  assert.deepEqual(c.harness, { select: 'worker.readOnly', pin: null });
  assert.equal(c.model.label, 'codex:gpt-6-luna:medium');
  assert.equal(c.timeoutSeconds, 900);
  assert.equal(c.maxTokensPerRun, 250000);
  assert.deepEqual(c.arms.N.pathAdd, []);
  assert.deepEqual(c.arms.D.pathAdd, ['doflow-shim']);
  assert.equal(c.arms.N.leak.length, 2);
  assert.equal(c.arms.D.leak.length, 1);
  assert.equal(c.arms.N.count, undefined);
  assert.equal(c.arms.D.count.length, 1);
  assert.equal(c.arms.N.paragraph.includes('retrieval'), false, 'arm N never names the tool');
});

test('loadConfig: a malformed config is refused with the field named, never defaulted', () => {
  const write = (name, text) => {
    const file = path.join(TMP, `cfg-${++seq}-${name}.json`);
    fs.writeFileSync(file, text);
    return file;
  };
  const broken = (mutate) => write('c', JSON.stringify(testConfig(mutate)));
  const cases = [
    ['not json', write('bad', '{ nope'), '(file)'],
    ['schema', broken((c) => { c.schemaVersion = 2; }), 'schemaVersion'],
    ['missing paragraph', broken((c) => { delete c.arms.N.paragraph; }), 'arms.N.paragraph'],
    ['bad leak regex', broken((c) => { c.arms.D.leak = ['(unclosed']; }), 'arms.D.leak[0]'],
    ['leak not array', broken((c) => { c.arms.N.leak = 'x'; }), 'arms.N.leak'],
    ['bad count regex', broken((c) => { c.arms.D.count = ['[']; }), 'arms.D.count[0]'],
    ['timeout string', broken((c) => { c.timeoutSeconds = '900'; }), 'timeoutSeconds'],
    ['cap per run zero', broken((c) => { c.maxTokensPerRun = 0; }), 'maxTokensPerRun'],
    ['copy with a path', broken((c) => { c.home.copy = ['../auth.json']; }), 'home.copy'],
    ['path with a slash', broken((c) => { c.path = ['/usr/bin/node']; }), 'path'],
    ['no arms', broken((c) => { c.arms = {}; }), 'arms'],
    ['select shape', broken((c) => { c.harness.select = 'readOnly'; }), 'harness.select'],
  ];
  for (const [name, file, field] of cases) {
    assert.throws(() => execute.loadConfig(file), (e) => e instanceof UsageError && e.reason === 'config-invalid' && e.field === field && e.message.includes(field), name);
  }
  assert.doesNotThrow(() => execute.loadConfig(write('ok', JSON.stringify(testConfig()))));
});

// --- harness selection and argv ---------------------------------------------------------------

test('selectHarness: chosen by capability from a registry with made-up names; pin settles a tie', () => {
  const sel = execute.selectHarness(REGISTRY, REAL_CONFIG);
  assert.equal(sel.id, 'alpha');
  assert.equal(sel.recipe.cli.binary, 'fakeharness-alpha');

  assert.throws(() => execute.selectHarness(AMBIGUOUS, REAL_CONFIG), (e) => e instanceof UsageError && e.reason === 'harness-ambiguous');
  const pinned = clone(REAL_CONFIG);
  pinned.harness.pin = 'gamma';
  assert.equal(execute.selectHarness(AMBIGUOUS, pinned).id, 'gamma');
  pinned.harness.pin = 'beta';
  assert.throws(() => execute.selectHarness(AMBIGUOUS, pinned), (e) => e.reason === 'harness-none', 'a pin that does not qualify');

  const none = { version: 1, harnesses: [REGISTRY.harnesses[1]] };
  assert.throws(() => execute.selectHarness(none, REAL_CONFIG), (e) => e instanceof UsageError && e.reason === 'harness-none');
  const partial = clone(REGISTRY);
  partial.harnesses[0].worker.spawnDenial.status = 'unsupported';
  assert.throws(() => execute.selectHarness(partial, REAL_CONFIG), (e) => e.reason === 'harness-none', 'every recipe group is required');
});

test('selectHarness: the shipped registry yields exactly one harness without a pin', () => {
  const registry = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'harnesses.json'), 'utf8'));
  const sel = execute.selectHarness(registry, REAL_CONFIG);
  assert.equal(typeof sel.id, 'string');
  assert.equal(typeof sel.recipe.cli.binary, 'string');
});

test('insertModelArgv: equals assembleArgv with the model argv right after the read-only group', () => {
  const recipe = REGISTRY.harnesses[0].worker;
  const lastMessage = '/runs/x/last-message.txt';
  const base = launch.assembleArgv(recipe, 'prompt text', false, lastMessage);
  const withModel = execute.insertModelArgv(recipe, base, ['-m', 'fake-model']);
  assert.deepEqual(withModel, [
    'exec', '-s', 'read-only', '-m', 'fake-model', '--disable', 'multi_agent', '--json', '-o', lastMessage, '--ephemeral', '-',
  ]);
  const at = recipe.readOnly.argv.length;
  assert.deepEqual(withModel, [...base.slice(0, at), '-m', 'fake-model', ...base.slice(at)]);
  assert.deepEqual(execute.insertModelArgv(recipe, base, []), base);
});

// --- plan -------------------------------------------------------------------------------------

test('planIteration: offline projection with the redacted argv, spawning nothing', () => {
  const s = setup();
  const saved = { spawn: childProcess.spawn, spawnSync: childProcess.spawnSync };
  childProcess.spawn = childProcess.spawnSync = () => { throw new Error('plan must not spawn'); };
  let plan;
  try {
    plan = execute.planIteration({ ...s.opts, arm: 'D' });
  } finally {
    Object.assign(childProcess, saved);
  }
  assert.equal(plan.arm, 'D');
  assert.equal(plan.iteration, 'it1');
  assert.equal(plan.harness, 'alpha');
  assert.equal(plan.harnessBinary, 'fakeharness-alpha');
  assert.equal(plan.harnessVersion, null, 'plan never runs the binary');
  assert.equal(plan.model, 'fake:model');
  assert.equal(plan.snapshot, 'deadbeef');
  assert.deepEqual(plan.runs.map((r) => r.id), ['T1', 'T2', 'T3']);
  const prompt = buildPrompt(TASKS[0], s.opts.config.arms.D.paragraph);
  const r0 = plan.runs[0];
  assert.equal(r0.key, TASKS[0].key);
  assert.equal(r0.split, 'train');
  assert.equal(r0.kind, 'conceptual-discovery');
  assert.equal(r0.runDir, path.join(s.runRoot, 'it1', 'T1'));
  assert.equal(r0.promptSha256, promptSha256(prompt));
  assert.equal(r0.promptBytes, Buffer.byteLength(prompt));
  assert.deepEqual(r0.argvShape.slice(0, 5), ['exec', '-s', 'read-only', '-m', 'fake-model']);
  assert.ok(r0.argvShape.includes('<last-message-file>'));
  assert.equal(JSON.stringify(plan).includes(TASKS[0].query), false, 'the plan never carries prompt text');
  assert.deepEqual(plan.projection, { runs: 3, maxTokensPerRun: 1000, ceilingTokens: 3000, typicalTokens: null });
  assert.equal(fs.existsSync(s.runRoot), false, 'plan writes nothing');
});

test('planIteration: --tasks filters in task order; unknown ids and arms are refused', () => {
  const s = setup();
  assert.deepEqual(execute.planIteration({ ...s.opts, tasks: ['T3', 'T1'] }).runs.map((r) => r.id), ['T1', 'T3']);
  assert.deepEqual(execute.planIteration({ ...s.opts, tasks: 'T2' }).runs.map((r) => r.id), ['T2']);
  assert.throws(() => execute.planIteration({ ...s.opts, tasks: ['T9'] }), (e) => e.reason === 'task-unknown');
  assert.throws(() => execute.planIteration({ ...s.opts, tasks: [] }), (e) => e.reason === 'tasks-empty');
  assert.throws(() => execute.planIteration({ ...s.opts, arm: 'Z' }), (e) => e.reason === 'arm-unknown');
  assert.throws(() => execute.planIteration({ ...s.opts, iteration: '../x' }), (e) => e.reason === 'iteration-invalid');
});

test('planIteration: typicalTokens is runs times the median of recorded runs on the same model label only', () => {
  const s = setup();
  const record = (iteration, model, tokensList) => {
    fs.mkdirSync(path.join(s.runRoot, iteration), { recursive: true });
    fs.writeFileSync(path.join(s.runRoot, iteration, 'iteration.json'), JSON.stringify({ arm: 'N', model }));
    tokensList.forEach((tokens, i) => {
      const dir = path.join(s.runRoot, iteration, `R${i}`);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'launch.json'), '{}');
      fs.writeFileSync(path.join(dir, 'timing.json'), JSON.stringify(tokens === null ? { duration_ms: 1 } : { total_tokens: tokens, duration_ms: 1 }));
    });
  };
  record('old-a', 'fake:model', [100, 300, null]);
  record('old-b', 'fake:model', [200]);
  record('other', 'other:model', [999999]);
  const plan = execute.planIteration(s.opts);
  assert.equal(plan.projection.typicalTokens, 3 * 200, 'median of 100, 200, 300 (the unknown run is left out)');
});

// --- execute: refusals ------------------------------------------------------------------------

test('execute refuses with exit 2, zero runs and nothing written', async () => {
  const caps = [undefined, null, 0, -5, 1.5, 'abc', ''];
  for (const cap of caps) {
    const s = setup();
    assertRefused(s, await execute.executeIteration({ ...s.opts, cap }), 'cap-invalid');
  }

  let s = setup({ ownRepo: true });
  fs.writeFileSync(path.join(s.repoRoot, 'untracked.txt'), 'dirty\n');
  assertRefused(s, await execute.executeIteration(s.opts), 'tree-dirty');

  s = setup();
  fs.mkdirSync(path.join(s.runRoot, 'it1', 'T2'), { recursive: true });
  s.preexisting = ['T2'];
  assertRefused(s, await execute.executeIteration(s.opts), 'run-exists');

  s = setup();
  assertRefused(s, await execute.executeIteration({ ...s.opts, cap: 2999 }), 'over-cap');

  s = setup();
  assertRefused(s, await execute.executeIteration({ ...s.opts, arm: 'Z' }), 'arm-unknown');

  s = setup();
  assertRefused(s, await execute.executeIteration({ ...s.opts, tasks: ['T9'] }), 'task-unknown');

  s = setup();
  assertRefused(s, await execute.executeIteration({ ...s.opts, registry: AMBIGUOUS }), 'harness-ambiguous');

  s = setup();
  assertRefused(s, await execute.executeIteration({ ...s.opts, env: { ...s.env, PATH: '/usr/bin:/bin' } }), 'harness-binary-missing');

  s = setup({ config: testConfig((c) => { c.path = ['node', 'no-such-tool-for-097']; }) });
  assertRefused(s, await execute.executeIteration(s.opts), 'tool-missing');
});

test('execute refuses a second invocation that disagrees with the existing iteration record', async () => {
  const s = setup();
  fs.mkdirSync(path.join(s.runRoot, 'it1'), { recursive: true });
  fs.writeFileSync(path.join(s.runRoot, 'it1', 'iteration.json'), JSON.stringify({ arm: 'D', model: 'fake:model', sourceAt: 'x', snapshot: 'deadbeef' }));
  const result = await execute.executeIteration({ ...s.opts, tasks: ['T1'] });
  assert.equal(result.exit, 2);
  assert.equal(result.reason, 'iteration-mismatch');
  assert.deepEqual(readDump(s), []);
  assert.equal(fs.existsSync(path.join(s.runRoot, 'it1', 'T1')), false);
});

// --- execute: a complete run ------------------------------------------------------------------

test('execute: records iteration, launch, transcript, status and timing; the harness sees a fresh git workspace', async () => {
  const s = setup();
  const result = await execute.executeIteration({ ...s.opts, arm: 'D', tasks: ['T1'] });
  assert.equal(result.exit, 0, result.refusal);
  assert.deepEqual(result.ran, ['T1']);
  assert.deepEqual(result.undone, []);
  assert.equal(result.spent, 900);

  const head = git(s.repoRoot, 'rev-parse', 'HEAD');
  const iteration = readJson(s.runRoot, 'it1', 'iteration.json');
  assert.deepEqual(Object.keys(iteration).sort(), ['arm', 'captureSha256', 'harness', 'harnessVersion', 'model', 'snapshot', 'sourceAt', 'startedAt']);
  assert.equal(iteration.arm, 'D');
  assert.equal(iteration.model, 'fake:model');
  assert.equal(iteration.sourceAt, head);
  assert.equal(iteration.snapshot, 'deadbeef');
  assert.equal(iteration.harness, 'alpha');
  assert.equal(iteration.harnessVersion, 'fake 0.0.0');
  assert.match(iteration.startedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(execute.readIteration(path.join(s.runRoot, 'it1')), iteration);
  assert.deepEqual(fs.readdirSync(path.join(s.runRoot, 'it1')).sort(), ['T1', 'iteration.json'], 'the lock is released');

  const dir = path.join(s.runRoot, 'it1', 'T1');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['last-message.txt', 'launch.json', 'run_status.json', 'timing.json', 'transcript.jsonl']);
  const launchJson = readJson(dir, 'launch.json');
  const prompt = buildPrompt(TASKS[0], s.opts.config.arms.D.paragraph);
  assert.equal(launchJson.key, TASKS[0].key);
  assert.equal(launchJson.arm, 'D');
  assert.equal(launchJson.harness, 'alpha');
  assert.equal(launchJson.harnessVersion, 'fake 0.0.0');
  assert.equal(launchJson.model, 'fake:model');
  assert.equal(launchJson.promptSha256, promptSha256(prompt));
  assert.equal(launchJson.promptBytes, Buffer.byteLength(prompt));
  assert.deepEqual(launchJson.argvShape, execute.planIteration({ ...s.opts, arm: 'D' }).runs[0].argvShape);
  assert.deepEqual(launchJson.toolProfile.pathAdd, ['doflow-shim']);
  assert.deepEqual(launchJson.toolProfile.pathDirs, ['<profile>/bin'], 'no caller directory is recorded or used');
  assert.deepEqual(Object.keys(launchJson.toolProfile.tools).sort(), ['git', 'node']);
  assert.ok(Object.values(launchJson.toolProfile.tools).every((target) => path.isAbsolute(target)));
  assert.equal(launchJson.snapshot, 'deadbeef');
  assert.equal(launchJson.credentialCopied, true);
  const launchText = fs.readFileSync(path.join(dir, 'launch.json'), 'utf8');
  for (const forbidden of [TASKS[0].query, 'canary', 'credential-body', s.opts.sourceHome]) {
    assert.equal(launchText.includes(forbidden), false, `launch.json must not hold: ${forbidden}`);
  }

  assert.equal(fs.readFileSync(path.join(dir, 'last-message.txt'), 'utf8'), '{"files":["src/a.js","src/b.js"]}');
  const events = fs.readFileSync(path.join(dir, 'transcript.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => e.type), ['item.completed', 'item.completed', 'turn.completed']);
  assert.match(events[0].item.command, /doflow retrieve/);
  assert.deepEqual(readJson(dir, 'run_status.json'), { status: 'completed', exitCode: 0, signal: null });
  const timing = readJson(dir, 'timing.json');
  assert.equal(timing.total_tokens, 900);
  assert.equal(timing.usage, 'reported');
  assert.equal(Number.isFinite(timing.duration_ms) && timing.duration_ms >= 0, true);

  const runs = runDump(s);
  assert.equal(runs.length, 1);
  const lastMessageFile = path.join(launchJson.profileRoot, 'last-message.txt');
  assert.deepEqual(runs[0].argv, [
    'exec', '-s', 'read-only', '-m', 'fake-model', '--disable', 'multi_agent', '--json', '-o', lastMessageFile, '--ephemeral', '-',
  ]);
  assert.equal(path.dirname(runs[0].HOME), launchJson.profileRoot);
  assert.equal(runs[0].cwd, launchJson.workspaceRoot);
  assert.equal(runs[0].prompt, prompt, 'the prompt on stdin is exactly the IC-011 template');
  assert.equal(runs[0].hasGit, true, 'the workspace is its own git root');
  assert.equal(runs[0].cwd.startsWith(s.tmpDir) || fs.realpathSync(s.tmpDir) === fs.realpathSync(path.dirname(path.dirname(runs[0].cwd))), true);
  assert.equal(readDump(s)[0].kind, 'version', '--version is answered before the first run');
  assert.deepEqual(leftovers(s), []);
});

test('execute: both arms differ only in the paragraph and one PATH entry; env is the allowlist; shim and credentials as specified (FR-002, NFR-010)', async () => {
  const s = setup();
  fs.writeFileSync(path.join(s.dir, 'srchome', '.fakehome', 'extra.txt'), 'must not be copied');
  await execute.executeIteration({ ...s.opts, iteration: 'it-n', arm: 'N', tasks: ['T1'] });
  await execute.executeIteration({ ...s.opts, iteration: 'it-d', arm: 'D', tasks: ['T1'] });
  const [n, d] = runDump(s);

  const swap = (record, name) => record.argv.map((a) => a.replace(`/${name}/`, '/IT/').replace(/\/doflow-agentic-[^/]+\/last-message\.txt$/, '/PROFILE/last-message.txt'));
  assert.deepEqual(swap(n, 'it-n'), swap(d, 'it-d'));
  assert.deepEqual(n.envKeys, d.envKeys);
  const norm = (p) => p.replace(/doflow-agentic-[^/:]+/g, 'PROFILE');
  assert.ok(norm(d.PATH).startsWith(`${norm(n.PATH)}${path.delimiter}`), 'arm D PATH is arm N PATH plus the shim directory');
  assert.equal(norm(d.PATH).slice(norm(n.PATH).length + 1).split(path.delimiter).length, 1);
  assert.equal(
    d.prompt.replace(REAL_CONFIG.arms.D.paragraph, REAL_CONFIG.arms.N.paragraph), n.prompt,
    'the prompts differ only by the arm paragraph',
  );
  assert.equal(n.prompt.includes('retrieval'), false);

  // The shim: one executable script in a per-run directory, arm D only, removed with the profile.
  assert.equal(n.doflowFiles.some((f) => f.dir.includes('doflow-agentic-')), false);
  const shim = d.doflowFiles.filter((f) => f.dir.includes('doflow-agentic-'));
  assert.equal(shim.length, 1);
  assert.equal(shim[0].mode & 0o111, 0o111, 'executable');
  assert.match(shim[0].text, /^#!\/bin\/sh\nexec node '[^']*\/doflow-agentic-tool-[^/']+\/bin\/doflow\.js' "\$@"\n$/);
  assert.equal(shim[0].text.includes(s.repoRoot), false, 'the shim never names the checkout');
  assert.equal(fs.existsSync(shim[0].dir), false, 'removed with the profile');

  // The environment: only the allowlist, a fresh HOME, and only the listed credential file.
  const allowed = new Set(['PATH', 'HOME', 'FAKE_HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', '__CF_USER_TEXT_ENCODING']);
  for (const run of [n, d]) {
    for (const key of run.envKeys.filter((k) => !k.startsWith('AGENTIC_FAKE_'))) assert.ok(allowed.has(key), `unexpected variable in the child env: ${key}`);
    for (const key of ['SECRET_CANARY', 'OPENAI_API_KEY', 'DOFLOW_HOLDOUT_KEY']) assert.equal(run.envKeys.includes(key), false, key);
    assert.notEqual(run.HOME, s.env.HOME);
    assert.match(run.HOME, /doflow-agentic-[^/]+\/home$/);
    assert.equal(run.profileMode, 0o700);
    assert.match(run.harnessHome, /doflow-agentic-[^/]+\/harness-home$/);
    assert.deepEqual(run.harnessHomeFiles, ['auth.json']);
    assert.ok(run.PATH.split(path.delimiter).includes('/usr/bin'));
  }
  assert.ok(n.PATH.endsWith('/usr/bin:/bin'));
  assert.deepEqual(leftovers(s), []);
});

test('execute: the run PATH holds a per-run bin of symlinks, never a caller directory (one-tool contrast)', async () => {
  const s = setup({ config: testConfig((c) => { c.path = ['node', 'rg', 'git']; }) });
  // A caller directory that holds the tools AND the two programs that would break the contrast.
  const callerDir = path.join(s.dir, 'caller-bin');
  fs.mkdirSync(callerDir);
  fs.symlinkSync(process.execPath, path.join(callerDir, 'node'));
  fs.symlinkSync(childProcess.execFileSync('which', ['git'], { encoding: 'utf8' }).trim(), path.join(callerDir, 'git'));
  for (const name of ['rg', 'doflow', 'codex']) {
    fs.writeFileSync(path.join(callerDir, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  const env = { ...s.env, PATH: `${BIN}${path.delimiter}${callerDir}${path.delimiter}${process.env.PATH}` };
  const extraEnv = { ...s.extraEnv, AGENTIC_FAKE_WATCH: 'doflow,codex,rg,node,git' };
  await execute.executeIteration({ ...s.opts, env, extraEnv, iteration: 'it-n', arm: 'N', tasks: ['T1'] });
  await execute.executeIteration({ ...s.opts, env, extraEnv, iteration: 'it-d', arm: 'D', tasks: ['T1'] });
  const [n, d] = runDump(s);

  const entries = (run) => run.PATH.split(path.delimiter);
  assert.equal(entries(n).length, 3);
  assert.match(entries(n)[0], /doflow-agentic-[^/]+\/bin$/);
  assert.deepEqual(entries(n).slice(1), ['/usr/bin', '/bin']);
  assert.equal(n.PATH.includes(callerDir), false);
  // The per-run bin holds exactly the configured tools, each a link to the tool's own path on the caller PATH.
  assert.deepEqual(n.firstPathDir, {
    git: path.join(callerDir, 'git'), node: path.join(callerDir, 'node'), rg: path.join(callerDir, 'rg'),
  });
  assert.deepEqual(readJson(s.runRoot, 'it-n', 'T1', 'launch.json').toolProfile.tools, n.firstPathDir);
  // Arm N cannot reach doflow or the harness binary (/usr/bin and /bin hold neither on this machine).
  assert.deepEqual(n.watch.doflow, []);
  assert.deepEqual(n.watch.codex, []);
  assert.equal(n.watch.rg.length, 1);
  // Arm D reaches doflow only through the shim directory.
  assert.equal(d.watch.doflow.length, 1);
  assert.notEqual(d.watch.doflow[0], callerDir);
  assert.match(d.watch.doflow[0], /doflow-agentic-[^/]+\/shim$/);
  assert.deepEqual(d.watch.codex, []);
  assert.equal(d.PATH.includes(callerDir), false);
  assert.deepEqual(leftovers(s), []);
});

test('execute: a third arm added in a config runs without a code change; a missing credential file is recorded (FR-013)', async () => {
  const config = testConfig((c) => { c.arms.X = { paragraph: 'Use only your shell tools, arm X.', pathAdd: [], leak: [] }; });
  const s = setup({ config, withCredential: false });
  const plan = execute.planIteration({ ...s.opts, arm: 'X', tasks: ['T1'] });
  assert.equal(plan.arm, 'X');
  const result = await execute.executeIteration({ ...s.opts, arm: 'X', tasks: ['T1'] });
  assert.equal(result.exit, 0, result.refusal);
  assert.equal(readJson(s.runRoot, 'it1', 'iteration.json').arm, 'X');
  assert.ok(runDump(s)[0].prompt.includes('arm X'));
  assert.equal(readJson(s.runRoot, 'it1', 'T1', 'launch.json').credentialCopied, false, 'recorded, and the run still went ahead');
  assert.deepEqual(runDump(s)[0].harnessHomeFiles, []);
  assert.deepEqual(leftovers(s), []);
});

// --- execute: outcomes and cleanup ------------------------------------------------------------

test('execute: api-error, silent and unreported usage are recorded outcomes with cleanup, never exit codes', async () => {
  const s = setup();
  const scenario = writeScenario(s, 'outcomes', {
    tasks: {
      T1: { match: 'widget is frobbed', N: { behaviour: 'api-error', message: 'rate limited' } },
      T2: { match: 'gadget is wired', N: { behaviour: 'silent' } },
      T3: { match: 'sprocket is spun', N: { files: ['src/z.js'], tokens: null } },
    },
  });
  const result = await execute.executeIteration({ ...s.opts, extraEnv: { ...s.extraEnv, AGENTIC_FAKE_SCENARIO: scenario } });
  assert.equal(result.exit, 0, result.refusal);
  assert.deepEqual(result.ran, ['T1', 'T2', 'T3']);

  const dir = (id) => path.join(s.runRoot, 'it1', id);
  assert.deepEqual(readJson(dir('T1'), 'run_status.json'), { status: 'api-error', evidence: 'rate limited', exitCode: 1, signal: null });
  assert.equal('total_tokens' in readJson(dir('T1'), 'timing.json'), false);
  assert.deepEqual(readJson(dir('T2'), 'run_status.json'), { status: 'truncated', evidence: 'unparsed: no-turn-end', exitCode: 0, signal: null });
  assert.equal(fs.readFileSync(path.join(dir('T2'), 'transcript.jsonl'), 'utf8'), '');
  assert.equal('total_tokens' in readJson(dir('T2'), 'timing.json'), false, 'unreported usage is omitted, never 0');
  assert.deepEqual(readJson(dir('T3'), 'run_status.json'), { status: 'completed', exitCode: 0, signal: null });
  assert.equal('total_tokens' in readJson(dir('T3'), 'timing.json'), false);
  assert.deepEqual(leftovers(s), [], 'workspace and profile removed after success and api-error');
});

// R-1 / R-6: usage the worker already reported is never thrown away when the run does not end on its
// own terms. An interrupted or timed-out run counts at the larger of its transcript sum and
// maxTokensPerRun, so an overshoot followed by an interrupt still stops the next command.
const R1_CONFIG = () => testConfig((c) => { c.timeoutSeconds = 60; c.maxTokensPerRun = 250000; });
const reportedTurn = (s) => {
  const file = path.join(s.runRoot, 'it1', 'T1', 'transcript.jsonl');
  return fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('turn.completed');
};

test('R-1: SIGINT after the worker reported 900000 tokens records the larger of the sum and maxTokensPerRun; the next command is stopped by the cap', { timeout: 30000 }, async () => {
  const s = setup({ config: R1_CONFIG() });
  const scenario = writeScenario(s, 'overhang', oneTask({ behaviour: 'report-then-hang', tokens: 900000 }));
  const extraEnv = { ...s.extraEnv, AGENTIC_FAKE_SCENARIO: scenario };
  const { child, done } = spawnDriver(s, { tasks: ['T1'], extraEnv });
  assert.ok(await waitFor(() => reportedTurn(s)), 'the worker reported its turn');
  child.kill('SIGINT');
  const ended = await done;
  assert.equal(ended.signal, 'SIGINT', `the executor re-raises SIGINT (stderr: ${ended.stderr})`);
  const dir = path.join(s.runRoot, 'it1', 'T1');
  assert.equal(readJson(dir, 'run_status.json').status, 'truncated');
  assert.equal(readJson(dir, 'timing.json').total_tokens, 900000, 'the reported usage is kept, not replaced by unknown');
  const next = await execute.executeIteration({ ...s.opts, tasks: ['T2'], cap: 500000, extraEnv });
  assert.equal(next.exit, 3, 'counting the interrupted run at 250000 would admit T2 (250000 + 250000 <= 500000)');
  assert.deepEqual(next.ran, []);
  assert.deepEqual(next.undone, ['T2']);
  assert.equal(next.spent, 900000);
  assert.equal(runDump(s).length, 1, 'no second paid spawn');
});

test('R-1: SIGINT after a small reported usage still counts the run at maxTokensPerRun', { timeout: 30000 }, async () => {
  const s = setup({ config: R1_CONFIG() });
  const scenario = writeScenario(s, 'smallhang', oneTask({ behaviour: 'report-then-hang', tokens: 100 }));
  const extraEnv = { ...s.extraEnv, AGENTIC_FAKE_SCENARIO: scenario };
  const { child, done } = spawnDriver(s, { tasks: ['T1'], extraEnv });
  assert.ok(await waitFor(() => reportedTurn(s)), 'the worker reported its turn');
  child.kill('SIGINT');
  assert.equal((await done).signal, 'SIGINT');
  const next = await execute.executeIteration({ ...s.opts, tasks: ['T2'], cap: 400000, extraEnv });
  assert.equal(next.exit, 3, '250000 + 250000 > 400000');
  assert.equal(next.spent, 250000, 'a turn may have been in flight: the run counts at maxTokensPerRun, not 100');
});

test('R-6: a timed-out run that reported a turn counts at the larger of its sum and maxTokensPerRun', async () => {
  const s = setup({ config: testConfig((c) => { c.timeoutSeconds = 0.5; c.maxTokensPerRun = 250000; }) });
  const scenario = writeScenario(s, 'timeouthang', oneTask({ behaviour: 'report-then-hang', tokens: 100 }));
  const extraEnv = { ...s.extraEnv, AGENTIC_FAKE_SCENARIO: scenario };
  const first = await execute.executeIteration({ ...s.opts, tasks: ['T1'], extraEnv });
  assert.equal(readJson(s.runRoot, 'it1', 'T1', 'run_status.json').status, 'timeout');
  assert.equal(readJson(s.runRoot, 'it1', 'T1', 'timing.json').total_tokens, 100, 'the reported sum is kept as recorded');
  assert.equal(first.spent, 250000, 'counting the reported 100 would hide a turn in flight');
});

test('execute: a timeout ends the whole process tree, records it, and removes workspace and profile', async () => {
  const config = testConfig((c) => { c.timeoutSeconds = 0.5; });
  const s = setup({ config });
  const pidfile = path.join(s.dir, 'sleeper.pid');
  const scenario = writeScenario(s, 'timeout', oneTask({ behaviour: 'timeout' }));
  const started = Date.now();
  const result = await execute.executeIteration({
    ...s.opts, tasks: ['T1'], extraEnv: { ...s.extraEnv, AGENTIC_FAKE_SCENARIO: scenario, AGENTIC_FAKE_PIDFILE: pidfile },
  });
  assert.equal(result.exit, 0, 'a timeout is a recorded outcome');
  assert.ok(Date.now() - started < 9000);
  const dir = path.join(s.runRoot, 'it1', 'T1');
  const status = readJson(dir, 'run_status.json');
  assert.equal(status.status, 'timeout');
  assert.match(status.evidence, /0\.5s/);
  assert.equal('total_tokens' in readJson(dir, 'timing.json'), false);

  const pid = Number(fs.readFileSync(pidfile, 'utf8'));
  let alive = true;
  for (let i = 0; i < 20 && alive; i++) {
    try {
      process.kill(pid, 0);
      await sleep(50);
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, 'the leader\'s child was ended with the tree');
  assert.deepEqual(leftovers(s), [], 'workspace and profile removed after a timeout');
});

// --- execute: cap and stop rule ---------------------------------------------------------------

test('execute: the stop rule halts before a run that could pass the cap, exit 3, and lists the undone ids', async () => {
  const s = setup();
  const scenario = writeScenario(s, 'overshoot', { tasks: { T1: { match: 'widget is frobbed', N: { tokens: 1500 } } } });
  const result = await execute.executeIteration({ ...s.opts, tasks: ['T1', 'T2'], cap: 2000, extraEnv: { ...s.extraEnv, AGENTIC_FAKE_SCENARIO: scenario } });
  assert.equal(result.exit, 3);
  assert.deepEqual(result.ran, ['T1']);
  assert.deepEqual(result.undone, ['T2']);
  assert.equal(result.spent, 1500);
  assert.equal(fs.existsSync(path.join(s.runRoot, 'it1', 'T2')), false, 'no directory for an undone task');
  assert.deepEqual(leftovers(s), []);
});

test('execute: spend counts earlier runs of the iteration, and a run with unknown usage at maxTokensPerRun', async () => {
  const s = setup();
  const head = git(s.repoRoot, 'rev-parse', 'HEAD');
  const seed = (name, timing) => {
    const dir = path.join(s.runRoot, 'it1', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'launch.json'), '{}');
    fs.writeFileSync(path.join(dir, 'timing.json'), JSON.stringify(timing));
  };
  seed('EARLIER', { total_tokens: 1500, duration_ms: 1 });
  seed('BLIND', { duration_ms: 1 });
  fs.writeFileSync(path.join(s.runRoot, 'it1', 'iteration.json'), JSON.stringify({ arm: 'N', model: 'fake:model', sourceAt: head, snapshot: 'deadbeef', captureSha256: execute.captureSha256(s.opts.config) }));
  const scenario = writeScenario(s, 'small', {
    tasks: { T1: { match: 'widget is frobbed', N: { tokens: 100 } }, T2: { match: 'gadget is wired', N: { tokens: 100 } } },
  });
  // Spent so far: 1500 recorded + 1000 for the blind run = 2500. T1 fits exactly (2500 + 1000 = 3500), T2 does not
  // (2600 + 1000 > 3500). Counting the blind run at 0 would let T2 run too.
  const result = await execute.executeIteration({ ...s.opts, tasks: ['T1', 'T2'], cap: 3500, extraEnv: { ...s.extraEnv, AGENTIC_FAKE_SCENARIO: scenario } });
  assert.equal(result.exit, 3);
  assert.deepEqual(result.ran, ['T1']);
  assert.deepEqual(result.undone, ['T2']);
  assert.equal(result.spent, 2600);
});

// --- workspace --------------------------------------------------------------------------------

test('prepareWorkspace: the real snapshot export becomes its own single-commit git root', { timeout: 120000 }, (t) => {
  const present = childProcess.spawnSync('git', ['-C', REPO, 'cat-file', '-e', `${SNAPSHOT.commit}^{commit}`]);
  if (present.status !== 0) {
    t.skip(`snapshot commit ${SNAPSHOT.commit} is absent from this clone`);
    return;
  }
  const parent = path.join(TMP, `ws-${++seq}`);
  fs.mkdirSync(parent);
  const home = path.join(parent, 'home');
  fs.mkdirSync(home);
  const ws = execute.prepareWorkspace({ commit: SNAPSHOT.commit, snapshot: SNAPSHOT, repoRoot: REPO, parent, home });
  try {
    const run = (...args) => childProcess.spawnSync('git', args, { cwd: ws.root, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
    assert.equal(fs.realpathSync(run('rev-parse', '--show-toplevel').stdout.trim()), fs.realpathSync(ws.root));
    assert.equal(run('rev-list', '--count', 'HEAD').stdout.trim(), '1', 'the checkout history is not visible');
    assert.equal(fs.existsSync(path.join(ws.root, 'src')), true);
    assert.equal(fs.existsSync(path.join(ws.root, 'agent-docs')), false, 'pruned like the retrieval export');
  } finally {
    ws.cleanup();
  }
  assert.deepEqual(fs.readdirSync(parent).filter((n) => n.startsWith('doflow-agentic-ws-')), []);
});

// --- review fixes (097 review C-1..C-11, N-1, N-2, N-4) -----------------------------------------

const DRIVER = path.join(REPO, 'test', 'fixtures', 'agentic', 'execute-driver.js');
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function waitFor(predicate, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}
const authCopies = (dir) => {
  const found = [];
  const walk = (d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === 'auth.json') found.push(full);
    }
  };
  walk(dir);
  return found;
};

/** Starts the executor in a child process; resolves `{ code, signal, stdout }` when it ends. */
function spawnDriver(s, overrides = {}) {
  const optsFile = path.join(s.dir, `driver-${++seq}.json`);
  const { materialise, ...plain } = { ...s.opts, ...overrides };
  fs.writeFileSync(optsFile, JSON.stringify(plain));
  const child = childProcess.spawn(process.execPath, [DRIVER, optsFile], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const done = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr })));
  return { child, done };
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  test(`C-1: ${sig} to the executor ends the worker group, removes profile and workspace, keeps the spend, and re-raises`, { timeout: 30000 }, async () => {
    const s = setup({ config: testConfig((c) => { c.timeoutSeconds = 60; }) });
    const pidfile = path.join(s.dir, 'sleeper.pid');
    const scenario = writeScenario(s, 'hang', oneTask({ behaviour: 'timeout' }));
    const { child, done } = spawnDriver(s, { tasks: ['T1'], extraEnv: { ...s.extraEnv, AGENTIC_FAKE_SCENARIO: scenario, AGENTIC_FAKE_PIDFILE: pidfile } });
    assert.ok(await waitFor(() => fs.existsSync(pidfile) && fs.readFileSync(pidfile, 'utf8') !== ''), 'the worker started');
    assert.ok(authCopies(s.tmpDir).length === 1, 'the credential copy exists while the worker runs');
    const workerPid = runDump(s)[0].pid;
    const sleeperPid = Number(fs.readFileSync(pidfile, 'utf8'));
    child.kill(sig);
    const ended = await done;
    assert.equal(ended.signal, sig, `the executor re-raises ${sig} (stdout: ${ended.stdout} stderr: ${ended.stderr})`);
    assert.ok(await waitFor(() => !isAlive(workerPid) && !isAlive(sleeperPid), 3000), 'no worker process survives');
    assert.deepEqual(authCopies(s.tmpDir), [], 'no credential copy is left');
    assert.deepEqual(leftovers(s), [], 'profile and workspace removed');
    const dir = path.join(s.runRoot, 'it1', 'T1');
    assert.equal(fs.existsSync(path.join(dir, 'launch.json')), true, 'the interrupted run keeps its record');
    assert.equal('total_tokens' in readJson(dir, 'timing.json'), false, 'its spend counts at maxTokensPerRun');
    assert.equal(readJson(dir, 'run_status.json').status, 'truncated');
    assert.match(readJson(dir, 'run_status.json').evidence, new RegExp(`interrupted by ${sig}`));
    assert.equal(fs.existsSync(path.join(s.runRoot, 'it1', '.lock')), false, 'the iteration lock is released');
    // The spend is still seen: a rerun of the same task is refused, another task is stopped by the cap.
    assert.equal((await execute.executeIteration({ ...s.opts, tasks: ['T1'] })).reason, 'run-exists');
    const next = await execute.executeIteration({ ...s.opts, tasks: ['T2'], cap: 1500 });
    assert.equal(next.exit, 3);
    assert.deepEqual(next.undone, ['T2']);
  });
}

test('C-1: a fault after the credential copy (shim write) or in the workspace cleanup leaves no credential copy', async () => {
  const real = { writeFileSync: fs.writeFileSync, rmSync: fs.rmSync };
  // (a) the arm D shim write fails after auth.json was copied: the profile is still removed.
  let s = setup();
  fs.writeFileSync = function patched(file, ...rest) {
    if (String(file).endsWith(`${path.sep}shim${path.sep}doflow`)) {
      const e = new Error('EACCES injected');
      e.code = 'EACCES';
      throw e;
    }
    return real.writeFileSync.call(this, file, ...rest);
  };
  try {
    await assert.rejects(execute.executeIteration({ ...s.opts, arm: 'D', tasks: ['T1'] }), /EACCES injected/);
  } finally {
    fs.writeFileSync = real.writeFileSync;
  }
  assert.deepEqual(authCopies(s.tmpDir), []);
  assert.deepEqual(leftovers(s), []);
  assert.equal(fs.existsSync(path.join(s.runRoot, 'it1', 'T1')), false, 'no spawn happened, so no run record is kept');
  assert.deepEqual(runDump(s), []);

  // (b) the workspace cleanup throws after a run: the profile is removed anyway, the run is kept.
  s = setup();
  let thrown = 0;
  fs.rmSync = function patched(target, ...rest) {
    if (String(target).includes('doflow-agentic-ws-') && thrown === 0) {
      thrown++;
      throw new Error('EBUSY injected');
    }
    return real.rmSync.call(this, target, ...rest);
  };
  try {
    await execute.executeIteration({ ...s.opts, tasks: ['T1'] }).catch(() => {});
  } finally {
    fs.rmSync = real.rmSync;
  }
  assert.equal(thrown, 1, 'the fault was injected');
  assert.deepEqual(authCopies(s.tmpDir), [], 'the credential copy is removed even when the workspace cleanup fails');
  assert.equal(fs.existsSync(path.join(s.runRoot, 'it1', 'T1', 'launch.json')), true);
});

test('C-2: two concurrent executors on one iteration spawn the task once; a second arm on a held iteration is refused', { timeout: 30000 }, async () => {
  const s = setup({ config: testConfig((c) => { c.timeoutSeconds = 0.6; }) });
  const scenario = writeScenario(s, 'slow', oneTask({ behaviour: 'timeout' }));
  const extraEnv = { ...s.extraEnv, AGENTIC_FAKE_SCENARIO: scenario };
  const a = spawnDriver(s, { tasks: ['T1'], extraEnv });
  const b = spawnDriver(s, { tasks: ['T1'], extraEnv });
  const [ra, rb] = await Promise.all([a.done, b.done]);
  assert.equal(runDump(s).length, 1, `exactly one spawn of T1 (exits ${ra.code}, ${rb.code})`);
  assert.deepEqual([ra.code, rb.code].sort(), [0, 2]);
  const refusal = JSON.parse([ra, rb].find((r) => r.code === 2).stdout);
  assert.ok(['iteration-locked', 'run-exists'].includes(refusal.reason), refusal.reason);

  // A second arm while the iteration is held: refused by the lock, before the iteration record exists.
  const s2 = setup({ config: testConfig((c) => { c.timeoutSeconds = 1.2; }) });
  const sc2 = writeScenario(s2, 'slow', oneTask({ behaviour: 'timeout' }));
  const pidfile = path.join(s2.dir, 'sleeper.pid');
  const held = spawnDriver(s2, { tasks: ['T1'], extraEnv: { ...s2.extraEnv, AGENTIC_FAKE_SCENARIO: sc2, AGENTIC_FAKE_PIDFILE: pidfile } });
  assert.ok(await waitFor(() => fs.existsSync(pidfile)));
  const other = await execute.executeIteration({ ...s2.opts, arm: 'D', tasks: ['T2'] });
  assert.equal(other.exit, 2);
  assert.equal(other.reason, 'iteration-locked');
  assert.equal(fs.existsSync(path.join(s2.runRoot, 'it1', 'T2')), false);
  await held.done;
  assert.equal(runDump(s2).length, 1);
});

test('R-2: a lock left by a dead executor is refused with the scratch profile it left and the instruction to delete it', async () => {
  const s = setup();
  const dead = childProcess.spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const deadPid = Number(dead.stdout);
  assert.equal(isAlive(deadPid), false);
  const iterDir = path.join(s.runRoot, 'it1');
  const profileRoot = path.join(s.tmpDir, 'doflow-agentic-left');
  fs.mkdirSync(path.join(profileRoot, 'home'), { recursive: true });
  fs.writeFileSync(path.join(profileRoot, 'home', 'auth.json'), '{}');
  fs.mkdirSync(path.join(iterDir, 'T9'), { recursive: true });
  fs.writeFileSync(path.join(iterDir, 'T9', 'launch.json'), JSON.stringify({ profileRoot }));
  fs.mkdirSync(path.join(iterDir, 'T8'));
  fs.writeFileSync(path.join(iterDir, 'T8', 'launch.json'), JSON.stringify({ profileRoot: path.join(s.tmpDir, 'doflow-agentic-gone') }));
  fs.writeFileSync(path.join(iterDir, '.lock'), `${deadPid}\n`);
  const result = await execute.executeIteration({ ...s.opts, tasks: ['T1'] });
  assert.equal(result.exit, 2);
  assert.equal(result.reason, 'iteration-locked');
  assert.match(result.refusal, new RegExp(`pid ${deadPid}, which is not running`));
  assert.ok(result.refusal.includes(profileRoot), `names the profile left behind: ${result.refusal}`);
  assert.equal(result.refusal.includes('doflow-agentic-gone'), false, 'a removed profile is not named');
  assert.match(result.refusal, /may still be running/);
  assert.match(result.refusal, /delete/);
  assert.match(result.refusal, /credential copy/);
  assert.deepEqual(runDump(s), [], 'nothing was spawned');
  assert.equal(fs.existsSync(profileRoot), true, 'the executor never deletes it on its own');
});

test('R-2: after SIGKILL of the executor the next execute names the live profile from launch.json (the known residual)', { timeout: 30000 }, async () => {
  const s = setup({ config: testConfig((c) => { c.timeoutSeconds = 60; }) });
  const pidfile = path.join(s.dir, 'sleeper.pid');
  const scenario = writeScenario(s, 'hangkill', oneTask({ behaviour: 'timeout' }));
  const { child, done } = spawnDriver(s, { tasks: ['T1'], extraEnv: { ...s.extraEnv, AGENTIC_FAKE_SCENARIO: scenario, AGENTIC_FAKE_PIDFILE: pidfile } });
  assert.ok(await waitFor(() => fs.existsSync(pidfile) && fs.readFileSync(pidfile, 'utf8') !== ''), 'the worker started');
  const workerPid = runDump(s)[0].pid;
  const sleeperPid = Number(fs.readFileSync(pidfile, 'utf8'));
  child.kill('SIGKILL');
  assert.equal((await done).signal, 'SIGKILL');
  try {
    const { profileRoot } = readJson(s.runRoot, 'it1', 'T1', 'launch.json');
    assert.equal(isAlive(workerPid), true, 'the residual: the worker outlives a SIGKILLed executor');
    assert.equal(authCopies(profileRoot).length, 1, 'the residual: the credential copy is left');
    const result = await execute.executeIteration({ ...s.opts, tasks: ['T2'] });
    assert.equal(result.reason, 'iteration-locked');
    assert.ok(result.refusal.includes(profileRoot), result.refusal);
    assert.match(result.refusal, /delete/);
  } finally {
    for (const pid of [workerPid, sleeperPid]) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }
});

test('C-3: an executor error after the spawn keeps the run record, counts it, and a rerun cannot spend again', async () => {
  const s = setup();
  const real = fs.writeFileSync;
  fs.writeFileSync = function patched(file, ...rest) {
    if (String(file).endsWith(`${path.sep}run_status.json`)) {
      const e = new Error('ENOSPC injected');
      e.code = 'ENOSPC';
      throw e;
    }
    return real.call(this, file, ...rest);
  };
  try {
    await assert.rejects(execute.executeIteration({ ...s.opts, tasks: ['T1'] }), /ENOSPC injected/);
  } finally {
    fs.writeFileSync = real;
  }
  assert.equal(runDump(s).length, 1, 'the worker ran');
  const dir = path.join(s.runRoot, 'it1', 'T1');
  assert.equal(fs.existsSync(path.join(dir, 'launch.json')), true, 'the run directory is kept after a spawn');
  assert.equal(fs.existsSync(path.join(s.runRoot, 'it1', '.lock')), false, 'the lock is released');
  assert.equal((await execute.executeIteration({ ...s.opts, tasks: ['T1'] })).reason, 'run-exists');
  const next = await execute.executeIteration({ ...s.opts, tasks: ['T2'], cap: 1500 });
  assert.equal(next.exit, 3, 'the kept run counts at maxTokensPerRun (1000 + 1000 > 1500)');
  assert.equal(runDump(s).length, 1, 'no second paid spawn');
  assert.deepEqual(leftovers(s), []);
});

test('C-4: no checkout path reaches the worker: argv, env, shim and launch.json; the shim runs a pruned export', async () => {
  const s = setup({ ownRepo: true });
  for (const [rel, text] of [['bin/doflow.js', '// cli\n'], ['src/x.js', '// x\n'], ['bench/agentic/tasks-heldout.json', '{"secret":1}\n'], ['package.json', '{}\n'], ['agent-docs/n.md', 'n\n']]) {
    fs.mkdirSync(path.dirname(path.join(s.repoRoot, rel)), { recursive: true });
    fs.writeFileSync(path.join(s.repoRoot, rel), text);
  }
  git(s.repoRoot, 'add', '-A');
  git(s.repoRoot, 'commit', '-q', '-m', 'tree');
  for (const arm of ['N', 'D']) {
    const r = await execute.executeIteration({ ...s.opts, iteration: `it-${arm}`, arm, tasks: ['T1'] });
    assert.equal(r.exit, 0, r.refusal);
  }
  const roots = [s.repoRoot, fs.realpathSync(s.repoRoot), s.runRoot];
  for (const run of runDump(s)) {
    const seen = JSON.stringify({ argv: run.argv, PATH: run.PATH, HOME: run.HOME, harnessHome: run.harnessHome, cwd: run.cwd, doflowFiles: run.doflowFiles });
    for (const root of roots) assert.equal(seen.includes(root), false, `arm ${run.arm} sees ${root}`);
    const o = run.argv[run.argv.indexOf('-o') + 1];
    assert.match(o, /doflow-agentic-[^/]+\/last-message\.txt$/, 'the final message is written inside the profile');
  }
  const d = runDump(s).find((r) => r.doflowFiles.some((f) => f.dir.includes('doflow-agentic-')));
  const shim = d.doflowFiles.find((f) => f.dir.includes('doflow-agentic-'));
  assert.deepEqual(shim.rootEntries, ['bin', 'package.json', 'src'], 'the shim tree holds only the package files, no bench/ or agent-docs/');
  for (const arm of ['N', 'D']) {
    const dir = path.join(s.runRoot, `it-${arm}`, 'T1');
    const text = fs.readFileSync(path.join(dir, 'launch.json'), 'utf8');
    for (const root of roots) assert.equal(text.includes(root), false, `launch.json of ${arm} names ${root}`);
    const launchJson = JSON.parse(text);
    assert.ok(path.isAbsolute(launchJson.workspaceRoot) && path.isAbsolute(launchJson.profileRoot));
    assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'last-message.txt'), 'utf8')).files.length > 0, 'copied back from the profile');
  }
  assert.deepEqual(leftovers(s), [], 'the shim export is removed too');
});

test('C-5: a run that passes the cap ends with exit 3 and the amount it was exceeded by', async () => {
  const s = setup();
  const scenario = writeScenario(s, 'over', { tasks: { T1: { match: 'widget is frobbed', N: { tokens: 1500 } } } });
  const result = await execute.executeIteration({ ...s.opts, tasks: ['T1'], cap: 1000, extraEnv: { ...s.extraEnv, AGENTIC_FAKE_SCENARIO: scenario } });
  assert.equal(result.exit, 3);
  assert.deepEqual(result.capExceeded, { by: 500, task: 'T1' });
  assert.equal(result.spent, 1500);
});

test('C-6: spend sums every turn and counts a run with a missing usage field at maxTokensPerRun', async () => {
  const s = setup();
  const scenario = writeScenario(s, 'usage', {
    tasks: {
      T1: { match: 'widget is frobbed', N: { usageEvents: [{ input_tokens: 900, output_tokens: 0 }, { input_tokens: 1, output_tokens: 0 }] } },
      T2: { match: 'gadget is wired', N: { usageEvents: [{ output_tokens: 2 }] } },
      T3: { match: 'sprocket is spun', N: { usageEvents: [{ input_tokens: 900, output_tokens: 0 }, { input_tokens: 1, output_tokens: 0 }] } },
    },
  });
  const extraEnv = { ...s.extraEnv, AGENTIC_FAKE_SCENARIO: scenario };
  const first = await execute.executeIteration({ ...s.opts, tasks: ['T1'], cap: 2000, extraEnv });
  assert.equal(first.exit, 0);
  assert.equal(readJson(s.runRoot, 'it1', 'T1', 'timing.json').total_tokens, 901, 'the two turns are summed, never overwritten');
  // Successive-subset control: 901 spent, T2 fits (901 + 1000 <= 2000) and reports a partial usage,
  // which counts at 1000; T3 then cannot fit. Undercounting would admit T3.
  const second = await execute.executeIteration({ ...s.opts, tasks: ['T2', 'T3'], cap: 2000, extraEnv });
  assert.equal('total_tokens' in readJson(s.runRoot, 'it1', 'T2', 'timing.json'), false, 'a missing usage field is unknown usage');
  assert.equal(second.exit, 3);
  assert.deepEqual(second.ran, ['T2']);
  assert.deepEqual(second.undone, ['T3']);
  assert.equal(second.spent, 1901);
});

test('C-9: no turn end, a nonzero exit or a signal is recorded as truncated with the exit code and signal', async () => {
  const s = setup();
  const scenario = writeScenario(s, 'abrupt', {
    tasks: {
      T1: { match: 'widget is frobbed', N: { behaviour: 'crash', truthFiles: 1 } },
      T2: { match: 'gadget is wired', N: { behaviour: 'exit', exitCode: 5, tokens: 100 } },
      T3: { match: 'sprocket is spun', N: { behaviour: 'silent' } },
    },
  });
  const result = await execute.executeIteration({ ...s.opts, extraEnv: { ...s.extraEnv, AGENTIC_FAKE_SCENARIO: scenario } });
  assert.equal(result.exit, 0);
  const st = (id) => readJson(s.runRoot, 'it1', id, 'run_status.json');
  assert.equal(st('T1').status, 'truncated');
  assert.equal(st('T1').signal, 'SIGKILL');
  assert.equal(st('T2').status, 'truncated');
  assert.equal(st('T2').exitCode, 5);
  assert.equal(st('T3').status, 'truncated', 'a silent exit 0 without a turn end is not a completed run');
  assert.equal(st('T3').exitCode, 0);
});

test('C-11: a symlinked run entry counts at maxTokensPerRun; a symlinked run root or iteration is refused', async () => {
  let s = setup();
  const head = git(s.repoRoot, 'rev-parse', 'HEAD');
  const ext = path.join(s.dir, 'ext', 'fake');
  fs.mkdirSync(ext, { recursive: true });
  fs.writeFileSync(path.join(ext, 'launch.json'), '{}');
  fs.writeFileSync(path.join(ext, 'timing.json'), JSON.stringify({ total_tokens: 0, duration_ms: 1 }));
  fs.mkdirSync(path.join(s.runRoot, 'it1'), { recursive: true });
  fs.writeFileSync(path.join(s.runRoot, 'it1', 'iteration.json'), JSON.stringify({ arm: 'N', model: 'fake:model', sourceAt: head, snapshot: 'deadbeef', captureSha256: execute.captureSha256(s.opts.config) }));
  fs.symlinkSync(ext, path.join(s.runRoot, 'it1', 'LINKED'));
  const r = await execute.executeIteration({ ...s.opts, tasks: ['T1'], cap: 1500 });
  assert.equal(r.exit, 3, 'the linked entry counts at 1000, so 1000 + 1000 > 1500');
  assert.deepEqual(r.undone, ['T1']);

  s = setup();
  const outside = path.join(s.dir, 'outside');
  fs.mkdirSync(outside);
  const linkedRoot = path.join(s.dir, 'linked-runs');
  fs.symlinkSync(outside, linkedRoot);
  s.opts.runRoot = linkedRoot;
  const refusedRoot = await execute.executeIteration({ ...s.opts, tasks: ['T1'] });
  assert.equal(refusedRoot.exit, 2);
  assert.equal(refusedRoot.reason, 'run-root-symlink');
  assert.deepEqual(fs.readdirSync(outside), []);

  s = setup();
  fs.mkdirSync(s.runRoot, { recursive: true });
  fs.mkdirSync(path.join(s.dir, 'elsewhere'));
  fs.symlinkSync(path.join(s.dir, 'elsewhere'), path.join(s.runRoot, 'it1'));
  const refusedIt = await execute.executeIteration({ ...s.opts, tasks: ['T1'] });
  assert.equal(refusedIt.reason, 'run-root-symlink');
  assert.deepEqual(readDump(s), []);
});

test('N-1, N-4: the version check runs in a scratch profile; the credential copy is mode 0600; iteration records the capture digest', async () => {
  const s = setup();
  const r = await execute.executeIteration({ ...s.opts, tasks: ['T1'] });
  assert.equal(r.exit, 0);
  const version = readDump(s).find((x) => x.kind === 'version');
  assert.match(String(version.HOME), /doflow-agentic-ver-[^/]+\/home$/, 'the --version spawn gets a scratch HOME');
  assert.match(String(version.harnessHome), /doflow-agentic-ver-[^/]+\/harness-home$/);
  assert.deepEqual(version.harnessHomeFiles, [], 'no credential is copied for the version check');
  assert.deepEqual(runDump(s)[0].harnessHomeModes, { 'auth.json': 0o600 });
  assert.equal(readJson(s.runRoot, 'it1', 'iteration.json').captureSha256, execute.captureSha256(s.opts.config));
  assert.match(execute.captureSha256(s.opts.config), /^[0-9a-f]{64}$/);
  assert.notEqual(execute.captureSha256(testConfig((c) => { c.timeoutSeconds = 11; })), execute.captureSha256(s.opts.config));
  assert.deepEqual(leftovers(s), []);
});

test('N-2: each rehearsal command authorizes one run, so stage R stays at two runs of maxTokensPerRun', () => {
  const runner = require('../../bench/agentic/runner.js');
  const stages = runner.paidStages({ taskSet: { train: [{ id: 'DC-1' }], tasks: [{ id: 'DC-1' }, { id: 'DC-2' }] }, config: { maxTokensPerRun: 250000 }, k: 3 });
  for (const line of stages.R) assert.match(line, / --cap 250000$/);
});

test('R-8: plan says the cap applies per execute command and gives each stage its end figure with the overshoots', async () => {
  const runner = require('../../bench/agentic/runner.js');
  const stages = runner.paidStages({ taskSet: { train: [{ id: 'DC-1' }], tasks: [{ id: 'DC-1' }, { id: 'DC-2' }] }, config: { maxTokensPerRun: 250000 }, k: 3 });
  assert.match(stages.capScope, /per execute command/);
  assert.match(stages.capScope, /stage R: 2 x 250000 = 500000 tokens plus up to 2 one-run overshoots/);
  assert.match(stages.capScope, /stage N: 3 x 500000 = 1500000 tokens plus up to 3 one-run overshoots/);
  assert.match(stages.capScope, /stage D: 3 x 500000 = 1500000 tokens plus up to 3 one-run overshoots/);
  const s = setup();
  const lines = [];
  const code = await runner.main(['plan', '--iteration', 'x1', '--arm', 'N'], {
    repoRoot: s.repoRoot, config: s.opts.config, registry: REGISTRY, taskSet: { ...TASK_SET, train: TASKS.slice(0, 2) }, runRoot: s.runRoot,
    noiseConfig: { k: 3 }, out: (m) => lines.push(m), err: (m) => lines.push(m),
  });
  assert.equal(code, 0, lines.join('\n'));
  assert.ok(lines.some((l) => /^cap: .*per execute command/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('stage figures: ') && /plus up to 3 one-run overshoots/.test(l)), lines.join('\n'));
});

test('C-5: plan states the one-run residual; the execute text names the amount the cap was exceeded by', async () => {
  const runner = require('../../bench/agentic/runner.js');
  const s = setup();
  const lines = [];
  const code = await runner.main(['plan', '--iteration', 'x1', '--arm', 'N'], {
    repoRoot: s.repoRoot, config: s.opts.config, registry: REGISTRY, taskSet: { ...TASK_SET, train: TASKS.slice(0, 2) }, runRoot: s.runRoot,
    noiseConfig: { k: 3 }, out: (m) => lines.push(m), err: (m) => lines.push(m),
  });
  assert.equal(code, 0, lines.join('\n'));
  assert.ok(lines.some((l) => /one run's overshoot/.test(l) && /timeoutSeconds/.test(l)), lines.join('\n'));
  const text = runner.executeLines({ exit: 3, ran: ['T1'], undone: [], spent: 1500, capExceeded: { by: 500, task: 'T1' } }, 'it1');
  assert.ok(text.some((l) => l === 'cap exceeded by 500 tokens on T1'), text.join('\n'));
});
