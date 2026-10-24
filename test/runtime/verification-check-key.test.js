'use strict';

// D2 / IC-009: real file bytes with a git-status seam; no fixture git writes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { treeDigest, treeState, checkKey, checkKeyV2, toolDigest, envDigest } = require('../../src/runtime/verification/check-key.ts');

const HEAD = '1'.repeat(40);
const CLEAN = crypto.createHash('sha256').update('clean').digest('hex');
function options(root, status, configDir) {
  return { configDir, spawnSyncImpl: (_command, args) => ({
    status: 0,
    stdout: args.includes('--show-toplevel') ? root : args.includes('HEAD') ? HEAD : status(),
  }) };
}
function write(root, name, text) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}
function key(cwd, opts) {
  return checkKey({ cwd, command: 'npm test', timeoutMs: 1000, env: {}, ...opts });
}

test('tracked fixture .doflow contents participate in both tree digest and check key', (t) => {
  const root = tempDir(t, 'doflow-check-key-fixture-');
  const name = 'fixtures/p/.doflow/data.json';
  const opts = options(root, () => ` M ${name}\0`);
  const file = write(root, name, '{"value":1}');
  const before = treeDigest(root, opts);
  const beforeKey = key(root, opts);
  assert.match(before, /^[0-9a-f]{64}$/);
  assert.match(beforeKey, /^[0-9a-f]{16}$/);
  fs.writeFileSync(file, '{"value":2}');
  assert.notEqual(treeDigest(root, opts), before);
  assert.notEqual(key(root, opts), beforeKey);
});

test('nested configDir remains keyable and stable before and after its lock is created', (t) => {
  const root = tempDir(t, 'doflow-check-key-config-');
  const cwd = path.join(root, 'pkg');
  fs.mkdirSync(cwd);
  const configDir = path.join(cwd, '.doflow');
  let status = '';
  const opts = options(root, () => status, configDir);
  const before = key(cwd, opts);
  assert.match(before, /^[0-9a-f]{16}$/);
  const name = 'pkg/.doflow/state/verification/v0/inflight.lock';
  const lock = write(root, name, 'leader token');
  status = `?? ${name}\0`;
  assert.equal(treeDigest(cwd, opts), CLEAN);
  assert.equal(key(cwd, opts), before);
  fs.writeFileSync(lock, 'follower token');
  assert.equal(key(cwd, opts), before);
});

