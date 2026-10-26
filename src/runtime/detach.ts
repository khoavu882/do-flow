'use strict';

const { spawn } = require('node:child_process');

/** The execArgv entries a detached copy keeps (the type-stripping and warning flags; worker/command.ts allowedExecArgv). */
const EXEC_ARGV_ALLOWED = /^(--(no-)?experimental-(strip|transform)-types|--no-warnings|--disable-warning=.+)$/;

/**
 * Starts `script` as a detached node process and writes `payload` (JSON) to its stdin, so work that may outlast
 * the verb does not hold the verb, or the user's turn, open. The child has no stdout or stderr and survives this
 * process. Returns whether it started; never throws.
 */
function runDetached(script: string, payload: unknown, { cwd, env }: { cwd?: string; env?: Record<string, string | undefined> } = {}): boolean {
  try {
    const child = spawn(process.execPath, [...process.execArgv.filter((arg: string) => EXEC_ARGV_ALLOWED.test(arg)), script], {
      detached: true, stdio: ['pipe', 'ignore', 'ignore'], cwd: cwd || process.cwd(), env: env || process.env,
    });
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
    child.unref();
    return Number.isInteger(child.pid);
  } catch {
    return false;
  }
}

module.exports = { runDetached };
