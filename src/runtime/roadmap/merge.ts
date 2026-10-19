'use strict';

/** IC-009: local, replayable merge plumbing. The caller owns the one-step lease and gate approval. */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { parseSeed, deriveStatus, render, renderRoadmapFile } = require('./rows.ts');
const { gatherGitFacts } = require('./facts.ts');

const PHASES = ['intent', 'built', 'ff-started', 'ff-done', 'rendered', 'cleaned'];
const SHA = /^[a-f0-9]{40}$/;
const ROW = /^[0-9]{3}([a-z]|-[A-Z])?$/;

function intentDirectory(root: string): string {
  return path.join(root, '.doflow', 'state', 'roadmap', 'intents');
}

function doneDirectory(root: string): string {
  return path.join(root, '.doflow', 'state', 'roadmap', 'done');
}

function readIntent(file: string, fsImpl: any = fs): any {
  let raw: string;
  try { raw = fsImpl.readFileSync(file, 'utf8'); }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
  const value = JSON.parse(raw);
  if (value.schema !== 1 || !ROW.test(value.row) || !PHASES.includes(value.phase)
    || !SHA.test(value.developHead) || !SHA.test(value.featureHead)
    || typeof value.slug !== 'string' || !value.slug.startsWith(`${value.row}-`)
    || value.featureBranch !== `feat/${value.slug}` || !path.isAbsolute(value.developWorktree)
    || !value.identity?.name || !value.identity?.email || !/^\d+ [+-]\d{4}$/.test(value.identity?.date)
    || typeof value.message !== 'string') throw new Error(`unreadable merge intent: ${file}`);
  return value;
}

/** Read failures are errors, never an empty list of open intents (G16). */
function readOpenIntents({ root, fsImpl = fs }: any): any[] {
  const dir = intentDirectory(root);
  let names: string[];
  try { names = fsImpl.readdirSync(dir); }
  catch (error: any) { if (error.code === 'ENOENT') return []; throw error; }
  return names.filter((name) => /^\d{3}(?:[a-z]|-[A-Z])?\.json$/.test(name)).sort()
    .map((name) => readIntent(path.join(dir, name), fsImpl));
}

