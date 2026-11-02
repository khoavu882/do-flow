'use strict';

/**
 * The intake engine (136 IC-002, IC-003, IC-004): sorts the loose files of a feature's `additional-context/`
 * folder into category subfolders, previews a sort, undoes one, lists the folder and files prompt text. The
 * files are the user's, so every rule below favours leaving things alone:
 *   - only loose, non-hidden regular files at the folder's root move; subfolders, dotfiles and links never do;
 *   - nothing is deleted or overwritten (a taken destination name gets a numbered suffix) and nothing outside
 *     the folder is written;
 *   - every move is journaled `planned` before the rename and `done` after the destination's hash is checked,
 *     so a crash is reconciled by the next run and a changed file is reported, never moved again;
 *   - matching reads names and extensions only, in registry order, so the same folder gives the same moves.
 * The manifest is `manifest.ts`'s; the category rules are `taxonomy.ts`'s.
 *
 * Ceilings accepted: the manifest is rewritten whole after every journal step (quadratic in the number of
 * moves in one run, fine for the handful of loose files a context folder holds), and the no-overwrite check
 * is a look immediately before the rename, not an atomic exclusive rename.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const { categoryFolder } = require('./taxonomy.ts');
const {
  readManifest, writeManifest, withManifestLock, newRunId, isConfinedPath, assertIntakeDir, INTAKE_DIR, IntakeUsageError,
} = require('./manifest.ts');

const CONTEXT_DIR = 'additional-context';
const HASH_CHUNK = 1 << 20;

// ── small helpers ──────────────────────────────────────────────────────────────────────────────

/** Byte order of the names, so the order does not depend on the locale or on UTF-16 surrogates. */
function byBytes(a: string, b: string): number { return Buffer.compare(Buffer.from(a), Buffer.from(b)); }

