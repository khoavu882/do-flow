'use strict';

// FU-b2cb9e: a global antigravity install retires ~/.gemini/bin/doflow-run, the locator the retired
// Gemini adapter wrote before it moved to ~/.gemini/config/bin (f7928c48), when its bytes equal a
// shipped legacy shim. Any other content, a link, or an absent file is left alone. The legacy bytes
// come from git history, so those cases skip in a clone that lacks it. Every run uses a scratch HOME.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadRegistry } = require('../../../src/registry/index.ts');
const { buildAdapterRegistry } = require('../../../src/cli/shared.ts');
const { stateRoot, readLedger } = require('../../../src/state/index.ts');
const { planLifecycle, applyLifecycle } = require('../../../src/lifecycle/index.ts');
const { tempDir } = require('../../helper/tmp.ts');

const REPO = path.resolve(__dirname, '..', '..', '..');
// blob -> sha256 of the locator shims e575b259, 1fbab132 and a3c15cdb shipped to ~/.gemini/bin.
const LEGACY = { '22340592c44f9f5a47240f9031a416bc7678d4e7': 'bee62b0a97b9365fba95541a2d2979b1dd57f63a13e0d7bcc6077147664008a4',
  '34bb6c6c8e4b759291ac487a61ef8be60a19f6b7': '66530de094c6ec22bda9219b19f9c02e6a076068aa671b5eb6dff463d06f966a',
  '344ebd524df79f0e319b578151c69ef71e2c7985': '9b5cae2a84d7486deff8ecabe477c06af5802d77af6efa72476897f08b8864d6' };
// f35da05d's shim came after the move to ~/.gemini/config/bin, so it was never written to ~/.gemini/bin.
const POST_MOVE_BLOB = 'f5113436e76da8a2e1e0e93f38617160207d46c6';

function blob(sha1: string): Buffer | null {
  try { return execFileSync('git', ['cat-file', 'blob', sha1], { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 20 }); } catch { return null; }
}
const sha256 = (bytes: Buffer | string) => crypto.createHash('sha256').update(bytes).digest('hex');
const legacyBlobs = (): [string, Buffer][] => Object.keys(LEGACY).map((sha1): [string, Buffer | null] => [sha1, blob(sha1)])
  .filter((pair): pair is [string, Buffer] => pair[1] !== null);

function setup(t: any) {
  const home = tempDir(t, 'doflow-agy-legacy-shim-');
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = savedHome; });
  const registry = loadRegistry({ repoRoot: REPO });
  const adapters = buildAdapterRegistry();
  const state = stateRoot({ scope: 'global', homeDir: home });
  const legacy = path.join(home, '.gemini', 'bin', 'doflow-run');
  const current = path.join(home, '.gemini', 'config', 'bin', 'doflow-run');
  const install = () => {
    const plan = planLifecycle({ registry, adapters, scope: 'global', scopeRoot: home, targets: ['antigravity'], ledger: readLedger(state) ?? undefined,
      context: { repoRoot: REPO, projectRoot: home, homeDir: home, sourceVersion: 'test', operation: 'update' } });
    assert.deepEqual(plan.conflicts, []);
    if (plan.changes.length) applyLifecycle({ plan, registry, adapters, stateRoot: state, ledger: plan.ledger, hasBashCapableShellFn: () => true });
    return plan;
  };
  const plant = (bytes: Buffer | string) => { fs.mkdirSync(path.dirname(legacy), { recursive: true }); fs.writeFileSync(legacy, bytes); };
  const tombstones = () => (readLedger(state)?.tombstones ?? []).filter((entry: any) => entry.fromTarget === legacy);
  return { home, legacy, current, install, plant, tombstones };
}

test('the recorded legacy hashes are those of the git blobs, and the post-move shim is not among them', (t) => {
  const blobs = legacyBlobs();
  if (!blobs.length) return t.skip('git history unavailable');
  for (const [sha1, bytes] of blobs) assert.equal(sha256(bytes), LEGACY[sha1 as keyof typeof LEGACY], sha1);
  const post = blob(POST_MOVE_BLOB);
  if (post) assert.ok(!Object.values(LEGACY).includes(sha256(post)));
});

