'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * The feature pointer (row 135): `<storeRoot>/.doflow/state/feature/<id>.json` names the feature one
 * checkout of the repository is working on, so a fresh session reads it instead of inferring the
 * feature from the branch alone. Only the runtime writes it, when a feature is started or switched
 * (`lifecycle --action init`, an `orchestrate` start or catch-up that begins a `feature` run) and
 * clears it when the feature finishes. The branch stays the other witness: `describe` reports a
 * disagreement instead of trusting either side.
 *
 * One file per checkout, named by the first 16 hex of the sha256 of the checkout's realpath git
 * toplevel, so two worktrees on two features never share a file: there is no read-modify-write
 * across checkouts to lose an update in, and each write is a temp file renamed into place.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { resolveActiveFeature } = require('./feature-resolve.ts');

const SCHEMA = 1;
const POINTER_DIR = path.join('.doflow', 'state', 'feature');
const POINTER_NAME = /^[0-9a-f]{16}\.json$/;

interface PointerEntry { schema: number; checkout: string; slug: string; artifactDir: string | null; branch: string | null; taskId: string | null; updatedAt: string }

const checkoutId = (checkout: string): string => crypto.createHash('sha256').update(checkout).digest('hex').slice(0, 16);
/** The pointer file of the checkout whose realpath git toplevel is `checkout`. */
const pointerFile = (storeRoot: string, checkout: string): string => path.join(storeRoot, POINTER_DIR, `${checkoutId(checkout)}.json`);

function git(cwd: string, args: string[]): string | null {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; }
}

/** The checkout `cwd` is in (its realpath git toplevel) and its current branch, or null outside a repository. */
function checkoutOf(cwd: string): { key: string; branch: string | null } | null {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return null;
  let key = top;
  try { key = fs.realpathSync(top); } catch { /* keep git's spelling */ }
  return { key, branch: git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || null };
}

/** One pointer file: `{status:'none'}`, `{status:'ok', data}` or `{status:'unreadable', reason}`. */
function readEntry(file: string): { status: 'none' | 'ok' | 'unreadable'; data?: PointerEntry; reason?: string } {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error: any) {
    return error.code === 'ENOENT' ? { status: 'none' } : { status: 'unreadable', reason: error.message };
  }
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || data.schema !== SCHEMA || typeof data.slug !== 'string') {
      return { status: 'unreadable', reason: `${path.basename(file)} is not a schema ${SCHEMA} pointer file` };
    }
    return { status: 'ok', data };
  } catch (error: any) {
    return { status: 'unreadable', reason: `${path.basename(file)} is not valid JSON: ${error.message}` };
  }
}

