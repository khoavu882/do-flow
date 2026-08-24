'use strict';

// Content-addressed object store. Objects are immutable blobs keyed by
// their sha256 digest; writes are therefore idempotent and verification is intrinsic — recomputing
// a stored object's digest either matches its address or the store is corrupt. This module knows
// nothing about harnesses or lifecycles; callers decide what an object means. Layout mirrors git's
// fan-out: <root>/objects/<aa>/<remaining hex>, which keeps directories small without a database.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

function storeRoot({ scope, projectRoot = '.', homeDir = os.homedir() }) {
  if (scope !== 'project' && scope !== 'global') throw new Error(`Invalid store scope: '${scope}'`);
  const base = scope === 'project' ? path.resolve(projectRoot) : path.resolve(homeDir);
  return path.join(base, '.doflow', 'store');
}

function digestOf(content) {
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}

function parseDigest(digest) {
  const match = /^sha256:([0-9a-f]{64})$/.exec(String(digest ?? ''));
  if (!match) throw new Error(`Invalid object digest: '${digest}'`);
  return match[1];
}

function objectPath(root, digest) {
  const hex = parseDigest(digest);
  return path.join(storePath(root), 'objects', hex.slice(0, 2), hex.slice(2));
}

function storePath(root) { return path.resolve(root); }

/** Store a blob under its digest. Idempotent: an existing object with the same digest is left
 * untouched, because equal digests imply equal bytes. Returns {digest, size}. */
function putObject(root, content, { fsImpl = fs } = {}) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  const digest = digestOf(buffer);
  const target = objectPath(root, digest);
  if (!fsImpl.existsSync(target)) {
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
    try {
      fsImpl.writeFileSync(tmp, buffer, { flag: 'wx' });
      fsImpl.renameSync(tmp, target);
    } finally {
      if (fsImpl.existsSync(tmp)) fsImpl.rmSync(tmp, { force: true });
    }
  }
  return { digest, size: buffer.length };
}

function getObject(root, digest, { fsImpl = fs } = {}) {
  const target = objectPath(root, digest);
  if (!fsImpl.existsSync(target)) return null;
  return fsImpl.readFileSync(target);
}

/** Read an object as UTF-8 text, or null when absent. */
function getTextObject(root, digest, options = {}) {
  const buffer = getObject(root, digest, options);
  return buffer === null ? null : buffer.toString('utf8');
}

function hasObject(root, digest, { fsImpl = fs } = {}) {
  return fsImpl.existsSync(objectPath(root, digest));
}

/** Recompute a stored object's digest and compare against its address. Returns
 * {ok:true, digest} or {ok:false, reason:'missing'|'corrupt', digest, actualDigest}. */
function verifyObject(root, digest, { fsImpl = fs } = {}) {
  let buffer;
  try { buffer = getObject(root, digest, { fsImpl }); } catch { buffer = null; }
  if (buffer === null) return { ok: false, reason: 'missing', digest, actualDigest: null };
  const actual = digestOf(buffer);
  return actual === digest ? { ok: true, digest } : { ok: false, reason: 'corrupt', digest, actualDigest: actual };
}

module.exports = {
  storeRoot, digestOf, parseDigest, objectPath,
  putObject, getObject, getTextObject, hasObject, verifyObject,
};
