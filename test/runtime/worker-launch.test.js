'use strict';

// 081 B.3 (IC-003, IC-012; DEC-030, DEC-037, DEC-045): the worker environment, the launch
// emission, argv assembly and the spawn. Every spawn resolves to test/helper/fake-harness-cli.js
// linked into a scratch bin/, and the child PATH is that bin/ plus the directory of
// process.execPath only (NFR-002). The caller env given to each launch deletes the DOFLOW_* identity
// variables, so the launcher alone sets them and the developer's shell decides nothing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { tempDir } = require('../helper/tmp.js');
const { IDENTITY_VARS, linkBin, writeScenario, readLog } = require('../helper/fake-harness-cli.js');
const { ENV_SET, PROMPT_LIMITS, argvShape, assembleArgv, launchEnv, launchRecord, launchWorker } = require('../../src/runtime/worker/launch.ts');
const { resolveIdentity } = require('../../src/runtime/context/identity.ts');
const DESCRIPTORS = require('../fixtures/worker/descriptors.json');

const POSIX_ONLY = { skip: process.platform === 'win32' && 'the fake CLI is linked by symlink and shebang on POSIX' };
const RUN_ID = 'w-0123456789ab';
const SECRET = 'sk-test-value-that-must-not-appear';

/** A copy of a fake descriptor, so a case may change its recipe. */
function recipeOf(harness) {
  return JSON.parse(JSON.stringify(DESCRIPTORS[harness]));
}

/** A scratch bin/, log, scenario, worktree and caller env with every DOFLOW_* identity variable deleted. */
function world(t, scenario = {}) {
  const dir = tempDir(t, 'doflow-worker-launch-');
  const childPath = linkBin(path.join(dir, 'bin'), ['fake-claude', 'fake-codex']);
  const log = path.join(dir, 'log.jsonl');
  const worktree = path.join(dir, 'work');
  fs.mkdirSync(worktree);
  fs.mkdirSync(path.join(dir, 'config'));
  const env = {
    PATH: childPath,
    HOME: dir,
    XDG_CONFIG_HOME: path.join(dir, 'config'),
    TMPDIR: process.env.TMPDIR || '/tmp',
    FAKE_HARNESS_SCENARIO: writeScenario(dir, scenario),
    FAKE_HARNESS_LOG: log,
    PROVIDER_API_KEY: SECRET,
  };
  for (const key of IDENTITY_VARS) delete env[key];
  return { dir, log, worktree, env };
}

/** Waits for a launched child to exit. */
function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

/** Launches `harness` with a run-scoped identity, waits for the exit, and returns the result and the one log line. */
async function launchOnce(w, harness, prompt, { token = 1, runKey = 'abcdef0123456789/local/main' } = {}) {
  const { identity } = launchEnv({ env: w.env, runKey, token, execWorktree: w.worktree, runId: RUN_ID });
  const result = await launchWorker({ recipe: recipeOf(harness), prompt, identity, execWorktree: w.worktree, env: w.env });
  const end = await exited(result.child);
  return { result, end, lines: readLog(w.log) };
}

test('IC-012 a default claim run gives a run-scoped run: the run id without w-, set with the six launch variables', (t) => {
  const w = world(t);
  const caller = { ...w.env, DOFLOW_RUN_ID: 'local', DOFLOW_LINEAGE_ID: 'main', DOFLOW_CONTEXT_MAX_BYTES: '9000' };
  const { env, identity } = launchEnv({ env: caller, runKey: 'abcdef0123456789/local/main', token: 3, execWorktree: w.worktree, runId: RUN_ID });

  assert.deepEqual(identity, { run: '0123456789ab', lineage: 'main', attempt: '3', runSource: 'run-scoped' });
  assert.equal(env.DOFLOW_RUN_ID, '0123456789ab');
  assert.equal(env.DOFLOW_LINEAGE_ID, 'main');
  assert.equal(env.DOFLOW_ATTEMPT, '3');
  assert.equal(env.DOFLOW_SESSION_ROLE, 'worker');
  assert.equal(env.DOFLOW_WORKTREE, w.worktree);
  assert.equal(env.DOFLOW_WORKER_RUN, RUN_ID, '110: the worker run id, whole');
  // DEC-045: everything else is the caller's environment, unchanged, provider keys included.
  const others = (e) => Object.fromEntries(Object.entries(e).filter(([k]) => !ENV_SET.includes(k)));
  assert.deepEqual(others(env), others(caller));
  assert.equal(env.PROVIDER_API_KEY, SECRET);
  assert.deepEqual(Object.keys(env).filter((k) => !(k in caller)).sort(), ['DOFLOW_ATTEMPT', 'DOFLOW_SESSION_ROLE', 'DOFLOW_WORKER_RUN', 'DOFLOW_WORKTREE']);
  assert.equal(caller.DOFLOW_RUN_ID, 'local', 'the caller env is not mutated');
});

