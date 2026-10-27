'use strict';

// A scratch folder for tests whose subject walks UP from the project looking for a `.doflow/` store
// (runtime reach, doctor). On POSIX the temp folder is outside the account home, so tempDir() is enough.
// On win32 the temp folder lives under the account profile (C:\Users\<name>\AppData\Local\Temp), so the
// walk reaches the real profile's own `.doflow/` and reports its harnesses; the premise "no store above
// the project" is then arranged at the drive root instead of being assumed. The folder is created with a
// random name by mkdirSync and removed when the test ends.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('./tmp.ts');

const DRIVE_ROOT = `${process.env.SystemDrive || 'C:'}\\`;

function tempDirOutsideProfile(t: any, prefix: string): string {
  if (process.platform !== 'win32') return tempDir(t, prefix);
  if (!prefix.startsWith('doflow-')) throw new Error("temporary directory prefix must start with 'doflow-'");
  const dir = path.join(DRIVE_ROOT, `${prefix}${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return fs.realpathSync.native(dir);
}

/** Same, for a test that has no `t` (a top-level helper): removed when the process exits. */
function suiteTempDirOutsideProfile(prefix: string): string {
  if (process.platform !== 'win32') return require('./tmp.ts').suiteTempDir(prefix);
  if (!prefix.startsWith('doflow-')) throw new Error("temporary directory prefix must start with 'doflow-'");
  const dir = path.join(DRIVE_ROOT, `${prefix}${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir);
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });
  return fs.realpathSync.native(dir);
}

module.exports = { tempDirOutsideProfile, suiteTempDirOutsideProfile };
