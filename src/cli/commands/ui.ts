'use strict';
// `doflow ui [<project>] [--port N]` — run the DoFlow Console, a separately installed package
// (092 IC-008). The package is found by file existence and never loaded into the core: this module
// loads only node:fs, node:path and node:child_process (test/runtime/ui-launcher.test.ts). It never
// listens, reads DoFlow state, installs anything, or adds a variable to the Console's environment.
// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

/** The package's entry, fixed by its own contract (093 IC-002). */
const CONSOLE_BIN = path.join('bin', 'doflow-ui.js');
const USAGE = 'doflow ui: usage: doflow ui [<project>] [--port N]';
const NOT_INSTALLED = 'doflow ui: the Console is not installed. Install it with: npm install -g @khoavu882/doflow-ui';

/** The Console bin when `dir` holds both the package's package.json and its bin, else null. */
function consoleBinIn(dir: string): string | null {
  const bin = path.join(dir, CONSOLE_BIN);
  return fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(bin) ? bin : null;
}

/**
 * IC-008 order. First the core's sibling: npm puts both packages in the same
 * `node_modules/@khoavu882/`, global or project, so that copy was installed next to this very core.
 * Then a walk up from the project for `node_modules/@khoavu882/doflow-ui`.
 */
function findConsole(coreRoot: string, project: string): string | null {
  const sibling = consoleBinIn(path.join(coreRoot, '..', 'doflow-ui'));
  if (sibling) return sibling;
  for (let dir = project; ; dir = path.dirname(dir)) {
    const bin = consoleBinIn(path.join(dir, 'node_modules', '@khoavu882', 'doflow-ui'));
    if (bin) return bin;
    if (path.dirname(dir) === dir) return null;
  }
}

/** `coreRoot` is this core's package root, passed in by the COMMANDS table (src/helper/repo-root.ts owns it). */
function cmdUi(o: any, coreRoot: string): Promise<void> | void {
  const port = o.port;
  const otherFlags = o.flagsGiven.filter((flag: string) => flag !== '--port' && !flag.startsWith('--port='));
  if (o.positional.length > 1 || otherFlags.length > 0
    || (port !== undefined && !(/^[0-9]{1,5}$/.test(port) && Number(port) <= 65535))) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const project = path.resolve(o.positional[0] ?? '.');
  const bin = findConsole(coreRoot, project);
  if (!bin) {
    console.error(NOT_INSTALLED);
    process.exitCode = 2;
    return;
  }
  // stderr, so stdout carries only the Console's own one line (093 IC-002).
  console.error(`doflow ui: using ${bin}`);
  const args = [bin, '--core', path.join(coreRoot, 'bin', 'doflow.js')];
  if (o.positional.length > 0) args.push('--project', project);
  if (port !== undefined) args.push('--port', port);
  const child = spawn(process.execPath, args, { stdio: 'inherit' });

  // Stay up until the Console exits, so its exit code is ours. A terminal Ctrl-C already reaches the
  // Console through the process group; it is forwarded as SIGTERM, which the Console handles once
  // separately from SIGINT, so the second delivery does not cut its 2 s shutdown short.
  const forward = () => { child.kill('SIGTERM'); };
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', forward);
      process.off('SIGTERM', forward);
      finish();
      resolve();
    };
    child.on('error', (error: any) => settle(() => {
      console.error(`doflow ui: cannot start ${bin}: ${error.message}`);
      process.exitCode = 1;
    }));
    // Killed by a signal: die by the same signal, the shell's own way of forwarding it.
    child.on('exit', (code: number | null, signal: string | null) => settle(() => {
      if (signal) process.kill(process.pid, signal);
      else process.exitCode = code ?? 1;
    }));
  });
}

module.exports = cmdUi;
