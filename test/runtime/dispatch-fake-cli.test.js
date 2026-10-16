'use strict';
// 082 IC-041 fixtures (DEC-010, DEC-056): the fake CLI's dispatch steps, the edit-capable fake
// descriptors, the graph-plan fixtures and the dispatch sandbox. No case starts a real harness
// (NFR-002): every child PATH is the sandbox's scratch bin/ alone, and every child env sets the five
// DOFLOW_* identity variables explicitly.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.js');
const { IDENTITY_VARS } = require('../helper/fake-harness-cli.js');
const {
  makeDispatchSandbox, editDescriptors, PLAN_DIR, PLAN_FIXTURES, FAKE_BINARIES, EDIT_ARGV, HARNESS_BINARIES,
} = require('../helper/dispatch-sandbox.js');
const { validateWorker } = require('../../src/registry/index.ts');
const { loadPlan } = require('../../src/runtime/task-attempts.ts');

const POSIX_ONLY = { skip: process.platform === 'win32' && 'tree cleanup is unverified on win32 (NFR-005)' };

/** Runs one sandbox binary in `cwd` (default the scratch repo) with the sandbox env plus `extra`. */
function run(box, name, argv, { cwd = box.root, extra = {} } = {}) {
  return spawnSync(name, argv, { cwd, env: { ...box.env, ...extra }, encoding: 'utf8', timeout: 10000 });
}

test('writeAt writes to the absolute path an env var names; any other path exits 97', POSIX_ONLY, (t) => {
  const box = makeDispatchSandbox(t, { scenario: { run: [{ writeAt: { env: 'STRAY_TARGET', content: 'stray' } }] } });
  const target = path.join(box.dir, 'caller', 'stray.txt');
  const ok = run(box, 'fake-claude', ['run', 'p'], { extra: { STRAY_TARGET: target } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(fs.readFileSync(target, 'utf8'), 'stray');

  const unnamed = run(box, 'fake-claude', ['run', 'p']);
  assert.equal(unnamed.status, 97);
  assert.match(unnamed.stderr, /writeAt names no absolute path: STRAY_TARGET/);
  const relative = run(box, 'fake-claude', ['run', 'p'], { extra: { STRAY_TARGET: 'rel/stray.txt' } });
  assert.equal(relative.status, 97);
  assert.equal(fs.existsSync(path.join(box.root, 'rel')), false);
});

test('commit makes exactly one commit of the tracked edit with the fake identity', POSIX_ONLY, (t) => {
  const box = makeDispatchSandbox(t, {
    scenario: { run: [{ write: { path: 'src/one.js', content: 'edited\n' } }, { commit: { message: 'worker edit' } }] },
  });
  const count = () => Number(spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: box.root, env: box.env, encoding: 'utf8' }).stdout.trim());
  const before = count();
  const r = run(box, 'fake-claude', ['run', 'p']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(count(), before + 1);
  const head = spawnSync('git', ['log', '-1', '--format=%an <%ae>|%s'], { cwd: box.root, env: box.env, encoding: 'utf8' }).stdout.trim();
  assert.equal(head, 'fake <fake@invalid>|worker edit');
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: box.root, env: box.env, encoding: 'utf8' }).stdout, '');
});

test('commit with nothing to commit exits with git status, not 0', POSIX_ONLY, (t) => {
  const box = makeDispatchSandbox(t, { scenario: { run: [{ commit: { message: 'empty' } }, { print: 'never' }] } });
  const r = run(box, 'fake-claude', ['run', 'p']);
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, '');
});

test('doflow runs FAKE_DOFLOW_CLI under the inherited env and writes its stdout to out', POSIX_ONLY, (t) => {
  const box = makeDispatchSandbox(t, {
    scenario: { run: [{ doflow: { args: ['dispatch', '--action', 'spawn', '--json'], out: 'spawn.json' } }, { print: 'after' }] },
  });
  const cli = path.join(tempDir(t, 'doflow-fakedoflow-'), 'cli.js');
  fs.writeFileSync(cli, 'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), run: process.env.DOFLOW_RUN_ID, cwd: process.cwd() }));\n');
  const r = run(box, 'fake-claude', ['run', 'p'], { extra: { FAKE_DOFLOW_CLI: cli } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'after\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(box.root, 'spawn.json'), 'utf8')), {
    argv: ['dispatch', '--action', 'spawn', '--json'], run: box.identity.DOFLOW_RUN_ID, cwd: box.root,
  });
  const missing = run(box, 'fake-claude', ['run', 'p']);
  assert.equal(missing.status, 96);
  assert.match(missing.stderr, /FAKE_DOFLOW_CLI/);
});

