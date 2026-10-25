'use strict';

/**
 * Package tree rules and digests (122 IC-005). `walkTree` applies the tree rules and returns IC-004 findings
 * beside the regular files it saw; `contentDigest` hashes a clean tree; `capabilityDigest` hashes what the
 * manifest lets the package do. Nothing here writes. Per-file hashing is sha256 hex of the bytes, as in
 * `src/adapters/copy-tree.ts`; that module is not required here because it pulls in the adapter layer.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const SEGMENT_GRAMMAR = '^[A-Za-z0-9_][A-Za-z0-9._-]*$ (no leading dot)';
const CONTENT_HEADER = 'doflow-package-content-v1\n';
const CAPABILITY_HEADER = 'doflow-package-capability-v1\n';

const sha256 = (data: any): string => crypto.createHash('sha256').update(data).digest('hex');

type TreeFile = { rel: string; abs: string; size: number; exec: boolean };

/** Key-sorted JSON, the canonical form of `fingerprint` in `src/state/index.ts`. */
function canonicalJson(value: any): string {
  const stable = (v: any): any => {
    if (Array.isArray(v)) return v.map(stable);
    if (!v || typeof v !== 'object') return v;
    return Object.fromEntries(Object.keys(v).sort().map((key) => [key, stable(v[key])]));
  };
  return JSON.stringify(stable(value));
}

function compareBytes(a: string, b: string): number {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

/**
 * Walk `root` under the IC-005 tree rules. Never throws on content: a rule break is a finding, and a symlink
 * or special file is reported and not entered. `files` lists the regular files in ascending bytewise order of
 * their POSIX relative path. `limits` is `{ files, bytes, fileBytes, pathLength }`.
 */
function walkTree(root: string, limits: any, { packageId = null, fsImpl = fs }: any = {}): { files: TreeFile[]; findings: any[] } {
  const findings: any[] = [];
  const files: TreeFile[] = [];
  const add = (field: string, code: string, message: string, allowed: any) =>
    findings.push({ package: packageId, field, code, severity: 'error', message, allowed });
  let total = 0;
  let stop = false;

  const visit = (dir: string, relDir: string): void => {
    let entries: any[];
    try {
      entries = fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch (error: any) {
      add(`tree.${relDir || '.'}`, 'file-missing', `cannot read directory: ${error.message}`, 'a readable directory');
      return;
    }
    entries.sort((a, b) => compareBytes(a.name, b.name));
    for (const entry of entries) {
      if (stop) return;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      const field = `tree.${rel}`;
      if (entry.isSymbolicLink()) { add(field, 'symlink', `${rel} is a symbolic link`, 'regular files and directories only'); continue; }
      if (!entry.isFile() && !entry.isDirectory()) {
        add(field, 'special-file', `${rel} is a device, socket or FIFO`, 'regular files and directories only');
        continue;
      }
      if (!SEGMENT.test(entry.name)) {
        add(field, 'bad-type', `${rel}: segment '${entry.name}' breaks the path grammar`, SEGMENT_GRAMMAR);
        continue;
      }
      if (rel.length > limits.pathLength) {
        add(field, 'too-large', `${rel} is ${rel.length} characters long`, `a relative path of at most ${limits.pathLength} characters`);
        continue;
      }
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { visit(abs, rel); continue; }
      if (files.length >= limits.files) {
        add('tree', 'too-many-files', `the package holds more than ${limits.files} files`, `at most ${limits.files} files`);
        stop = true;
        return;
      }
      const stat = fsImpl.lstatSync(abs);
      if (stat.size > limits.fileBytes) {
        add(field, 'too-large', `${rel} is ${stat.size} bytes`, `at most ${limits.fileBytes} bytes per file`);
      }
      total += stat.size;
      files.push({ rel, abs, size: stat.size, exec: (stat.mode & 0o111) !== 0 });
    }
  };
  visit(root, '');
  if (total > limits.bytes) add('tree', 'too-large', `the package holds ${total} bytes`, `at most ${limits.bytes} bytes in total`);
  files.sort((a, b) => compareBytes(a.rel, b.rel));
  return { files, findings };
}

/** Content digest of a walked file list (IC-005): header, then `<path>\0<x>\0<sha256>\n` per file in bytewise path order. */
function digestFiles(files: TreeFile[], fsImpl: any = fs): string {
  const hash = crypto.createHash('sha256').update(CONTENT_HEADER);
  for (const file of [...files].sort((a, b) => compareBytes(a.rel, b.rel))) {
    hash.update(`${file.rel}\0${file.exec ? '1' : '0'}\0${sha256(fsImpl.readFileSync(file.abs))}\n`);
  }
  return hash.digest('hex');
}

/** `contentDigest(dir)`: the IC-005 digest of a package directory. Throws when the tree breaks a tree rule. */
function contentDigest(dir: string, { limits = { files: 512, bytes: 4194304, fileBytes: 262144, pathLength: 200 }, fsImpl = fs }: any = {}): string {
  const { files, findings } = walkTree(dir, limits, { fsImpl });
  if (findings.length > 0) throw new Error(`cannot digest ${dir}: ${findings.map((f) => `${f.code} ${f.field}`).join(', ')}`);
  return digestFiles(files, fsImpl);
}

/**
 * Capability digest (IC-005): what the manifest lets the package do. `tiers` maps a point id to its tier. A
 * contribution's `qualifiedId` is always `<package id>.<local id>`; `programs` are passed through sorted by id
 * (the IC-018 normalization arrives with the first executable point).
 */
function capabilityDigest(manifest: any, { trustPolicyVersion, tiers }: { trustPolicyVersion: number; tiers: Record<string, string> }): string {
  const contributions = (manifest.contributions ?? []).map((c: any) => ({
    point: c.point, version: c.version, qualifiedId: `${manifest.id}.${c.id}`, tier: tiers[c.point] ?? null,
  })).sort((a: any, b: any) => compareBytes(a.point, b.point) || compareBytes(a.qualifiedId, b.qualifiedId));
  const programs = [...(manifest.programs ?? [])].sort((a: any, b: any) => compareBytes(String(a.id), String(b.id)));
  const body = canonicalJson({
    trustPolicyVersion, id: manifest.id, version: manifest.version, doflow: manifest.doflow, contributions, programs,
  });
  return sha256(CAPABILITY_HEADER + body);
}

module.exports = { walkTree, digestFiles, contentDigest, capabilityDigest, canonicalJson, SEGMENT, SEGMENT_GRAMMAR };