test('IC-012 a launched claim run keeps its run and lineage', (t) => {
  const w = world(t);
  const { env, identity } = launchEnv({ env: w.env, runKey: 'abcdef0123456789/r7/w2', token: 12, execWorktree: w.worktree, runId: RUN_ID });
  assert.deepEqual(identity, { run: 'r7', lineage: 'w2', attempt: '12', runSource: 'claim' });
  assert.equal(env.DOFLOW_RUN_ID, 'r7');
  assert.equal(env.DOFLOW_LINEAGE_ID, 'w2');
});

test('IC-012 the worker resolves lineageKind launched for both run sources', (t) => {
  const w = world(t);
  for (const runKey of ['abcdef0123456789/local/main', 'abcdef0123456789/r7/w2']) {
    const { env, identity } = launchEnv({ env: w.env, runKey, token: 1, execWorktree: w.worktree, runId: RUN_ID });
    const resolved = resolveIdentity(env, { cwd: w.worktree, sessionId: '' });
    assert.equal(resolved.lineageKind, 'launched', runKey);
    assert.equal(resolved.role, 'worker');
    assert.equal(resolved.unitId, `L.${identity.run}.${identity.lineage}.1`);
  }
});

test('IC-003 argv order is readOnly, spawnDenial, structuredOutput, oneShot with the prompt element replaced', () => {
  assert.deepEqual(assembleArgv(recipeOf('claude'), 'do the task'), ['--read-only', '--no-spawn', '--jsonl', 'run', 'do the task']);
});

test('IC-003 a {prompt} inside a longer argv string is not interpolated; only the whole element is replaced', () => {
  const recipe = recipeOf('claude');
  recipe.oneShot.argv = ['run', '--msg={prompt}', '{prompt}', 'x{prompt}x'];
  const argv = assembleArgv(recipe, 'BRIEF');
  assert.deepEqual(argv.slice(3), ['run', '--msg={prompt}', 'BRIEF', 'x{prompt}x']);
});

test('IC-003 argvShape writes the prompt element as its sha256 and byte count', () => {
  const prompt = 'brief é';
  const hex = crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');
  assert.deepEqual(argvShape(recipeOf('claude'), prompt).at(-1), `<prompt sha256:${hex} bytes:${Buffer.byteLength(prompt)}>`);
  assert.ok(!argvShape(recipeOf('claude'), prompt).includes(prompt));
});

test('IC-003 DEC-062 a prompt of 131072 bytes in argv mode is prompt-too-large (MAX_ARG_STRLEN counts the NUL); 131071 is accepted', () => {
  assert.equal(PROMPT_LIMITS.argv, 131071);
  assert.equal(assembleArgv(recipeOf('claude'), 'a'.repeat(131071)).at(-1).length, 131071);
  assert.throws(() => assembleArgv(recipeOf('claude'), 'a'.repeat(131072)), (error) => error.code === 'prompt-too-large' && error.reason === 'prompt-too-large');
  assert.throws(() => assembleArgv(recipeOf('claude'), 'a'.repeat(131073)), (error) => error.code === 'prompt-too-large' && error.reason === 'prompt-too-large');
  // stdin mode allows up to 1048576 bytes.
  assert.doesNotThrow(() => assembleArgv(recipeOf('codex'), 'a'.repeat(131073)));
  assert.throws(() => assembleArgv(recipeOf('codex'), 'a'.repeat(PROMPT_LIMITS.stdin + 1)), { code: 'prompt-too-large' });
});

