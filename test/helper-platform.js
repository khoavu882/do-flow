'use strict';

// Platform-aware assertion helpers for tests that would otherwise assume POSIX semantics.
// Windows has no executable permission bits: fs.chmodSync can only toggle the read-only flag,
// and statSync().mode always reports a writable file as 0666 (0444 when read-only), so any
// assertion on mode & 0o111 is unanswerable there. On win32 we assert the weaker invariant that
// still catches the real regressions these tests exist for — the file was deployed and is not
// empty — instead of skipping outright.

const path = require('node:path');

const IS_WIN = process.platform === 'win32';

// DOFLOW_TEST_SPAWN_VIA_BASH=1 exercises the win32 interpreter-spawn branch on any OS, so the
// wrapping itself stays covered by the mandatory darwin/linux legs instead of first running on CI.
const FORCE_BASH = process.env.DOFLOW_TEST_SPAWN_VIA_BASH === '1';

/** How to execute `exe` — usually a shebang script such as a projected doflow-run locator or the
 * dispatcher, which win32 can neither exec directly (CreateProcess has no shebang handling nor
 * exec bits) nor skip, since "the pieces join up" is exactly what these tests exist to prove.
 * Windows runners ship Git Bash, so spawning through `bash` gives REAL coverage of the same POSIX
 * script rather than a skip. Returns the spawnSync/spawn leading arguments. */
function interpreterSpawn(exe, args) {
  if (!IS_WIN && !FORCE_BASH) return { file: exe, args };
  return { file: 'bash', args: [exe, ...args] };
}

/** True when `a` and `b` are the same directory/file, tolerating the three spellings one path can
 * legitimately carry across this repo's own surfaces: a Windows caller sees backslashes, while
 * scripts running under MSYS/Git Bash report `/c/...` POSIX form, and git prints `C:/...`.
 * Comparison is case-insensitive only on win32, where paths are case-insensitive. */
function samePath(a, b) {
  const canonical = (p) => path.normalize(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const left = canonical(a);
  const right = canonical(b);
  return IS_WIN ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** True when `child` is `ancestor` or lives underneath it, with the same cross-form tolerance as
 * samePath(). A trailing separator boundary is required: /tmp/x must not match /tmp/xy. */
function withinPath(child, ancestor) {
  const canonical = (p) => path.normalize(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const base = canonical(ancestor);
  const full = canonical(child);
  const [left, right] = IS_WIN ? [full.toLowerCase(), `${base.toLowerCase()}/`] : [full, `${base}/`];
  return left === base || left.startsWith(right);
}

/** Environment additions that stop MSYS/Git Bash rewriting script arguments that merely LOOK like
 * POSIX paths: handing a hook payload's "/x/y.js" to a native tool otherwise becomes "X:/y.js"
 * ("/x/" reads as drive X:), which is a fixture artifact, not the behavior under test. */
function msysArgConvGuards() {
  return IS_WIN ? { MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' } : {};
}

module.exports = { IS_WIN, expectExecutable, interpreterSpawn, samePath, withinPath, msysArgConvGuards };

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
