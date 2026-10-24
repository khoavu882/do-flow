'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const seal = require('../../bench/retrieval/lib/seal.ts');
const { tempDir } = require('../helper/tmp.ts');

const PASS = 'correct horse battery staple 123';
const CLASSES = ['exact-lookup', 'conceptual-discovery', 'impact-refactor'];
const taskFile = () => ({
  schemaVersion: 1, snapshotId: 1, split: 'holdout',
  tasks: [
    { id: 'HC-002', class: 'exact-lookup', query: 'secret query text' },
    { id: 'HC-001', class: 'conceptual-discovery', query: 'other secret' },
  ],
});

function keyFile(t, mode = 0o600, body = `${PASS}\nsecond line\n`) {
  const file = path.join(tempDir(t, 'doflow-seal-key-'), 'holdout.key');
  fs.writeFileSync(file, body);
  fs.chmodSync(file, mode);
  return file;
}

function assertNoPassphrase(fn) {
  const chunks = [];
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = (c) => { chunks.push(String(c)); return true; };
  process.stderr.write = (c) => { chunks.push(String(c)); return true; };
  let thrown = '';
  try { fn(); } catch (e) { thrown = `${e.message}\n${e.stack}`; } finally { process.stdout.write = out; process.stderr.write = err; }
  assert.ok(!chunks.join('').includes(PASS), 'passphrase leaked to stdout or stderr');
  assert.ok(!thrown.includes(PASS), 'passphrase leaked into an error');
}

test('canonicalJson sorts keys recursively and has no whitespace', () => {
  assert.equal(seal.canonicalJson({ b: 1, a: { d: [{ y: 1, x: 2 }], c: null } }), '{"a":{"c":null,"d":[{"x":2,"y":1}]},"b":1}');
});

test('key resolution order: --key-file, then the environment, then the default file', (t) => {
  const file = keyFile(t);
  const home = tempDir(t, 'doflow-seal-home-');
  const env = { DOFLOW_HOLDOUT_KEY: 'x'.repeat(24) };
  assert.deepEqual(seal.resolveKey({ keyFile: file, env, home, repoRoot: '/nonexistent-repo' }), { passphrase: PASS, source: 'key-file' });
  assert.deepEqual(seal.resolveKey({ env, home }), { passphrase: 'x'.repeat(24), source: 'env' });
  assert.equal(seal.resolveKey({ env: {}, home, optional: true }), null);
  assert.throws(() => seal.resolveKey({ env: {}, home }), (e) => e instanceof seal.SealError && e.exitCode === 2 && /no holdout key/.test(e.message));
  fs.mkdirSync(path.join(home, '.config', 'doflow'), { recursive: true });
  const def = path.join(home, '.config', 'doflow', 'holdout.key');
  fs.writeFileSync(def, `${PASS}\n`);
  fs.chmodSync(def, 0o600);
  assert.deepEqual(seal.resolveKey({ env: {}, home }), { passphrase: PASS, source: 'default-file' });
});

test('a short environment key, a repo-internal key file and a loose mode are refused with exit 2', (t) => {
  assert.throws(() => seal.resolveKey({ env: { DOFLOW_HOLDOUT_KEY: 'short' }, home: '/nonexistent' }), (e) => e.exitCode === 2 && !e.message.includes('short'));
  const file = keyFile(t);
  assert.throws(() => seal.resolveKey({ keyFile: file, repoRoot: path.dirname(file) }), /outside the repository/);
  if (process.platform !== 'win32') {
    const loose = keyFile(t, 0o644);
    assert.throws(() => seal.resolveKey({ keyFile: loose, repoRoot: '/nonexistent-repo' }), (e) => e.exitCode === 2 && /0600/.test(e.message));
  }
  const warnings = [];
  const ok = seal.resolveKey({ keyFile: keyFile(t, 0o644), repoRoot: '/nonexistent-repo', platform: 'win32', warn: (m) => warnings.push(m) });
  assert.equal(ok.passphrase, PASS);
  assert.equal(warnings.length, 1);
});

