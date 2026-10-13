'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

interface TreeState {
  gitCommit: string | null;
  dirty: Set<string> | null;
  prefix: string | null;
  fingerprint: string | null;
}

type GitRunner = (args: string[], cwd?: string) => string | null;

interface SourceVersion {
  gitCommit: string | null;
  fileHash: string | null;
  isDirty: boolean | null;
}

const treeStateMemo = new Map<string, TreeState>();

function clearTreeStateCache(): void {
  treeStateMemo.clear();
}

/**
 * Finds the top of the git work tree and root's relative prefix below it using filesystem reads only.
 */
function findWorkTreeTop(root: string): { top: string | null; prefix: string | null } {
  let current = path.resolve(root);
  while (true) {
    try {
      if (fs.existsSync(path.join(current, '.git'))) {
        const rel = path.relative(current, path.resolve(root));
        const prefix = rel && rel !== '.' ? (rel.split(path.sep).join('/') + '/') : '';
        return { top: current, prefix };
      }
    } catch {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { top: null, prefix: null };
}

function defaultGitRunner(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/**
 * Measures the repository's HEAD commit, dirty paths and tree fingerprint with one git status call.
 */
function measureTreeState(root: string, runner?: GitRunner): TreeState {
  const absRoot = path.resolve(root);
  if (!runner && treeStateMemo.has(absRoot)) {
    return treeStateMemo.get(absRoot)!;
  }

  const { top: workTreeTop, prefix } = findWorkTreeTop(absRoot);
  if (!workTreeTop) {
    const unmeasured: TreeState = {
      gitCommit: null,
      dirty: null,
      prefix: null,
      fingerprint: null,
    };
    if (!runner) treeStateMemo.set(absRoot, unmeasured);
    return unmeasured;
  }

  const args = ['-C', absRoot, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--ignored=matching'];
  const raw = runner ? runner(args, absRoot) : defaultGitRunner(args, absRoot);

  if (raw === null || raw === undefined) {
    const commit = runner
      ? runner(['-C', absRoot, 'rev-parse', 'HEAD'], absRoot)
      : defaultGitRunner(['-C', absRoot, 'rev-parse', 'HEAD'], absRoot);
    const failed: TreeState = {
      gitCommit: commit?.trim() || null,
      dirty: null,
      prefix,
      fingerprint: null,
    };
    if (!runner) treeStateMemo.set(absRoot, failed);
    return failed;
  }

  const tokens = raw.split('\0');
  let gitCommit: string | null = null;
  const dirty = new Set<string>();
  const entryRecords: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;

    if (token.startsWith('# branch.oid ')) {
      const oid = token.slice('# branch.oid '.length).trim();
      if (oid && oid !== '(initial)') {
        gitCommit = oid;
      }
      continue;
    }
    if (token.startsWith('# ')) {
      continue;
    }

    if (token.startsWith('! ')) {
      const ignoredPath = token.slice(2);
      if (prefix && (ignoredPath === prefix.slice(0, -1) || ignoredPath === `${prefix.slice(0, -1)}/`)) {
        const ignored: TreeState = { gitCommit, dirty: null, prefix, fingerprint: null };
        if (!runner) treeStateMemo.set(absRoot, ignored);
        return ignored;
      }
      continue;
    }

    let dirtyPath: string | null = null;
    let entryText = token;

    if (token.startsWith('1 ')) {
      const parts = token.split(' ');
      dirtyPath = parts.slice(8).join(' ');
      dirty.add(dirtyPath);
    } else if (token.startsWith('2 ')) {
      const parts = token.split(' ');
      dirtyPath = parts.slice(9).join(' ');
      dirty.add(dirtyPath);
      if (i + 1 < tokens.length && tokens[i + 1]) {
        const origPath = tokens[i + 1];
        dirty.add(origPath);
        entryText = `${token}\0${origPath}`;
        i++;
      }
    } else if (token.startsWith('u ')) {
      const parts = token.split(' ');
      dirtyPath = parts.slice(10).join(' ');
      dirty.add(dirtyPath);
    } else if (token.startsWith('? ')) {
      dirtyPath = token.slice(2);
      dirty.add(dirtyPath);
    }

    if (dirtyPath !== null) {
      const statePath = `${prefix}.doflow/state/`;
      const normalizedDirtyPath = dirtyPath.split(path.sep).join('/');
      const shouldFingerprint = !normalizedDirtyPath.startsWith(statePath);
      if (shouldFingerprint && /^(?:1|2|u) \S+ S\.M /.test(token)) {
        const nestedRoot = path.resolve(workTreeTop, dirtyPath);
        const nested = measureNestedRepository(nestedRoot);
        if (nested === null) {
          const unknown: TreeState = { gitCommit, dirty: null, prefix, fingerprint: null };
          if (!runner) treeStateMemo.set(absRoot, unknown);
          return unknown;
        }
        entryRecords.push(`${entryText}:nested:${nested}`);
        continue;
      }
      if (shouldFingerprint && token.startsWith('? ')) {
        const nestedRoot = path.resolve(workTreeTop, dirtyPath.replace(/\/$/, ''));
        if (fs.existsSync(path.join(nestedRoot, '.git'))) {
          const nested = measureNestedRepository(nestedRoot);
          if (nested === null) {
            const unknown: TreeState = { gitCommit, dirty: null, prefix, fingerprint: null };
            if (!runner) treeStateMemo.set(absRoot, unknown);
            return unknown;
          }
          entryRecords.push(`${entryText}:nested:${nested}`);
          continue;
        }
      }
      if (!shouldFingerprint) continue;
      let statTerm = 'absent';
      try {
        const absPath = path.resolve(workTreeTop, dirtyPath);
        const st = fs.statSync(absPath);
        statTerm = `${st.size}:${st.mtimeMs}`;
      } catch {
        statTerm = 'absent';
      }
      entryRecords.push(`${entryText}:${statTerm}`);
    }
  }

  if (!gitCommit) {
    const uncommitted: TreeState = {
      gitCommit: null,
      dirty: null,
      prefix,
      fingerprint: null,
    };
    if (!runner) treeStateMemo.set(absRoot, uncommitted);
    return uncommitted;
  }

  const hash = crypto.createHash('sha256');
  hash.update(gitCommit);
  hash.update('\0');
  hash.update(entryRecords.sort().join('\0'));
  const fingerprint = `sha256:${hash.digest('hex')}`;

  const state: TreeState = {
    gitCommit,
    dirty,
    prefix,
    fingerprint,
  };
  if (!runner) treeStateMemo.set(absRoot, state);
  return state;
}

function measureNestedRepository(root: string): string | null {
  try {
    const gitEntry = path.join(root, '.git');
    const gitStat = fs.statSync(gitEntry);
    const gitDir = gitStat.isFile()
      ? path.resolve(root, fs.readFileSync(gitEntry, 'utf8').trim().replace(/^gitdir:\s*/, ''))
      : gitEntry;
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const headRef = head.startsWith('ref: ')
      ? fs.readFileSync(path.join(gitDir, head.slice('ref: '.length)), 'utf8').trim()
      : head;
    const index = fs.statSync(path.join(gitDir, 'index'));
    return `${head}:${headRef}:${index.mtimeMs}:${index.size}`;
  } catch {
    return null;
  }
}

function fileHash(root: string, locator: any): string | null {
  if (!locator?.file) return null;
  try {
    const absolute = path.resolve(root, locator.file);
    if (!fs.statSync(absolute).isFile()) return null;
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}`;
  } catch {
    return null;
  }
}

/**
 * Derives source version { gitCommit, fileHash, isDirty } for a given locator and tree state.
 */
function sourceVersionFor(root: string, locator: any, state: TreeState): SourceVersion {
  const hash = fileHash(root, locator);
  if (!locator?.file || !state || !state.dirty) {
    return {
      gitCommit: state?.gitCommit ?? null,
      fileHash: hash,
      isDirty: null,
    };
  }

  const prefix = state.prefix || '';
  if (path.isAbsolute(locator.file)) {
    return { gitCommit: state.gitCommit ?? null, fileHash: hash, isDirty: null };
  }
  const candidate = path.posix.normalize(`${prefix}${locator.file.split(path.sep).join('/')}`).replace(/^\.\//, '');
  const isDirty = state.dirty.has(candidate);

  return {
    gitCommit: state.gitCommit ?? null,
    fileHash: hash,
    isDirty,
  };
}

module.exports = {
  measureTreeState,
  sourceVersionFor,
  clearTreeStateCache,
};