function lstatOrNull(fsImpl: any, file: string): any {
  try { return fsImpl.lstatSync(file); } catch (error: any) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function stemOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** `sha256:<hex>` and size of a file, read in chunks so a 22 MB recording is never held whole. */
function hashFile(fsImpl: any, file: string): { sha256: string; bytes: number } {
  const hash = nodeCrypto.createHash('sha256');
  const fd = fsImpl.openSync(file, 'r');
  let bytes = 0;
  try {
    const buffer = Buffer.alloc(HASH_CHUNK);
    for (;;) {
      const read = fsImpl.readSync(fd, buffer, 0, HASH_CHUNK, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      bytes += read;
    }
  } finally {
    fsImpl.closeSync(fd);
  }
  return { sha256: `sha256:${hash.digest('hex')}`, bytes };
}

function hashBytes(buffer: Buffer): string { return `sha256:${nodeCrypto.createHash('sha256').update(buffer).digest('hex')}`; }

const rel = (...parts: string[]): string => parts.join('/');

/** The context folder as a real directory, or null when absent. A link or a plain file there is refused. */
function contextState(contextDir: string, fsImpl: any): 'absent' | 'present' {
  const stat = lstatOrNull(fsImpl, contextDir);
  if (!stat) return 'absent';
  if (stat.isSymbolicLink()) throw new IntakeUsageError(`${contextDir} is a symbolic link; intake works only inside a real additional-context folder`);
  if (!stat.isDirectory()) throw new IntakeUsageError(`${contextDir} exists and is not a folder`);
  return 'present';
}

/**
 * Checks the folder chain `dir` (relative, `/`-separated) under the context folder. Existing links and files
 * on the chain are refused; the folders that do not exist yet are returned, shallowest first.
 */
function chainOf(contextDir: string, dir: string, fsImpl: any): { missing: string[]; bad: string | null } {
  const missing: string[] = [];
  let walked = '';
  for (const segment of dir.split('/')) {
    walked = walked ? rel(walked, segment) : segment;
    const stat = lstatOrNull(fsImpl, path.join(contextDir, walked));
    if (!stat) missing.push(walked);
    else if (!stat.isDirectory()) return { missing, bad: `${walked} exists and is not a plain folder` };
  }
  return { missing, bad: null };
}

// ── planning ───────────────────────────────────────────────────────────────────────────────────

/** Creates one folder; false when it already exists as a folder (someone made it since the plan). */
function makeDir(fsImpl: any, dir: string): boolean {
  try {
    fsImpl.mkdirSync(dir);
    return true;
  } catch (error: any) {
    if (error.code === 'EEXIST' && lstatOrNull(fsImpl, dir)?.isDirectory()) return false;
    throw error;
  }
}

/**
 * Root entries of the context folder: loose files and folder names. Hidden names, links and others are not either.
 * A loose file whose name the manifest could not hold (the `isConfinedPath` rule, e.g. a backslash) is listed in
 * `unsupported`, never in `files`: journaling it would make the manifest unreadable on every later call.
 */
function rootEntries(contextDir: string, fsImpl: any): { files: string[]; dirs: Set<string>; unsupported: string[] } {
  const files: string[] = [];
  const unsupported: string[] = [];
  const dirs = new Set<string>();
  for (const entry of fsImpl.readdirSync(contextDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isFile()) (isConfinedPath(entry.name) ? files : unsupported).push(entry.name);
    else if (entry.isDirectory()) dirs.add(entry.name);
  }
  return { files: files.sort(byBytes), dirs, unsupported: unsupported.sort(byBytes) };
}

function ruleMatches(rule: any, name: string): boolean {
  if (!rule.extensions.includes(extOf(name))) return false;
  return !rule.namePattern || new RegExp(rule.namePattern, 'i').test(stemOf(name));
}

/** The first non-companion rule that claims `name`, in category then rule order. */
function directClaim(categories: any[], name: string): any {
  for (const category of categories) {
    for (const rule of category.rules) {
      if (!rule.companionOf && ruleMatches(rule, name)) return { category, rule };
    }
  }
  return null;
}

/**
 * Plans a sort of the loose files (IC-002). Pure with respect to the folder: it reads, hashes and decides, and
 * writes nothing. A companion rule sends a file beside a same-stem file that is itself moving in this plan.
 */
function planSort({ contextDir, taxonomy, now, fsImpl = nodeFs, withHashes = true }: any): any {
  const { files, dirs, unsupported } = rootEntries(contextDir, fsImpl);
  const windowMs = taxonomy.recentWindowSeconds * 1000;
  const recent = new Set<string>();
  for (const name of files) {
    if (windowMs > 0 && now.getTime() - fsImpl.lstatSync(path.join(contextDir, name)).mtimeMs < windowMs) recent.add(name);
  }

  // Phase 1: direct claims. A file that is recent does not move, so it is nobody's companion either.
  const direct = new Map<string, any>();
  for (const name of files) {
    const claim = directClaim(taxonomy.categories, name);
    if (claim) direct.set(name, claim);
  }
  const movers = files.filter((name: string) => direct.has(name) && !recent.has(name));

  const placeOf = (claim: any): { dir: string; categoryId: string } => {
    const folder = categoryFolder(claim.category, dirs);
    return { dir: claim.rule.into ? rel(folder, claim.rule.into) : folder, categoryId: claim.category.id };
  };

  // Phase 2: the final claim of each file, rules in order, a companion rule resolved against the movers.
  const claimOf = (name: string): { dir: string; categoryId: string } | null => {
    for (const category of taxonomy.categories) {
      for (const rule of category.rules) {
        if (!ruleMatches(rule, name)) continue;
        if (!rule.companionOf) return placeOf({ category, rule });
        const stem = stemOf(name);
        const partner = movers.find((other: string) => other !== name && stemOf(other) === stem && rule.companionOf.includes(extOf(other)));
        if (partner) return placeOf(direct.get(partner));
      }
    }
    return null;
  };

  const moves: any[] = [];
  const skipped: any[] = unsupported.map((name: string) => ({ path: name, reason: 'unsupported-name', detail: 'the name cannot be recorded in the manifest' }));
  const unmatched: string[] = [];
  const createdDirs: string[] = [];
  const taken = new Set<string>();
  const chains = new Map<string, { missing: string[]; bad: string | null }>();
  for (const name of files) {
    const claim = claimOf(name);
    if (!claim) { unmatched.push(name); continue; }
    if (recent.has(name)) { skipped.push({ path: name, reason: 'recent' }); continue; }
    if (!chains.has(claim.dir)) chains.set(claim.dir, chainOf(contextDir, claim.dir, fsImpl));
    const chain = chains.get(claim.dir) as { missing: string[]; bad: string | null };
    if (chain.bad) { skipped.push({ path: name, reason: 'failed', detail: `destination folder ${claim.dir}: ${chain.bad}` }); continue; }
    const to = freeName(contextDir, claim.dir, name, taken, fsImpl);
    taken.add(to.toLowerCase());
    for (const dir of chain.missing) if (!createdDirs.includes(dir)) createdDirs.push(dir);
    const from = path.join(contextDir, name);
    const stat = withHashes ? hashFile(fsImpl, from) : { sha256: null, bytes: fsImpl.lstatSync(from).size };
    moves.push({ from: name, to, category: claim.categoryId, sha256: stat.sha256, bytes: stat.bytes });
  }
  return { moves, skipped, unmatched, createdDirs };
}

/** The first free relative path for `name` in `dir`: the name itself, else `<stem>-<n><.ext>`. */
function freeName(contextDir: string, dir: string, name: string, taken: Set<string>, fsImpl: any): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 0; ; n += 1) {
    const candidate = rel(dir, n === 0 ? name : `${stem}-${n}${ext}`);
    if (!taken.has(candidate.toLowerCase()) && !lstatOrNull(fsImpl, path.join(contextDir, candidate))) return candidate;
  }
}

