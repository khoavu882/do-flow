'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Check key and tree digest (088 E.2, IC-009, DD-2; 089 IC-001, DD-1).
 *
 * Computes a deterministic 16-hex key representing a check's execution identity.
 * Two check invocations with equal check keys can safely share results in in-flight
 * deduplication (P5.4, G.4, IC-017) and, when enabled, reuse a recorded PASS (089).
 *
 * Key (payload version 2) = sha16(JSON.stringify([
 *   2,
 *   command,
 *   timeoutMs,
 *   realpath(cwd),
 *   HEAD,
 *   treeDigest,       modified/untracked files, ignored entries removed (unchanged from version 1)
 *   ignoredDigest,    sorted names of ignored entries (`!!`), `none` when there are none
 *   inputsDigest,     bytes of the registry's policy.reuse.ignoredInputs, `absent` when missing
 *   toolDigest,       realpath/size/mtime/inode of `node` and of the command's first word on env.PATH
 *   process.version,
 *   platform,
 *   arch,
 *   envDigest
 * ]))
 *
 * `checkKeyV2` also returns the full sha256 of the same payload (`payloadDigest`) for the
 * reuse store's trust check; `checkKey` returns the key only. One `git status` call yields
 * both the tree digest and the ignored set (`treeState`).
 *
 * If git faults, more than 500 files or 50 MB are modified/untracked, or a declared input is a
 * symlink, a non-file, unreadable or over 1 MB, the key is null (unkeyable, runs unshared).
 * Residual (design RK-1): an ignored file outside the declared list that changes content, and
 * a tool behind a wrapper, are not seen.
 */

const MAX_UNCOMMITTED_FILES = 500;
const MAX_UNCOMMITTED_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_INPUT_BYTES = 1024 * 1024; // 1 MB per declared ignored input
const PAYLOAD_VERSION = 2;
/** Stands for an ignored-entry digest that could not be read; never equals a sha256 hex digest. */
const IGNORED_UNAVAILABLE = 'unavailable';

/** First words that are shell syntax, not a program on PATH (IC-001 toolDigest). */
const SHELL_KEYWORDS: ReadonlySet<string> = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac',
  'select', 'function', 'time', 'coproc', '!', '{', '}', '[[', ']]', '(', ')',
]);

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Registry-owned inputs of the key; a load fault makes a check unkeyable at the caller. */
function keyPolicy(): { envExclude: readonly string[]; ignoredInputs: readonly string[] } {
  const { loadVerificationRegistry } = require('./registry.ts');
  const policy = loadVerificationRegistry().policy;
  const exclude = policy?.dedup?.envExclude;
  if (!Array.isArray(exclude) || !exclude.every((key: unknown) => typeof key === 'string')) {
    throw new Error('Invalid dedup environment exclusions');
  }
  const inputs = policy?.reuse?.ignoredInputs;
  if (!Array.isArray(inputs) || !inputs.every((entry: unknown) => typeof entry === 'string')) {
    throw new Error('Invalid reuse ignored inputs');
  }
  return { envExclude: exclude, ignoredInputs: inputs };
}

function envExclude(): readonly string[] {
  return keyPolicy().envExclude;
}

/**
 * Computes sha256 of sorted NAME=VALUE lines minus excluded environment variables.
 * @param {Record<string, string | undefined>} [env=process.env]
 * @param {readonly string[]} [exclude=registry policy.dedup.envExclude]
 * @returns {string} sha256 hex digest
 */
function envDigest(
  env: Record<string, string | undefined> = process.env,
  exclude: readonly string[] = envExclude(),
): string {
  const excludeSet = new Set(exclude);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || excludeSet.has(key)) continue;
    // Raw NAME=VALUE lines must be unambiguous. Multiline environments run unshared
    // rather than collide with a second environment containing an additional key.
    if (key.includes('=') || key.includes('\n') || value.includes('\n')) {
      throw new Error('Unkeyable environment');
    }
    lines.push(`${key}=${value}`);
  }
  lines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return crypto.createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