test('a byte-identical legacy shim is removed and journaled as a swept tombstone; a second install is a no-op', (t) => {
  const blobs = legacyBlobs();
  if (!blobs.length) return t.skip('git history unavailable');
  for (const [sha1, bytes] of blobs) {
    const env = setup(t);
    env.plant(bytes);
    const plan = env.install();
    const change = plan.changes.find((item: any) => item.target === env.legacy);
    assert.equal(change?.operation, 'remove', sha1);
    assert.ok(!fs.existsSync(env.legacy), `${sha1}: legacy shim removed`);
    assert.ok(!fs.existsSync(path.dirname(env.legacy)), `${sha1}: emptied ~/.gemini/bin pruned`);
    assert.ok(fs.existsSync(env.current), `${sha1}: current shim in place`);
    const [entry, ...rest] = env.tombstones();
    assert.deepEqual(rest, []);
    assert.equal(entry.harness, 'antigravity');
    assert.equal(entry.toTarget, env.current);
    assert.equal(entry.fingerprint, LEGACY[sha1 as keyof typeof LEGACY]);
    assert.ok(entry.sweptAt);
    const again = env.install();
    assert.deepEqual(again.changes, [], `${sha1}: nothing left to do`);
    assert.equal(env.tombstones().length, 1, `${sha1}: not journaled twice`);
  }
});

test('a legacy shim the person edited is left untouched and not journaled', (t) => {
  const [first] = legacyBlobs();
  if (!first) return t.skip('git history unavailable');
  const env = setup(t);
  const edited = Buffer.concat([first[1], Buffer.from('# mine\n')]);
  env.plant(edited);
  const plan = env.install();
  assert.ok(!plan.changes.some((item: any) => item.target === env.legacy));
  assert.deepEqual(fs.readFileSync(env.legacy), edited);
  assert.deepEqual(env.tombstones(), []);
  env.install();
  assert.deepEqual(fs.readFileSync(env.legacy), edited);
});

test('the post-move shim at ~/.gemini/bin is not a legacy blob and is left alone', (t) => {
  const post = blob(POST_MOVE_BLOB);
  if (!post) return t.skip('git history unavailable');
  const env = setup(t);
  env.plant(post);
  env.install();
  assert.deepEqual(fs.readFileSync(env.legacy), post);
});

test('a symlink or a directory at the legacy path is left untouched, even when the link points at legacy bytes', (t) => {
  const [first] = legacyBlobs();
  if (!first) return t.skip('git history unavailable');
  const env = setup(t);
  const elsewhere = path.join(env.home, 'dotfiles-doflow-run');
  fs.writeFileSync(elsewhere, first[1]);
  fs.mkdirSync(path.dirname(env.legacy), { recursive: true });
  fs.symlinkSync(elsewhere, env.legacy);
  env.install();
  assert.ok(fs.lstatSync(env.legacy).isSymbolicLink(), 'link kept');
  assert.deepEqual(fs.readFileSync(elsewhere), first[1], 'link target kept');
  assert.deepEqual(env.tombstones(), []);

  const dirEnv = setup(t);
  fs.mkdirSync(dirEnv.legacy, { recursive: true });
  dirEnv.install();
  assert.ok(fs.statSync(dirEnv.legacy).isDirectory());
  assert.deepEqual(dirEnv.tombstones(), []);
});

test('an absent legacy path plans nothing and a repeated install stays idempotent', (t) => {
  const env = setup(t);
  const first = env.install();
  assert.ok(!first.changes.some((item: any) => item.target === env.legacy));
  assert.ok(!fs.existsSync(path.dirname(env.legacy)));
  assert.deepEqual(env.tombstones(), []);
  assert.deepEqual(env.install().changes, []);
  assert.deepEqual(env.tombstones(), []);
});
