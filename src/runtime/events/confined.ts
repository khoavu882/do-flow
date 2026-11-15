'use strict';

// Feature 161 (review 1): every file a lane of `doflow events --follow` reads by name is opened here,
// and only as the regular file a fresh check shows it to be at that read.
//
//   1. `lstat` every component below the lane's root: each directory a real directory (no link), the
//      file a regular file (no link, no device, no directory)
//   2. open read-only with O_NOFOLLOW where the platform has it (not on Windows), so a link put in
//      place after the check fails to open
//   3. `fstat` the descriptor: its dev and inode must be the ones step 1 saw, so a directory swapped
//      for a link between the check and the open is refused too
//
// A refusal is the error code `EREFUSED` (`why`: `outside-root`, `not-a-directory`,
// `not-a-regular-file`, `swapped`); a missing component is the `lstat`'s own ENOENT or ENOTDIR.
// The root itself (a checkout, the lifecycle root, the state home) is trusted as given. Read-only:
// nothing is created, written or locked.

const fs = require('node:fs');
const path = require('node:path');

/** O_NOFOLLOW where the platform defines it, else 0 (the inode check still holds). */
const NOFOLLOW: number = fs.constants.O_NOFOLLOW ?? 0;

type Why = 'outside-root' | 'not-a-directory' | 'not-a-regular-file' | 'swapped';

function refused(why: Why): Error {
  return Object.assign(new Error(`not read: ${why}`), { code: 'EREFUSED', why });
}

/**
 * Opens `file`, which must lie below `root`, after steps 1 to 3 above; the caller closes the descriptor.
 * @returns {number} a read-only descriptor of the regular file the check saw
 */
function openConfined(root: string, file: string, fsImpl: any = fs): number {
  const rel = path.relative(root, file);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw refused('outside-root');
  let dir = root;
  for (const part of rel.split(path.sep).slice(0, -1)) {
    dir = path.join(dir, part);
    if (!fsImpl.lstatSync(dir).isDirectory()) throw refused('not-a-directory');
  }
  const seen = fsImpl.lstatSync(file, { bigint: true });
  if (!seen.isFile()) throw refused('not-a-regular-file');
  let fd: number;
  try {
    fd = fsImpl.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  } catch (error: any) {
    if (error && error.code === 'ELOOP') throw refused('not-a-regular-file'); // a link put in place after the check
    throw error;
  }
  try {
    const opened = fsImpl.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== seen.dev || opened.ino !== seen.ino) throw refused('swapped');
  } catch (error) {
    fsImpl.closeSync(fd);
    throw error;
  }
  return fd;
}

/**
 * The bytes of `file` (opened as `openConfined` opens it) when its descriptor's size is at most `cap`;
 * null, with nothing read, when it is larger. At most that size is read.
 */
function readConfined(root: string, file: string, fsImpl: any = fs, cap: number = Infinity): Buffer | null {
  const fd = openConfined(root, file, fsImpl);
  try {
    const size = Number(fsImpl.fstatSync(fd).size);
    if (size > cap) return null;
    const buf = Buffer.alloc(size);
    let filled = 0;
    while (filled < size) {
      const n = fsImpl.readSync(fd, buf, filled, size - filled, filled);
      if (!n) break;
      filled += n;
    }
    return buf.subarray(0, filled);
  } finally {
    fsImpl.closeSync(fd);
  }
}

/**
 * The fs `readLogPage` (src/runtime/worker/log-read.ts) reads `file` through: its one open is
 * `openConfined` under `root`, and a refusal reads as ENOENT, so a refused file is an absent page.
 */
function confinedReader(root: string, fsImpl: any = fs): any {
  return {
    openSync(file: string): number {
      try {
        return openConfined(root, file, fsImpl);
      } catch (error: any) {
        if (error && error.code === 'EREFUSED') throw Object.assign(new Error(error.message), { code: 'ENOENT', why: error.why });
        throw error;
      }
    },
    fstatSync: (fd: number, options?: any) => fsImpl.fstatSync(fd, options),
    readSync: (fd: number, buf: Buffer, offset: number, length: number, position: number) => fsImpl.readSync(fd, buf, offset, length, position),
    closeSync: (fd: number) => fsImpl.closeSync(fd),
  };
}

module.exports = { openConfined, readConfined, confinedReader, NOFOLLOW };