test('IC-012 the launch emission text precedes the brief when the reason is emit', POSIX_ONLY, async (t) => {
  const w = world(t);
  const brief = 'BRIEF: summarise the plan';
  const { result, end, lines } = await launchOnce(w, 'claude', brief);
  assert.deepEqual(end, { code: 0, signal: null });
  assert.equal(result.launched.reason, 'emit');
  assert.ok(result.launched.bytes > 0);
  assert.equal(Object.hasOwn(result.launched, 'text'), false, 'the emission text is not returned for storage');

  assert.equal(lines.length, 1);
  const [line] = lines;
  assert.deepEqual(line.argv.slice(0, 4), ['--read-only', '--no-spawn', '--jsonl', 'run']);
  const prompt = line.argv[4];
  assert.ok(prompt.endsWith(`\n\n${brief}`), 'emission, a blank line, then the brief');
  assert.ok(prompt.startsWith('## ContextPack'), 'the emission text comes first');
  assert.equal(Buffer.byteLength(prompt), result.launched.bytes + 2 + Buffer.byteLength(brief));
  assert.equal(fs.realpathSync(line.cwd), fs.realpathSync(w.worktree));
  assert.deepEqual(line.doflowEnv, {
    DOFLOW_RUN_ID: '0123456789ab', DOFLOW_LINEAGE_ID: 'main', DOFLOW_ATTEMPT: '1', DOFLOW_SESSION_ROLE: 'worker', DOFLOW_WORKTREE: w.worktree,
  });

  // A second launch of the same unit is already bootstrapped: the brief goes alone.
  const again = await launchOnce(w, 'claude', brief);
  assert.equal(again.result.launched.reason, 'silent:already-bootstrapped');
  assert.equal(again.result.launched.bytes, 0);
  assert.equal(again.lines[1].argv[4], brief);
});

test('IC-012 DEC-052 a refused launch emission that returns text is still delivered before the brief', POSIX_ONLY, async (t) => {
  const w = world(t);
  w.env.DOFLOW_CONTEXT_MAX_BYTES = '64';
  const brief = 'BRIEF: summarise the plan';
  const { result, end, lines } = await launchOnce(w, 'claude', brief);
  assert.deepEqual(end, { code: 0, signal: null });
  assert.equal(result.launched.reason, 'refused:mandatory-over-budget');
  assert.ok(result.launched.bytes > 0, 'the refused emission carries text');
  const prompt = lines[0].argv[4];
  assert.ok(prompt.endsWith(`\n\n${brief}`), 'the refused text, a blank line, then the brief');
  assert.equal(Buffer.byteLength(prompt), result.launched.bytes + 2 + Buffer.byteLength(brief), 'bytes counts the text delivered');
});

test('IC-012 the worker runs detached in its own process group with no shell', POSIX_ONLY, async (t) => {
  const w = world(t, { run: [{ sleep: 200 }] });
  const { identity } = launchEnv({ env: w.env, runKey: 'abcdef0123456789/r1/w1', token: 1, execWorktree: w.worktree, runId: RUN_ID });
  const { child } = await launchWorker({ recipe: recipeOf('claude'), prompt: 'p; echo injected', identity, execWorktree: w.worktree, env: w.env });
  assert.equal(child.stdin, null, 'argv mode leaves stdin ignored');
  assert.equal(child.spawnargs[0], 'fake-claude');
  assert.equal(child.spawnargs.length, 6, 'binary plus five argv elements: the prompt stays one element');
  assert.ok(child.spawnargs.at(-1).endsWith('\n\np; echo injected'));
  // A detached child leads its own group, so signalling -pid reaches it.
  assert.doesNotThrow(() => process.kill(-child.pid, 0));
  await exited(child);
  assert.ok(readLog(w.log)[0].argv.at(-1).endsWith('\n\np; echo injected'));
});

test('IC-003 stdin mode writes the prompt to stdin and closes it; the argv carries no prompt', POSIX_ONLY, async (t) => {
  const w = world(t);
  const { identity } = launchEnv({ env: w.env, runKey: 'abcdef0123456789/r1/w1', token: 1, execWorktree: w.worktree, runId: RUN_ID });
  const brief = 'stdin brief';
  const recipe = recipeOf('codex');
  assert.equal(recipe.oneShot.promptVia, 'stdin');
  const { child, launched } = await launchWorker({ recipe, prompt: brief, identity, execWorktree: w.worktree, env: w.env });
  assert.ok(child.stdin, 'stdin is a pipe');
  assert.equal(child.stdin.writableEnded, true, 'stdin is closed after the write');
  await exited(child);
  const expected = launched.reason === 'emit' ? launched.bytes + 2 + Buffer.byteLength(brief) : Buffer.byteLength(brief);
  assert.equal(child.stdin.bytesWritten, expected, 'the whole prompt, emission included, went to stdin');
  const [line] = readLog(w.log);
  assert.deepEqual(line.argv, assembleArgv(recipe, 'unused'));
  assert.ok(!line.argv.some((a) => a.includes(brief)));
});

