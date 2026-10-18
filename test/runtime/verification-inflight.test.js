'use strict';

// 088 G.4, IC-009/017: barriers order executions; no timing sleeps or process-table probes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { runInflight, sweepInflight } = require('../../src/runtime/verification/inflight.ts');
const { checkKey, treeDigest, envDigest } = require('../../src/runtime/verification/check-key.ts');
const { loadVerificationRegistry } = require('../../src/runtime/verification/registry.ts');
const REPO = path.resolve(__dirname, '../..');
const KEY = '0123456789abcdef';
const TOKEN = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const good = () => ({ status: 0, stdout: '# tests 3\n# fail 0\n', stderr: '' });
const bad = () => ({ status: 7, stdout: '# tests 3\n# fail 1\n', stderr: 'failed\n' });
const enoent = () => Object.assign(new Error('absent'), { code: 'ENOENT' });
const lockName = (dir) => path.join(dir, `inflight-${KEY}.lock`);
const resultName = (dir, token = TOKEN) => path.join(dir, `inflight-${KEY}.${token}.result.json`);
function lock(dir, overrides = {}) {
  const record = { v: 1, token: TOKEN, pid: process.pid, startedAt: 100, deadlineAt: 50000, ...overrides };
  fs.writeFileSync(lockName(dir), JSON.stringify(record), { mode: 0o600 });
  return record;
}
function result(dir, overrides = {}) {
  fs.writeFileSync(resultName(dir), JSON.stringify({ v: 1, token: TOKEN, finishedAt: 1000, result: bad(), ...overrides }));
}
function follow(t, setup = () => {}, options = {}) {
  const dir = tempDir(t, 'doflow-inflight-follower-');
  lock(dir);
  setup(dir);
  let runs = 0;
  const got = runInflight({ dir, key: KEY, timeoutMs: 5000, now: () => 1000,
    execute: () => { runs++; return good(); }, ...options });
  return { dir, got, runs };
}
async function until(predicate, label) {
  const limit = Date.now() + 12000;
  while (!predicate()) {
    assert.ok(Date.now() < limit, `barrier timed out: ${label}`);
    await new Promise(setImmediate);
  }
}

// The digest sees real file bytes through the IC-009 git-status seam, avoiding fixture git writes.
const CHILD = `
const fs=require('node:fs'),path=require('node:path');
const input=JSON.parse(process.argv[1]);
const {VerificationContractRunner}=require(input.repo+'/src/runtime/verification/contract-runner.ts');
const {loadVerificationRegistry}=require(input.repo+'/src/runtime/verification/registry.ts');
const {treeDigest}=require(input.repo+'/src/runtime/verification/check-key.ts');
const io=Object.create(fs);
io.readFileSync=(file,...args)=>{const out=fs.readFileSync(file,...args);if(String(file).endsWith('.lock')) process.send({following:true});return out;};
const registry=loadVerificationRegistry();
const runner=new VerificationContractRunner({cwd:input.root,fsImpl:io,env:input.env,
 logDir:input.dir+'/logs',context:{v0:input.v0!==false,registry,riskLevel:input.risk||'LOW',configDir:input.dir}});
runner._treeContext={head:'1'.repeat(40),tree:treeDigest(input.root,{spawnSyncImpl:()=>({status:0,stdout:' M dirty.js\\0'})})};
const check=runner.runCheck(input.name,input.command,10000);
const metric=runner.metrics.get(check);
process.send({check,metric});process.disconnect();
`;
function child(t, input) {
  const proc = spawn(process.execPath, ['-e', CHILD, JSON.stringify({ repo: REPO, ...input })],
    { env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const messages = [];
  let stderr = '';
  proc.stderr.on('data', (data) => { stderr += data; });
  proc.on('message', (message) => messages.push(message));
  const done = new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('exit', (code, signal) => resolve({ code, signal, stderr }));
  });
  t.after(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); });
  return { proc, messages, done };
}
function concurrentFixture(t, exit = 7) {
  const root = tempDir(t, 'doflow-inflight-workers-');
  const dir = path.join(root, '.doflow');
  fs.writeFileSync(path.join(root, 'dirty.js'), 'first\n');
  const command = `printf 'run\\n' >> runs; : > entered; until [ -f go ]; do [ -d "${root}" ] || exit 1; done; printf '# tests 3\\n# fail ${exit ? 1 : 0}\\n'; exit ${exit}`;
  return { root, dir, command, env: { ...process.env, DOFLOW_TELEMETRY: 'on' } };
}
function countRuns(root) {
  try { return fs.readFileSync(path.join(root, 'runs'), 'utf8').trim().split('\n').length; } catch { return 0; }
}
function finish(root) { fs.writeFileSync(path.join(root, 'go'), ''); }
async function completed(worker) {
  const ended = await worker.done;
  assert.equal(ended.code, 0, ended.stderr);
  const output = worker.messages.find((m) => m.check);
  assert.ok(output, 'child returned a check');
  return output;
}

