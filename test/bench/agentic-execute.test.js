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

test('leak and count patterns: command position only, MCP tool-call names, tested with the shipped config', () => {
  const compile = (list) => list.map((s) => new RegExp(s));
  const matches = (list, text) => compile(list).some((re) => re.test(text));
  const nLeak = REAL_CONFIG.arms.N.leak;
  const dCount = REAL_CONFIG.arms.D.count;
  const retrieval = [
    'doflow retrieve --scope code --query x --root .',
    '/usr/local/bin/doflow retrieve --query x',
    'doflow-run retrieve --query x',
    'node /home/user/proj/bin/doflow.js retrieve --query x',
    'cd src && doflow retrieve --query x',
    'rg frob | doflow retrieve --query x',
    'ls; doflow retrieve --query x',
    'echo $(doflow retrieve --query x)',
    '/bin/zsh -lc "doflow retrieve --scope code --query x"',
    "bash -c 'doflow retrieve --query x'",
  ];
  const benign = [
    'rg retrieve src',
    'rg -n "doflow retrieve" docs',
    'rg -c "doflow retrieve" docs',
    'cat bin/doflow.js | head',
    'echo doflow retrieve',
    '/bin/zsh -lc "rg doflow retrieve"',
    'grep -rn retrieve src/runtime',
  ];
  for (const text of retrieval) {
    assert.equal(matches(nLeak, text), true, `N leak: ${text}`);
    assert.equal(matches(dCount, text), true, `D count: ${text}`);
  }
  for (const text of benign) {
    assert.equal(matches(nLeak, text), false, `N leak: ${text}`);
    assert.equal(matches(dCount, text), false, `D count: ${text}`);
  }
  for (const name of ['mcp:semble/search', 'mcp__semble__search', 'mcp:context7/query-docs']) {
    assert.equal(matches(nLeak, name), true, name);
    assert.equal(matches(REAL_CONFIG.arms.D.leak, name), true, name);
  }
  for (const text of ['rg mcp src', 'node mcp-server.js', 'cat docs/mcp.md']) assert.equal(matches(REAL_CONFIG.arms.D.leak, text), false, text);
  assert.equal(matches(REAL_CONFIG.arms.D.leak, 'doflow retrieve --query x'), false, 'arm D may call the tool');
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
  assert.deepEqual(Object.keys(iteration).sort(), ['arm', 'harness', 'harnessVersion', 'model', 'snapshot', 'sourceAt', 'startedAt']);
  assert.equal(iteration.arm, 'D');
  assert.equal(iteration.model, 'fake:model');
  assert.equal(iteration.sourceAt, head);
  assert.equal(iteration.snapshot, 'deadbeef');
  assert.equal(iteration.harness, 'alpha');
  assert.equal(iteration.harnessVersion, 'fake 0.0.0');
  assert.match(iteration.startedAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(execute.readIteration(path.join(s.runRoot, 'it1')), iteration);

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
  assert.deepEqual(readJson(dir, 'run_status.json'), { status: 'completed' });
  const timing = readJson(dir, 'timing.json');
  assert.equal(timing.total_tokens, 900);
  assert.equal(Number.isFinite(timing.duration_ms) && timing.duration_ms >= 0, true);

  const runs = runDump(s);
  assert.equal(runs.length, 1);
  const lastMessageFile = path.join(dir, 'last-message.txt');
  assert.deepEqual(runs[0].argv, [
    'exec', '-s', 'read-only', '-m', 'fake-model', '--disable', 'multi_agent', '--json', '-o', lastMessageFile, '--ephemeral', '-',
  ]);
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

  const swap = (record, name) => record.argv.map((a) => a.replace(`/${name}/`, '/IT/'));
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
  assert.equal(shim[0].text, `#!/bin/sh\nexec node '${path.join(s.repoRoot, 'bin', 'doflow.js')}' "$@"\n`);
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
  assert.deepEqual(readJson(dir('T1'), 'run_status.json'), { status: 'api-error', evidence: 'rate limited' });
  assert.equal('total_tokens' in readJson(dir('T1'), 'timing.json'), false);
  assert.deepEqual(readJson(dir('T2'), 'run_status.json'), { status: 'completed' });
  assert.equal(fs.readFileSync(path.join(dir('T2'), 'transcript.jsonl'), 'utf8'), '');
  assert.equal('total_tokens' in readJson(dir('T2'), 'timing.json'), false, 'unreported usage is omitted, never 0');
  assert.deepEqual(readJson(dir('T3'), 'run_status.json'), { status: 'completed' });
  assert.equal('total_tokens' in readJson(dir('T3'), 'timing.json'), false);
  assert.deepEqual(leftovers(s), [], 'workspace and profile removed after success and api-error');
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
  fs.writeFileSync(path.join(s.runRoot, 'it1', 'iteration.json'), JSON.stringify({ arm: 'N', model: 'fake:model', sourceAt: head, snapshot: 'deadbeef' }));
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
