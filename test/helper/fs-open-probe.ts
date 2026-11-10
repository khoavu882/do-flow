'use strict';

// Feature 150 A.7 (IC-022, DEC-006, FR-012): a file-open probe, loaded with
// `node --require test/helper/fs-open-probe.ts <script>`. When DOFLOW_OPEN_PROBE names a file, it
// wraps fs.openSync, fs.open, fs.readFileSync, fs.readFile, fs.createReadStream, fs.copyFileSync,
// fs.copyFile, fs.promises.open and fs.promises.readFile (`require('node:fs/promises')` is the same
// object as fs.promises) and appends the absolute path of every open those calls are asked for (a
// copy's source) to that file, one per line, before the call runs (so an open that then fails is
// recorded too). The wrapped call gets the same `this` and
// arguments and its result or throw is passed through untouched. A path given as a string, a Buffer
// or a file: URL is recorded; a numeric fd is not a path and is skipped. The probe file is written
// with the fs functions captured before wrapping, under a re-entry flag, so its own writes are never
// recorded. With DOFLOW_OPEN_PROBE unset the module installs nothing.

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const INSTALLED = Symbol.for('doflow.test.fs-open-probe');

/** The path an fs call was given, as an absolute string; null for an fd or an unreadable value. */
function pathOf(target: any): string | null {
  let text: string | null = null;
  if (typeof target === 'string') text = target;
  else if (Buffer.isBuffer(target)) text = target.toString('utf8');
  else if (target && typeof target === 'object' && typeof target.href === 'string' && target.protocol === 'file:') {
    try { text = fileURLToPath(target); } catch { text = null; }
  }
  if (text === null) return null;
  try { return path.resolve(text); } catch { return text; }
}

function install(probeFile: string) {
  const original = {
    openSync: fs.openSync,
    open: fs.open,
    readFileSync: fs.readFileSync,
    readFile: fs.readFile,
    createReadStream: fs.createReadStream,
    copyFileSync: fs.copyFileSync,
    copyFile: fs.copyFile,
    promisesOpen: fs.promises.open,
    promisesReadFile: fs.promises.readFile,
    promisesCopyFile: fs.promises.copyFile,
    openAsBlob: fs.openAsBlob,
    writeSync: fs.writeSync,
    closeSync: fs.closeSync,
  };
  let recording = false;

  /** Appends one line for `target`; never throws and never re-enters itself. */
  const record = (target: any) => {
    if (recording) return;
    const opened = pathOf(target);
    if (opened === null) return;
    recording = true;
    try {
      const fd = original.openSync.call(fs, probeFile, 'a');
      try { original.writeSync.call(fs, fd, `${opened.replace(/[\r\n]/g, ' ')}\n`); }
      finally { original.closeSync.call(fs, fd); }
    } catch { /* the probe must not change the call it watches */ }
    finally { recording = false; }
  };

  const wrap = (fn: any) => function (this: any, ...args: any[]) {
    record(args[0]);
    return fn.apply(this, args);
  };

  fs.openSync = wrap(original.openSync);
  fs.open = wrap(original.open);
  fs.readFileSync = wrap(original.readFileSync);
  fs.readFile = wrap(original.readFile);
  fs.createReadStream = wrap(original.createReadStream);
  fs.copyFileSync = wrap(original.copyFileSync);
  fs.copyFile = wrap(original.copyFile);
  fs.promises.open = wrap(original.promisesOpen);
  fs.promises.readFile = wrap(original.promisesReadFile);
  if (typeof (fs.promises as any).copyFile === 'function') fs.promises.copyFile = wrap(original.promisesCopyFile);
  if (typeof (fs as any).openAsBlob === 'function') (fs as any).openAsBlob = wrap(original.openAsBlob);
  // An ES module that imports node:fs by name sees the wrapped functions too.
  require('node:module').syncBuiltinESMExports();
}

const probeFile = process.env.DOFLOW_OPEN_PROBE;
if (probeFile && !(globalThis as any)[INSTALLED]) {
  (globalThis as any)[INSTALLED] = true;
  install(path.resolve(probeFile));
}

module.exports = { pathOf };