for (const exit of [0, 7]) {
  test(`two concurrent requests execute once with equal ${exit ? 'FAIL' : 'PASS'} verdicts and one token-bound shared result`, async (t) => {
    const fixture = concurrentFixture(t, exit);
    if (exit) fixture.env.DOFLOW_TELEMETRY = 'off';
    const leader = child(t, { ...fixture, name: 'leader-name' });
    await until(() => countRuns(fixture.root) === 1, 'leader executing');
    const follower = child(t, { ...fixture, name: 'follower-name' });
    await until(() => follower.messages.some((m) => m.following), 'follower read lock');
    finish(fixture.root);
    const [a, b] = await Promise.all([completed(leader), completed(follower)]);
    assert.equal(countRuns(fixture.root), 1);
    assert.equal(a.check.status, exit ? 'FAIL' : 'PASS');
    assert.equal(b.check.status, a.check.status);
    assert.equal(b.check.exitCode, a.check.exitCode);
    assert.equal(b.check.stdout, a.check.stdout);
    assert.equal(a.check.shared, undefined);
    assert.equal(b.check.name, 'follower-name');
    assert.deepEqual(b.check.shared, { from: a.metric.sharedRef });
    assert.equal(a.metric.shared, 'leader');
    assert.equal(b.metric.shared, 'follower');
    assert.equal(b.metric.sharedRef, a.metric.sharedRef);
    assert.ok(b.metric.durationMs >= 0);
    assert.equal(b.metric.cpuMs, null);
    assert.equal(fs.existsSync(path.join(fixture.dir, 'state/verification/v0', `inflight-${KEY}.lock`)), false);
  });
}

for (const difference of ['NODE_OPTIONS', 'environment key', 'uncommitted change']) {
  test(`${difference} gives two executions`, async (t) => {
    const fixture = concurrentFixture(t);
    const leader = child(t, { ...fixture, name: 'one' });
    await until(() => countRuns(fixture.root) === 1, 'leader executing');
    const env = { ...fixture.env };
    if (difference === 'NODE_OPTIONS') env.NODE_OPTIONS = '--no-warnings';
    else if (difference === 'environment key') env.TEST_IDENTITY = 'different';
    else fs.writeFileSync(path.join(fixture.root, 'dirty.js'), 'uncommitted edit\n');
    const second = child(t, { ...fixture, env, name: 'two' });
    await until(() => countRuns(fixture.root) === 2, 'independent execution');
    finish(fixture.root);
    const [a, b] = await Promise.all([completed(leader), completed(second)]);
    assert.notEqual(a.metric.checkKey, b.metric.checkKey);
    assert.equal(a.check.shared, undefined);
    assert.equal(b.check.shared, undefined);
  });
}

test('SIGKILLed leader: follower executes and never removes the dead leader lock', async (t) => {
  const fixture = concurrentFixture(t);
  const leader = child(t, { ...fixture, name: 'killed' });
  await until(() => countRuns(fixture.root) === 1, 'leader executing');
  const follower = child(t, { ...fixture, name: 'survivor' });
  await until(() => follower.messages.some((m) => m.following), 'follower read lock');
  leader.proc.kill('SIGKILL');
  const ended = await leader.done;
  assert.equal(ended.signal, 'SIGKILL');
  await until(() => countRuns(fixture.root) === 2, 'follower fallback after SIGKILL');
  finish(fixture.root); // also releases the killed Node parent's orphaned shell
  const out = await completed(follower);
  assert.equal(out.metric.shared, 'none');
  assert.equal(out.check.status, 'FAIL');
  const dir = path.join(fixture.dir, 'state/verification/v0');
  assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.lock')).length, 1);
});

