'use strict';

// After a test SIGKILLs a process that writes a task-state store (a supervisor writing the run store), the kill can land
// inside a write, between the lock's mkdir and its release. The lock is then left behind by a dead holder, and the
// documented rule (src/runtime/task-state.ts; docs/reference.md, "cross-process locks") reclaims it only once it is
// LOCK_STALE_MS (10 s) old, while the next writer waits 5 s before it gives up. A test whose next step writes that store
// (an operator cancel) first waits here until the lock is gone or old enough for that writer to reclaim it. How likely the
// kill is to land in a write grows with the load on the machine (the write is slower), which is why it shows under load only.

const fs = require('node:fs');
const path = require('node:path');
const { LOCK_STALE_MS } = require(path.join(__dirname, '..', '..', 'src', 'runtime', 'task-state.ts'));

/** Margin over LOCK_STALE_MS for a coarse directory modification time. */
const MTIME_MARGIN_MS = 1000;
const POLL_MS = 100;

/**
 * Resolves once `<file>.lock` is absent or older than LOCK_STALE_MS plus a margin, so the next writer of `file` takes or
 * reclaims it at once. Only for a store whose live writers are all stopped: a lock that is still young after three stale
 * ages is being taken again and again by a live writer, and the wait gives up with an error naming it.
 */
async function untilLockReclaimable(file: string, { now = Date.now, sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}): Promise<'absent' | 'reclaimable'> {
  const lockDir = `${file}.lock`;
  const giveUp = now() + 3 * LOCK_STALE_MS;
  for (;;) {
    let mtimeMs: number;
    try { mtimeMs = fs.statSync(lockDir).mtimeMs; } catch (error: any) {
      if (error?.code === 'ENOENT') return 'absent';
      throw error;
    }
    if (now() - mtimeMs > LOCK_STALE_MS + MTIME_MARGIN_MS) return 'reclaimable';
    if (now() > giveUp) throw new Error(`the lock ${lockDir} stayed fresh for ${3 * LOCK_STALE_MS / 1000}s: a live writer holds it`);
    await sleep(POLL_MS);
  }
}

module.exports = { untilLockReclaimable, MTIME_MARGIN_MS };
