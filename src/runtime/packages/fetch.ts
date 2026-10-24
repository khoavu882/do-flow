'use strict';

/**
 * Pin and fetch IC-022 git sources by commit using argv arrays with `shell: false`.
 * Git hooks are off, `protocol.file.allow=never`, and `GIT_TERMINAL_PROMPT=0`.
 * Fetching uses no checkout or submodules; DoFlow writes no file and git writes only inside
 * the caller's empty staging directory.
 */

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { loadPoints } = require('./points.ts');
const { readTar } = require('./tar.ts');

function limits(): any {
  const loaded = loadPoints();
  if (!loaded.ok) throw new Error(loaded.errors.join('; '));
  return loaded.registry.limits;
}

function finding(code: string, message: string): any {
  return { package: null, field: 'source', code, severity: 'error', message, allowed: 'a fetchable pinned git source' };
}

function runGit(args: string[], { env, timeoutMs = 120000, cwd, maxBytes }: any): any {
  return spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=never', ...args], {
    shell: false, cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, encoding: 'buffer',
    timeout: timeoutMs, maxBuffer: 2 * maxBytes + 1048576,
  });
}

function reason(result: any): string {
  const stderr = result?.stderr ? result.stderr.toString('utf8').split(/\r?\n/u)[0].slice(0, 200) : '';
  return stderr || result?.error?.message?.slice(0, 200) || 'git command failed';
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

module.exports = { pinGit, fetchGit };