test('arrival after finishedAt is not shared (negative control: arrival guard)', (t) => {
  const { got, runs } = follow(t, (dir) => result(dir, { finishedAt: 999 }));
  assert.equal(runs, 1);
  assert.equal(got.shared, 'none');
  assert.equal(got.result.status, 0);
});

test('an invalid arrival clock runs unshared instead of bypassing the late-arrival guard', (t) => {
  for (const invalid of [NaN, Infinity, '1000', undefined]) {
    let arriving = false;
    const { got, runs } = follow(t, (dir) => result(dir), {
      // Sweep and lock creation see a valid clock; the EEXIST arrival read faults.
      now: () => arriving ? invalid : 1000,
      fsImpl: new Proxy(fs, { get(target, prop) {
        if (prop === 'linkSync') return (...args) => {
          arriving = true;
          return target.linkSync(...args);
        };
        return target[prop];
      } }),
    });
    assert.equal(runs, 1, `invalid arrival ${invalid} executes locally`);
    assert.equal(got.shared, 'none');
  }
});

test('a result carrying a different token is never accepted (negative control: token guard)', (t) => {
  const { got, runs } = follow(t, (dir) => result(dir, { token: OTHER }));
  assert.equal(runs, 1);
  assert.equal(got.shared, 'none');
});

test('a file for a different token is not accepted', (t) => {
  const { got, runs } = follow(t, (dir) => {
    result(dir);
    fs.renameSync(resultName(dir), resultName(dir, OTHER));
  }, { isAlive: () => false });
  assert.equal(runs, 1);
  assert.equal(got.shared, 'none');
});

test('follower preserves a failing leader verdict and measures only its wait', (t) => {
  let clock = 1000;
  const { got, runs } = follow(t, () => {}, {
    now: () => clock,
    monotonic: () => BigInt(clock) * 1000000n,
    sleep: () => { clock += 250; },
    fsImpl: new Proxy(fs, { get(target, prop) {
      if (prop === 'readFileSync') return (file, ...args) => {
        if (String(file).endsWith('.result.json') && clock >= 1250) {
          return JSON.stringify({ v: 1, token: TOKEN, finishedAt: clock, result: bad() });
        }
        return target.readFileSync(file, ...args);
      };
      return target[prop];
    } }),
  });
  assert.equal(runs, 0);
  assert.equal(got.result.status, 7);
  assert.equal(got.shared, 'follower');
  assert.equal(got.sharedRef, TOKEN);
  assert.equal(got.durationMs, 250);
});

for (const fault of ['dead pid', 'deadline', 'lock gone', 'lock replaced', 'corrupt result', 'result read', 'liveness', 'poll']) {
  test(`follower runs unshared on ${fault} and never deletes a live lock`, (t) => {
    let clock = 1000;
    const { got, runs, dir } = follow(t, () => {}, {
      now: () => clock,
      isAlive: () => { if (fault === 'liveness') throw new Error('fault'); return fault !== 'dead pid'; },
      sleep: () => { throw new Error('poll fault'); },
      fsImpl: new Proxy(fs, { get(target, prop) {
        if (prop === 'readFileSync') return (file, ...args) => {
          if (String(file).endsWith('.result.json')) {
            if (fault === 'corrupt result') return '{';
            if (fault === 'result read') throw new Error('read fault');
            if (fault === 'lock gone') { fs.unlinkSync(path.join(path.dirname(file), `inflight-${KEY}.lock`)); }
            if (fault === 'lock replaced') lock(path.dirname(file), { token: OTHER });
            if (fault === 'deadline') clock = 50001;
            throw enoent();
          }
          return target.readFileSync(file, ...args);
        };
        return target[prop];
      } }),
    });
    assert.equal(runs, 1);
    assert.equal(got.shared, 'none');
    if (fault !== 'lock gone') assert.ok(fs.existsSync(lockName(dir)), 'follower leaves lock alone');
  });
}