// ── manifest reconcile ─────────────────────────────────────────────────────────────────────────

/**
 * IC-007: settles every `planned` move left by a run that died between its steps. The origin still holding a
 * file means the rename never happened (`failed`); a destination holding the recorded hash with the origin
 * empty means it did (`done`). Anything else is `failed`. Returns true when the manifest changed.
 */
function reconcile(manifest: any, contextDir: string, now: Date, fsImpl: any): boolean {
  let changed = false;
  for (const run of manifest.runs) {
    let settled = false;
    for (const move of run.moves) {
      if (move.state !== 'planned') continue;
      const toStat = lstatOrNull(fsImpl, path.join(contextDir, move.to));
      const fromStat = move.from === null ? null : lstatOrNull(fsImpl, path.join(contextDir, move.from));
      const toIsFile = Boolean(toStat && toStat.isFile());
      if (fromStat) {
        move.state = 'failed';
        move.reason = 'the move did not complete: the origin still holds a file';
      } else if (toIsFile && hashFile(fsImpl, path.join(contextDir, move.to)).sha256 === move.sha256) {
        move.state = 'done';
        move.reason = null;
      } else {
        move.state = 'failed';
        move.reason = toIsFile ? 'the destination does not hold the recorded content' : 'neither the origin nor the destination holds the file';
      }
      settled = true;
      changed = true;
    }
    if (settled && run.finishedAt === null) run.finishedAt = now.toISOString();
  }
  return changed;
}

const hasPlanned = (manifest: any): boolean => manifest.runs.some((run: any) => run.moves.some((move: any) => move.state === 'planned'));

// ── actions ────────────────────────────────────────────────────────────────────────────────────

const absent = (action: string, extra: any = {}): any => ({ action, state: 'absent', ...extra });
const absentSort = (action: string): any => absent(action, { runId: null, moves: [], skipped: [], unmatched: [], createdDirs: [] });

/** IC-002 preview: the plan, with `runId: null`; no lock, no manifest, no write. */
function previewSort({ contextDir, taxonomy, now = new Date(), fsImpl = nodeFs }: any): any {
  if (contextState(contextDir, fsImpl) === 'absent') return absentSort('preview');
  return { action: 'preview', state: 'sorted', runId: null, ...planSort({ contextDir, taxonomy, now, fsImpl }) };
}

