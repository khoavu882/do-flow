'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const CORPUS_LIMITS = Object.freeze({ maxFiles: 2000, maxFileBytes: 1024 * 1024, maxBytes: 64 * 1024 * 1024, timeoutMs: 2000, maxOutputBytes: 2 * 1024 * 1024 });
const EXCLUDED = new Set(['.git', '.doflow', 'node_modules', 'graphify-out', '.semble', '__pycache__']);
const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const digest = (value: any): string => crypto.createHash('sha256').update(value).digest('hex');

function relativeCodePath(raw: any): string | null {
  if (typeof raw !== 'string' || !raw || raw.includes('\0') || /[\r\n]/.test(raw)) return null;
  const rel = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (path.posix.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.split('/').some((p: string) => p === '..' || p === '' || p === '.')) return null;
  return rel;
}

function insideRoot(root: string, absolute: string): boolean {
  const rel = path.relative(root, absolute);
  return rel !== '' && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

function sameFile(a: any, b: any): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Read a regular admitted path using a bounded descriptor, never an unbounded readFile. */
function readCorpusFile(root: string, entry: any, { maxBytes = CORPUS_LIMITS.maxFileBytes, fsImpl = fs, now = Date.now, deadline = Infinity }: any = {}): any {
  let fd: any = null;
  let bytesRead = 0;
  try {
    const rel = relativeCodePath(entry?.path);
    if (!rel) return { ok: false, reason: 'invalid-path', bytesRead };
    const absolute = path.resolve(root, rel);
    if (!insideRoot(root, absolute)) return { ok: false, reason: 'outside-root', bytesRead };
    let cursor = root;
    for (const piece of rel.split('/')) {
      if (now() > deadline) return { ok: false, reason: 'deadline', bytesRead };
      cursor = path.join(cursor, piece);
      if (fsImpl.lstatSync(cursor).isSymbolicLink()) return { ok: false, reason: 'symlink', bytesRead };
    }
    if (fsImpl.realpathSync(absolute) !== absolute) return { ok: false, reason: 'outside-root', bytesRead };
    const before = fsImpl.lstatSync(absolute);
    if (!before.isFile()) return { ok: false, reason: 'not-regular-file', bytesRead };
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || before.size > maxBytes) return { ok: false, reason: 'read-byte-limit', bytesRead };
    fd = fsImpl.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const opened = fsImpl.fstatSync(fd);
    if (!opened.isFile() || !sameFile(before, opened)) return { ok: false, reason: 'source-changed', bytesRead };
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, opened.size + 1));
    while (bytesRead < buffer.length) {
      if (now() > deadline) return { ok: false, reason: 'deadline', bytesRead };
      const count = fsImpl.readSync(fd, buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!count) break;
      bytesRead += count;
    }
    if (bytesRead > maxBytes) return { ok: false, reason: 'read-byte-limit', bytesRead };
    const after = fsImpl.fstatSync(fd);
    if (!sameFile(opened, after) || !sameFile(after, fsImpl.lstatSync(absolute)) || fsImpl.realpathSync(absolute) !== absolute || bytesRead !== after.size) {
      return { ok: false, reason: 'source-changed', bytesRead };
    }
    const content = buffer.subarray(0, bytesRead);
    const fileHash = digest(content);
    if (entry.fileHash && entry.fileHash !== fileHash) return { ok: false, reason: 'source-changed', bytesRead };
    return { ok: true, content, fileHash, bytesRead, stat: after };
  } catch (error: any) {
    return { ok: false, reason: error.code === 'ENOENT' ? 'missing-source' : 'source-unreadable', bytesRead };
  } finally {
    if (fd !== null) { try { fsImpl.closeSync(fd); } catch { /* no live descriptor survives */ } }
  }
}

function globExpression(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') { i += 1; out += '(?:.*/)?'; }
        else out += '.*';
      } else out += '[^/]*';
    } else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[|\\{}()[\]^$+.]/g, '\\$&');
  }
  return out;
}

