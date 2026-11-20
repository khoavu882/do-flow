'use strict';

const { spawnSync } = require('node:child_process');

/** Longest a hook-bridge spawn may run before it is killed. The slowest one in a loaded suite takes a few seconds. */
const BRIDGE_SPAWN_TIMEOUT_MS = 90000;

/**
 * `spawnSync` with a bound: a child that outlives `timeout` is killed with SIGKILL and the call throws an Error that
 * names the timeout (and kills the child's whole process group) and carries the child's captured stderr and stdout, so a hung bridge fails the test instead of
 * hanging the suite. `spawnImpl` swaps the spawn call (for `spawnWithFd3`); it receives the same bounded options.
 */
function boundedSpawnSync(file: string, args: readonly string[], options: any = {}, spawnImpl: any = null) {
  const timeout = options.timeout ?? BRIDGE_SPAWN_TIMEOUT_MS;
  // A POSIX child leads its own process group, so a timeout can kill the grandchildren it forked as well.
  const bounded = { ...options, timeout, killSignal: 'SIGKILL', ...(process.platform === 'win32' ? {} : { detached: true }) };
  const result: any = spawnImpl ? spawnImpl(args, bounded) : spawnSync(file, args, bounded);
  const out = (value: any) => (value == null ? '' : String(value));
  if (result.error || result.signal) {
    if (process.platform !== 'win32' && result.pid) { try { process.kill(-result.pid, 'SIGKILL'); } catch { /* the group is already gone */ } }
    const timedOut = result.error?.code === 'ETIMEDOUT';
    throw new Error([
      `spawn ${timedOut ? `timed out after ${timeout} ms and was killed (${bounded.killSignal})` : `failed (${result.error?.message ?? `signal ${result.signal}`})`}: ${file} ${args.join(' ')}`,
      `stderr: ${JSON.stringify(out(result.stderr).slice(0, 2000))}`,
      `stdout: ${JSON.stringify(out(result.stdout).slice(0, 2000))}`,
    ].join('\n'));
  }
  return result;
}

module.exports = { BRIDGE_SPAWN_TIMEOUT_MS, boundedSpawnSync };