test('the contract runner supplies its nested configDir to the tree digest', (t) => {
  const root = tempDir(t, 'doflow-check-key-runner-config-');
  const cwd = path.join(root, 'pkg');
  fs.mkdirSync(cwd);
  const script = `
    const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
    const [repo, root] = process.argv.slice(1), cwd = path.join(root, 'pkg'), configDir = path.join(cwd, '.doflow');
    cp.spawnSync = (_command, args) => ({ status: 0, stdout:
      args.includes('HEAD') ? '${HEAD}' : args.includes('--show-toplevel') ? root :
      fs.existsSync(configDir) ? '?? pkg/.doflow/state/verification/v0/\\0' : '' });
    const { VerificationContractRunner } = require(repo + '/src/runtime/verification/contract-runner.ts');
    const { loadVerificationRegistry } = require(repo + '/src/runtime/verification/registry.ts');
    const registry = loadVerificationRegistry();
    const keys = [];
    for (let i = 0; i < 2; i++) {
      const runner = new VerificationContractRunner({ cwd, env: {},
        exec: () => ({ status: 0, stdout: '', stderr: '' }),
        context: { v0: true, registry, riskLevel: 'LOW', configDir } });
      const check = runner.runCheck('check', 'true', 1000);
      keys.push(runner.metrics.get(check).checkKey);
    }
    process.stdout.write(JSON.stringify(keys));
  `;
  const child = spawnSync(process.execPath, ['-e', script, path.resolve(__dirname, '../..'), root], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const [before, after] = JSON.parse(child.stdout);
  assert.match(before, /^[0-9a-f]{16}$/);
  assert.match(after, /^[0-9a-f]{16}$/);
  assert.equal(after, before);
});

test('dirty porcelain paths resolve from the git top level when cwd is a subdirectory', (t) => {
  const root = tempDir(t, 'doflow-check-key-subdir-');
  const cwd = path.join(root, 'pkg');
  fs.mkdirSync(cwd);
  write(root, 'dirty.js', 'changed\n');
  const opts = options(root, () => ' M dirty.js\0');
  assert.match(key(cwd, opts), /^[0-9a-f]{16}$/);
  assert.equal(treeDigest(cwd, opts), treeDigest(root, opts));
  assert.notEqual(treeDigest(cwd, opts), CLEAN);
});

test('an excluded top-level lock leaves the clean sentinel and check key unchanged', (t) => {
  const root = tempDir(t, 'doflow-check-key-clean-');
  let status = '';
  const opts = options(root, () => status);
  const before = key(root, opts);
  write(root, '.doflow/state/verification/v0/inflight.lock', 'token');
  status = '?? .doflow/state/verification/v0/inflight.lock\0';
  assert.equal(treeDigest(root, opts), CLEAN);
  assert.equal(key(root, opts), before);
});

test('configDir exclusion follows realpath and does not exclude sibling prefixes', (t) => {
  const root = tempDir(t, 'doflow-check-key-realconfig-');
  const configDir = path.join(root, 'pkg/.doflow');
  write(root, 'pkg/runtime-state/lock', 'token');
  fs.symlinkSync('runtime-state', configDir);
  const opts = options(root, () => '?? pkg/runtime-state/lock\0', configDir);
  assert.equal(treeDigest(root, opts), CLEAN);
  const sibling = 'pkg/runtime-state-fixture/data.json';
  write(root, sibling, 'one');
  const siblingOpts = options(root, () => `?? pkg/runtime-state/lock\0 M ${sibling}\0`, configDir);
  const before = treeDigest(root, siblingOpts);
  assert.notEqual(before, CLEAN);
  write(root, sibling, 'two');
  assert.notEqual(treeDigest(root, siblingOpts), before);
});

// 089 A.1 (IC-001, DD-1, DA-1, DA-2): payload version 2. Each case changes ONE input and
// asserts the key moves (or, for RK-1, does not move).
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const NONE = sha('none');

/** A git root with a bin directory; `env` resolves `node` and `mytool` from it. */
function toolRoot(t, prefix) {
  const root = tempDir(t, prefix);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'node'), 'node-v1');
  fs.writeFileSync(path.join(bin, 'mytool'), 'tool-v1');
  return { root, bin, env: { PATH: bin } };
}

test('an ignored entry appearing changes the key and only the ignored digest', (t) => {
  const root = tempDir(t, 'doflow-check-key-ignored-');
  let status = '';
  const opts = options(root, () => status);
  const before = key(root, opts);
  const stateBefore = treeState(root, opts);
  status = '!! build/\0';
  assert.notEqual(key(root, opts), before);
  const stateAfter = treeState(root, opts);
  assert.equal(stateAfter.tree, stateBefore.tree);
  assert.equal(stateBefore.ignored, NONE);
  assert.equal(stateAfter.ignored, sha('build/'));
  status = '!! a.log\0!! b/\0';
  assert.equal(treeState(root, opts).ignored, sha('a.log\0b/'));
});

test('ignored entries are ordered and the excluded runtime-state directories are left out', (t) => {
  const root = tempDir(t, 'doflow-check-key-ignored-order-');
  const a = key(root, options(root, () => '!! z.log\0!! a.log\0'));
  assert.equal(key(root, options(root, () => '!! a.log\0!! z.log\0')), a);
  const base = key(root, options(root, () => ''));
  assert.equal(key(root, options(root, () => '!! .doflow/\0')), base);
  assert.equal(key(root, options(root, () => '!! .doflow/state/x\0')), base);
});

test('tree digests are unchanged by ignored entries and equal the version 1 values', (t) => {
  const root = tempDir(t, 'doflow-check-key-v1-tree-');
  write(root, 'dirty.js', 'changed\n');
  const dirty = ` M dirty.js\0`;
  const expected = crypto.createHash('sha256')
    .update(` M dirty.js\0${sha('changed\n')}\0`).digest('hex');
  assert.equal(treeDigest(root, options(root, () => dirty)), expected);
  assert.equal(treeDigest(root, options(root, () => `!! build/\0${dirty}!! x.log\0`)), expected);
  assert.equal(treeDigest(root, options(root, () => '!! build/\0')), CLEAN);
});

