'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { lookupReuse, storeReuse, reuseDir } = require('../../src/runtime/verification/reuse.ts');

const KEY = '0123456789abcdef';
const DIGEST = 'a'.repeat(64);
const REF = 'b'.repeat(32);
const NOW = 1792500000000;
const MAX_AGE = 1000;
const UID = typeof process.getuid === 'function' ? process.getuid() : 0;

function goodRecord(overrides = {}) {
  return {
    v: 1,
    key: KEY,
    payloadDigest: DIGEST,
    ref: REF,
    recordedAt: NOW,
    level: 'L2',
    result: { status: 'PASS', exitCode: 0, stdout: 'ok', stderr: '', truncated: false, tests: 12, testsFailed: 0 },
    ...overrides,
  };
}

function recordFile(dir, key = KEY) { return path.join(dir, `reuse-${key}.json`); }
function writeRecord(dir, value, mode = 0o600, key = KEY) {
  fs.mkdirSync(dir, { recursive: true });
  const file = recordFile(dir, key);
  fs.writeFileSync(file, JSON.stringify(value), { mode });
  fs.chmodSync(file, mode);
  return file;
}

function ioWith(overrides = {}) {
  return new Proxy(fs, {
    get(target, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property];
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function lookup(dir, options = {}) {
  return lookupReuse({ dir, key: KEY, payloadDigest: DIGEST, maxAgeMs: MAX_AGE, now: () => NOW, fsImpl: fs, uid: UID, ...options });
}

function mutatedReuse(before, after) {
  const filename = path.resolve(__dirname, '../../src/runtime/verification/reuse.ts');
  const source = fs.readFileSync(filename, 'utf8');
  assert.ok(source.includes(before), `mutation target exists: ${before}`);
  const instance = new Module(filename, module);
  instance.filename = filename;
  instance.paths = module.paths;
  instance._compile(Module.stripTypeScriptTypes(source.replace(before, after)), filename);
  return instance.exports;
}

test('lookup returns absent without creating a path and refuses unsafe keys before filesystem access', (t) => {
  const dir = path.join(tempDir(t, 'doflow-reuse-'), 'missing');
  assert.deepEqual(lookup(dir), { hit: false, reason: 'absent' });
  assert.equal(fs.existsSync(dir), false);

  const badFs = ioWith({ lstatSync: () => { throw new Error('must not touch a path'); } });
  assert.deepEqual(lookupReuse({ dir, key: '../outside', payloadDigest: DIGEST, maxAgeMs: MAX_AGE, now: () => NOW, fsImpl: badFs, uid: UID }), { hit: false, reason: 'invalid' });
  assert.deepEqual(lookupReuse(null), { hit: false, reason: 'invalid' });
  assert.deepEqual(storeReuse(null), { stored: false, ref: null });
});

test('lookup accepts the exact maximum age boundary', (t) => {
  const dir = tempDir(t, 'doflow-reuse-');
  writeRecord(dir, goodRecord({ recordedAt: NOW - MAX_AGE }));
  const out = lookup(dir);
  assert.equal(out.hit, true);
  assert.deepEqual(out.record, goodRecord({ recordedAt: NOW - MAX_AGE }));
});

test('lookup returns invalid for unknown keys, FAIL, non-zero exit, and wrong types', (t) => {
  const dir = tempDir(t, 'doflow-reuse-');
  const cases = [
    ['unknown top-level key', (record) => { record.extra = true; }],
    ['unknown result key', (record) => { record.result.extra = true; }],
    ['FAIL status', (record) => { record.result.status = 'FAIL'; }],
    ['non-zero exit', (record) => { record.result.exitCode = 1; }],
    ['wrong stdout type', (record) => { record.result.stdout = 1; }],
    ['wrong truncated type', (record) => { record.result.truncated = 0; }],
    ['wrong optional count type', (record) => { record.result.tests = '12'; }],
    ['oversized excerpt', (record) => { record.result.stderr = 'x'.repeat(2201); }],
  ];
  for (const [label, change] of cases) {
    const record = goodRecord();
    change(record);
    writeRecord(dir, record);
    assert.deepEqual(lookup(dir), { hit: false, reason: 'invalid' }, label);
  }
});

test('lookup permits tests and testsFailed to be omitted or null', (t) => {
  const dir = tempDir(t, 'doflow-reuse-');
  const record = goodRecord();
  delete record.result.tests;
  delete record.result.testsFailed;
  writeRecord(dir, record);
  assert.equal(lookup(dir).hit, true);

  record.result.tests = null;
  record.result.testsFailed = null;
  writeRecord(dir, record);
  assert.equal(lookup(dir).hit, true);
});

test('lookup distinguishes digest mismatch, future timestamps, and stale records', (t) => {
  const dir = tempDir(t, 'doflow-reuse-');
  writeRecord(dir, goodRecord({ payloadDigest: 'c'.repeat(64) }));
  assert.deepEqual(lookup(dir), { hit: false, reason: 'digest-mismatch' });

  writeRecord(dir, goodRecord({ recordedAt: NOW + 1 }));
  assert.deepEqual(lookup(dir), { hit: false, reason: 'future' });

  writeRecord(dir, goodRecord({ recordedAt: NOW - MAX_AGE - 1 }));
  assert.deepEqual(lookup(dir), { hit: false, reason: 'stale' });
});

test('lookup rejects symlinks, group-writable files, and records owned by another uid', (t) => {
  const dir = tempDir(t, 'doflow-reuse-');
  const source = writeRecord(path.join(dir, 'target'), goodRecord());
  const links = path.join(dir, 'links');
  fs.mkdirSync(links);
  fs.symlinkSync(source, recordFile(links));
  assert.deepEqual(lookup(links), { hit: false, reason: 'untrusted' });

  fs.chmodSync(source, 0o620);
  assert.deepEqual(lookup(path.dirname(source)), { hit: false, reason: 'untrusted' });
  fs.chmodSync(source, 0o600);
  assert.deepEqual(lookup(path.dirname(source), { uid: UID + 1 }), { hit: false, reason: 'untrusted' });
});

test('lookup read errors return fault and never escape', (t) => {
  const dir = tempDir(t, 'doflow-reuse-');
  writeRecord(dir, goodRecord());
  const fsImpl = ioWith({ readFileSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } });
  assert.deepEqual(lookup(dir, { fsImpl }), { hit: false, reason: 'fault' });
});

test('store refuses FAIL, non-zero exit, and malformed keys without writing', (t) => {
  const dir = path.join(tempDir(t, 'doflow-reuse-'), 'store');
  const base = { dir, key: KEY, payloadDigest: DIGEST, level: 'L2', now: () => NOW, fsImpl: fs, mintRef: () => REF };
  for (const result of [
    { status: 'FAIL', exitCode: 1, stdout: '', stderr: '', truncated: false },
    { status: 'PASS', exitCode: 1, stdout: '', stderr: '', truncated: false },
  ]) assert.deepEqual(storeReuse({ ...base, result }), { stored: false, ref: null });
  assert.deepEqual(storeReuse({ ...base, key: '../bad', result: { status: 'PASS', exitCode: 0, stdout: '', stderr: '', truncated: false } }), { stored: false, ref: null });
  assert.equal(fs.existsSync(dir), false);
});

test('store writes a truncated owner-only record atomically into a 0700 directory', (t) => {
  const dir = path.join(tempDir(t, 'doflow-reuse-'), 'store');
  const writes = [];
  const renames = [];
  const fsImpl = ioWith({
    writeFileSync: (file, data, options) => { writes.push({ file, options }); return fs.writeFileSync(file, data, options); },
    renameSync: (from, to) => { renames.push([from, to]); return fs.renameSync(from, to); },
  });
  const result = { status: 'PASS', exitCode: 0, stdout: 's'.repeat(2205), stderr: 'e'.repeat(2203), truncated: false, tests: 4393, testsFailed: 0 };
  assert.deepEqual(storeReuse({ dir, key: KEY, payloadDigest: DIGEST, level: 'L2', result, now: () => NOW, fsImpl, mintRef: () => REF }), { stored: true, ref: REF });
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const finalFile = recordFile(dir);
  assert.equal(fs.statSync(finalFile).mode & 0o777, 0o600);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.flag, 'wx');
  assert.equal(writes[0].options.mode, 0o600);
  assert.match(path.basename(writes[0].file), new RegExp(`^reuse-${KEY}\\.${REF}\\.tmp$`));
  assert.deepEqual(renames, [[writes[0].file, finalFile]]);
  assert.deepEqual(fs.readdirSync(dir), [`reuse-${KEY}.json`]);
  const record = JSON.parse(fs.readFileSync(finalFile, 'utf8'));
  assert.deepEqual(Object.keys(record), ['v', 'key', 'payloadDigest', 'ref', 'recordedAt', 'level', 'result']);
  assert.equal(record.result.stdout, 's'.repeat(2200));
  assert.equal(record.result.stderr, 'e'.repeat(2200));
  assert.equal(record.result.truncated, true);
  assert.equal(record.result.tests, 4393);
  assert.equal(record.result.testsFailed, 0);
});

test('store replaces an older record for the same key', (t) => {
  const dir = tempDir(t, 'doflow-reuse-');
  writeRecord(dir, goodRecord({ ref: 'c'.repeat(32), result: { ...goodRecord().result, stdout: 'old' } }));
  assert.deepEqual(storeReuse({ dir, key: KEY, payloadDigest: DIGEST, level: 'L1', result: { status: 'PASS', exitCode: 0, stdout: 'new', stderr: '', truncated: false }, now: () => NOW + 1, fsImpl: fs, mintRef: () => REF }), { stored: true, ref: REF });
  const replaced = JSON.parse(fs.readFileSync(recordFile(dir), 'utf8'));
  assert.equal(replaced.ref, REF);
  assert.equal(replaced.result.stdout, 'new');
  assert.equal(replaced.recordedAt, NOW + 1);
});

test('store returns stored false for injected mkdir, write, rename, clock, and ref faults', (t) => {
  const root = tempDir(t, 'doflow-reuse-fault-');
  const result = { status: 'PASS', exitCode: 0, stdout: '', stderr: '', truncated: false };
  const base = { key: KEY, payloadDigest: DIGEST, level: 'L2', result, mintRef: () => REF };
  const failures = [
    ['mkdir', (dir) => ioWith({ mkdirSync: () => { throw new Error('mkdir fault'); } }), () => NOW, () => REF],
    ['chmod', (dir) => ioWith({ chmodSync: () => { throw new Error('chmod fault'); } }), () => NOW, () => REF],
    ['write', (dir) => ioWith({ writeFileSync: () => { throw new Error('write fault'); } }), () => NOW, () => REF],
    ['rename', (dir) => ioWith({ renameSync: () => { throw new Error('rename fault'); } }), () => NOW, () => REF],
    ['clock', () => fs, () => { throw new Error('clock fault'); }, () => REF],
    ['ref', () => fs, () => NOW, () => { throw new Error('ref fault'); }],
  ];
  for (const [label, makeFs, now, mintRef] of failures) {
    const dir = path.join(root, label);
    assert.doesNotThrow(() => assert.deepEqual(storeReuse({ ...base, dir, now, mintRef, fsImpl: makeFs(dir) }), { stored: false, ref: null }), label);
    assert.ok(!fs.existsSync(dir) || fs.readdirSync(dir).length === 0, `${label} leaves no owned temp`);
  }
});

test('reuseDir resolves the declared verification-reuse store from the storage registry', (t) => {
  const projectRoot = tempDir(t, 'doflow-reuse-resolver-');
  assert.equal(reuseDir({ projectRoot, fsImpl: fs }), path.join(projectRoot, '.doflow', 'state', 'verification', 'reuse'));
});

test('negative control: removing the group/other mode check accepts a group-writable record', (t) => {
  const mutant = mutatedReuse("    if ((stat.mode & 0o077) !== 0) return { hit: false, reason: 'untrusted' };\n", '');
  const dir = tempDir(t, 'doflow-reuse-negative-mode-');
  const file = writeRecord(dir, goodRecord());
  fs.chmodSync(file, 0o620);
  const out = mutant.lookupReuse({ dir, key: KEY, payloadDigest: DIGEST, maxAgeMs: MAX_AGE, now: () => NOW, fsImpl: fs, uid: UID });
  assert.equal(out.hit, true);
  assert.throws(() => assert.equal(out.reason, 'untrusted'), assert.AssertionError);
});

test('negative control: comparing only key accepts a different payload digest', (t) => {
  const mutant = mutatedReuse("  if (record.key !== key || record.payloadDigest !== payloadDigest) return { hit: false, reason: 'digest-mismatch' };\n", "  if (record.key !== key) return { hit: false, reason: 'digest-mismatch' };\n");
  const dir = tempDir(t, 'doflow-reuse-negative-digest-');
  writeRecord(dir, goodRecord({ payloadDigest: 'c'.repeat(64) }));
  const out = mutant.lookupReuse({ dir, key: KEY, payloadDigest: DIGEST, maxAgeMs: MAX_AGE, now: () => NOW, fsImpl: fs, uid: UID });
  assert.equal(out.hit, true);
  assert.throws(() => assert.equal(out.reason, 'digest-mismatch'), assert.AssertionError);
});