/**
 * The HEAD commit hash of the git repository at root, or null on git fault.
 * @param {string} root
 * @param {{ spawnSyncImpl?: typeof spawnSync }} [options]
 * @returns {string | null} 40- or 64-character hex commit, or null
 */
function headCommit(root: string, { spawnSyncImpl = spawnSync }: { spawnSyncImpl?: any } = {}): string | null {
  try {
    const res = spawnSyncImpl('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
    if (res.status !== 0 || typeof res.stdout !== 'string') return null;
    const trimmed = res.stdout.trim();
    return /^[0-9a-f]{40,64}$/.test(trimmed) ? trimmed : null;
  } catch {
    return null;
  }
}

/** What one `git status` call says about the working tree (089 IC-001). */
interface TreeState {
  /** Digest of modified/untracked files; ignored entries are not part of it. */
  tree: string;
  /** Digest of the sorted ignored-entry names; sha256('none') when there are none. */
  ignored: string;
  /** Realpath of the git top level, where the declared ignored inputs live. */
  gitRoot: string;
}

type KeyIo = { spawnSyncImpl?: any; fsImpl?: any; configDir?: string };

type StatusRead = {
  gitRoot: string;
  entries: Array<{ entry: string; relPath: string }>;
  ignored: string;
};

/**
 * Runs the ONE `git status --porcelain=v1 -z --untracked-files=all --ignored=matching` call and
 * splits it: modified/untracked entries (runtime-state directories left out) and the digest of the
 * ignored (`!!`) entry names. Null on a git fault or a malformed rename entry.
 */
function readStatus(
  root: string,
  { spawnSyncImpl = spawnSync, fsImpl = nodeFs, configDir }: KeyIo,
): StatusRead | null {
  const top = spawnSyncImpl('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' });
  if (top.status !== 0 || typeof top.stdout !== 'string' || !path.isAbsolute(top.stdout.trim())) return null;
  const gitRoot = fsImpl.realpathSync(top.stdout.trim());
  const excluded = ['.doflow'];
  if (configDir) {
    // A first run may not have created its config directory yet. Resolve its nearest
    // existing ancestor so a symlinked parent has the same identity after creation.
    let ancestor = path.resolve(configDir);
    const missing: string[] = [];
    let realConfig: string;
    for (;;) {
      try { realConfig = path.join(fsImpl.realpathSync(ancestor), ...missing); break; }
      catch (error: any) {
        if (error.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw error;
        missing.unshift(path.basename(ancestor));
        ancestor = path.dirname(ancestor);
      }
    }
    const relative = path.relative(gitRoot, realConfig!);
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      excluded.push(relative.split(path.sep).join('/'));
    }
  }
  const res = spawnSyncImpl(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'],
    { cwd: root, encoding: 'utf8' },
  );
  if (res.status !== 0 || typeof res.stdout !== 'string') return null;

  const raw = res.stdout;
  const tokens = raw.split('\0');
  // The trailing null produces an empty token at the end
  if (tokens.length > 0 && tokens[tokens.length - 1] === '') {
    tokens.pop();
  }

  const entries: Array<{ entry: string; relPath: string }> = [];
  const ignoredPaths: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token) continue;
    const status = token.slice(0, 2);
    const relPath = token.slice(3);
    let entry = token;
    // Both names are part of a rename/copy entry; dropping the source can give two
    // different uncommitted trees the same digest when their destination bytes match.
    if (/[RC]/.test(status)) {
      const source = tokens[++i];
      if (!source) return null;
      entry += `\0${source}`;
    }

    // Only runtime state is excluded; fixture/project .doflow directories are inputs.
    if (excluded.some((dir) => relPath === dir || relPath.startsWith(`${dir}/`))) {
      continue;
    }
    // Ignored entries (`!!`) are named in the key, never read: the tree digest stays what it was.
    if (status === '!!') {
      ignoredPaths.push(relPath);
      continue;
    }
    entries.push({ entry, relPath });
  }

  ignoredPaths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { gitRoot, entries, ignored: sha256(ignoredPaths.length === 0 ? 'none' : ignoredPaths.join('\0')) };
}