function writeIntent(file: string, intent: any, fsImpl: any = fs): void {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fsImpl.writeFileSync(temp, `${JSON.stringify(intent)}\n`, { mode: 0o600 });
    fsImpl.renameSync(temp, file);
  } finally {
    try { fsImpl.unlinkSync(temp); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
}

// Prove death without spawning ps. A live/reused/inaccessible pid is conservatively unknown.
function childAlive(proc: any): boolean | 'unknown' {
  if (!Number.isInteger(proc?.pid) || proc.pid <= 0) return 'unknown';
  try { process.kill(proc.pid, 0); return 'unknown'; }
  catch (error: any) { return error.code === 'ESRCH' ? false : 'unknown'; }
}

/**
 * Merge + lean gate + render + non-force cleanup. No model, shell, hooks or network launcher.
 * postMergeCheck({cwd, head}) is mandatory for completion: the caller answers whether a passing
 * verification is recorded for that develop head; this module runs no check itself.
 * onPhase is an in-process fault seam, called only after the phase is durably recorded.
 * isEnabled is re-read at each boundary. Under an off switch a recorded ff-started is only settled:
 * a develop already at the commit records ff-done, a proven-dead partial is repaired, and no new
 * fast-forward is spawned.
 */
async function mergeRoadmapRow(options: any): Promise<any> {
  const { root, row, runId, gate, approvedHead, fsImpl = fs, env = process.env,
    execFileSync = cp.execFileSync, spawn = cp.spawn, now = Date.now, alive = childAlive } = options;
  if (!ROW.test(row?.id) || !/^[0-9]{3}(?:[a-z]|-[A-Z])?-[A-Za-z0-9][A-Za-z0-9-]*$/.test(row?.slug)
    || !row.slug.startsWith(`${row.id}-`) || typeof row.title !== 'string' || row.title.trim().length === 0
    || /[\r\n\u2028\u2029]/.test(row.title)) throw new Error('invalid merge row');
  const file = path.join(intentDirectory(root), `${row.id}.json`);
  let intent = readIntent(file, fsImpl);
  const done = path.join(doneDirectory(root), `${row.id}.json`);
  if (!intent) intent = readIntent(done, fsImpl);
  let fileWrites = 0;
  const result = (extra: any) => ({ schema: 1, row: row.id, runId: intent?.runId || runId,
    phase: intent?.phase, commit: intent?.commit, fileWrites, ...extra });
  const deny = (reason: string) => result({ outcome: 'denied', reason });
  const stopped = () => {
    const state = options.isEnabled?.() ?? { enabled: true };
    return state === false || state.enabled === false
      ? result({ outcome: 'stopped', annotations: { switch: state.switch || 'setting' } }) : null;
  };
  const phase = async (next: string) => {
    intent.phase = next;
    writeIntent(file, intent, fsImpl);
    await options.onPhase?.(next, JSON.parse(JSON.stringify(intent)));
  };
  // Ignore inherited git routing variables: every command must address the named checkout.
  const environment = { ...env };
  for (const key of Object.keys(environment)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(key)) delete environment[key];
  const execOptions = { cwd: root, encoding: 'utf8', env: environment, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 };
  const version = String(execFileSync('git', ['--version'], execOptions)).match(/git version (\d+)\.(\d+)/);
  if (!version || +version[1] < 2 || (+version[1] === 2 && +version[2] < 38)) return deny('git-too-old');
  const checkouts = String(execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain', '-z'], execOptions))
    .split('\0\0').filter(Boolean).map((block) => {
      const fields = block.split('\0');
      return { worktree: fields.find((s) => s.startsWith('worktree '))?.slice(9),
        branch: fields.find((s) => s.startsWith('branch '))?.slice(7) };
    });
  const develop = intent?.developWorktree || options.developWorktree
    || checkouts.find((entry) => entry.branch === 'refs/heads/develop')?.worktree;
  if (!develop || !fsImpl.existsSync(develop) || !checkouts.some((entry) => entry.worktree === develop)) return deny('no-develop-worktree');
  let currentBranch: string;
  try { currentBranch = String(execFileSync('git', ['-C', develop, 'symbolic-ref', '-q', 'HEAD'], execOptions)).trim(); }
  catch (error: any) { if (error.status === 1) return deny('develop-wrong-branch'); throw error; }
  if (currentBranch !== 'refs/heads/develop') return deny('develop-wrong-branch');
  const head = () => String(execFileSync('git', ['-C', develop, 'rev-parse', 'HEAD'], execOptions)).trim();
  const porcelain = () => String(execFileSync('git', ['-C', develop, 'status', '--porcelain', '--untracked-files=all'], execOptions));
  const branch = `feat/${row.slug}`;
  const featureHead = () => String(execFileSync('git', ['-C', root, 'rev-parse', '--verify', `refs/heads/${branch}`], execOptions)).trim();
  const checkFeature = () => { try { return featureHead() === intent.featureHead; } catch { return false; } };
  if (intent && (intent.row !== row.id || intent.slug !== row.slug)) throw new Error(`merge intent identity mismatch: ${file}`);
  if (intent?.phase === 'cleaned') {
    if (head() !== intent.commit) return deny('develop-moved');
    if (fsImpl.existsSync(file)) { fsImpl.mkdirSync(path.dirname(done), { recursive: true }); fsImpl.renameSync(file, done); }
    return result({ outcome: 'merged', cleanup: 'cleaned' });
  }
  if (!intent) {
    const stop = stopped(); if (stop) return stop;
    if (porcelain() !== '') return deny('develop-dirty');
    let feature: string;
    try { feature = featureHead(); } catch { return deny('head-moved'); }
    if (!SHA.test(approvedHead) || feature !== approvedHead) return deny('head-moved');
    if (gate?.id !== 'gate-b' || !/^sha256:[a-f0-9]{64}(?:\+sha256:[a-f0-9]{64})?$/.test(gate?.digest)) throw new Error('merge requires gate-b approval digest');
    const name = String(execFileSync('git', ['-C', develop, 'config', '--get', 'user.name'], execOptions)).trim();
    const email = String(execFileSync('git', ['-C', develop, 'config', '--get', 'user.email'], execOptions)).trim();
    if (!name || !email || /[\r\n<>]/.test(name + email)) throw new Error('invalid develop identity');
    intent = { schema: 1, row: row.id, slug: row.slug, runId, phase: 'intent', developWorktree: develop,
      developHead: head(), featureBranch: branch, featureHead: feature,
      featureWorktree: options.featureWorktree || checkouts.find((entry) => entry.branch === `refs/heads/${branch}`)?.worktree || null,
      gate: { id: gate.id, digest: gate.digest }, identity: { name, email, date: `${Math.floor(now() / 1000)} +0000` },
      message: `merge: ${row.id} ${row.title}\n\nDoFlow-Row: ${row.id}\nDoFlow-Policy: ${gate.id}@${gate.digest}\n` };
    await phase('intent');
  }
  // Git is the authority, even if a kill happened before the phase write.
  let builtValid = false;
  if (SHA.test(intent.commit) && SHA.test(intent.tree)) {
    try {
      execFileSync('git', ['-C', root, 'cat-file', '-e', intent.commit], execOptions);
      const shape = String(execFileSync('git', ['-C', root, 'show', '-s', '--format=%T %P', intent.commit], execOptions)).trim();
      builtValid = shape === `${intent.tree} ${intent.developHead} ${intent.featureHead}`;
    } catch { /* Missing or mismatched object: rebuild only while still before the ff. */ }
  }
  if (!builtValid && !['intent', 'built'].includes(intent.phase)) return deny('develop-moved');
  // HEAD at the built commit outranks a stale phase: the merge already happened, never make another.
  if (builtValid && head() === intent.commit && PHASES.indexOf(intent.phase) < PHASES.indexOf('ff-done')) await phase('ff-done');
  if (['intent', 'built'].includes(intent.phase)) {
    if (head() !== intent.developHead) return deny('develop-moved');
    if (!checkFeature()) return deny('head-moved');
    if (porcelain() !== '') return deny('develop-dirty');
    if (!builtValid) {
      let tree: string;
      try { tree = String(execFileSync('git', ['-C', root, 'merge-tree', '--write-tree', intent.developHead, intent.featureHead], execOptions)).trim(); }
      catch (error: any) { if (error.status === 1) return deny('merge-conflict'); throw error; }
      if (!SHA.test(tree)) throw new Error('unreadable merge-tree result');
      const stop = stopped(); if (stop) return stop;
      const identity = intent.identity;
      const commit = String(execFileSync('git', ['-C', root, 'commit-tree', tree, '-p', intent.developHead, '-p', intent.featureHead, '--no-gpg-sign'], {
        ...execOptions, input: intent.message, env: { ...environment, GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
          GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email, GIT_AUTHOR_DATE: identity.date, GIT_COMMITTER_DATE: identity.date },
      })).trim();
      if (!SHA.test(commit)) throw new Error('unreadable commit-tree result');
      intent.tree = tree; intent.commit = commit;
      await phase('built');
    }
    const stop = stopped(); if (stop) return stop;
    if (!checkFeature()) return deny('head-moved');
    if (head() !== intent.developHead) return deny('develop-moved');
    if (porcelain() !== '') return deny('develop-dirty');
    await phase('ff-started');
  }
  if (intent.phase === 'ff-started') {
    if (head() !== intent.commit) {
      if (head() !== intent.developHead) return deny('develop-moved');
      if (!checkFeature()) return deny('head-moved');
      // Any recorded child must be proven dead before retrying or touching an index lock.
      if (intent.ff && alive(intent.ff) !== false) return deny('ff-running');
      const lock = gitPath(develop, 'index.lock', execFileSync, execOptions);
      if (porcelain() !== '' || fsImpl.existsSync(lock)) {
        // Settling a proven-dead partial is allowed under an off switch; it starts no new merge.
        if (!intent.ff) return deny('develop-dirty');
        if (!repairFastForward({ intent, root, develop, execFileSync, execOptions, fsImpl, now, staleLockSeconds: options.staleLockSeconds ?? 120 })) return deny('develop-dirty');
      } else {
        // A clean develop at its old head: a new fast-forward would start here, so the switch decides.
        const stop = stopped(); if (stop) return stop;
        // Disable repo hooks; only the supplied git binary is launched by mechanical work.
        await new Promise<void>((resolve, reject) => {
          const child = spawn('git', ['-C', develop, '-c', 'core.hooksPath=/dev/null', 'merge', '--ff-only', intent.commit], {
            cwd: develop, env: environment, stdio: ['ignore', 'ignore', 'pipe'],
          });
          child.stderr?.resume();
          child.once('error', reject);
          child.once('spawn', () => {
            intent.ff = { pid: child.pid, start: null, startedAt: new Date(now()).toISOString() };
            try { writeIntent(file, intent, fsImpl); } catch (error) { reject(error); }
          });
          child.once('close', (code: number) => code === 0 ? resolve() : reject(new Error(`fast-forward failed (${code})`)));
        });
      }
    }
    if (head() !== intent.commit) return deny('develop-moved');
    await phase('ff-done');
  }
  if (head() !== intent.commit) return deny('develop-moved');
  if (porcelain() !== '') return deny('develop-dirty');
  const stop = stopped(); if (stop) return stop;
  if (intent.phase === 'ff-done') {
    let checked: any;
    try { checked = await options.postMergeCheck?.({ cwd: develop, head: intent.commit }); }
    catch { checked = { ok: false }; }
    if (checked?.ok !== true || head() !== intent.commit || porcelain() !== '') {
      intent.status = 'merged-unverified'; writeIntent(file, intent, fsImpl);
      return result({ outcome: 'merged-unverified', status: 'merged-unverified' });
    }
    delete intent.status;
    intent.verifiedHead = intent.commit;
    writeIntent(file, intent, fsImpl);
    const stop = stopped(); if (stop) return stop;
    const facts = (options.gatherFacts || gatherGitFacts)({ root });
    if (facts.unreadable?.length) return result({ outcome: 'denied', error: 'cannot-read-facts', sources: facts.unreadable });
    const seedFile = options.seedPath || path.join(root, 'agent-docs', 'roadmap', 'rows.json');
    const rows = parseSeed(fsImpl.readFileSync(seedFile, 'utf8')).rows;
    const { statuses } = deriveStatus(rows, facts);
    const rendered = renderRoadmapFile({ roadmapPath: options.roadmapPath || path.join(root, 'agent-docs', 'roadmap', 'ROADMAP.md'), content: render(rows, statuses), fsImpl });
    fileWrites += rendered.written ? 1 : 0;
    await phase('rendered');
  }
  const stopCleanup = stopped(); if (stopCleanup) return stopCleanup;
  if (intent.verifiedHead !== intent.commit) {
    intent.status = 'merged-unverified'; writeIntent(file, intent, fsImpl);
    return result({ outcome: 'merged-unverified', status: 'merged-unverified' });
  }
  if (head() !== intent.commit) return deny('develop-moved');
  if (!cleanupFeature({ intent, root, develop, execFileSync, execOptions, fsImpl })) return result({ outcome: 'merged', cleanup: 'cleanup-kept' });
  await phase('cleaned');
  fsImpl.mkdirSync(path.dirname(done), { recursive: true }); fsImpl.renameSync(file, done);
  return result({ outcome: 'merged', cleanup: 'cleaned' });
}

/** `rev-parse --git-path` answers relative to the checkout it ran in (a main checkout's `.git/...`). */
function gitPath(checkout: string, name: string, execFileSync: any, execOptions: any): string {
  return path.resolve(checkout, String(execFileSync('git', ['-C', checkout, 'rev-parse', '--git-path', name], execOptions)).trim());
}

/**
 * All dirty paths must be changed by the merge. A working file must equal the commit's blob; a staged
 * blob must equal the commit's or the old head's version of that path (a third version is a person's).
 */
function repairFastForward({ intent, root, develop, execFileSync, execOptions, fsImpl, now, staleLockSeconds }: any): boolean {
  const lock = gitPath(develop, 'index.lock', execFileSync, execOptions);
  if (fsImpl.existsSync(lock) && now() - fsImpl.statSync(lock).mtimeMs <= staleLockSeconds * 1000) return false;
  const changed = new Set(String(execFileSync('git', ['-C', root, 'diff', '--name-only', '-z', intent.developHead, intent.commit], execOptions)).split('\0').filter(Boolean));
  const unstaged = String(execFileSync('git', ['-C', develop, 'diff', '--name-only', '-z'], execOptions));
  const staged = String(execFileSync('git', ['-C', develop, 'diff', '--cached', '--name-only', '-z'], execOptions)).split('\0').filter(Boolean);
  const untracked = String(execFileSync('git', ['-C', develop, 'ls-files', '-o', '--exclude-standard', '-z'], execOptions));
  const blob = (rev: string, name: string): string | null => {
    try { return String(execFileSync('git', ['-C', root, 'rev-parse', '--verify', '-q', `${rev}:${name}`], execOptions)).trim(); }
    catch { return null; }
  };
  for (const name of new Set([...(unstaged + untracked).split('\0').filter(Boolean), ...staged])) {
    if (!changed.has(name)) return false;
    const full = path.join(develop, name);
    // Symlinks, missing paths and type/mode changes need human resolution.
    let stat: any;
    try { stat = fsImpl.lstatSync(full); } catch { return false; }
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const expected = blob(intent.commit, name);
    if (!expected) return false;
    const actual = String(execFileSync('git', ['-C', develop, 'hash-object', '--no-filters', '--', name], execOptions)).trim();
    if (actual !== expected) return false;
  }
  if (staged.length) {
    // `ls-files -s -z`: "<mode> <blob> <stage>\t<path>\0". Only stage-0 entries of a known version pass.
    const index = new Map<string, string>();
    for (const entry of String(execFileSync('git', ['-C', develop, 'ls-files', '-s', '-z'], execOptions)).split('\0').filter(Boolean)) {
      const match = entry.match(/^[0-7]{6} ([0-9a-f]{40}) ([0-3])\t(.+)$/s);
      if (!match) return false;
      if (match[2] !== '0' || index.has(match[3])) index.set(match[3], 'unmerged');
      else index.set(match[3], match[1]);
    }
    for (const name of staged) {
      const sha = index.get(name);
      if (!sha || (sha !== blob(intent.commit, name) && sha !== blob(intent.developHead, name))) return false;
    }
  }
  // All refusal checks precede the first write. read-tree rewrites the index before the ref update,
  // which compares the old head atomically; when that compare-and-swap fails the index bytes read
  // here are put back, so a refused repair leaves develop's index as it found it.
  if (fsImpl.existsSync(lock)) fsImpl.unlinkSync(lock);
  const indexFile = gitPath(develop, 'index', execFileSync, execOptions);
  let saved: Buffer | null = null;
  try { saved = fsImpl.readFileSync(indexFile); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  execFileSync('git', ['-C', develop, 'read-tree', intent.commit], execOptions);
  try { execFileSync('git', ['-C', develop, 'update-ref', 'refs/heads/develop', intent.commit, intent.developHead], execOptions); }
  catch (error) {
    if (saved) fsImpl.writeFileSync(indexFile, saved);
    else fsImpl.rmSync(indexFile, { force: true });
    throw error;
  }
  try { execFileSync('git', ['-C', develop, 'checkout-index', '-a'], execOptions); }
  catch (error: any) {
    // Without force, checkout-index reports already-existing paths with exit 1. It still writes
    // missing paths; refresh and the final porcelain assertion decide whether repair completed.
    if (error.status !== 1) throw error;
  }
  execFileSync('git', ['-C', develop, 'update-index', '-q', '--refresh'], execOptions);
  return String(execFileSync('git', ['-C', develop, 'status', '--porcelain', '--untracked-files=all'], execOptions)) === '';
}

function cleanupFeature({ intent, root, develop, execFileSync, execOptions, fsImpl }: any): boolean {
  const feature = intent.featureWorktree;
  const branch = intent.featureBranch;
  try {
    let featureHead: string;
    try { featureHead = String(execFileSync('git', ['-C', root, 'rev-parse', '--verify', `refs/heads/${branch}`], execOptions)).trim(); }
    catch { return !feature || !fsImpl.existsSync(feature); }
    if (featureHead !== intent.featureHead) return false;
    // Only a tip already on develop may lose its worktree: a branch someone kept committing on keeps
    // both the worktree (and its gitignored agent-docs/.doflow files) and the branch.
    try { execFileSync('git', ['-C', root, 'merge-base', '--is-ancestor', featureHead, 'refs/heads/develop'], execOptions); }
    catch { return false; }
    if (feature && fsImpl.existsSync(feature)) {
      const current = String(execFileSync('git', ['-C', feature, 'symbolic-ref', '-q', 'HEAD'], execOptions)).trim();
      if (current !== `refs/heads/${branch}`) return false;
      if (String(execFileSync('git', ['-C', feature, 'status', '--porcelain', '--untracked-files=all'], execOptions)) !== '') return false;
      execFileSync('git', ['-C', develop, 'worktree', 'remove', '--', feature], execOptions);
    }
    execFileSync('git', ['-C', develop, 'branch', '-d', '--', branch], execOptions);
    return true;
  } catch { return false; }
}

module.exports = { mergeRoadmapRow, readOpenIntents, writeIntent, cleanupFeature };