test('missing and empty locks are reread for at most one second, never removed', (t) => {
  for (const missing of [false, true]) {
    let elapsed = 0;
    const { got, runs, dir } = follow(t, (dir) => fs.writeFileSync(lockName(dir), ''), {
      now: () => 1000 + elapsed,
      sleep: (ms) => { elapsed += ms; },
      fsImpl: new Proxy(fs, { get(target, prop) {
        if (missing && prop === 'readFileSync') return () => { throw enoent(); };
        return target[prop];
      } }),
    });
    assert.equal(runs, 1);
    assert.equal(got.shared, 'none');
    assert.equal(elapsed, 1000);
    assert.equal(fs.readFileSync(lockName(dir), 'utf8'), '');
  }
});

test('inflight directory is a regular file: both requests run without throwing', (t) => {
  const parent = tempDir(t, 'doflow-inflight-file-');
  const dir = path.join(parent, 'v0');
  fs.writeFileSync(dir, 'regular file');
  let runs = 0;
  for (let n = 0; n < 2; n++) {
    const got = runInflight({ dir, key: KEY, timeoutMs: 10, execute: () => { runs++; return bad(); } });
    assert.equal(got.shared, 'none');
    assert.equal(got.result.status, 7);
  }
  assert.equal(runs, 2);
});

test('sweep removes results older than one hour and expired locks, preserving live locks', (t) => {
  const dir = tempDir(t, 'doflow-inflight-sweep-');
  result(dir, { finishedAt: 1 });
  lock(dir, { deadlineAt: 1001 });
  const live = path.join(dir, `inflight-${'f'.repeat(16)}.lock`);
  fs.writeFileSync(live, JSON.stringify({ v: 1, token: OTHER, pid: process.pid, startedAt: 0, deadlineAt: 9999999 }));
  sweepInflight(dir, { now: () => 3600002 });
  assert.equal(fs.existsSync(resultName(dir)), false);
  assert.equal(fs.existsSync(lockName(dir)), false);
  assert.equal(fs.existsSync(live), true);
});

test('leader releases only its token, even when its lock has been replaced', (t) => {
  const dir = tempDir(t, 'doflow-inflight-owned-');
  const got = runInflight({ dir, key: KEY, timeoutMs: 5000, now: () => 1000, mintToken: () => TOKEN,
    execute: () => { lock(dir, { token: OTHER }); return bad(); } });
  assert.equal(got.result.status, 7);
  assert.equal(JSON.parse(fs.readFileSync(lockName(dir))).token, OTHER);
});

test('leader and sweep share the removal claim: stale sweep cannot unlink a successor', (t) => {
  const dir = tempDir(t, 'doflow-inflight-claim-');
  lock(dir, { deadlineAt: 500 });
  let raced = false;
  const io = new Proxy(fs, { get(target, prop) {
    if (prop === 'writeFileSync') return (file, ...args) => {
      if (String(file).endsWith('.claim') && !raced) {
        raced = true;
        // The other remover acquired this instance's claim first, removed it, and a new
        // leader linked its lock. Our claim fails, so no stale unlink can follow.
        target.writeFileSync(file, '', { flag: 'wx' });
        lock(dir, { token: OTHER, deadlineAt: 50000 });
      }
      return target.writeFileSync(file, ...args);
    };
    return target[prop];
  } });
  let runs = 0;
  const out = runInflight({ dir, key: KEY, timeoutMs: 10, fsImpl: io, now: () => 1000,
    execute: () => { runs++; return good(); } });
  assert.equal(out.shared, 'none');
  assert.equal(runs, 1);
  assert.equal(JSON.parse(fs.readFileSync(lockName(dir))).token, OTHER);
});

for (const call of ['mkdirSync', 'readdirSync', 'writeFileSync', 'linkSync', 'renameSync', 'unlinkSync']) {
  test(`${call} fault falls back to one local execution`, (t) => {
    const dir = tempDir(t, 'doflow-inflight-fault-');
    let runs = 0;
    const io = new Proxy(fs, { get(target, prop) {
      if (prop === call) return () => { throw new Error(call); };
      return target[prop];
    } });
    const out = runInflight({ dir, key: KEY, timeoutMs: 1000, fsImpl: io,
      execute: () => { runs++; return bad(); } });
    assert.equal(runs, 1);
    assert.equal(out.shared, 'none');
    assert.equal(out.result.status, 7);
  });
}

