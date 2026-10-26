'use strict';

/**
 * Pin and fetch IC-022 git sources by commit and npm sources by exact version plus SHA-512
 * integrity using argv arrays with `shell: false`. Git hooks are off, `protocol.file.allow=never`,
 * and `GIT_TERMINAL_PROMPT=0`. npm pack always receives `--ignore-scripts`; UNVERIFIED: whether
 * `npm pack` of a registry spec runs lifecycle scripts. Fetching uses no checkout or submodules;
 * DoFlow writes no file and tools write only inside the caller's empty staging directory.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { loadPoints } = require('./points.ts');
const { readTar } = require('./tar.ts');
const { parseSemVer, compareSemVer } = require('../../helper/semver.ts');
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
// The location and repository variables of `git rev-parse --local-env-vars` (git 2.50), plus GIT_ALLOW_PROTOCOL,
// which overrides `-c protocol.file.allow=never`. Hardcoded so no git process is spawned to compute it.
// GIT_CONFIG, GIT_CONFIG_PARAMETERS and GIT_CONFIG_COUNT (with its KEY_n/VALUE_n pairs) are left out on purpose:
// CI injects auth headers and `insteadOf` rewrites for private package hosts through them, and the `-c` guard
// below still wins over them.
const GIT_LOCATION_KEYS = Object.freeze([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_OBJECT_DIRECTORY', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE', 'GIT_INDEX_FILE', 'GIT_NO_REPLACE_OBJECTS', 'GIT_REPLACE_REF_BASE', 'GIT_PREFIX',
  'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR', 'GIT_ALLOW_PROTOCOL',
]);

function limits(): any {
  const loaded = loadPoints();
  if (!loaded.ok) throw new Error(loaded.errors.join('; '));
  return loaded.registry.limits;
}

function finding(code: string, message: string): any {
  return { package: null, field: 'source', code, severity: 'error', message, allowed: 'a fetchable pinned git or npm source' };
}

function runGit(args: string[], { env, timeoutMs = 120000, cwd, maxBytes }: any): any {
  const gitEnv = { ...env };
  for (const key of GIT_LOCATION_KEYS) delete gitEnv[key];
  return spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', ...args], {
    shell: false, cwd, env: { ...gitEnv, GIT_TERMINAL_PROMPT: '0' }, encoding: 'buffer',
    timeout: timeoutMs, maxBuffer: 2 * maxBytes + 1048576,
  });
}

function reason(result: any, command = 'git'): string {
  const stderr = result?.stderr ? result.stderr.toString('utf8').split(/\r?\n/u)[0].slice(0, 200) : '';
  return stderr || result?.error?.message?.slice(0, 200) || `${command} command failed`;
}

function runNpm(args: string[], { env, timeoutMs = 120000, maxBytes }: any): any {
  return spawnSync('npm', args, {
    shell: false, env, encoding: 'buffer', timeout: timeoutMs, maxBuffer: 2 * maxBytes + 1048576,
  });
}

function pinGit(source: any, { env, timeoutMs }: any): any {
  const maxBytes = limits().bytes;
  if (/^[0-9a-fA-F]{40}$/u.test(source.ref)) {
    const pinned = { type: 'git', url: source.url, commit: source.ref, ...(source.path === undefined ? {} : { path: source.path }) };
    return { ok: true, pinned };
  }
  const result = runGit(['ls-remote', source.url, source.ref], { env, timeoutMs, maxBytes });
  if (result.status !== 0) return { ok: false, finding: finding('source-unpinned', reason(result)) };
  const rows = result.stdout.toString('utf8').split(/\r?\n/u).map((line: string) => line.split('\t'));
  const refs = [
    `refs/tags/${source.ref}^{}`, `refs/tags/${source.ref}`, `refs/heads/${source.ref}`, source.ref,
  ];
  for (const ref of refs) {
    const row = rows.find((parts: string[]) => parts[1] === ref && /^[0-9a-fA-F]{40}$/u.test(parts[0]));
    if (row) return { ok: true, pinned: { type: 'git', url: source.url, commit: row[0], ...(source.path === undefined ? {} : { path: source.path }) } };
  }
  return { ok: false, finding: finding('source-unpinned', `ref ${source.ref} not found`) };
}

function fetchGit(pinned: any, { stagingDir, env, limits: treeLimits, timeoutMs }: any): any {
  const fail = (message: string): any => ({ ok: false, findings: [finding('source-unpinned', message)] });
  if (!/^[0-9a-fA-F]{40}$/u.test(pinned?.commit ?? '')) {
    return { ok: false, findings: [finding('bad-type', 'pinned git commit must be 40 hexadecimal characters')] };
  }
  try {
    if (!fs.statSync(stagingDir).isDirectory() || fs.readdirSync(stagingDir).length !== 0) {
      return { ok: false, findings: [finding('bad-type', 'staging directory must exist and be empty')] };
    }
  } catch { return { ok: false, findings: [finding('bad-type', 'staging directory must exist and be empty')] }; }
  const maxBytes = treeLimits.bytes;
  for (const args of [
    ['init', '-q'], ['remote', 'add', 'origin', pinned.url], ['fetch', '--depth', '1', '--no-tags', 'origin', pinned.commit],
  ]) {
    const result = runGit(args, { env, timeoutMs, cwd: stagingDir, maxBytes });
    if (result.status !== 0) return fail(reason(result));
  }
  const args = ['archive', '--format=tar', pinned.commit, ...(pinned.path ? [pinned.path] : [])];
  const result = runGit(args, { env, timeoutMs, cwd: stagingDir, maxBytes });
  if (result.status !== 0) return fail(reason(result));
  const archive = readTar(result.stdout, { limits: treeLimits, stripPrefix: pinned.path ? `${pinned.path}/` : undefined });
  if (!archive.ok) return { ok: false, findings: archive.findings };
  return { ok: true, pinned, files: archive.files };
}

function pinNpm(source: any, { env, timeoutMs }: any): any {
  const maxBytes = limits().bytes;
  const result = runNpm(['view', `${source.name}@${source.version}`, 'version', 'dist.integrity', '--json'], {
    env, timeoutMs, maxBytes,
  });
  if (result.status !== 0) return { ok: false, finding: finding('source-unpinned', reason(result, 'npm')) };

  let response: any;
  try { response = JSON.parse(result.stdout.toString('utf8')); }
  catch { return { ok: false, finding: finding('source-unpinned', 'npm view answered no valid version and integrity') }; }
  const entries = Array.isArray(response) ? response : [response];
  const versions = entries.filter((entry: any) => typeof entry?.version === 'string' && parseSemVer(entry.version) !== null);
  if (versions.length === 0) {
    return { ok: false, finding: finding('source-unpinned', `no version of ${source.name} matches ${source.version}`) };
  }
  const valid = versions.filter((entry: any) => typeof entry['dist.integrity'] === 'string' && INTEGRITY.test(entry['dist.integrity']));
  if (valid.length === 0) {
    return { ok: false, finding: finding('source-unpinned', 'npm view answered no valid version and integrity') };
  }
  let selected = valid[0];
  for (const entry of valid.slice(1)) {
    if (compareSemVer(entry.version, selected.version) > 0) selected = entry;
  }
  return {
    ok: true,
    pinned: { type: 'npm', name: source.name, version: selected.version, integrity: selected['dist.integrity'] },
  };
}

function fetchNpm(pinned: any, { stagingDir, env, limits: treeLimits, timeoutMs }: any): any {
  const fail = (code: string, message: string): any => ({ ok: false, findings: [finding(code, message)] });
  if (pinned?.type !== 'npm' || typeof pinned?.name !== 'string'
    || !/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/u.test(pinned.name)) {
    return fail('bad-type', 'pinned npm package name is invalid');
  }
  if (typeof pinned.version !== 'string' || parseSemVer(pinned.version) === null) {
    return fail('bad-type', 'pinned npm version must be an exact semver');
  }
  if (typeof pinned.integrity !== 'string' || !INTEGRITY.test(pinned.integrity)) {
    return fail('bad-type', 'pinned npm integrity must be a sha512 value');
  }
  try {
    if (!fs.statSync(stagingDir).isDirectory() || fs.readdirSync(stagingDir).length !== 0) {
      return fail('bad-type', 'staging directory must exist and be empty');
    }
  } catch { return fail('bad-type', 'staging directory must exist and be empty'); }

  const result = runNpm([
    'pack', `${pinned.name}@${pinned.version}`, '--ignore-scripts', '--json', '--pack-destination', stagingDir,
  ], { env, timeoutMs, maxBytes: treeLimits.bytes });
  if (result.status !== 0) return fail('source-unpinned', reason(result, 'npm'));

  let packed: any;
  try { packed = JSON.parse(result.stdout.toString('utf8')); }
  catch { return fail('source-unpinned', 'npm pack did not return valid JSON'); }
  const filename = Array.isArray(packed) ? packed[0]?.filename : undefined;
  if (typeof filename !== 'string' || filename.length === 0) {
    return fail('source-unpinned', 'npm pack did not return a tarball filename');
  }
  const tarball = path.join(stagingDir, path.basename(filename));
  let stat: any;
  try { stat = fs.statSync(tarball); }
  catch { return fail('source-unpinned', 'npm pack tarball is missing'); }
  if (!stat.isFile()) return fail('source-unpinned', 'npm pack tarball is not a file');
  if (stat.size > treeLimits.bytes + (treeLimits.files + 64) * 1024) {
    return fail('too-large', 'npm pack tarball exceeds the bounded archive size');
  }

  const bytes = fs.readFileSync(tarball);
  const integrity = `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`;
  if (integrity !== pinned.integrity) {
    return fail('integrity-mismatch', `npm tarball integrity ${integrity} does not match pinned integrity ${pinned.integrity}`);
  }
  const archive = readTar(bytes, { limits: treeLimits, stripPrefix: 'package/' });
  if (!archive.ok) return { ok: false, findings: archive.findings };
  return { ok: true, pinned, files: archive.files };
}

module.exports = { pinGit, fetchGit, pinNpm, fetchNpm };
