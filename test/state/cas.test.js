'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { storeRoot, digestOf, parseDigest, objectPath, putObject, getObject, getTextObject, hasObject, verifyObject } = require('../../src/state/cas');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cas-')); }

test('store roots mirror state-root neutrality per scope', () => {
  const home = scratch();
  const project = scratch();
  assert.equal(storeRoot({ scope: 'project', projectRoot: project }), path.join(project, '.doflow', 'store'));
  assert.equal(storeRoot({ scope: 'global', homeDir: home }), path.join(home, '.doflow', 'store'));
  assert.throws(() => storeRoot({ scope: 'other', projectRoot: project }), /Invalid store scope/);
});

test('digests are strict sha256 addresses and map to a fan-out path', () => {
  const hex = 'a'.repeat(64);
  const digest = `sha256:${hex}`;
  assert.equal(parseDigest(digest), hex);
  assert.throws(() => parseDigest('sha256:zz'), /Invalid object digest/);
  assert.throws(() => objectPath('/tmp/x', 'md5:abc'), /Invalid object digest/);
  assert.ok(objectPath('/tmp/x', digest).includes(path.join('aa', 'a'.repeat(62))));
});

test('put/get round-trips bytes and repeats of the same content are idempotent single objects', () => {
  const root = scratch();
  const body = JSON.stringify({ hello: 'world' });
  const first = putObject(root, body);
  assert.equal(first.size, Buffer.byteLength(body));
  assert.equal(first.digest, digestOf(body));
  assert.deepEqual(getObject(root, first.digest), Buffer.from(body));
  assert.equal(getTextObject(root, first.digest), body);

  // Same bytes again: no second object, no rewrite churn beyond the one file.
  const before = fs.statSync(objectPath(root, first.digest));
  const second = putObject(root, body);
  const after = fs.statSync(objectPath(root, first.digest));
  assert.deepEqual(second, first);
  assert.equal(before.mtimeMs, after.mtimeMs, 'existing object must not be rewritten');
  const blobs = [];
  const walk = (dir) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) entry.isDirectory() ? walk(path.join(dir, entry.name)) : blobs.push(entry.name); };
  walk(root);
  assert.equal(blobs.length, 1, 'equal content must share exactly one stored object');
});

test('verify distinguishes intact, corrupt, and missing objects', () => {
  const root = scratch();
  const { digest } = putObject(root, 'payload');
  assert.deepEqual(verifyObject(root, digest), { ok: true, digest });
  const target = objectPath(root, digest);
  fs.writeFileSync(target, 'tampered');
  const verdict = verifyObject(root, digest);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'corrupt');
  assert.notEqual(verdict.actualDigest, null);
  assert.equal(verifyObject(root, `sha256:${'b'.repeat(64)}`).reason, 'missing');
  assert.equal(hasObject(root, `sha256:${'b'.repeat(64)}`), false);
});
