'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * The feature pointer (row 135): `<storeRoot>/.doflow/state/feature.json` names the feature each
 * checkout of the repository is working on, so a fresh session reads it instead of inferring the
 * feature from the branch alone. Only the runtime writes it, when a feature is started or switched
 * (`lifecycle --action init`, `orchestrate --action start` for a `feature` run) and clears it when
 * the feature finishes. The branch stays the other witness: `describe` reports a disagreement
 * instead of trusting either side.
 *
 * Keyed by the checkout's git toplevel, so two worktrees on two features never overwrite each
 * other. Ceiling accepted: a read-modify-write with no lock, so two verbs recording in the same
 * millisecond from different checkouts can drop one entry; the next start rewrites it.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveActiveFeature } = require('./feature-resolve.ts');

const SCHEMA = 1;
const POINTER_REL = path.join('.doflow', 'state', 'feature.json');

interface PointerEntry { slug: string; artifactDir: string | null; branch: string | null; taskId: string | null; updatedAt: string }

const pointerFile = (storeRoot: string): string => path.join(storeRoot, POINTER_REL);

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

/** The pointer file: `{status:'none'}`, `{status:'ok', data}` or `{status:'unreadable', reason}`. */
function readPointer(storeRoot: string): { status: 'none' | 'ok' | 'unreadable'; data?: any; reason?: string } {
  let text: string;
  try { text = fs.readFileSync(pointerFile(storeRoot), 'utf8'); } catch (error: any) {
    return error.code === 'ENOENT' ? { status: 'none' } : { status: 'unreadable', reason: error.message };
  }
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || data.schema !== SCHEMA || !data.checkouts || typeof data.checkouts !== 'object' || Array.isArray(data.checkouts)) {
      return { status: 'unreadable', reason: `feature.json is not a schema ${SCHEMA} pointer file` };
    }
    return { status: 'ok', data };
  } catch (error: any) {
    return { status: 'unreadable', reason: `feature.json is not valid JSON: ${error.message}` };
  }
}

function writePointer(storeRoot: string, checkouts: Record<string, PointerEntry>): void {
  const file = pointerFile(storeRoot);
  if (Object.keys(checkouts).length === 0) {
    try { fs.unlinkSync(file); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify({ schema: SCHEMA, checkouts }, null, 2)}\n`);
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* renamed away, or never written */ }
  }
}

/** Runs a pointer write; a failure is one stderr note and never reaches the verb's exit status. */
function bestEffort(what: string, fn: () => void): void {
  try { fn(); } catch (error: any) { console.error(`doflow: note: feature pointer not ${what}: ${error.message}`); }
}

/** A readable pointer's checkouts map; an unreadable file is replaced on record and left alone on clear. */
function checkoutsFor(storeRoot: string, { replaceUnreadable }: { replaceUnreadable: boolean }): Record<string, PointerEntry> | null {
  const read = readPointer(storeRoot);
  if (read.status === 'ok') return { ...read.data.checkouts };
  if (read.status === 'none' || replaceUnreadable) return {};
  return null;
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

/** Sets the calling checkout's entry to `slug` (a later start of another slug overwrites it). */
function recordFeature({ storeRoot, cwd, slug, taskId = null }: { storeRoot: string; cwd: string; slug: string | null; taskId?: string | null }): void {
  if (!slug) return;
  bestEffort('written', () => {
    const here = checkoutOf(cwd);
    if (!here) return;
    const checkouts = checkoutsFor(storeRoot, { replaceUnreadable: true }) as Record<string, PointerEntry>;
    checkouts[here.key] = { slug, artifactDir: artifactDirOf(here.key, storeRoot, slug), branch: here.branch, taskId, updatedAt: new Date().toISOString() };
    writePointer(storeRoot, checkouts);
  });
}

/** Removes the calling checkout's entry when it names `slug`. */
function clearCheckout({ storeRoot, cwd, slug }: { storeRoot: string; cwd: string; slug: string | null }): void {
  if (!slug) return;
  bestEffort('cleared', () => {
    const here = checkoutOf(cwd);
    const checkouts = checkoutsFor(storeRoot, { replaceUnreadable: false });
    if (!here || !checkouts || !checkouts[here.key] || checkouts[here.key].slug !== slug) return;
    delete checkouts[here.key];
    writePointer(storeRoot, checkouts);
  });
}

/** Removes every entry naming `slug`, whichever checkout holds it (the feature is finished). */
function clearSlug({ storeRoot, slug }: { storeRoot: string; slug: string | null }): void {
  if (!slug) return;
  bestEffort('cleared', () => {
    const checkouts = checkoutsFor(storeRoot, { replaceUnreadable: false });
    if (!checkouts) return;
    const kept = Object.fromEntries(Object.entries(checkouts).filter(([, entry]) => !entry || entry.slug !== slug));
    if (Object.keys(kept).length !== Object.keys(checkouts).length) writePointer(storeRoot, kept);
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
  const read = readPointer(storeRoot);
  if (read.status === 'unreadable') return { ...base, state: 'unreadable', reason: read.reason };
  const entry = read.status === 'ok' && here ? read.data.checkouts[here.key] : null;
  if (!entry || typeof entry !== 'object' || typeof entry.slug !== 'string') return { ...base, state: 'none' };
  const mismatch = entry.branch !== current.branch || (derived !== null && derived !== entry.slug);
  if (mismatch) return { ...base, state: 'mismatch', pointer: entry };
  return { state: 'agree', slug: entry.slug, artifactDir: entry.artifactDir ?? null, branch: entry.branch ?? null, pointer: entry, current };
}

module.exports = { recordFeature, clearCheckout, clearSlug, describeActive, readPointer, pointerFile, POINTER_REL };