test('110 launchWorker sets DOFLOW_WORKER_RUN to the given run id for the child, and nothing but the id', POSIX_ONLY, async (t) => {
  const w = world(t);
  const { identity } = launchEnv({ env: w.env, runKey: 'abcdef0123456789/local/main', token: 1, execWorktree: w.worktree, runId: RUN_ID });
  const result = await launchWorker({ recipe: recipeOf('claude'), prompt: 'brief', identity, execWorktree: w.worktree, env: w.env, runId: RUN_ID });
  await exited(result.child);
  assert.equal(result.env.DOFLOW_WORKER_RUN, RUN_ID);
  const [line] = readLog(w.log);
  assert.equal(line.workerRun, RUN_ID, 'the child process saw it');
  assert.equal(result.env.PROVIDER_API_KEY, SECRET);
  assert.ok(!Object.entries(result.env).some(([k, v]) => k !== 'PROVIDER_API_KEY' && v === SECRET), 'no credential is copied into another variable');
});

test('110 a launch with no runId leaves DOFLOW_WORKER_RUN unset, even when the caller env carries one', POSIX_ONLY, async (t) => {
  const w = world(t);
  w.env.DOFLOW_WORKER_RUN = 'w-aaaaaaaaaaaa';
  const { identity } = launchEnv({ env: w.env, runKey: 'abcdef0123456789/local/main', token: 1, execWorktree: w.worktree, runId: RUN_ID });
  const result = await launchWorker({ recipe: recipeOf('claude'), prompt: 'brief', identity, execWorktree: w.worktree, env: w.env });
  await exited(result.child);
  assert.equal(Object.hasOwn(result.env, 'DOFLOW_WORKER_RUN'), false);
  const [line] = readLog(w.log);
  assert.equal(Object.hasOwn(line, 'workerRun'), false, 'the child did not see the caller value either');
});

test('110 a malformed runId is a run-id-malformed usage error from launchWorker', POSIX_ONLY, async (t) => {
  const w = world(t);
  const { identity } = launchEnv({ env: w.env, runKey: 'abcdef0123456789/local/main', token: 1, execWorktree: w.worktree, runId: RUN_ID });
  await assert.rejects(
    launchWorker({ recipe: recipeOf('claude'), prompt: 'brief', identity, execWorktree: w.worktree, env: w.env, runId: 'w-NOT-HEX' }),
    (error) => error.code === 'run-id-malformed',
  );
  assert.deepEqual(readLog(w.log), [], 'nothing was spawned');
});

test('IC-012 the record lists variable names only and no value of any variable', (t) => {
  const w = world(t);
  const caller = { ...w.env, DOFLOW_RUN_ID: 'local', DOFLOW_LINEAGE_ID: 'main' };
  const { env, identity } = launchEnv({ env: caller, runKey: 'abcdef0123456789/local/main', token: 2, execWorktree: w.worktree, runId: RUN_ID });
  const record = launchRecord(recipeOf('claude'), identity, 'the brief');

  assert.deepEqual(record.envSet, ['DOFLOW_RUN_ID', 'DOFLOW_LINEAGE_ID', 'DOFLOW_ATTEMPT', 'DOFLOW_SESSION_ROLE', 'DOFLOW_WORKTREE', 'DOFLOW_WORKER_RUN']);
  assert.equal(record.envInherited, true);
  assert.deepEqual(record.identity, { run: '0123456789ab', lineage: 'main', attempt: '2', runSource: 'run-scoped' });
  assert.deepEqual(Object.keys(record.recipe), ['binary', 'argvShape', 'promptVia', 'parser', 'profile']);
  const text = JSON.stringify(record);
  for (const value of Object.values(caller)) {
    if (value.length >= 6) assert.ok(!text.includes(value), `record holds no value of the caller env: ${value.slice(0, 12)}`);
  }
  assert.ok(!text.includes(w.worktree), 'no DOFLOW_WORKTREE value');
  assert.ok(!text.includes(SECRET));
  assert.ok(!text.includes('the brief'), 'the prompt is stored as its shape only');
  assert.notEqual(env, caller);
});

test('IC-012 a missing binary rejects with ENOENT', POSIX_ONLY, async (t) => {
  const w = world(t);
  const recipe = recipeOf('claude');
  recipe.cli.binary = 'fake-absent';
  const { identity } = launchEnv({ env: w.env, runKey: 'abcdef0123456789/r1/w1', token: 1, execWorktree: w.worktree, runId: RUN_ID });
  await assert.rejects(launchWorker({ recipe, prompt: 'p', identity, execWorktree: w.worktree, env: w.env }), { code: 'ENOENT' });
  assert.deepEqual(readLog(w.log), []);
});
