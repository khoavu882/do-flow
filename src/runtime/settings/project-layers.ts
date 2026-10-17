'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * 086 IC-007, DD-9: where the project layer of the settings lives. Locates files only; both project
 * files are untrusted (D-16) and the resolver reads them. A linked worktree with no settings of its
 * own falls back to the main checkout's `.doflow/` (OI-4, a declared 2.1 change), found by reading
 * `.git` (`gitdir: <g>`) and `<g>/commondir`: two small reads, no process (no `git worktree list` per
 * verb). A sandbox (`.doflow-worktree-base`, which every dispatch worktree under
 * `<root>/.doflow/state/dispatch-worktrees/<id>` carries) stays isolated and uses only its own.
 *
 * Every fault yields the checkout's own `.doflow`, never a throw. A `.doflow` that is a symlink out of
 * its checkout is not followed: the own one yields no project layer, a main checkout's falls back to
 * the own. Pure data: the same tree gives the same answer, so the caller may memoize per process.
 */

const nodeFs = require('node:fs');
const path = require('node:path');

const MARKER = '.doflow-worktree-base';
const SETTINGS_FILES = Object.freeze(['settings.json', 'settings.local.json', 'decision-model.json', 'prune']);
const MAX_POINTER_BYTES = 4096;
const GITDIR_LINE = /^gitdir:[ \t]*([^\r\n]+?)[ \t]*\r?\n?$/;

type Checkout = 'own' | 'main' | 'sandbox';
interface ProjectLayerSource {
  /** `<dir>/.doflow` the project files are read from, or null when there is no usable project layer */
  layersFrom: string | null;
  checkout: Checkout | null;
  /** the project layer files, nearest (`settings.local.json`) first; empty with a null `layersFrom` */
  files: string[];
}

function lstatOrNull(p: string, fsImpl: any): any {
  try { return fsImpl.lstatSync(p); } catch { return null; }
}

/** The directory from `cwd` upward that holds `.git` (a folder or a file) or the sandbox marker. */
function checkoutRoot(cwd: string, fsImpl: any): { root: string; git: any } | null {
  let dir = path.resolve(cwd);
  for (;;) {
    const git = lstatOrNull(path.join(dir, '.git'), fsImpl);
    if (git) return { root: dir, git };
    if (lstatOrNull(path.join(dir, MARKER), fsImpl)) return { root: dir, git: null };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** True when `<root>/.doflow` may serve as a layer folder: absent is fine (the files are absent
 * too), a real folder is fine, a symlink must resolve inside `root`. */
function containedDoflow(root: string, fsImpl: any): boolean {
  const dir = path.join(root, '.doflow');
  const stat = lstatOrNull(dir, fsImpl);
  if (!stat || !stat.isSymbolicLink()) return true;
  try {
    const rel = path.relative(fsImpl.realpathSync(root), fsImpl.realpathSync(dir));
    return !!rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  } catch { return false; }
}

function holdsSettings(root: string, fsImpl: any): boolean {
  return SETTINGS_FILES.some((name) => lstatOrNull(path.join(root, '.doflow', name), fsImpl) !== null);
}

/** A small regular file's text, or null (missing, not a file, over the bound, unreadable). */
function readPointer(file: string, fsImpl: any): string | null {
  try {
    const stat = fsImpl.statSync(file);
    if (!stat.isFile() || stat.size > MAX_POINTER_BYTES) return null;
    const text = String(fsImpl.readFileSync(file, 'utf8'));
    return text.includes('\0') ? null : text;
  } catch { return null; }
}

/** The main checkout a linked worktree at `root` belongs to, from `.git` and `commondir`; null on any fault. */
function mainCheckoutOf(root: string, fsImpl: any): string | null {
  const pointer = readPointer(path.join(root, '.git'), fsImpl);
  const match = pointer === null ? null : GITDIR_LINE.exec(pointer);
  if (!match) return null;
  const gitdir = path.resolve(root, match[1]);
  const common = readPointer(path.join(gitdir, 'commondir'), fsImpl);
  const line = common === null ? '' : common.replace(/\r?\n$/, '');
  if (!line || /[\r\n]/.test(line)) return null;
  const commonDir = path.resolve(gitdir, line);
  return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : null;
}

function located(root: string, checkout: Checkout, fsImpl: any): ProjectLayerSource {
  if (!containedDoflow(root, fsImpl)) return { layersFrom: null, checkout: 'own', files: [] };
  const layersFrom = path.join(root, '.doflow');
  return { layersFrom, checkout, files: [path.join(layersFrom, 'settings.local.json'), path.join(layersFrom, 'settings.json')] };
}

/**
 * @param cwd any directory inside a checkout
 * @param fsImpl `lstatSync`, `statSync`, `readFileSync`, `realpathSync`
 * @returns the `.doflow` folder and the ordered layer files, with which checkout they belong to
 */
function projectLayerSource(cwd: string | null | undefined, fsImpl: any = nodeFs): ProjectLayerSource {
  if (!cwd) return { layersFrom: null, checkout: null, files: [] };
  try {
    const found = checkoutRoot(cwd, fsImpl);
    if (!found) return located(path.resolve(cwd), 'own', fsImpl);
    const { root, git } = found;
    if (git && git.isDirectory()) return located(root, 'own', fsImpl);
    if (lstatOrNull(path.join(root, MARKER), fsImpl)) return located(root, 'sandbox', fsImpl);
    if (holdsSettings(root, fsImpl)) return located(root, 'own', fsImpl);
    const main = mainCheckoutOf(root, fsImpl);
    if (main && lstatOrNull(path.join(main, '.doflow'), fsImpl) && containedDoflow(main, fsImpl)) return located(main, 'main', fsImpl);
    return located(root, 'own', fsImpl);
  } catch {
    return { layersFrom: null, checkout: null, files: [] };
  }
}

module.exports = { projectLayerSource, MARKER };
