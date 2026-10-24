'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

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

const NODE_TEST_FILE = /\.test\.(?:js|mjs|cjs|ts)$/;
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
function quotePath(file: string, platform: string = process.platform): string {
  if (SAFE_WORD.test(file)) return file;
  if (platform === 'win32') return `"${file.replace(/"/g, '""')}"`;
  return `'${file.replace(/'/g, `'\\''`)}'`;
}

/** Normalises a repository-relative path: forward slashes, no leading `./`, no trailing `/`. */
function normalize(file: any): string {
  return String(file).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
}

function statOf(fsImpl: any, file: string): any {
  try {
    return fsImpl.statSync(file);
  } catch {
    return null;
  }
}

/** Repository-relative paths of every file under `rel` (a file counts as itself). */
function walkFiles(fsImpl: any, root: string, rel: string): string[] {
  const abs = path.join(root, rel);
  const stat = statOf(fsImpl, abs);
  if (!stat) return [];
  if (stat.isFile()) return [normalize(rel)];
  if (!stat.isDirectory()) return [];
  const out: string[] = [];
  let entries: any[];
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
function conventionFor(found: any): any {
  if (found && found.source === 'package.json' && Array.isArray(found.testDirs) && found.testDirs.length > 0) {
    const roots = found.testDirs.map(normalize).filter(Boolean);
    const underRoot = (file: string) => roots.some((r: string) => file === r || file.startsWith(`${r}/`));
    return {
      basis: 'changed-test-files',
      roots,
      isTest: (file: string) => NODE_TEST_FILE.test(file) && underRoot(file),
      guardDir: roots.some((r: string) => GUARD_DIR === r || GUARD_DIR.startsWith(`${r}/`)) ? GUARD_DIR : null,
      found,
    };
  }
  if (found && found.source === 'pyproject.toml') {
    return { basis: 'changed-test-files', roots: ['.'], isTest: (file: string) => PYTEST_FILE.test(file), guardDir: null, found };
  }
  return null;
}

/**
 * Walks the test files for the toolchain described by `found`.
 * Returns sorted unique repo-relative paths of regular files that satisfy `convention.isTest`.
 * @param {Object} found the detected `testTargeted` entry
 * @param {string} root project root
 * @param {Object} [fsImpl]
 * @returns {Array<string>}
 */
function testFilesFor(found: any, root: string, fsImpl: any = nodeFs): string[] {
  const convention = conventionFor(found);
  if (!convention) return [];
  const files = new Set<string>();
  for (const r of convention.roots) {
    for (const file of walkFiles(fsImpl, root, r)) {
      if (convention.isTest(file) && statOf(fsImpl, path.join(root, file))?.isFile()) {
        files.add(file);
      }
    }
  }
  return [...files].sort();
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
function selectChangedTests({ found, observation, root, fsImpl = nodeFs, platform = process.platform }: {
  found: any;
  observation: any;
  root: string;
  fsImpl?: any;
  platform?: string;
}): any {
  const convention = conventionFor(found);
  if (!convention) return null;

  const total = new Set<string>(testFilesFor(found, root, fsImpl));
  const totalCount = total.size;
  const fallback = (reason: string, selectedCount: number | null = 0) => ({
    pattern: null,
    selection: { basis: convention.basis, selectedCount, totalCount, fallback: reason },
  });

  if (!observation || !Array.isArray(observation.files)) return fallback('change-scope-unavailable', null);

  const guardDir = convention.guardDir && statOf(fsImpl, path.join(root, convention.guardDir))?.isDirectory()
    ? convention.guardDir
    : null;
  const underGuard = (file: string) => guardDir !== null && file.startsWith(`${guardDir}/`);

  const changed = [...new Set<string>(observation.files.map(normalize))]
    .filter((file: string) => convention.isTest(file))
    .filter((file: string) => statOf(fsImpl, path.join(root, file))?.isFile())
    .sort();
  if (changed.length === 0) return fallback('no-changed-tests');

  // A changed guard file is already covered by running the guard directory itself.
  const files = changed.filter((file: string) => !underGuard(file));
  const guardFiles = guardDir ? [...total].filter(underGuard).length : 0;
  // `cmd.exe` expands `%` and `!` even inside quotes, so such a path cannot be passed safely there.
  if (platform === 'win32' && files.some((file: string) => WIN32_UNQUOTABLE.test(file))) return fallback('unsafe-path');
  // A relative path starting with `-` would be read as a runner option, so it gets a directory prefix.
  const asArgument = (file: string) => (file.startsWith('-') ? `./${file}` : file);
  const words = [...files.map((file: string) => quotePath(asArgument(file), platform))];
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

/**
 * Formats a sorted list of selected test files into a shell-quoted command argument pattern (IC-003).
 * When guardDir is present and files under guardDir are included in selectedTests, they are replaced
 * by a single quoted `${guardDir}/` token.
 *
 * @param {Object} input
 * @param {Array<string>} input.selectedTests repo-relative test paths
 * @param {string|null} [input.guardDir] optional guard directory (e.g. 'test/guards')
 * @param {string} [input.platform] platform for path quoting
 * @returns {string} shell-quoted argument string
 */
function formatSelectedTestPattern({
  selectedTests = [],
  guardDir = null,
  platform = process.platform,
}: {
  selectedTests?: string[];
  guardDir?: string | null;
  platform?: string;
}): string {
  const underGuard = (file: string) => Boolean(guardDir && (file === guardDir || file.startsWith(`${guardDir}/`)));
  const nonGuard = [...new Set(selectedTests.map(normalize))]
    .filter((f: string) => !underGuard(f))
    .sort();
  const asArgument = (file: string) => (file.startsWith('-') ? `./${file}` : file);
  const words = nonGuard.map((file: string) => quotePath(asArgument(file), platform));
  const hasGuard = Boolean(guardDir && (selectedTests.some(underGuard) || selectedTests.length === 0));
  if (hasGuard) {
    words.push(quotePath(`${guardDir}/`, platform));
  }
  return words.join(' ');
}

module.exports = {
  selectChangedTests,
  formatSelectedTestPattern,
  quotePath,
  GUARD_DIR,
  testFilesFor,
  conventionFor,
};