/** Normalize the scopes once per admission; a plain scope matches itself or any path under it. */
function scopeMatcher(scopes: any[]): (rel: string) => boolean {
  if (!scopes.length) return () => true;
  const plain = new Set<string>();
  const globs: RegExp[] = [];
  for (const raw of scopes) {
    if (typeof raw !== 'string') continue;
    const scope = raw.replace(/^\.\//, '').replace(/\/$/, '');
    if (!scope || scope === '.' || scope === '**') return () => true;
    if (!/[?*]/.test(scope)) plain.add(scope);
    else globs.push(new RegExp(`^${globExpression(scope)}$`));
  }
  return (rel: string) => {
    if (plain.has(rel)) return true;
    for (let i = rel.indexOf('/'); i > 0; i = rel.indexOf('/', i + 1)) if (plain.has(rel.slice(0, i))) return true;
    return globs.some((glob) => glob.test(rel));
  };
}

function parseIgnore(text: string, base: string): any[] {
  const rules: any[] = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/(?<!\\) +$/, '');
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    line = line.replace(/^\\([#!])/, '$1');
    const directory = line.endsWith('/');
    if (directory) line = line.slice(0, -1);
    const anchored = line.startsWith('/');
    if (anchored) line = line.slice(1);
    if (!line) continue;
    const prefix = anchored || line.includes('/') ? '^' : '(?:^|/)';
    rules.push({ base, negate, directory, regex: new RegExp(`${prefix}${globExpression(line)}(?:/.*)?$`) });
  }
  return rules;
}

function ignored(rel: string, rules: any[], isDirectory = false): boolean {
  let result = false;
  for (const rule of rules) {
    if (rule.base && !rel.startsWith(`${rule.base}/`)) continue;
    const local = rule.base ? rel.slice(rule.base.length + 1) : rel;
    if (rule.directory && !isDirectory && !local.includes('/')) continue;
    if (rule.regex.test(local)) result = !rule.negate;
  }
  return result;
}

/** Enumerate once. All search, mirror and validation callers receive this same inventory. */
function admitCodeCorpus(options: any = {}): any {
  const { fsImpl = fs, execFileSyncImpl = execFileSync, now = Date.now } = options;
  const limits = { ...CORPUS_LIMITS, ...options.limits };
  for (const [name, value] of Object.entries(limits)) if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`invalid corpus limit ${name}`);
  const root = fsImpl.realpathSync(path.resolve(options.root || process.cwd()));
  const scopes = Array.isArray(options.scopes) ? options.scopes : [];
  const inScope = scopeMatcher(scopes);
  const started = now();
  const deadline = options.deadline ?? started + limits.timeoutMs;
  const skipped: any[] = [];
  const files: any[] = [];
  const ignoreSources: any[] = [];
  const ruleCache = new Map<string, any[]>();
  let complete = true;
  let sourceBytes = 0;
  let readBytes = 0;
  const reject = (p: string, reason: string) => { skipped.push({ path: p, reason }); complete = false; };
  const rulesFor = (dir: string): any[] => {
    if (ruleCache.has(dir)) return ruleCache.get(dir) || [];
    const parent = dir ? path.posix.dirname(dir) : null;
    const rules = parent !== null ? [...rulesFor(parent === '.' ? '' : parent)] : [];
    for (const name of ['.gitignore', '.sembleignore']) {
      const rel = dir ? `${dir}/${name}` : name;
      const p = path.resolve(root, rel);
      try {
        const stat = fsImpl.lstatSync(p);
        if (!stat.isFile() || stat.size > 65536) { reject(rel, 'invalid-ignore-file'); continue; }
        const read = readCorpusFile(root, { path: rel }, { maxBytes: 65536, fsImpl, now, deadline });
        readBytes += read.bytesRead;
        if (!read.ok) { reject(rel, read.reason); continue; }
        const text = read.content.toString('utf8');
        ignoreSources.push([rel, digest(text)]);
        rules.push(...parseIgnore(text, dir).map((r: any) => ({ ...r, kind: name })));
      } catch (error: any) { if (error.code !== 'ENOENT') reject(rel, 'ignore-unreadable'); }
    }
    ruleCache.set(dir, rules);
    return rules;
  };
  let paths: string[] = [];
  let gitInventory = false;
  if (Array.isArray(options.files)) {
    paths = options.files.map((f: any) => typeof f === 'string' ? f : f.path);
  } else {
    try {
      const data = execFileSyncImpl('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        encoding: 'utf8', timeout: Math.max(1, deadline - now()), maxBuffer: limits.maxOutputBytes, stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (Buffer.byteLength(String(data), 'utf8') > limits.maxOutputBytes) throw Object.assign(new Error('output limit'), { code: 'ENOBUFS' });
      paths = String(data).split('\0').filter(Boolean);
      gitInventory = true;
    } catch (error: any) {
      if (error.code === 'ENOBUFS' || error.code === 'ETIMEDOUT' || error.signal) reject('', error.code === 'ENOBUFS' ? 'enumeration-output-limit' : 'deadline');
      else {
        const walk = (dir: string) => {
          if (now() > deadline) { reject(dir, 'deadline'); return; }
          let entries: any[];
          try { entries = fsImpl.readdirSync(path.join(root, dir), { withFileTypes: true }).sort((a: any, b: any) => compareText(a.name, b.name)); }
          catch { reject(dir, 'directory-unreadable'); return; }
          const rules = rulesFor(dir);
          for (const entry of entries) {
            if (now() > deadline) { reject(dir, 'deadline'); break; }
            if (EXCLUDED.has(entry.name)) continue;
            const rel = dir ? `${dir}/${entry.name}` : entry.name;
            if (ignored(rel, rules, entry.isDirectory())) continue;
            if (entry.isDirectory()) walk(rel);
            else paths.push(rel);
            if (paths.length > limits.maxFiles) { reject(rel, 'file-count-limit'); return; }
          }
        };
        walk('');
      }
    }
  }
  const unique = [...new Set(paths)].sort(compareText);
  for (const raw of unique) {
    if (now() > deadline) { reject('', 'deadline'); break; }
    const rel = relativeCodePath(raw);
    if (!rel) { reject(String(raw), 'invalid-path'); continue; }
    if (rel.split('/').some((p: string) => EXCLUDED.has(p)) || !inScope(rel)) continue;
    const dir = path.posix.dirname(rel);
    const rules = rulesFor(dir === '.' ? '' : dir);
    // Git itself owns gitignore semantics for its inventory; sembleignore always applies.
    const activeRules = gitInventory ? rules.filter((r: any) => r.kind === '.sembleignore') : rules;
    if (ignored(rel, activeRules)) continue;
    const absolutePath = path.resolve(root, rel);
    try {
      const stat = fsImpl.lstatSync(absolutePath);
      if (!stat.isFile() || stat.isSymbolicLink() || fsImpl.realpathSync(absolutePath) !== absolutePath) { reject(rel, 'not-regular-file'); continue; }
      if (files.length >= limits.maxFiles) { reject(rel, 'file-count-limit'); break; }
      if (stat.size > limits.maxFileBytes) { reject(rel, 'file-byte-limit'); continue; }
      if (sourceBytes + stat.size > limits.maxBytes) { reject(rel, 'corpus-byte-limit'); continue; }
      let fileHash: string | null = null;
      if (options.hashFiles !== false) {
        const read = readCorpusFile(root, { path: rel }, { maxBytes: limits.maxFileBytes, fsImpl, now, deadline });
        readBytes += read.bytesRead;
        if (!read.ok) { reject(rel, read.reason); continue; }
        fileHash = read.fileHash;
      }
      files.push({ path: rel, absolutePath, sizeBytes: stat.size, fileHash });
      sourceBytes += stat.size;
    } catch { reject(rel, 'source-unreadable'); }
  }
  const scopeIgnoreDigest = digest(JSON.stringify({ scopes, ignores: ignoreSources.sort((a: any, b: any) => compareText(a[0], b[0])), exclusions: [...EXCLUDED].sort() }));
  const identity = digest(JSON.stringify({ root, scopeIgnoreDigest, files: files.map((f: any) => [f.path, f.sizeBytes, f.fileHash]), complete }));
  return { schemaVersion: 1, root, identity, scopeIgnoreDigest, files, complete, skipped,
    coverage: { complete, admittedFiles: files.length, skippedFiles: skipped.length, sourceBytes },
    accounting: { sourceBytes, readBytes, elapsedMs: Math.max(0, now() - started) },
    options: { root, files: options.files, scopes, hashFiles: options.hashFiles, limits } };
}

function fingerprintCorpus(inventory: any, options: any = {}): any {
  return admitCodeCorpus({ ...inventory.options, root: inventory.root, ...options, hashFiles: true });
}

module.exports = { CORPUS_LIMITS, compareText, digest, relativeCodePath, insideRoot, readCorpusFile, admitCodeCorpus, fingerprintCorpus };