test('printRepeat prints the text the given number of times', POSIX_ONLY, (t) => {
  const box = makeDispatchSandbox(t, { scenario: { run: [{ printRepeat: { text: 'transcript line', times: 250 } }] } });
  const r = run(box, 'fake-claude', ['run', 'p']);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  assert.equal(lines.pop(), '');
  assert.equal(lines.length, 250);
  assert.ok(lines.every((line) => line === 'transcript line'));
});

test('edit descriptors: claude has a supported isolatedEdit and every block passes validateWorker', () => {
  const descriptors = editDescriptors();
  for (const [id, block] of Object.entries(descriptors)) {
    const errors = [];
    validateWorker(block, `harness '${id}'`, errors);
    assert.deepEqual(errors, [], `${id}: ${errors.join('; ')}`);
  }
  assert.equal(descriptors.claude.isolatedEdit.status, 'supported');
  assert.deepEqual(descriptors.claude.isolatedEdit.argv, ['--edit-in-cwd']);
  assert.deepEqual(EDIT_ARGV, ['--edit-in-cwd']);
  assert.equal(Object.hasOwn(descriptors.gemini, 'isolatedEdit'), false, 'gemini declares none');
  assert.notEqual(editDescriptors().claude, descriptors.claude, 'a fresh copy per call');
  // Negative control: a supported isolatedEdit without its argv recipe fails validation.
  const broken = editDescriptors().claude;
  delete broken.isolatedEdit.argv;
  const errors = [];
  validateWorker(broken, "harness 'claude'", errors);
  assert.deepEqual(errors, ["harness 'claude' worker 'isolatedEdit': requires recipe field 'argv' when status is supported"]);
});

test('plan fixtures: each builds through loadPlan with no problem as a v1 graph plan', (t) => {
  const expected = {
    dependent: { ids: ['A.1', 'A.2', 'A.3'], deps: { 'A.3': ['A.1', 'A.2'] } },
    disjoint: { ids: ['A.1', 'A.2', 'A.3', 'A.4'], deps: {} },
    overlap: { ids: ['A.1', 'A.2', 'A.3'], deps: {} },
    budget: { ids: ['A.1'], deps: {} },
  };
  assert.deepEqual([...PLAN_FIXTURES].sort(), Object.keys(expected).sort());
  for (const name of PLAN_FIXTURES) {
    const root = tempDir(t, 'doflow-dispatchplan-');
    const file = path.join(root, 'agent-docs', 'doflow', 'fixture', 'plan.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.join(PLAN_DIR, `${name}.md`), file);
    const plan = loadPlan({ roots: [root], slug: 'fixture' });
    assert.equal(plan.graph.graphHeader, 'v1', name);
    assert.deepEqual(plan.warnings, [], name);
    assert.deepEqual(plan.graph.tasks.map((task) => task.id), expected[name].ids, name);
    for (const task of plan.graph.tasks) assert.deepEqual(task.taskDeps, expected[name].deps[task.id] ?? [], `${name} ${task.id}`);
    const files = plan.graph.tasks.map((task) => task.files);
    if (name === 'disjoint') assert.equal(new Set(files.flat()).size, 4, 'four disjoint files');
    if (name === 'overlap') assert.deepEqual(files, [['src/shared.js'], ['src/shared.js'], []]);
    if (name === 'budget') assert.deepEqual(plan.graph.tasks[0].budget, { attempts: 2 });
    else for (const task of plan.graph.tasks) assert.equal(task.budget, null, `${name} ${task.id}`);
  }
});

test('sandbox: repo holds the plan and seeded files; env sets the identity; verify argv starts with node', POSIX_ONLY, (t) => {
  const box = makeDispatchSandbox(t, { plan: 'overlap', slug: '082-overlap' });
  assert.equal(fs.readFileSync(path.join(box.root, 'agent-docs', 'doflow', '082-overlap', 'plan.md'), 'utf8'),
    fs.readFileSync(path.join(PLAN_DIR, 'overlap.md'), 'utf8'));
  assert.deepEqual(box.files, ['src/shared.js']);
  const tracked = spawnSync('git', ['ls-files'], { cwd: box.root, env: box.env, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  assert.deepEqual(tracked.sort(), ['.gitignore', 'README.md', 'src/shared.js']);
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: box.root, env: box.env, encoding: 'utf8' }).stdout, '');
  for (const key of IDENTITY_VARS) assert.equal(typeof box.env[key], 'string', key);
  assert.equal(box.env.DOFLOW_WORKTREE, box.root);
  assert.equal(box.env.DOFLOW_SESSION_ROLE, 'main');
  assert.equal(box.verifyArgv[0], process.execPath);
  assert.ok(path.isAbsolute(box.verifyArgv[0]));
  const verify = spawnSync(box.verifyArgv[0], box.verifyArgv.slice(1), { cwd: box.root, env: box.env });
  assert.equal(verify.status, 0);
  const deleted = makeDispatchSandbox(t, { identity: { DOFLOW_ATTEMPT: undefined } });
  assert.equal(Object.hasOwn(deleted.env, 'DOFLOW_ATTEMPT'), false, 'undefined deletes an identity variable');
});

