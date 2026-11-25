'use strict';

// Whether a pid names a process that is still running. kill(pid, 0) also succeeds for a zombie: a process that has
// exited and runs nothing, whose exit status the process that adopted it has not collected yet. How soon that happens
// is up to the runner's init or subreaper, not to the code under test, so a test that asks "is anything left running"
// counts a zombie as gone, as src/runtime/worker/process-tree.ts separates live members from zombies. POSIX only.

const { spawnSync } = require('node:child_process');

function processRunning(pid: number): boolean {
  // Only ESRCH means no such process; EPERM is a process this user may not signal, which is running.
  try { process.kill(pid, 0); } catch (error: any) { return error?.code !== 'ESRCH'; }
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  const state = String(ps.stdout ?? '').trim();
  if (state) return !state.startsWith('Z');
  // ps lists nothing: "no such pid" only when kill(pid, 0) now agrees; any other failure of ps (missing, or a ps without
  // -p) is no answer, and kill(pid, 0) stands.
  try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code !== 'ESRCH'; }
}

module.exports = { processRunning };
