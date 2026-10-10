'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TEMP_DIRS = new Set();

function requirePrefix(prefix) {
  if (typeof prefix !== 'string' || !prefix.startsWith('doflow-')) {
    throw new Error("temporary directory prefix must start with 'doflow-'");
  }
}

function makeTempDir(prefix) {
  requirePrefix(prefix);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  TEMP_DIRS.add(dir);
  return dir;
}

function restoreOwnerWritePermission(dir) {
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;

  try {
    fs.chmodSync(dir, stat.mode | 0o700);
  } catch {
    // The retry below reports the original deletion failure if this cannot be changed.
  }
  if (!stat.isDirectory()) return;

  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) restoreOwnerWritePermission(path.join(dir, entry));
}

/** Recursive removal that restores owner write permission on EACCES and retries. */
function removeTree(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    if (!['EACCES', 'ENOTEMPTY', 'EPERM'].includes(error?.code)) throw error;
    restoreOwnerWritePermission(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  TEMP_DIRS.delete(dir);
}

/** A real-path temp dir removed by t.after(); prefix must start with 'doflow-'. */
function tempDir(t, prefix = 'doflow-test-') {
  const dir = makeTempDir(prefix);
  t.after(() => removeTree(dir));
  return dir;
}

/** A real-path temp dir removed by the process-exit cleanup net; call at top level or in before(). */
function suiteTempDir(prefix = 'doflow-test-') {
  return makeTempDir(prefix);
}

function cleanupOnExit() {
  for (const dir of TEMP_DIRS) {
    try {
      removeTree(dir);
    } catch {
      // Exit cleanup is best-effort; a normal cleanup path surfaces removal errors.
    }
  }
}

// node:test intercepts a top-level throw before it emits `exit` in current Node releases. Monitor
// it without consuming it so the exit-net promise also holds in a test worker.
process.on('uncaughtExceptionMonitor', cleanupOnExit);
process.on('exit', cleanupOnExit);

module.exports = { tempDir, suiteTempDir, removeTree };