test('treeState reads the ignored set from the one status call', (t) => {
  const root = tempDir(t, 'doflow-check-key-onecall-');
  const calls = [];
  const spawnSyncImpl = (command, args) => {
    calls.push(args);
    return { status: 0, stdout: args.includes('--show-toplevel') ? root : '!! node_modules/\0' };
  };
  const state = treeState(root, { spawnSyncImpl });
  assert.deepEqual(Object.keys(state).sort(), ['gitRoot', 'ignored', 'links', 'tree']);
  const statusCalls = calls.filter((args) => args[0] === 'status');
  assert.equal(statusCalls.length, 1);
  assert.deepEqual(statusCalls[0], ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching']);
  assert.equal(checkKeyV2({ cwd: root, command: 'npm test', timeoutMs: 1, env: {}, head: HEAD, spawnSyncImpl }).key.length, 16);
  assert.equal(calls.filter((args) => args[0] === 'status').length, 2, 'one status call per key, not per input');
});

test('a precomputed tree and ignored digest equal the self-computed key', (t) => {
  const root = tempDir(t, 'doflow-check-key-precomputed-');
  const opts = options(root, () => '!! build/\0 M dirty.js\0');
  write(root, 'dirty.js', 'x');
  const state = treeState(root, opts);
  const self = key(root, opts);
  assert.equal(key(root, { ...opts, head: HEAD, tree: state.tree, ignored: state.ignored }), self);
  assert.notEqual(key(root, { ...opts, tree: state.tree, ignored: sha('other') }), self);
});

test('a declared ignored input changing, appearing or disappearing changes the key', (t) => {
  const root = tempDir(t, 'doflow-check-key-inputs-');
  const opts = options(root, () => '');
  const absent = key(root, opts);
  const env = write(root, '.env', 'A=1');
  const one = key(root, opts);
  assert.notEqual(one, absent, 'creation');
  fs.writeFileSync(env, 'A=2');
  const two = key(root, opts);
  assert.notEqual(two, one, 'bytes');
  fs.writeFileSync(env, 'A=1');
  assert.equal(key(root, opts), one, 'same bytes, same key');
  fs.rmSync(env);
  assert.equal(key(root, opts), absent, 'deletion returns to absent');
  write(root, 'node_modules/.package-lock.json', '{}');
  assert.notEqual(key(root, opts), absent, 'a nested declared input');
});

test('RK-1: an undeclared ignored file changing content leaves the key unchanged', (t) => {
  const root = tempDir(t, 'doflow-check-key-rk1-');
  const opts = options(root, () => '!! cache.bin\0');
  const file = write(root, 'cache.bin', 'one');
  const before = key(root, opts);
  fs.writeFileSync(file, 'two, longer');
  assert.equal(key(root, opts), before);
});

test('a declared input that is a symlink, a directory or over 1 MB makes the key null', (t) => {
  const root = tempDir(t, 'doflow-check-key-bad-input-');
  const opts = options(root, () => '');
  assert.match(key(root, opts), /^[0-9a-f]{16}$/);
  const target = write(root, 'real-env', 'A=1');
  fs.symlinkSync(target, path.join(root, '.env'));
  assert.equal(key(root, opts), null, 'symlink');
  fs.rmSync(path.join(root, '.env'));
  fs.mkdirSync(path.join(root, '.env'));
  assert.equal(key(root, opts), null, 'directory');
  fs.rmSync(path.join(root, '.env'), { recursive: true });
  write(root, '.env', 'x'.repeat(1024 * 1024));
  assert.match(key(root, opts), /^[0-9a-f]{16}$/, 'exactly 1 MB is keyable');
  write(root, '.env', 'x'.repeat(1024 * 1024 + 1));
  assert.equal(key(root, opts), null, 'over 1 MB');
  fs.rmSync(path.join(root, '.env'));
  const io = Object.create(fs);
  io.lstatSync = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  assert.equal(key(root, { ...opts, fsImpl: io }), null, 'a read fault other than ENOENT');
});

test('the PATH node file changing size or mtime alone changes the key', (t) => {
  const { root, bin, env } = toolRoot(t, 'doflow-check-key-node-');
  const opts = options(root, () => '');
  const node = path.join(bin, 'node');
  const when = new Date(1_700_000_000_000);
  fs.utimesSync(node, when, when);
  const base = key(root, { ...opts, env, command: 'true' });
  assert.match(base, /^[0-9a-f]{16}$/);
  assert.equal(key(root, { ...opts, env, command: 'true' }), base, 'stable');
  fs.utimesSync(node, when, new Date(1_700_000_100_000));
  const touched = key(root, { ...opts, env, command: 'true' });
  assert.notEqual(touched, base, 'mtime alone');
  fs.writeFileSync(node, 'node-v2-longer');
  fs.utimesSync(node, when, new Date(1_700_000_100_000));
  assert.notEqual(key(root, { ...opts, env, command: 'true' }), touched, 'size alone');
  fs.rmSync(node);
  assert.notEqual(key(root, { ...opts, env, command: 'true' }), touched, 'node gone from PATH');
});

test('the first word of the command resolving to a different binary changes the key', (t) => {
  const { root, bin, env } = toolRoot(t, 'doflow-check-key-tool-');
  const opts = { ...options(root, () => ''), env, command: 'mytool run --all' };
  const tool = path.join(bin, 'mytool');
  const when = new Date(1_700_000_000_000);
  fs.utimesSync(tool, when, when);
  const base = key(root, opts);
  assert.equal(key(root, { ...opts, command: 'mytool run --all' }), base);
  fs.writeFileSync(tool, 'tool-v2-longer');
  fs.utimesSync(tool, when, when);
  const resized = key(root, opts);
  assert.notEqual(resized, base, 'size');
  fs.utimesSync(tool, when, new Date(1_700_000_200_000));
  assert.notEqual(key(root, opts), resized, 'mtime');
  const ctx = { cwd: root, env, fsImpl: fs };
  assert.equal(toolDigest('FOO=1 mytool run', ctx), toolDigest('mytool', ctx), 'only the first word names the tool');
  assert.notEqual(toolDigest('othertool', ctx), toolDigest('mytool', ctx));
  // Another binary with the same name earlier on PATH wins.
  const early = path.join(root, 'early');
  fs.mkdirSync(early);
  fs.writeFileSync(path.join(early, 'mytool'), 'early');
  assert.notEqual(key(root, { ...opts, env: { PATH: `${early}:${bin}` } }), key(root, opts));
  // A first word with a slash is taken relative to cwd.
  const direct = { ...opts, command: './bin/mytool x' };
  const viaSlash = key(root, direct);
  fs.writeFileSync(tool, 'changed again!!');
  assert.notEqual(key(root, direct), viaSlash);
});

test('checkKeyV2 returns the key and the full sha256 of the version 2 payload', (t) => {
  const root = tempDir(t, 'doflow-check-key-v2-');
  const opts = options(root, () => '');
  const input = { cwd: root, command: 'npm test', timeoutMs: 1000, env: {}, ...opts };
  const out = checkKeyV2(input);
  assert.match(out.payloadDigest, /^[0-9a-f]{64}$/);
  assert.equal(out.key, out.payloadDigest.slice(0, 16));
  assert.equal(checkKey(input), out.key);
  // Recompute the payload from first principles: nothing declared, no PATH, a clean tree.
  const inputs = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../core/registry/verification.json'), 'utf8'))
    .policy.reuse.ignoredInputs;
  const payload = [2, 'npm test', 1000, fs.realpathSync(root), HEAD, CLEAN, NONE,
    sha(inputs.map((rel) => `${rel}\0absent`).join('\n')),
    NONE, // linksDigest: no tracked symlinks
    sha(['node\0absent', 'npm\0absent'].join('\n')),
    process.version, process.platform, process.arch, envDigest({})];
  assert.equal(out.payloadDigest, sha(JSON.stringify(payload)));
  assert.equal(checkKeyV2({ ...input, timeoutMs: NaN }), null);
  assert.equal(checkKeyV2({ ...input, cwd: path.join(root, 'missing') }), null);
});

test('a git fault or a null head or tree stays unkeyable', (t) => {
  const root = tempDir(t, 'doflow-check-key-null-');
  const faulty = { spawnSyncImpl: () => ({ status: 128, stdout: '' }) };
  assert.equal(key(root, faulty), null);
  const opts = options(root, () => '');
  assert.equal(key(root, { ...opts, head: null }), null);
  assert.equal(key(root, { ...opts, tree: null }), null);
});

test('a caller-supplied tree outside a git checkout is keyable but never equals a healthy key', (t) => {
  const root = tempDir(t, 'doflow-check-key-degraded-');
  const faulty = { spawnSyncImpl: (_command, args) => ({ status: args.includes('HEAD') ? 0 : 128, stdout: HEAD }) };
  const input = { cwd: root, command: 'true', timeoutMs: 1, env: {}, head: HEAD, tree: 'tree' };
  const degraded = key(root, { ...input, ...faulty });
  assert.match(degraded, /^[0-9a-f]{16}$/);
  assert.equal(key(root, { ...input, ...faulty }), degraded);
  assert.notEqual(key(root, { ...input, ...options(root, () => ''), tree: 'tree' }), degraded);
  // The declared inputs are then read from cwd, so they still move the key.
  write(root, '.env', 'A=1');
  assert.notEqual(key(root, { ...input, ...faulty }), degraded);
});

// Execute a mutated module in memory (the pattern of verification-inflight.test.js): the
// production file is never edited, and each mutation must break the case asserted above.
function mutated(before, after) {
  const Module = require('node:module');
  const filename = path.resolve(__dirname, '../../src/runtime/verification/check-key.ts');
  const source = fs.readFileSync(filename, 'utf8');
  assert.ok(source.includes(before), `mutation target exists: ${before}`);
  const instance = new Module(filename, module);
  instance.filename = filename;
  instance.paths = module.paths;
  instance._compile(Module.stripTypeScriptTypes(source.replace(before, after)), filename);
  return instance.exports;
}

test('negative control: dropping ignoredDigest from the payload leaves the ignored-entry case red', (t) => {
  const mutant = mutated('    ignoredDig,\n    inputsDig,', '    inputsDig,');
  const root = tempDir(t, 'doflow-check-key-negative-ignored-');
  let status = '';
  const opts = options(root, () => status);
  const input = { cwd: root, command: 'npm test', timeoutMs: 1000, env: {}, ...opts };
  const before = mutant.checkKey(input);
  status = '!! build/\0';
  assert.throws(() => assert.notEqual(mutant.checkKey(input), before), assert.AssertionError);
  assert.notEqual(checkKey(input), before, 'the real module still distinguishes it');
});

test('negative control: reading process.version only (no PATH stat) leaves the tool case red', (t) => {
  const mutant = mutated('    toolDig,\n', '');
  const { root, bin, env } = toolRoot(t, 'doflow-check-key-negative-tool-');
  const input = { cwd: root, command: 'mytool', timeoutMs: 1000, env, ...options(root, () => '') };
  const before = mutant.checkKey(input);
  fs.writeFileSync(path.join(bin, 'mytool'), 'a much longer tool');
  fs.writeFileSync(path.join(bin, 'node'), 'a much longer node');
  assert.throws(() => assert.notEqual(mutant.checkKey(input), before), assert.AssertionError);
  assert.notEqual(checkKey(input), checkKey({ ...input, env: { PATH: '' } }));
});

test('negative control: dropping inputsDigest from the payload leaves the declared-input case red', (t) => {
  const mutant = mutated('    inputsDig,\n', '');
  const root = tempDir(t, 'doflow-check-key-negative-inputs-');
  const input = { cwd: root, command: 'npm test', timeoutMs: 1000, env: {}, ...options(root, () => '') };
  const before = mutant.checkKey(input);
  write(root, '.env', 'A=1');
  assert.throws(() => assert.notEqual(mutant.checkKey(input), before), assert.AssertionError);
});

// 089 review C-3/C-4/C-5 (WP-1): reuse-unkeyable inputs keep the key, drop the payload digest.
test('checkKeyV2 keeps the key and returns a null payloadDigest for a first word the parser cannot trust', (t) => {
  const root = tempDir(t, 'doflow-check-key-unkeyable-');
  const opts = options(root, () => '');
  const base = (command) => checkKeyV2({ cwd: root, command, timeoutMs: 1000, env: {}, ...opts });
  for (const command of ['"/a b/tool" x', "'/a b/tool' x", '/a\\ b/tool x', '$DIR/tool x', '`echo tool` x', 'X="a b" tool',
    'PATH=/x:$PATH tool', 'PATH=/x tool', '~/tool x', '/dir/to*l x', '/dir/too? x', '/dir/[t]ool x', 'LABEL=$HOME tool']) {
    const out = base(command);
    assert.match(out.key, /^[0-9a-f]{16}$/, `${command}: the key is kept`);
    assert.equal(out.payloadDigest, null, `${command}: not reusable`);
  }
  for (const command of ['LABEL=ok tool', 'npm test', 'node --test x', '/abs/tool x', 'A=1 B=2 tool', 'MYPATH=/x tool']) {
    assert.match(base(command).payloadDigest, /^[0-9a-f]{64}$/, `${command}: reusable`);
  }
  assert.equal(checkKey({ cwd: root, command: '$DIR/tool', timeoutMs: 1000, env: {}, ...opts }), base('$DIR/tool').key, 'checkKey still returns the key');
});

/** Stubs `git ls-files` with `lines` and counts its spawns; every other call answers like options(). */
function linkOptions(root, lines, calls = []) {
  const base = options(root, () => '');
  return { calls, spawnSyncImpl: (command, args, opts) => {
    if (args[0] === 'ls-files') { calls.push(args); return { status: 0, stdout: lines.map((line) => `${line}\0`).join('') }; }
    return base.spawnSyncImpl(command, args, opts);
  } };
}

test('treeState keys the out-of-repo target of a tracked symlink: file bytes, absent, or unkeyable', (t) => {
  const root = tempDir(t, 'doflow-check-key-links-');
  const outside = tempDir(t, 'doflow-check-key-links-out-');
  const target = write(outside, 'value.txt', 'ok');
  fs.symlinkSync(target, path.join(root, 'cfg.txt'));
  fs.symlinkSync(path.join(outside, 'later.txt'), path.join(root, 'gone.txt'));
  fs.symlinkSync(outside, path.join(root, 'dir'));
  fs.symlinkSync('real.txt', path.join(root, 'inner.txt'));
  write(root, 'real.txt', 'x');
  const entry = (name) => `120000 ${'a'.repeat(40)} 0\t${name}`;
  const digest = (...names) => treeState(root, linkOptions(root, names.map(entry))).links;
  assert.equal(digest(), NONE, 'no tracked symlink');
  assert.equal(digest('inner.txt'), NONE, 'an in-repo target is covered by the tree digest');
  const file = digest('cfg.txt');
  assert.match(file, /^[0-9a-f]{64}$/);
  write(outside, 'value.txt', 'bad');
  assert.notEqual(digest('cfg.txt'), file, 'the target bytes move the digest');
  const absent = digest('gone.txt');
  assert.match(absent, /^[0-9a-f]{64}$/);
  write(outside, 'later.txt', 'now');
  assert.notEqual(digest('gone.txt'), absent, 'a dangling target that appears moves the digest');
  assert.equal(digest('dir'), 'unkeyable', 'a directory target');
  write(outside, 'big.txt', 'x'.repeat(1024 * 1024 + 1));
  fs.symlinkSync(path.join(outside, 'big.txt'), path.join(root, 'big.txt'));
  assert.equal(digest('big.txt'), 'unkeyable', 'a target over 1 MB');
  const many = Array.from({ length: 501 }, (_, i) => entry(`l${i}`));
  assert.equal(treeState(root, linkOptions(root, many)).links, 'unkeyable', 'over 500 links');
  assert.equal(treeState(root, { spawnSyncImpl: () => ({ status: 128, stdout: '' }) }), null);
  const lsFault = options(root, () => '');
  assert.equal(treeState(root, { spawnSyncImpl: (c, args, o) => (args[0] === 'ls-files' ? { status: 128, stdout: '' } : lsFault.spawnSyncImpl(c, args, o)) }).links,
    'unkeyable', 'a git fault on ls-files');
});

test('an unkeyable tracked symlink keeps the key and drops the payloadDigest; a skipped link read is not reusable', (t) => {
  const root = tempDir(t, 'doflow-check-key-links-key-');
  const outside = tempDir(t, 'doflow-check-key-links-keyout-');
  fs.symlinkSync(outside, path.join(root, 'dir'));
  const unkeyable = linkOptions(root, [`120000 ${'a'.repeat(40)} 0\tdir`]);
  const out = checkKeyV2({ cwd: root, command: 'npm test', timeoutMs: 1000, env: {}, head: HEAD, ...unkeyable });
  assert.match(out.key, /^[0-9a-f]{16}$/);
  assert.equal(out.payloadDigest, null);
  const clean = checkKeyV2({ cwd: root, command: 'npm test', timeoutMs: 1000, env: {}, head: HEAD, ...options(root, () => '') });
  assert.notEqual(out.key, clean.key, 'the link digest is part of the key');
  const skipped = treeState(root, { ...linkOptions(root, []), links: false });
  assert.equal(skipped.links, 'skipped');
  const noRead = checkKeyV2({ cwd: root, command: 'npm test', timeoutMs: 1000, env: {}, head: HEAD, tree: skipped.tree,
    ignored: skipped.ignored, gitRoot: skipped.gitRoot, links: skipped.links, ...options(root, () => '') });
  assert.equal(noRead.payloadDigest, null, 'a key built without reading the links is never a stored-PASS identity');
});

test('treeState spawns git ls-files once per read, and not at all with links: false', (t) => {
  const root = tempDir(t, 'doflow-check-key-lsfiles-');
  const calls = [];
  treeState(root, linkOptions(root, [], calls));
  assert.deepEqual(calls, [['ls-files', '-s', '-z']]);
  treeState(root, { ...linkOptions(root, [], calls), links: false });
  assert.equal(calls.length, 1, 'links: false adds no spawn');
});

test('a tracked .doflow entry enters the tree digest; untracked, ignored and state entries do not (C-5)', (t) => {
  const root = tempDir(t, 'doflow-check-key-doflow-tracked-');
  write(root, '.doflow/check.cfg', 'ok');
  write(root, '.doflow/state/tracked.json', '{}');
  const digest = (status, configDir) => treeDigest(root, options(root, () => status, configDir));
  assert.equal(digest('?? .doflow/x\0'), CLEAN);
  assert.equal(digest('!! .doflow/\0'), CLEAN);
  assert.equal(digest(' M .doflow/state/tracked.json\0'), CLEAN);
  assert.equal(digest('?? .doflow/state/verification/v0/lock\0'), CLEAN);
  const modified = digest(' M .doflow/check.cfg\0');
  assert.notEqual(modified, CLEAN);
  assert.notEqual(digest('M  .doflow/check.cfg\0'), CLEAN);
  assert.notEqual(digest('A  .doflow/check.cfg\0'), CLEAN);
  write(root, '.doflow/check.cfg', 'bad');
  assert.notEqual(digest(' M .doflow/check.cfg\0'), modified, 'the bytes move the digest');
  // The same rule for a config dir inside the repository.
  assert.notEqual(digest(' M .doflow/check.cfg\0', path.join(root, '.doflow')), CLEAN);
  assert.equal(digest('?? .doflow/x\0', path.join(root, '.doflow')), CLEAN);
  assert.equal(digest(' M .doflow/state/tracked.json\0', path.join(root, '.doflow')), CLEAN);
  write(root, 'cfg/settings.json', '{}');
  assert.notEqual(digest(' M cfg/settings.json\0', path.join(root, 'cfg')), CLEAN, 'a tracked file in a custom config dir');
  assert.equal(digest('?? cfg/new.json\0', path.join(root, 'cfg')), CLEAN);
});