/**
 * Digest of the modified/untracked entries: reads each file's bytes. Null when more than 500
 * files or 50 MB are dirty, or an entry is a symlink, a non-file or unreadable.
 */
function hashEntries(
  gitRoot: string,
  entries: Array<{ entry: string; relPath: string }>,
  fsImpl: any,
): string | null {
  if (entries.length === 0) {
    return crypto.createHash('sha256').update('clean', 'utf8').digest('hex');
  }

  if (entries.length > MAX_UNCOMMITTED_FILES) {
    return null; // More than 500 uncommitted files -> unkeyable
  }

  // Sort entries deterministically
  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  const hasher = crypto.createHash('sha256');
  let totalBytes = 0;

  for (const item of entries) {
    const fullPath = path.resolve(gitRoot, item.relPath);
    let fileHash = '';
    try {
      if (typeof fsImpl.lstatSync === 'function' && fsImpl.lstatSync(fullPath).isSymbolicLink()) return null;
      const stat = fsImpl.statSync(fullPath);
      if (!stat.isFile()) return null; // directory/submodule contents are not represented by porcelain
      if (stat.isFile()) {
        totalBytes += stat.size;
        if (totalBytes > MAX_UNCOMMITTED_BYTES) {
          return null; // More than 50 MB total dirty content -> unkeyable
        }
        const content = fsImpl.readFileSync(fullPath);
        fileHash = crypto.createHash('sha256').update(content).digest('hex');
      }
    } catch (error: any) {
      // A deletion has no content; an unreadable live file cannot be safely keyed.
      if (error.code !== 'ENOENT' || !item.entry.slice(0, 2).includes('D')) return null;
    }
    hasher.update(item.entry, 'utf8');
    hasher.update('\0', 'utf8');
    hasher.update(fileHash, 'utf8');
    hasher.update('\0', 'utf8');
  }

  return hasher.digest('hex');
}

/**
 * Computes the tree digest and the ignored-entry digest from ONE git status call.
 * Returns null if not in a git repository, or if > 500 files or > 50 MB are dirty.
 * @param {string} root
 * @param {{ spawnSyncImpl?: typeof spawnSync, fsImpl?: typeof nodeFs, configDir?: string }} [options]
 * @returns {TreeState | null}
 */
function treeState(root: string, options: KeyIo = {}): TreeState | null {
  try {
    const status = readStatus(root, options);
    if (!status) return null;
    const tree = hashEntries(status.gitRoot, status.entries, options.fsImpl || nodeFs);
    return tree === null ? null : { tree, ignored: status.ignored, gitRoot: status.gitRoot };
  } catch {
    return null;
  }
}

/**
 * Computes a digest of all modified and untracked files in the working tree.
 * Returns null if not in a git repository, or if > 500 files or > 50 MB are dirty.
 * Values for trees without ignored entries are those of payload version 1.
 * @param {string} root
 * @param {{ spawnSyncImpl?: typeof spawnSync, fsImpl?: typeof nodeFs, configDir?: string }} [options]
 * @returns {string | null}
 */
function treeDigest(root: string, options: KeyIo = {}): string | null {
  return treeState(root, options)?.tree ?? null;
}

/**
 * Digest of the declared ignored inputs (089 IC-001, DA-1): `path\0sha256(bytes)` or
 * `path\0absent` per path, in registry order, relative to the git root. A symlink, a
 * non-file, a read fault other than ENOENT or a file over 1 MB makes the key null.
 * @returns {string | null}
 */