test('mode 0600, atomic link publication and result rename; no tmp files after success', (t) => {
  const dir = tempDir(t, 'doflow-inflight-mode-');
  const out = runInflight({ dir, key: KEY, timeoutMs: 5000, mintToken: () => TOKEN,
    execute: () => { assert.equal(fs.statSync(lockName(dir)).mode & 0o777, 0o600); return good(); } });
  assert.equal(out.shared, 'leader');
  assert.deepEqual(fs.readdirSync(dir), [path.basename(resultName(dir))]);
  assert.equal(fs.statSync(resultName(dir)).mode & 0o777, 0o600);
});

test('unkeyable input and malformed execution/result never create a shared PASS', (t) => {
  const dir = tempDir(t, 'doflow-inflight-invalid-');
  let runs = 0;
  const unkeyed = runInflight({ dir, key: null, timeoutMs: 1, execute: () => { runs++; return bad(); } });
  assert.equal(unkeyed.shared, 'none');
  assert.equal(runs, 1);
  const followed = follow(t, (dir) => result(dir, { result: { status: '0', stdout: '', stderr: '' } }));
  assert.equal(followed.got.shared, 'none');
  assert.equal(followed.runs, 1);
});

test('/tmp and /private/tmp aliases share a check key; all environment keys participate except registry exclusions', (t) => {
  const priorTmp = process.env.TMPDIR;
  let root;
  try { process.env.TMPDIR = '/tmp'; root = tempDir(t, 'doflow-inflight-key-'); }
  finally { if (priorTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = priorTmp; }
  const input = { cwd: root, command: 'true', timeoutMs: 1, head: '1'.repeat(40), tree: 'tree', env: {} };
  const key = checkKey(input);
  const alias = root.replace(/^\/private\/tmp\//, '/tmp/');
  assert.equal(checkKey({ ...input, cwd: alias }), key);
  assert.notEqual(checkKey({ ...input, env: { NODE_OPTIONS: '--no-warnings' } }), key);
  assert.notEqual(checkKey({ ...input, env: { TEST_KEY: '1' } }), key);
  const exclude = loadVerificationRegistry().policy.dedup.envExclude;
  assert.ok(exclude.includes('DOFLOW_RUN_ID'));
  assert.equal(envDigest({ DOFLOW_RUN_ID: 'one' }), envDigest({ DOFLOW_RUN_ID: 'two' }));
});

test('dirty content read faults are unkeyable; a deletion remains keyable', (t) => {
  const root = tempDir(t, 'doflow-inflight-dirty-');
  const io = { statSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
  assert.equal(treeDigest(root, { fsImpl: io, spawnSyncImpl: () => ({ status: 0, stdout: ' M dirty.js\0' }) }), null);
  io.statSync = () => { throw enoent(); };
  assert.match(treeDigest(root, { fsImpl: io, spawnSyncImpl: () => ({ status: 0, stdout: ' D gone.js\0' }) }), /^[0-9a-f]{64}$/);
});

// Execute mutated modules in memory. No production file or test assertion is edited; each
// mutation is shown to fail the same invariant asserted by the positive case above.
function mutated(file, before, after) {
  const Module = require('node:module');
  const filename = path.join(REPO, 'src/runtime/verification', file);
  const source = fs.readFileSync(filename, 'utf8');
  assert.ok(source.includes(before), `mutation target exists: ${before}`);
  const instance = new Module(filename, module);
  instance.filename = filename;
  instance.paths = module.paths;
  instance._compile(Module.stripTypeScriptTypes(source.replace(before, after)), filename);
  return instance.exports;
}
for (const [label, guard] of [
  ['arrival <= finishedAt', 'arrival > record.finishedAt || '],
  ['matching result token', 'record.token !== follower.token || '],
]) {
  test(`negative control: removing ${label} fails the corresponding fallback case`, (t) => {
    const mutant = mutated('inflight.ts', guard, '');
    const dir = tempDir(t, 'doflow-inflight-negative-');
    lock(dir);
    result(dir, label.startsWith('arrival') ? { finishedAt: 999 } : { token: OTHER });
    let runs = 0;
    const out = mutant.runInflight({ dir, key: KEY, timeoutMs: 1000, now: () => 1000,
      execute: () => { runs++; return good(); } });
    assert.throws(() => assert.equal(runs, 1), assert.AssertionError, 'the guarded fallback assertion fails');
    assert.throws(() => assert.equal(out.shared, 'none'), assert.AssertionError, 'the unshared assertion fails');
  });
}

test('negative control: removing owner-token check deletes another leader lock', (t) => {
  const mutant = mutated('inflight.ts', 'current.token === token && ', '');
  const dir = tempDir(t, 'doflow-inflight-negative-owner-');
  mutant.runInflight({ dir, key: KEY, timeoutMs: 1000, now: () => 1000, mintToken: () => TOKEN,
    execute: () => { lock(dir, { token: OTHER }); return bad(); } });
  assert.throws(() => assert.ok(fs.existsSync(lockName(dir))), assert.AssertionError);
});

test('negative control: removing envDigest from the key shares across NODE_OPTIONS and an environment key', (t) => {
  const mutant = mutated('check-key.ts', '    envDig,', '');
  const cwd = tempDir(t, 'doflow-inflight-negative-env-');
  const input = { cwd, head: '1'.repeat(40), tree: 'tree', command: 'true', timeoutMs: 1, env: {} };
  for (const env of [{ NODE_OPTIONS: '--no-warnings' }, { TEST_KEY: 'different' }]) {
    assert.throws(() => assert.notEqual(mutant.checkKey(input), mutant.checkKey({ ...input, env })), assert.AssertionError);
  }
});

test('negative control: removing dirty content hashing misses an uncommitted edit', (t) => {
  const mutant = mutated('check-key.ts', "fileHash = crypto.createHash('sha256').update(content).digest('hex');", "fileHash = '';");
  const root = tempDir(t, 'doflow-inflight-negative-tree-');
  const options = { spawnSyncImpl: () => ({ status: 0, stdout: ' M dirty.js\0' }) };
  const file = path.join(root, 'dirty.js');
  fs.writeFileSync(file, 'one');
  const a = mutant.treeDigest(root, options);
  fs.writeFileSync(file, 'two');
  assert.throws(() => assert.notEqual(mutant.treeDigest(root, options), a), assert.AssertionError);
});

test('ambiguous multiline NAME=VALUE environments fail closed to running unshared', (t) => {
  const cwd = tempDir(t, 'doflow-inflight-multiline-');
  const base = { cwd, command: 'true', timeoutMs: 1, head: '1'.repeat(40), tree: 'tree' };
  // Without the ambiguity guard these two different environments hash to the same raw lines.
  const a = { A: 'one\nB=two' };
  const b = { A: 'one', B: 'two' };
  assert.equal(checkKey({ ...base, env: a }), null);
  assert.match(checkKey({ ...base, env: b }), /^[0-9a-f]{16}$/);
});

test('a temp-name collision runs locally without deleting another owner temp', (t) => {
  const dir = tempDir(t, 'doflow-inflight-temp-collision-');
  const file = path.join(dir, `inflight-${KEY}.${TOKEN}.tmp`);
  fs.writeFileSync(file, 'other owner');
  let runs = 0;
  const out = runInflight({ dir, key: KEY, timeoutMs: 1, mintToken: () => TOKEN,
    execute: () => { runs++; return good(); } });
  assert.equal(out.shared, 'none');
  assert.equal(runs, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), 'other owner');
});

test('dirty rename source paths participate in identity; malformed rename entries are unkeyable', (t) => {
  const root = tempDir(t, 'doflow-inflight-rename-');
  fs.writeFileSync(path.join(root, 'destination.js'), 'identical bytes');
  const digest = (source) => treeDigest(root, {
    spawnSyncImpl: () => ({ status: 0, stdout: `R  destination.js\0${source}\0` }),
  });
  assert.notEqual(digest('source-a.js'), digest('source-b.js'));
  assert.equal(digest(''), null);
});

test('dirty symlinks and submodule/directory entries are unkeyable, never shared on incomplete identity', (t) => {
  const root = tempDir(t, 'doflow-inflight-nonregular-');
  fs.writeFileSync(path.join(root, 'target.js'), 'bytes');
  fs.symlinkSync('target.js', path.join(root, 'link.js'));
  fs.mkdirSync(path.join(root, 'submodule'));
  for (const name of ['link.js', 'submodule']) {
    assert.equal(treeDigest(root, { spawnSyncImpl: () => ({ status: 0, stdout: ` M ${name}\0` }) }), null);
  }
});
