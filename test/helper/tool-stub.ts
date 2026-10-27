'use strict';

// Fake `git` / `npm` executables for tests that put a `#!/bin/sh` stub first on PATH.
//
// POSIX resolves such a stub through the shebang. Windows cannot: CreateProcess has no shebang
// handling, and Node's spawnSync (shell: false) only finds `<name>.exe` / `<name>.com` on PATH, so the
// product would run the real git.exe (or fail with ENOENT for npm.cmd) and never reach the stub.
// Requiring this module patches child_process.spawnSync so a bare command name whose first PATH match
// (honouring the PATH of the options.env the product passes) is an extensionless `#!` script runs
// that script through Git for Windows' bash with the very same argv. The product's own argv and env
// construction stay under test. A directory holding `<name>.exe` ahead of the stub still wins, as on a
// real PATH. Subprocess runs of the CLI get the same patch through `withToolStubs(env)`.
//
// DOFLOW_TEST_FORCE_TOOL_STUB=1 exercises the same redirect on any OS so the plumbing stays covered by
// the POSIX legs.

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { bashPath } = require('./bash-locator.ts');

const ACTIVE = process.platform === 'win32' || process.env.DOFLOW_TEST_FORCE_TOOL_STUB === '1';

function pathKey(env: any): string | undefined {
  // Node's own rule on win32: env keys are case-insensitive, the lexicographically first one wins.
  return Object.keys(env).filter((k) => k.toUpperCase() === 'PATH').sort()[0];
}

function isShebangScript(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(2);
      fs.readSync(fd, head, 0, 2, 0);
      return head.toString('latin1') === '#!';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** The stub script a bare `name` resolves to on `env`'s PATH, or null when a real executable comes first. */
function findStub(name: string, env: any): string | null {
  const key = pathKey(env);
  if (!key || !env[key]) return null;
  for (const dir of String(env[key]).split(path.delimiter)) {
    if (!dir) continue;
    if (process.platform === 'win32') {
      for (const ext of ['.exe', '.com']) if (fs.existsSync(path.join(dir, name + ext))) return null;
    }
    const candidate = path.join(dir, name);
    if (isShebangScript(candidate)) return candidate;
    if (process.platform !== 'win32' && fs.existsSync(candidate)) return null;
  }
  return null;
}

/** The same env with Git for Windows' usr/bin appended, so `cat`, `cp`, `printf` resolve inside a stub. */
function withUsrBin(env: any): any {
  if (process.platform !== 'win32') return env;
  const bash = bashPath({ quiet: true });
  const usrBin = path.join(path.dirname(path.dirname(bash)), 'usr', 'bin');
  const key = pathKey(env) ?? 'PATH';
  const current = String(env[key] ?? '');
  if (current.toLowerCase().split(path.delimiter).includes(usrBin.toLowerCase())) return env;
  return { ...env, [key]: current ? `${current}${path.delimiter}${usrBin}` : usrBin };
}

/** The bash-run form of a bare `file` call when it resolves to a stub, else null. */
function redirect(file: any, args: any, options: any): { file: string; args: any[]; options: any } | null {
  if (typeof file !== 'string' || /[\\/]/.test(file) || !Array.isArray(args)) return null;
  const env = options?.env ?? process.env;
  const stub = findStub(file, env);
  if (!stub) return null;
  return { file: bashPath({ quiet: true }), args: [stub, ...args], options: { ...options, env: withUsrBin(env), shell: false } };
}

if (ACTIVE && !childProcess.spawnSync.__doflowToolStub) {
  // The synchronous entry points a product calls directly. execFileSync does not go through the exported
  // spawnSync, so each is wrapped on its own.
  for (const name of ['spawnSync', 'execFileSync', 'spawn']) {
    const original = childProcess[name];
    const patched = function (this: any, file: any, args?: any, options?: any) {
      // execFile*/spawn also accept (file, options): only the array form is a stub candidate
      const hit = redirect(file, args, options);
      return hit ? original.call(this, hit.file, hit.args, hit.options) : original.apply(this, arguments as any);
    };
    (patched as any).__doflowToolStub = true;
    childProcess[name] = patched;
  }
}

/** `env` plus a NODE_OPTIONS preload of this module, for a node child that runs the product. */
function withToolStubs(env: any): any {
  if (!ACTIVE) return env;
  const key = Object.keys(env).filter((k) => k.toUpperCase() === 'NODE_OPTIONS').sort()[0] ?? 'NODE_OPTIONS';
  const preload = `--require "${__filename.replace(/\\/g, '/')}"`;
  return { ...env, [key]: env[key] ? `${env[key]} ${preload}` : preload };
}

/** A path as embedded in a stub script's single quotes: forward slashes work in Git Bash and POSIX alike. */
function shPath(p: string): string {
  return process.platform === 'win32' ? p.replace(/\\/g, '/') : p;
}

module.exports = { withToolStubs, shPath, findStub };