test('seal then decrypt round-trips, with the canary inside the plaintext and the digest over the envelope bytes', () => {
  const out = seal.sealTasks({
    taskFile: taskFile(), passphrase: PASS, corpus: 'code', snapshotId: 1, generation: 1,
    sealedBy: 'worker:test', classes: CLASSES, now: new Date('2026-10-12T00:00:00Z'),
  });
  assert.deepEqual(Object.keys(out.envelope), ['format', 'corpus', 'snapshotId', 'generation', 'kdf', 'cipher', 'ivB64', 'aad', 'tagB64', 'ciphertextB64']);
  assert.equal(out.envelope.aad, 'doflow-holdout-v1|code|1|g1');
  assert.deepEqual(out.envelope.kdf, { name: 'scrypt', N: 32768, r: 8, p: 1, maxmem: 67108864, saltB64: out.envelope.kdf.saltB64 });
  assert.equal(Buffer.from(out.envelope.kdf.saltB64, 'base64').length, 16);
  assert.equal(Buffer.from(out.envelope.ivB64, 'base64').length, 12);
  const back = seal.decrypt(JSON.parse(out.envelopeText), PASS, 'p');
  assert.equal(back.taskFile.canary, out.seal.canary);
  assert.equal(back.plaintextSha256, out.seal.plaintextSha256);
  assert.equal(back.taskFile.tasks.length, 2);
  assert.equal(out.seal.ciphertextSha256, seal.sha256Hex(out.envelopeText));
  assert.deepEqual(out.seal.ids, ['HC-001', 'HC-002']);
  assert.deepEqual(out.seal.classCounts, { 'exact-lookup': 1, 'conceptual-discovery': 1, 'impact-refactor': 0 });
  assert.deepEqual(Object.keys(out.seal), ['format', 'corpus', 'snapshotId', 'generation', 'plaintextSha256', 'ciphertextSha256', 'taskCount', 'ids', 'classCounts', 'canary', 'sealedAt', 'sealedBy', 'reuse']);
  assert.equal(out.seal.sealedAt, '2026-10-12T00:00:00.000Z');
  assert.ok(!out.envelopeText.includes('secret query'), 'ciphertext does not carry task text');
});

test('wrong key, flipped ciphertext and a changed AAD fail with the exit-2 message', () => {
  const { envelope } = seal.sealTasks({ taskFile: taskFile(), passphrase: PASS, corpus: 'code', snapshotId: 1, generation: 1, sealedBy: 'w', classes: CLASSES });
  const bad = (e, pass = PASS) => assert.throws(() => seal.decrypt(e, pass, 'holdout/code.g1.sealed.json'),
    (err) => err.exitCode === 2 && err.message === 'holdout key does not decrypt holdout/code.g1.sealed.json');
  bad(envelope, 'another passphrase that is long');
  const ct = Buffer.from(envelope.ciphertextB64, 'base64');
  ct[0] ^= 1;
  bad({ ...envelope, ciphertextB64: ct.toString('base64') });
  bad({ ...envelope, aad: 'doflow-holdout-v1|code|1|g2' });
  assert.throws(() => seal.decrypt({ format: 'nope' }, PASS), /not a holdout envelope/);
});

test('generations count up from the seal digests on disk and files are written next to each other', (t) => {
  const dir = path.join(tempDir(t, 'doflow-seal-gen-'), 'holdout');
  assert.equal(seal.nextGeneration(dir, 'code'), 1);
  const g1 = seal.sealTasks({ taskFile: taskFile(), passphrase: PASS, corpus: 'code', snapshotId: 1, generation: 1, sealedBy: 'w', classes: CLASSES });
  const paths = seal.writeSealed({ dir, corpus: 'code', generation: 1, envelopeText: g1.envelopeText, sealText: g1.sealText });
  assert.equal(path.basename(paths.envelopeFile), 'code.g1.sealed.json');
  assert.equal(path.basename(paths.sealFile), 'code.g1.seal.json');
  assert.equal(seal.nextGeneration(dir, 'code'), 2);
  assert.equal(seal.nextGeneration(dir, 'guidance'), 1);
  assert.equal(seal.readSeal(dir, 'code', 1).ciphertextSha256, seal.sha256Hex(fs.readFileSync(paths.envelopeFile)));
  assert.equal(seal.decrypt(seal.readEnvelope(dir, 'code', 1), PASS).taskFile.tasks.length, 2);
});

test('no stdout, stderr or thrown message contains the passphrase', (t) => {
  const file = keyFile(t);
  assertNoPassphrase(() => {
    seal.resolveKey({ keyFile: file, repoRoot: '/nonexistent-repo' });
    const out = seal.sealTasks({ taskFile: taskFile(), passphrase: PASS, corpus: 'code', snapshotId: 1, generation: 1, sealedBy: 'w', classes: CLASSES });
    seal.decrypt(JSON.parse(out.envelopeText), PASS);
    seal.decrypt(JSON.parse(out.envelopeText), `${PASS} wrong`);
  });
  assertNoPassphrase(() => seal.resolveKey({ keyFile: keyFile(t, 0o644, `${PASS}\n`), repoRoot: '/nonexistent-repo' }));
});
