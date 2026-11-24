'use strict';

// Whether a pid names a process that is still running. kill(pid, 0) also succeeds for a zombie: a process that has
// exited and runs nothing, whose exit status the process that adopted it has not collected yet. How soon that happens
// is up to the runner's init or subreaper, not to the code under test, so a test that asks "is anything left running"
// counts a zombie as gone, as src/runtime/worker/process-tree.ts separates live members from zombies. POSIX only.

const { spawnSync } = require('node:child_process');

function processRunning(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  if (ps.error) return true; // no ps to ask: kill(pid, 0) is the answer
  const state = String(ps.stdout ?? '').trim();
  if (!state) return false; // ps no longer lists it
  return !state.startsWith('Z');
}

module.exports = { processRunning };
