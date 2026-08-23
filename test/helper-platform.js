'use strict';

// Platform-aware assertion helpers for tests that would otherwise assume POSIX semantics.
// Windows has no executable permission bits: fs.chmodSync can only toggle the read-only flag,
// and statSync().mode always reports a writable file as 0666 (0444 when read-only), so any
// assertion on mode & 0o111 is unanswerable there. On win32 we assert the weaker invariant that
// still catches the real regressions these tests exist for — the file was deployed and is not
// empty — instead of skipping outright.

const IS_WIN = process.platform === 'win32';

/** Assert `filePath` was deployed and is usable: present and non-empty everywhere, with the
 * POSIX executable bits additionally required (and meaningful) only off-Windows. */
function expectExecutable(fs, filePath, label = filePath) {
  const stat = fs.statSync(filePath);
  assertNonEmpty(fs, filePath, label);
  if (!IS_WIN) {
    if (!(stat.mode & 0o111)) {
      throw new Error(`${label} must be executable (mode ${(stat.mode & 0o777).toString(8)})`);
    }
  }
}

function assertNonEmpty(fs, filePath, label) {
  const stat = fs.statSync(filePath);
  if (stat.size === 0) throw new Error(`${label} exists but is empty`);
}

module.exports = { IS_WIN, expectExecutable };
