'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TEMP_DIRS = new Set();

// Every temp folder a test makes, and every one a spawned child makes, lives under one root named
// `*.noindex`: macOS Spotlight skips such a folder, so thousands of short-lived scratch trees do not
// feed mds. A single root also means one path to exclude or purge. TMPDIR is pointed at it so a
// child process that calls os.tmpdir() lands there too (a child that already sees the root keeps it).
// Node's compile cache lives in the same root: bin/doflow.js turns the cache on, but a spawn that
// sets its own TMPDIR would otherwise start cold and strip every .ts module again.
const ROOT_NAME = 'doflow-test.noindex';
const TEST_ROOT = (() => {
  const base = os.tmpdir();
  // Kept in the spelling the platform gives (macOS reaches its temp folder through a symlink, and
  // install/home-scope.test.ts checks that spelling); each folder made below is still a real path.
  const root = path.basename(base) === ROOT_NAME ? base : path.join(base, ROOT_NAME);
  fs.mkdirSync(root, { recursive: true });
  return root;
})();
process.env.TMPDIR = TEST_ROOT;
if (!process.env.NODE_COMPILE_CACHE && !process.env.NODE_DISABLE_COMPILE_CACHE) {
  process.env.NODE_COMPILE_CACHE = path.join(TEST_ROOT, 'node-compile-cache');
  // The variable above is read when a process starts, so it reaches every child but not this test
  // file's own process; enabling the cache here covers the modules this process loads after the helper.
  try { require('node:module').enableCompileCache(process.env.NODE_COMPILE_CACHE); } catch { /* best-effort */ }
}

// No git background gc/maintenance in any scratch repo a test builds: a detached one outlives the commit and
// rewrites .git/objects while the repo is copied (ENOENT in cpSync) or recreates a directory after its removal.
// GIT_CONFIG_COUNT entries are appended to any the environment already carries; a spawn that builds its own
// env passes the GIT_CONFIG_* variables through (see GIT_NO_MAINTENANCE_ENV) or keeps `-c` flags.
const GIT_NO_MAINTENANCE = [['gc.auto', '0'], ['maintenance.auto', 'false']];
(() => {
  let count = Number.parseInt(process.env.GIT_CONFIG_COUNT || '0', 10);
  if (!Number.isInteger(count) || count < 0) count = 0;
  for (const [key, value] of GIT_NO_MAINTENANCE) {
    process.env[`GIT_CONFIG_KEY_${count}`] = key;
    process.env[`GIT_CONFIG_VALUE_${count}`] = value;
    count += 1;
  }
  process.env.GIT_CONFIG_COUNT = String(count);
})();

function requirePrefix(prefix: any) {
  if (typeof prefix !== 'string' || !prefix.startsWith('doflow-')) {
    throw new Error("temporary directory prefix must start with 'doflow-'");
  }
}

function makeTempDir(prefix: any) {
  requirePrefix(prefix);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(TEST_ROOT, prefix)));
  TEMP_DIRS.add(dir);
  return dir;
}

function restoreOwnerWritePermission(dir: any) {
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

/** Recursive removal that restores owner write permission on EACCES/ENOTEMPTY/EPERM/EBUSY and retries with backoff. */
function removeTree(dir: any) {
  const RETRY_CODES = new Set(['EACCES', 'ENOTEMPTY', 'EPERM', 'EBUSY']);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      break;
    } catch (error: any) {
      if (!RETRY_CODES.has(error?.code)) throw error;
      restoreOwnerWritePermission(dir);
      if (attempt === 4) {
        fs.rmSync(dir, { recursive: true, force: true });
        break;
      }
      const start = Date.now();
      while (Date.now() - start < 25 * (attempt + 1)) {}
    }
  }
  TEMP_DIRS.delete(dir);
}

/** A real-path temp dir removed by t.after(); prefix must start with 'doflow-'. */
function tempDir(t: any, prefix = 'doflow-test-') {
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

module.exports = { tempDir, suiteTempDir, removeTree, TEST_ROOT };