function inputsDigest(gitRoot: string, inputs: readonly string[], fsImpl: any = nodeFs): string | null {
  try {
    const lines: string[] = [];
    for (const rel of inputs) {
      const full = path.resolve(gitRoot, rel);
      let stat: any;
      try { stat = fsImpl.lstatSync(full); }
      catch (error: any) {
        if (error.code === 'ENOENT') { lines.push(`${rel}\0absent`); continue; }
        return null;
      }
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_INPUT_BYTES) return null;
      const content = fsImpl.readFileSync(full);
      if (content.length > MAX_INPUT_BYTES) return null;
      lines.push(`${rel}\0${crypto.createHash('sha256').update(content).digest('hex')}`);
    }
    return sha256(lines.join('\n'));
  } catch {
    return null;
  }
}

/** First word of a shell command, past leading NAME=value assignments and quotes. */
function firstShellWord(command: string): string {
  for (const word of command.trim().split(/\s+/)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    return word.replace(/^["']+|["']+$/g, '');
  }
  return '';
}

/**
 * Identity of one program: its first match on PATH (PATHEXT on win32), realpath, size,
 * mtimeMs and inode, or `absent`. A word that is a shell keyword or contains a slash is
 * taken as a path relative to cwd. No process is spawned.
 */
function toolIdentity(
  word: string,
  { cwd, env, fsImpl, platform }: { cwd: string; env: Record<string, string | undefined>; fsImpl: any; platform: string },
): string {
  if (word === '') return `${word}\0absent`;
  const win = platform === 'win32';
  const direct = SHELL_KEYWORDS.has(word) || word.includes('/') || (win && word.includes('\\'));
  const extensions = win
    ? ['', ...String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)]
    : [''];
  const candidates: string[] = [];
  if (direct) {
    for (const ext of extensions) candidates.push(path.resolve(cwd, word + ext));
  } else if (typeof env.PATH === 'string') {
    for (const dir of env.PATH.split(win ? ';' : ':')) {
      for (const ext of extensions) candidates.push(path.resolve(cwd, dir === '' ? '.' : dir, word + ext));
    }
  }
  for (const candidate of candidates) {
    let isFile = false;
    try { isFile = fsImpl.statSync(candidate).isFile(); } catch { isFile = false; }
    if (!isFile) continue;
    const real = fsImpl.realpathSync(candidate);
    const stat = fsImpl.statSync(real);
    return [word, real, stat.size, stat.mtimeMs, stat.ino].join('\0');
  }
  return `${word}\0absent`;
}

/**
 * Digest of the identity of `node` and of the command's first word (089 IC-001, DA-2).
 * @returns {string}
 */
function toolDigest(
  command: string,
  { cwd, env = process.env, fsImpl = nodeFs, platform = process.platform }:
    { cwd: string; env?: Record<string, string | undefined>; fsImpl?: any; platform?: string },
): string {
  const io = { cwd, env, fsImpl, platform };
  return sha256([toolIdentity('node', io), toolIdentity(firstShellWord(command), io)].join('\n'));
}

/** The version 2 payload (089 IC-001); the order of the entries is part of the key's identity. */
function payloadOf(parts: {
  command: string; timeoutMs: number; realCwd: string; head: string; tree: string;
  ignoredDig: string; inputsDig: string; toolDig: string; envDig: string;
}): unknown[] {
  const { command, timeoutMs, realCwd, head, tree, ignoredDig, inputsDig, toolDig, envDig } = parts;
  const payload = [
    PAYLOAD_VERSION,
    command,
    timeoutMs,
    realCwd,
    head,
    tree,
    ignoredDig,
    inputsDig,
    toolDig,
    process.version,
    process.platform,
    (process as any).arch,
    envDig,
  ];
  return payload;
}

type KeyInput = {
  command: string;
  timeoutMs: number;
  cwd: string;
  head?: string | null;
  tree?: string | null;
  /** Precomputed ignored-entry digest (from `treeState`); computed with one status call when omitted. */
  ignored?: string | null;
  /** Realpath of the git top level; resolved when omitted. */
  gitRoot?: string | null;
  configDir?: string;
  env?: Record<string, string | undefined>;
  fsImpl?: any;
  spawnSyncImpl?: any;
  platform?: string;
};

/**
 * Computes the version 2 check key and the full payload digest for a command run in cwd
 * (089 IC-001). Returns null if unkeyable; any thrown error is null.
 * @param {Object} input
 * @param {string} input.command
 * @param {number} input.timeoutMs
 * @param {string} input.cwd
 * @param {string | null} [input.head] HEAD commit; resolved from cwd if omitted
 * @param {string | null} [input.tree] treeDigest; resolved from cwd if omitted
 * @param {string | null} [input.ignored] ignored-entry digest from treeState; resolved with one
 *   status call when omitted (also resolves `tree` when that is omitted too)
 * @param {Record<string, string | undefined>} [input.env=process.env]
 * @returns {{ key: string, payloadDigest: string } | null}
 */
function checkKeyV2({
  command,
  timeoutMs,
  cwd,
  head,
  tree,
  ignored,
  gitRoot,
  configDir,
  env = process.env,
  fsImpl = nodeFs,
  spawnSyncImpl = spawnSync,
  platform = process.platform,
}: KeyInput): { key: string; payloadDigest: string } | null {
  try {
    if (typeof command !== 'string' || !Number.isFinite(timeoutMs) || typeof cwd !== 'string') {
      return null;
    }

    const realCwd: string = fsImpl.realpathSync(cwd);

    let resolvedHead = head;
    if (resolvedHead === undefined) {
      resolvedHead = headCommit(realCwd, { spawnSyncImpl });
    }

    let resolvedTree = tree;
    let resolvedIgnored = ignored;
    let resolvedRoot = gitRoot;
    if (resolvedTree === undefined) {
      // Nothing precomputed: one status call supplies the tree, the ignored set and the root.
      const state = treeState(realCwd, { spawnSyncImpl, fsImpl, configDir });
      if (!state) return null;
      resolvedTree = state.tree;
      if (resolvedIgnored === undefined) resolvedIgnored = state.ignored;
      if (resolvedRoot === undefined) resolvedRoot = state.gitRoot;
    } else if (resolvedIgnored === undefined || resolvedRoot === undefined) {
      // A tree without its ignored set: one status call, without reading any dirty file again.
      // The caller already read the tree, so a fault here means this directory is not a git
      // checkout (a test seam); the key then carries IGNORED_UNAVAILABLE, which no healthy
      // digest equals, and the declared inputs are read from cwd.
      let status: StatusRead | null = null;
      try { status = readStatus(realCwd, { spawnSyncImpl, fsImpl, configDir }); } catch { status = null; }
      if (resolvedIgnored === undefined) resolvedIgnored = status ? status.ignored : IGNORED_UNAVAILABLE;
      if (resolvedRoot === undefined) resolvedRoot = status ? status.gitRoot : realCwd;
    }

    if (!resolvedHead || !resolvedTree || !resolvedIgnored || !resolvedRoot) {
      return null;
    }

    const policy = keyPolicy();
    const envDig = envDigest(env, policy.envExclude);
    const ignoredDig = resolvedIgnored;
    const inputsDig = inputsDigest(resolvedRoot, policy.ignoredInputs, fsImpl);
    if (inputsDig === null) return null;
    const toolDig = toolDigest(command, { cwd: realCwd, env, fsImpl, platform });
    const payload = payloadOf({
      command, timeoutMs, realCwd, head: resolvedHead, tree: resolvedTree,
      ignoredDig, inputsDig, toolDig, envDig,
    });

    const payloadDigest = sha256(JSON.stringify(payload));
    return { key: payloadDigest.slice(0, 16), payloadDigest };
  } catch {
    return null;
  }
}

/**
 * Computes checkKey for a command run in cwd.
 * Returns 16 hex chars, or null if unkeyable.
 * @param {Object} input see checkKeyV2
 * @returns {string | null}
 */
function checkKey(input: KeyInput): string | null {
  return checkKeyV2(input)?.key ?? null;
}

module.exports = {
  envDigest,
  headCommit,
  treeDigest,
  treeState,
  inputsDigest,
  toolDigest,
  checkKey,
  checkKeyV2,
};