/** IC-002 sort. */
function sortFolder({ contextDir, taxonomy, now = new Date(), fsImpl = nodeFs }: any): any {
  if (contextState(contextDir, fsImpl) === 'absent') return absentSort('sort');
  const empty = (plan: any): any => ({ action: 'sort', state: 'sorted', runId: null, moves: [], skipped: plan.skipped, unmatched: plan.unmatched, createdDirs: [] });
  // Nothing to move and nothing to settle: report without a lock or a single write.
  const first = planSort({ contextDir, taxonomy, now, fsImpl, withHashes: false });
  if (first.moves.length === 0 && !hasPlanned(readManifest(contextDir, fsImpl))) return empty(first);

  return withManifestLock(contextDir, () => {
    const manifest = readManifest(contextDir, fsImpl);
    if (reconcile(manifest, contextDir, now, fsImpl)) writeManifest(contextDir, manifest, fsImpl);
    const plan = planSort({ contextDir, taxonomy, now, fsImpl });
    if (plan.moves.length === 0) return empty(plan);

    const run: any = { id: newRunId(now), action: 'sort', startedAt: now.toISOString(), finishedAt: null, source: null, stage: null, createdDirs: [], moves: [] };
    manifest.runs.push(run);
    const moves: any[] = [];
    const skipped: any[] = [...plan.skipped];
    for (const planned of plan.moves) {
      const from = path.join(contextDir, planned.from);
      const to = path.join(contextDir, planned.to);
      const entry: any = { from: planned.from, to: planned.to, sha256: planned.sha256, bytes: planned.bytes, at: now.toISOString(), state: 'planned', reason: null };
      const fail = (reason: string): void => {
        entry.state = 'failed';
        entry.reason = reason;
        skipped.push({ path: planned.from, reason: 'failed', detail: reason });
        writeManifest(contextDir, manifest, fsImpl);
      };
      const chain = chainOf(contextDir, path.posix.dirname(planned.to), fsImpl);
      if (chain.bad) {
        run.moves.push(entry);
        fail(`destination folder: ${chain.bad}`);
        continue;
      }
      let madeDirs = true;
      for (const dir of chain.missing) {
        try {
          if (makeDir(fsImpl, path.join(contextDir, dir))) run.createdDirs.push(dir);
        } catch (error: any) {
          // A folder that cannot be created fails this move only; the file stays where it is.
          run.moves.push(entry);
          fail(`destination folder ${dir} could not be created: ${error.code ?? error.message}`);
          madeDirs = false;
          break;
        }
      }
      if (!madeDirs) continue;
      run.moves.push(entry);
      writeManifest(contextDir, manifest, fsImpl); // journal: planned
      if (lstatOrNull(fsImpl, to)) { fail('the destination appeared before the move'); continue; }
      try {
        fsImpl.renameSync(from, to);
      } catch (error: any) {
        fail(`rename failed: ${error.message}`);
        continue;
      }
      const after = hashFile(fsImpl, to).sha256;
      if (after !== planned.sha256) {
        fail(`the destination hash ${after} differs from the hash ${planned.sha256} taken before the move`);
        continue;
      }
      entry.state = 'done';
      moves.push({ from: planned.from, to: planned.to, category: planned.category, sha256: planned.sha256, bytes: planned.bytes });
    }
    run.finishedAt = now.toISOString();
    writeManifest(contextDir, manifest, fsImpl);
    return { action: 'sort', state: 'sorted', runId: run.id, moves, skipped, unmatched: plan.unmatched, createdDirs: run.createdDirs };
  }, fsImpl);
}

/**
 * IC-003 undo. Entries in state `done` (and `undo-skipped`, when a run is named) are restored newest first.
 * A `file-prompt` run has no origin, and undo never deletes, so naming one is refused.
 */