test('sandbox: PATH is one scratch bin holding only the expected links; no harness resolves', POSIX_ONLY, (t) => {
  const box = makeDispatchSandbox(t);
  const entries = box.env.PATH.split(path.delimiter);
  // Checked by lookup before anything is spawned, so a PATH that reaches a real harness fails here
  // without starting it.
  for (const name of ['codex', 'gemini', 'claude']) {
    assert.deepEqual(entries.filter((dir) => fs.existsSync(path.join(dir, name))), [], `${name} is in no PATH entry`);
  }
  assert.deepEqual(entries, [box.bin], 'PATH is the scratch bin alone');
  assert.ok(!entries.includes(path.dirname(process.execPath)), 'never the node directory');
  assert.deepEqual(fs.readdirSync(box.bin).sort(), [...FAKE_BINARIES, 'git', 'node'].sort());
  assert.equal(fs.readlinkSync(path.join(box.bin, 'node')), process.execPath);
  assert.equal(fs.readlinkSync(path.join(box.bin, 'git')), box.gitPath);
  // node and git resolve from the child; the fakes run.
  assert.equal(spawnSync('node', ['-e', 'process.stdout.write(process.execPath)'], { env: box.env, encoding: 'utf8' }).stdout, process.execPath);
  assert.equal(spawnSync('git', ['--version'], { env: box.env }).status, 0);
  for (const name of FAKE_BINARIES) assert.equal(run(box, name, ['--version']).status, 0, name);
  // No real harness binary resolves from a child with this env.
  for (const name of ['codex', 'gemini', 'claude']) {
    const r = spawnSync(name, ['--version'], { env: box.env, encoding: 'utf8', timeout: 5000 });
    assert.equal(r.error?.code, 'ENOENT', `${name} must not resolve`);
  }
});

test('sandbox: named system tools only, and a harness name is refused', POSIX_ONLY, (t) => {
  const box = makeDispatchSandbox(t, { systemTools: ['bash'], fakes: ['fake-claude'] });
  assert.deepEqual(fs.readdirSync(box.bin).sort(), ['bash', 'fake-claude', 'git', 'node']);
  assert.equal(spawnSync('bash', ['-c', 'exit 0'], { env: box.env }).status, 0);
  for (const name of ['codex', 'claude', 'node', '../bash']) {
    assert.throws(() => makeDispatchSandbox(t, { systemTools: [name] }), /not a linkable system tool/, name);
  }
});

test('sandbox (SF-6): HARNESS_BINARIES is every registry harness id and worker binary, agy included, and each is refused', POSIX_ONLY, (t) => {
  const registry = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'core', 'registry', 'harnesses.json'), 'utf8'));
  const expected = new Set();
  for (const h of registry.harnesses) {
    expected.add(h.id);
    if (h.worker?.cli?.binary) expected.add(h.worker.cli.binary);
  }
  assert.ok(expected.has('agy'), 'the registry names agy');
  assert.deepEqual([...HARNESS_BINARIES].sort(), [...expected].sort());
  for (const name of HARNESS_BINARIES) {
    assert.throws(() => makeDispatchSandbox(t, { systemTools: [name] }), /not a linkable system tool/, name);
  }
});
