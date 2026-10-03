'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ContextPackCompiler, handleContextPackCommand } = require('../../src/runtime/context-pack');
const { runDecision } = require('../../src/runtime/decision-register');

// IC-012: the pack carries the feature's live decisions. Each fixture is a scratch git repo with
// one feature folder, so the real resolver (do-paths.sh) decides which feature is meant.

function git(cwd, ...args) {
  const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')} failed: ${run.stderr}`);
}

/** A repo on `branch` holding feature 060-x; `withRegister` seeds three decisions, one superseded. */
function fixture(t, { branch = 'feat/060-x', withRegister = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-pack-decisions-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'agent-docs', 'doflow', '060-x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agent-docs', 'doflow', '060-x', '.keep'), '');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  if (branch !== 'main') git(root, 'checkout', '-q', '-b', branch);
  if (withRegister) {
    const add = (flags) => assert.equal(runDecision({ action: 'add', projectRoot: root, slug: '060-x', flags: { channel: 'question', stage: 'design', rationale: 'r', ...flags } }).exitCode, 0);
    assert.equal(runDecision({ action: 'init', projectRoot: root, slug: '060-x' }).exitCode, 0);
    add({ topic: 'wire-id', statement: 'The wire carries the key.' });
    add({ topic: 'auth-mode', statement: 'Tokens expire daily.' });
    add({ topic: 'wire-id', statement: 'The wire carries the UUID.', supersedes: 'DEC-001' });
  }
  return root;
}

function packOf(root, options) {
  let out = '';
  const original = console.log;
  const priorExitCode = process.exitCode;
  console.log = (text) => { out += text; };
  let code;
  try { code = handleContextPackCommand({ taskId: 'T-1', stateRoot: root, json: true, ...options }); }
  // The handler records its verdict on process.exitCode; a verdict of 1 must not become this
  // test file's own exit status.
  finally { console.log = original; process.exitCode = priorExitCode; }
  return { code, pack: JSON.parse(out) };
}

test('the pack lists live decisions only, sorted by topic, and a pack holding only decisions exits 0', (t) => {
  const { code, pack } = packOf(fixture(t));
  assert.equal(code, 0);
  assert.equal(pack.empty, false);
  assert.equal(pack.decisions.available, true);
  assert.equal(pack.decisions.liveCount, 2);
  assert.deepEqual(pack.decisions.live, [
    { id: 'DEC-002', topic: 'auth-mode', statement: 'Tokens expire daily.', decidedBy: 'user', stage: 'design' },
    { id: 'DEC-003', topic: 'wire-id', statement: 'The wire carries the UUID.', decidedBy: 'user', stage: 'design' },
  ]);
});

test('--slug finds the feature when the branch does not name it', (t) => {
  const root = fixture(t, { branch: 'main' });
  const without = packOf(root);
  assert.equal(without.pack.decisions.available, false);
  assert.equal(without.code, 1);
  const withSlug = packOf(root, { slug: '060-x' });
  assert.equal(withSlug.pack.decisions.liveCount, 2);
  assert.equal(withSlug.code, 0);
});

test('a feature without a register reads as unavailable, and the empty pack still exits 1', (t) => {
  const { code, pack } = packOf(fixture(t, { withRegister: false }));
  assert.deepEqual(pack.decisions, { available: false, live: [], liveCount: 0 });
  assert.equal(pack.empty, true);
  assert.equal(code, 1);
});

test('an unresolvable feature never throws', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-pack-nofeature-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { pack } = packOf(root);
  assert.deepEqual(pack.decisions, { available: false, live: [], liveCount: 0 });
});

test('an unreadable register reads as unavailable rather than failing the pack', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'agent-docs', 'doflow', '060-x', 'decisions', 'register.json'), '{ not json');
  const { decisions } = packOf(root).pack;
  assert.equal(decisions.available, false);
  assert.deepEqual(decisions.live, []);
  assert.equal(decisions.liveCount, 0);
  assert.match(decisions.reason, /^register unreadable: .*not valid JSON/);
});

test('a missing register carries no reason', (t) => {
  assert.equal('reason' in packOf(fixture(t, { withRegister: false })).pack.decisions, false);
});

test('the markdown form has a Live decisions section only when there are live decisions', () => {
  const compiler = new ContextPackCompiler();
  const withDecisions = compiler.compileContextPack({ taskId: 'x', decisions: {
    available: true, liveCount: 1, live: [{ id: 'DEC-007', topic: 'wire-id', statement: 'UUID on the wire.', decidedBy: 'user', stage: 'design' }],
  } });
  assert.match(compiler.formatMarkdown(withDecisions), /### Live decisions\n- DEC-007 \(wire-id\): UUID on the wire\.\n/);
  const without = compiler.compileContextPack({ taskId: 'x' });
  assert.deepEqual(without.decisions, { available: false, live: [], liveCount: 0 });
  assert.doesNotMatch(compiler.formatMarkdown(without), /Live decisions/);
});