function undoRun({ contextDir, runId = null, now = new Date(), fsImpl = nodeFs }: any): any {
  if (contextState(contextDir, fsImpl) === 'absent') return absent('undo', { runId: null, restored: [], skipped: [], removedDirs: [] });
  assertIntakeDir(contextDir, fsImpl);
  if (!lstatOrNull(fsImpl, path.join(contextDir, INTAKE_DIR))) {
    if (runId) throw new IntakeUsageError(`no run '${runId}' in the manifest`);
    return nothingToUndo();
  }
  return withManifestLock(contextDir, () => {
    const manifest = readManifest(contextDir, fsImpl);
    if (reconcile(manifest, contextDir, now, fsImpl)) writeManifest(contextDir, manifest, fsImpl);
    let run: any;
    if (runId) {
      run = manifest.runs.find((candidate: any) => candidate.id === runId);
      if (!run) throw new IntakeUsageError(`no run '${runId}' in the manifest`);
      if (run.action !== 'sort') throw new IntakeUsageError(`run '${runId}' filed prompt text; it has no origin to restore and undo never deletes a file`);
    } else {
      run = [...manifest.runs].reverse().find((candidate: any) => candidate.action === 'sort' && candidate.moves.some((move: any) => move.state === 'done'));
      if (!run) return nothingToUndo();
    }
    const restored: any[] = [];
    const skipped: any[] = [];
    const retry = runId ? ['done', 'undo-skipped'] : ['done'];
    const skip = (move: any, reason: string): void => {
      move.state = 'undo-skipped';
      move.reason = reason;
      skipped.push({ to: move.to, reason });
    };
    for (const move of [...run.moves].reverse()) {
      if (!retry.includes(move.state)) continue;
      const from = path.join(contextDir, move.from);
      const to = path.join(contextDir, move.to);
      const toStat = lstatOrNull(fsImpl, to);
      const fromStat = lstatOrNull(fsImpl, from);
      if (!toStat) {
        // A restore that died before it was journaled: the origin already holds the recorded content.
        if (fromStat && fromStat.isFile() && hashFile(fsImpl, from).sha256 === move.sha256) {
          move.state = 'undone';
          move.reason = null;
          restored.push({ from: move.from, to: move.to });
        } else {
          skip(move, 'missing');
        }
      } else if (!toStat.isFile() || hashFile(fsImpl, to).sha256 !== move.sha256) {
        skip(move, 'changed');
      } else if (fromStat) {
        skip(move, 'origin-taken');
      } else {
        const chain = chainOf(contextDir, path.posix.dirname(move.to), fsImpl);
        if (chain.bad || chain.missing.length) { skip(move, 'changed'); } else {
          fsImpl.renameSync(to, from);
          if (hashFile(fsImpl, from).sha256 === move.sha256) {
            move.state = 'undone';
            move.reason = null;
            restored.push({ from: move.from, to: move.to });
          } else {
            skip(move, 'changed');
          }
        }
      }
      writeManifest(contextDir, manifest, fsImpl);
    }
    // A folder this run created goes only when it is empty now: rmdir cannot delete a file.
    const removedDirs: string[] = [];
    for (const dir of [...run.createdDirs].reverse()) {
      const full = path.join(contextDir, dir);
      const stat = lstatOrNull(fsImpl, full);
      if (stat && stat.isDirectory() && fsImpl.readdirSync(full).length === 0) {
        fsImpl.rmdirSync(full);
        removedDirs.push(dir);
      }
    }
    return { action: 'undo', state: 'undone', runId: run.id, restored, skipped, removedDirs };
  }, fsImpl);
}

function nothingToUndo(): any {
  return { action: 'undo', state: 'nothing-to-undo', runId: null, restored: [], skipped: [], removedDirs: [] };
}

/** IC-004 list: every non-hidden regular file, recursively, outside `.intake/`; contents are only hashed. */
function listFolder({ contextDir, taxonomy, fsImpl = nodeFs }: any): any {
  if (contextState(contextDir, fsImpl) === 'absent') return absent('list', { files: [] });
  const owners = new Map<string, string>();
  for (const category of taxonomy.categories) for (const name of [category.id, ...category.names]) owners.set(name, category.id);
  const text = new Set(taxonomy.textExtensions);
  const files: any[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fsImpl.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const relative = prefix ? rel(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) { walk(path.join(dir, entry.name), relative); continue; }
      if (!entry.isFile()) continue;
      const { sha256, bytes } = hashFile(fsImpl, path.join(dir, entry.name));
      const ext = extOf(entry.name);
      files.push({
        path: relative,
        category: owners.get(relative.split('/')[0]) ?? null,
        kind: text.has(ext) ? 'text' : 'binary',
        bytes,
        sha256,
        pointer: ext === 'md' && bytes <= taxonomy.pointerMaxBytes,
      });
    }
  };
  walk(contextDir, '');
  files.sort((a: any, b: any) => byBytes(a.path, b.path));
  return { action: 'list', state: 'listed', files };
}