function writeEntry(file: string, entry: PointerEntry): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(entry, null, 2)}\n`);
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* renamed away, or never written */ }
  }
}

function removeEntry(file: string): void {
  try { fs.unlinkSync(file); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
}

/** Runs a pointer write; a failure is one stderr note and never reaches the verb's exit status. */
function bestEffort(what: string, fn: () => void): void {
  try { fn(); } catch (error: any) { console.error(`doflow: note: feature pointer not ${what}: ${error.message}`); }
}

/** The artifact folder of `slug`, repo-relative: the resolver's answer, else the default folder when it exists. */
function artifactDirOf(checkout: string, storeRoot: string, slug: string): string | null {
  const found = resolveActiveFeature({ projectRoot: checkout, slug });
  if (!found.error && found.paths && typeof found.paths.feature_dir === 'string') return found.paths.feature_dir;
  const rel = path.join('agent-docs', 'doflow', slug);
  for (const root of [checkout, storeRoot]) {
    try { if (fs.statSync(path.join(root, rel)).isDirectory()) return rel; } catch { /* absent */ }
  }
  return null;
}

/** Sets the calling checkout's entry to `slug` (a later start of another slug overwrites it, and so does an unreadable file). */
function recordFeature({ storeRoot, cwd, slug, taskId = null }: { storeRoot: string; cwd: string; slug: string | null; taskId?: string | null }): void {
  if (!slug) return;
  bestEffort('written', () => {
    const here = checkoutOf(cwd);
    if (!here) return;
    writeEntry(pointerFile(storeRoot, here.key), {
      schema: SCHEMA, checkout: here.key, slug, artifactDir: artifactDirOf(here.key, storeRoot, slug), branch: here.branch, taskId, updatedAt: new Date().toISOString(),
    });
  });
}

/** Removes the calling checkout's entry when it names `slug`; an unreadable file is left alone. */
function clearCheckout({ storeRoot, cwd, slug }: { storeRoot: string; cwd: string; slug: string | null }): void {
  if (!slug) return;
  bestEffort('cleared', () => {
    const here = checkoutOf(cwd);
    if (!here) return;
    const file = pointerFile(storeRoot, here.key);
    const read = readEntry(file);
    if (read.status === 'ok' && read.data!.slug === slug) removeEntry(file);
  });
}

/** Removes every entry naming `slug`, whichever checkout holds it (the feature is finished). */
function clearSlug({ storeRoot, slug }: { storeRoot: string; slug: string | null }): void {
  if (!slug) return;
  bestEffort('cleared', () => {
    const dir = path.join(storeRoot, POINTER_DIR);
    let names: string[];
    try { names = fs.readdirSync(dir); } catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
    for (const name of names.filter((n) => POINTER_NAME.test(n))) {
      const read = readEntry(path.join(dir, name));
      if (read.status === 'ok' && read.data!.slug === slug) removeEntry(path.join(dir, name));
    }
  });
}

/**
 * What the calling checkout's pointer says against what its branch says.
 * `state`: none (no entry), agree, mismatch (branch or branch-derived slug differs) or unreadable.
 * A mismatch names neither side as the answer: `slug` is null and both are reported.
 */
function describeActive({ storeRoot, cwd }: { storeRoot: string; cwd: string }): any {
  const here = checkoutOf(cwd);
  const found = resolveActiveFeature({ projectRoot: here ? here.key : cwd });
  const derived = !found.error && found.paths && typeof found.paths.feature_slug === 'string' ? found.paths.feature_slug : null;
  const current = { branch: here ? here.branch : null, slug: derived };
  const base = { slug: null, artifactDir: null, branch: null, pointer: null, current };
  if (!here) return { ...base, state: 'none' };
  const file = pointerFile(storeRoot, here.key);
  const read = readEntry(file);
  if (read.status === 'unreadable') return { ...base, state: 'unreadable', reason: read.reason, file: path.relative(storeRoot, file) };
  if (read.status === 'none') return { ...base, state: 'none' };
  const entry = read.data!;
  const mismatch = entry.branch !== current.branch || (derived !== null && derived !== entry.slug);
  if (mismatch) return { ...base, state: 'mismatch', pointer: entry };
  return { state: 'agree', slug: entry.slug, artifactDir: entry.artifactDir ?? null, branch: entry.branch ?? null, pointer: entry, current };
}

/**
 * The calling checkout's pointer entry when its recorded branch is the checkout's branch, else null
 * (no repository, no entry, unreadable, or a branch switch since). Unlike `describeActive` it does
 * not run the feature resolver: a caller on a hot path (the context-pack verb, issue #9) needs the
 * runtime's own record, not a second derivation from the branch.
 */
function activeEntry({ storeRoot, cwd, checkout }: { storeRoot: string; cwd: string; checkout?: { repoRoot: string; branch: string | null } | null }): PointerEntry | null {
  // `checkout` is the caller's already-resolved checkout (its feature resolution): no git child is spawned for it.
  let here: { key: string; branch: string | null } | null;
  if (checkout?.repoRoot) {
    let key = checkout.repoRoot;
    try { key = fs.realpathSync(key); } catch { /* keep the resolver's spelling */ }
    here = { key, branch: checkout.branch || null };
  } else here = checkoutOf(cwd);
  if (!here) return null;
  const read = readEntry(pointerFile(storeRoot, here.key));
  return read.status === 'ok' && read.data!.branch === here.branch ? read.data! : null;
}

module.exports = { recordFeature, clearCheckout, clearSlug, describeActive, activeEntry, pointerFile, POINTER_DIR };
