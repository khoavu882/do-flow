'use strict';

/**
 * Changed-test selector (feature 071, design C3): builds the `{pattern}` for a scopable targeted
 * test command from the tests a feature changed, so a LOW verification runs a few files instead of
 * the whole suite.
 *
 * The selection basis is deliberately narrow: changed test files that still exist, plus the guard
 * directory for `node --test` repositories. There is no source-to-test inference, because a text
 * reference graph selected about half of the files on recent commits and still missed paths that
 * tests build or spawn at run time. Change detection is not reimplemented here: the caller passes
 * the files the change-scope tier observes.
 */

const path = require('node:path');
const nodeFs = require('node:fs');

/** The guard lane of a `node --test` repository: structural checks that run with every selection. */
const GUARD_DIR = 'test/guards';

const NODE_TEST_FILE = /\.test\.(?:js|mjs|cjs)$/;
const PYTEST_FILE = /(?:^|\/)(?:test_[^/]*|[^/]*_test)\.py$/;

const SKIPPED_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__']);

/** Characters a shell passes through a word unquoted. `%` is excluded: `cmd.exe` expands `%VAR%` even
 * inside double quotes, so a path holding one must be quoted on POSIX and refused on win32. */
const SAFE_WORD = /^[A-Za-z0-9_@+=:,./-]+$/;

/** Characters `cmd.exe` expands inside a quoted word, which no quoting form here can neutralise. */
const WIN32_UNQUOTABLE = /[%!]/;

/**
 * Quotes one path as one shell word. The engine runs commands with `shell: true`, and
 * `applyTargetPattern` substitutes the pattern verbatim, so a path with a space or a metacharacter
 * must arrive already quoted.
 * @param {string} file
 * @param {string} [platform]
 * @returns {string}
 */
function quotePath(file, platform = process.platform) {
  if (SAFE_WORD.test(file)) return file;
  if (platform === 'win32') return `"${file.replace(/"/g, '""')}"`;
  return `'${file.replace(/'/g, `'\\''`)}'`;
}

/** Normalises a repository-relative path: forward slashes, no leading `./`, no trailing `/`. */
function normalize(file) {
  return String(file).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
}

function statOf(fsImpl, file) {
  try {
    return fsImpl.statSync(file);
  } catch {
    return null;
  }
}

/** Repository-relative paths of every file under `rel` (a file counts as itself). */
function walkFiles(fsImpl, root, rel) {
  const abs = path.join(root, rel);
  const stat = statOf(fsImpl, abs);
  if (!stat) return [];
  if (stat.isFile()) return [normalize(rel)];
  if (!stat.isDirectory()) return [];
  const out = [];
  let entries;
  try {
    entries = fsImpl.readdirSync(abs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const child = rel === '' || rel === '.' ? entry.name : `${normalize(rel)}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkFiles(fsImpl, root, child));
    else if (entry.isFile()) out.push(normalize(child));
  }
  return out;
}

/**
 * The convention that says which paths are test files for the detected toolchain, or null when this
 * module has none for it (the targeted command is then left as detected).
 * @param {{ source?: string, testDirs?: Array<string> }} found the detected `testTargeted` entry
 * @returns {null|{ basis: string, isTest: Function, roots: Array<string>, guardDir: string|null }}
 */
function conventionFor(found) {
  if (found && found.source === 'package.json' && Array.isArray(found.testDirs) && found.testDirs.length > 0) {
    const roots = found.testDirs.map(normalize).filter(Boolean);
    const underRoot = (file) => roots.some((r) => file === r || file.startsWith(`${r}/`));
    return {
      basis: 'changed-test-files',
      roots,
      isTest: (file) => NODE_TEST_FILE.test(file) && underRoot(file),
      guardDir: roots.some((r) => GUARD_DIR === r || GUARD_DIR.startsWith(`${r}/`)) ? GUARD_DIR : null,
    };
  }
  if (found && found.source === 'pyproject.toml') {
    return { basis: 'changed-test-files', roots: ['.'], isTest: (file) => PYTEST_FILE.test(file), guardDir: null };
  }
  return null;
}

/**
 * @param {Object} input
 * @param {Object} input.found the detected `testTargeted` entry (`source`, `testDirs`)
 * @param {{ files: Array<string>|null, reason?: string|null }} input.observation what the
 *   change-scope observation returned for this feature
 * @param {string} input.root project root the paths are relative to
 * @param {Object} [input.fsImpl]
 * @param {string} [input.platform] the platform the command will run on (test seam)
 * @returns {null|{ pattern: string|null, selection: { basis: string, selectedCount: number|null,
 *   totalCount: number|null, fallback: string|null } }} null when no convention applies to the toolchain
 */
function selectChangedTests({ found, observation, root, fsImpl = nodeFs, platform = process.platform }) {
  const convention = conventionFor(found);
  if (!convention) return null;

  const total = new Set();
  for (const r of convention.roots) {
    for (const file of walkFiles(fsImpl, root, r)) if (convention.isTest(file)) total.add(file);
  }
  const totalCount = total.size;
  const fallback = (reason, selectedCount = 0) => ({
    pattern: null,
    selection: { basis: convention.basis, selectedCount, totalCount, fallback: reason },
  });

  if (!observation || !Array.isArray(observation.files)) return fallback('change-scope-unavailable', null);

  const guardDir = convention.guardDir && statOf(fsImpl, path.join(root, convention.guardDir))?.isDirectory()
    ? convention.guardDir
    : null;
  const underGuard = (file) => guardDir !== null && file.startsWith(`${guardDir}/`);

  const changed = [...new Set(observation.files.map(normalize))]
    .filter((file) => convention.isTest(file))
    .filter((file) => statOf(fsImpl, path.join(root, file))?.isFile())
    .sort();
  if (changed.length === 0) return fallback('no-changed-tests');

  // A changed guard file is already covered by running the guard directory itself.
  const files = changed.filter((file) => !underGuard(file));
  const guardFiles = guardDir ? [...total].filter(underGuard).length : 0;
  // `cmd.exe` expands `%` and `!` even inside quotes, so such a path cannot be passed safely there.
  if (platform === 'win32' && files.some((file) => WIN32_UNQUOTABLE.test(file))) return fallback('unsafe-path');
  // A relative path starting with `-` would be read as a runner option, so it gets a directory prefix.
  const asArgument = (file) => (file.startsWith('-') ? `./${file}` : file);
  const words = [...files.map((file) => quotePath(asArgument(file), platform))];
  if (guardDir) words.push(quotePath(`${guardDir}/`, platform));
  return {
    pattern: words.join(' '),
    selection: {
      basis: convention.basis,
      selectedCount: files.length + guardFiles,
      totalCount,
      fallback: null,
    },
  };
}

module.exports = { selectChangedTests, quotePath, GUARD_DIR };