/**
 * IC-004 file-prompt: writes `bytes` unchanged to `<prompt folder>/prompt-<YYYY-MM-DD>-<NN>.md` and records the
 * provenance in the manifest, never in the file. Creates the context folder when it does not exist.
 */
function filePrompt({ contextDir, taxonomy, bytes, stage = null, now = new Date(), fsImpl = nodeFs }: any): any {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new IntakeUsageError('there is no prompt text to file: the input is empty');
  if (contextState(contextDir, fsImpl) === 'absent') {
    const parent = lstatOrNull(fsImpl, path.dirname(contextDir));
    if (!parent || !parent.isDirectory()) throw new IntakeUsageError(`${path.dirname(contextDir)} is not a feature folder that exists`);
    makeDir(fsImpl, contextDir);
  }
  return withManifestLock(contextDir, () => {
    const manifest = readManifest(contextDir, fsImpl);
    if (reconcile(manifest, contextDir, now, fsImpl)) writeManifest(contextDir, manifest, fsImpl);
    const category = taxonomy.categories.find((candidate: any) => candidate.id === taxonomy.promptCategory);
    const dir = categoryFolder(category, rootEntries(contextDir, fsImpl).dirs);
    const chain = chainOf(contextDir, dir, fsImpl);
    if (chain.bad) throw new IntakeUsageError(`the prompt folder ${dir}: ${chain.bad}`);
    const day = now.toISOString().slice(0, 10);
    let to: string;
    for (let n = 1; ; n += 1) {
      to = rel(dir, `prompt-${day}-${String(n).padStart(2, '0')}.md`);
      if (!lstatOrNull(fsImpl, path.join(contextDir, to))) break;
    }
    const sha256 = hashBytes(bytes);
    const run: any = { id: newRunId(now), action: 'file-prompt', startedAt: now.toISOString(), finishedAt: null, source: 'prompt', stage, createdDirs: [], moves: [] };
    const entry: any = { from: null, to, sha256, bytes: bytes.length, at: now.toISOString(), state: 'planned', reason: null };
    for (const made of chain.missing) if (makeDir(fsImpl, path.join(contextDir, made))) run.createdDirs.push(made);
    run.moves.push(entry);
    manifest.runs.push(run);
    writeManifest(contextDir, manifest, fsImpl); // journal: planned
    // Written beside the manifest, then renamed into place, so the file is whole or absent.
    const tmp = path.join(contextDir, INTAKE_DIR, `prompt.${process.pid}.tmp`);
    try {
      fsImpl.writeFileSync(tmp, bytes, { flag: 'wx' });
      if (lstatOrNull(fsImpl, path.join(contextDir, to))) throw new Error('the destination appeared before the write');
      fsImpl.renameSync(tmp, path.join(contextDir, to));
    } catch (error: any) {
      try { fsImpl.rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
      entry.state = 'failed';
      entry.reason = `write failed: ${error.message}`;
      run.finishedAt = now.toISOString();
      writeManifest(contextDir, manifest, fsImpl);
      throw new IntakeUsageError(`could not file the prompt text: ${error.message}`);
    }
    entry.state = hashFile(fsImpl, path.join(contextDir, to)).sha256 === sha256 ? 'done' : 'failed';
    if (entry.state === 'failed') entry.reason = 'the filed file does not hold the input bytes';
    run.finishedAt = now.toISOString();
    writeManifest(contextDir, manifest, fsImpl);
    if (entry.state === 'failed') throw new IntakeUsageError(`could not file the prompt text: ${entry.reason}`);
    return { action: 'file-prompt', path: to, sha256, bytes: bytes.length, runId: run.id };
  }, fsImpl);
}

module.exports = { previewSort, sortFolder, undoRun, listFolder, filePrompt, planSort, reconcile, hashFile, CONTEXT_DIR };
