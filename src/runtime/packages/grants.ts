'use strict';

/**
 * The person grant file reader (122 IC-008). `<configHome>/packages/grants.jsonl` is written only by a
 * person; this module reads it and never writes, renames or deletes it (a grep test in
 * test/runtime/package-grants.test.js holds every `src/` file to that).
 *
 * `readGrants` returns the file path and mtime, one `entries` row per well-formed line with its state, the
 * `grants` that count right now, and IC-004 findings. Void rules: an unreadable file, a line over 2 KiB, more
 * than 1000 lines, a malformed line, an unknown key or kind, or a duplicate key (`duplicateKey`: a trust line's grant,
 * package, version, contentDigest, capabilityDigest and policy; an exempt line's grant, package, version and
 * contentDigest; a fetch grant's source) voids every grant (`state-unreadable`, naming the line
 * number and never its text). A file whose realpath lies in the detected project root (`detectedProjectRoot`,
 * never the working directory itself), a `.doflow/state/dispatch-worktrees/` directory or the system temp directory is ignored (`grant-invalid`, reason
 * `grants-file-location`). No file means no grants and no finding.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { configHome } = require('../config-home.ts');
const { parseSemVer } = require('../../helper/semver.ts');
const { isPackageId, isQualifiedId } = require('../../helper/package-ids.ts');
const { duplicateKeys } = require('../review/protocols.ts');

const GRANTS_FILE = path.join('packages', 'grants.jsonl');
const LINE_MAX_BYTES = 2048;
const LINES_MAX = 1000;
const REBIND_MAX = 64;

const DIGEST = /^[0-9a-f]{64}$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const KEYS = new Map<string, { required: string[]; optional: string[] }>([
  ['trust', { required: ['grant', 'package', 'version', 'contentDigest', 'capabilityDigest', 'policy', 'at'], optional: ['rebind'] }],
  ['exempt', { required: ['grant', 'package', 'version', 'contentDigest', 'host', 'acceptRisk', 'at'], optional: [] }],
  ['fetch', { required: ['grant', 'source', 'at'], optional: [] }],
]);

const isObject = (value: any): boolean => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value: any): boolean => typeof value === 'string' && value !== '' && value.length <= 512;
const isTime = (value: any): boolean => typeof value === 'string' && ISO_UTC.test(value) && !Number.isNaN(Date.parse(value));
const isVersion = (value: any): boolean => typeof value === 'string' && parseSemVer(value) !== null;

function finding(code: string, field: string, message: string, allowed: string, reason?: string): any {
  return { package: null, field, code, severity: 'error', message, allowed, ...(reason ? { reason } : {}) };
}

/** The source of a `fetch` grant, as written: git `{type,url,ref,path?}` or npm `{type,name,version}`. */
function sourceProblem(source: any): string | null {
  if (!isObject(source)) return 'source must be an object';
  const keys = Object.keys(source).sort().join(',');
  if (source.type === 'git') {
    if (keys !== 'ref,type,url' && keys !== 'path,ref,type,url') return 'git source keys';
    return isText(source.url) && isText(source.ref) && (source.path === undefined || isText(source.path)) ? null : 'git source values';
  }
  if (source.type === 'npm') {
    if (keys !== 'name,type,version') return 'npm source keys';
    return isText(source.name) && isText(source.version) ? null : 'npm source values';
  }
  return 'source type';
}

/** Why a parsed line is not a grant of its kind, or null. The reason never quotes the line. */
function lineProblem(grant: any): string | null {
  if (!isObject(grant)) return 'not a JSON object';
  const spec = KEYS.get(grant.grant);
  if (!spec) return 'unknown kind';
  const allowed = new Set([...spec.required, ...spec.optional]);
  if (Object.keys(grant).some((key) => !allowed.has(key))) return 'unknown key';
  if (spec.required.some((key) => !Object.hasOwn(grant, key))) return 'missing key';
  if (!isTime(grant.at)) return 'bad at';
  if (grant.grant === 'fetch') return sourceProblem(grant.source) ? 'bad source' : null;
  if (!isPackageId(grant.package) || !isVersion(grant.version) || !DIGEST.test(grant.contentDigest)) return 'bad package, version or digest';
  if (grant.grant === 'exempt') return isVersion(grant.host) && grant.acceptRisk === true ? null : 'bad host or acceptRisk';
  if (!DIGEST.test(grant.capabilityDigest) || !Number.isInteger(grant.policy) || grant.policy < 1) return 'bad capabilityDigest or policy';
  if (Object.hasOwn(grant, 'rebind')
    && !(Array.isArray(grant.rebind) && grant.rebind.length <= REBIND_MAX && grant.rebind.every(isQualifiedId))) return 'bad rebind';
  return null;
}

/**
 * The duplicate key of IC-008 (FU-gjgp06, FU-92eftv): (grant, package, version, contentDigest, capabilityDigest, policy)
 * for trust, (grant, package, version, contentDigest) for exempt, and a fetch grant's source as written. Lines for one
 * package version with other digests or another policy coexist, so a re-trust after an edit or a policy bump is an
 * append; a line with an existing key is a replacement of that line (the package verbs say which).
 */
const duplicateKey = (grant: any): string => {
  if (grant.grant === 'fetch') return `fetch ${JSON.stringify(Object.keys(grant.source).sort().map((key) => [key, grant.source[key]]))}`;
  const key = `${grant.grant} ${grant.package} ${grant.version} ${grant.contentDigest}`;
  return grant.grant === 'trust' ? `${key} ${grant.capabilityDigest} ${grant.policy}` : key;
};

const realOf = (fsImpl: any, file: string): string => {
  try { return (fsImpl.realpathSync.native ?? fsImpl.realpathSync)(file); } catch { return path.resolve(file); }
};
const within = (child: string, parent: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** True when `path.join(dir, name)` exists and, with `directory`, is a directory. Never throws. */
const holds = (fsImpl: any, dir: string, name: string, directory: boolean): boolean => {
  try { const stat = fsImpl.statSync(path.join(dir, name)); return !directory || stat.isDirectory(); } catch { return false; }
};

/**
 * The detected project root (IC-008 as amended by FU-t622ad; IC-025 reuses it): from `cwd` upward, the nearest
 * directory, `cwd` included, that holds `.git` (a directory, or the file of a linked worktree) or a `.doflow/`
 * directory. The account home `homeDir` and every ancestor of it end the walk, because the home is the global scope,
 * not a project. Returns that directory's real path, or null when there is no project. Spawns no process.
 */
function detectedProjectRoot({ cwd = process.cwd(), homeDir = os.homedir(), fsImpl = fs }: { cwd?: string; homeDir?: string | null; fsImpl?: any } = {}): string | null {
  const home = homeDir ? realOf(fsImpl, homeDir) : null;
  for (let dir = realOf(fsImpl, cwd); ; dir = path.dirname(dir)) {
    if (home !== null && within(home, dir)) return null; // the home or an ancestor of it: so is every parent
    if (holds(fsImpl, dir, '.git', false) || holds(fsImpl, dir, '.doflow', true)) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

/** `grants-file-location` (IC-008): the realpath is in the project root (none when null), a dispatch worktree or the temp dir. */
function badLocation(real: string, projectRoot: string | null, tmpDir: string, fsImpl: any): boolean {
  const marker = `${path.sep}.doflow${path.sep}state${path.sep}dispatch-worktrees${path.sep}`;
  return (projectRoot !== null && within(real, realOf(fsImpl, projectRoot))) || within(real, realOf(fsImpl, tmpDir)) || `${real}${path.sep}`.includes(marker);
}

/**
 * Read the grant file. Options: `env` (for the config home, and its `HOME` for the account home), `fsImpl`,
 * `projectRoot` (default: `detectedProjectRoot` from the working directory; `null` means no project, so only the
 * dispatch-worktree and temp-dir rules apply), `tmpDir` (default `os.tmpdir()`; an injected seam for tests). Never throws.
 * Returns `{ path, noConfigHome, exists, mtime, entries, grants, findings }`: `path` is null with no config home
 * (no grant can exist); `mtime` is an ISO string or null; `entries` holds each well-formed line as
 * `{ line, raw, state: 'valid'|'void'|'ignored', reason?, ...fields }`; `grants` are the `valid` entries.
 */
function readGrants({ env = process.env, fsImpl = fs, projectRoot, tmpDir = os.tmpdir() }: any = {}): any {
  const dir = configHome(env).dir;
  const result: any = { path: null, noConfigHome: dir === null, exists: false, mtime: null, entries: [], grants: [], findings: [] };
  if (dir === null) return result;
  const file = path.join(dir, GRANTS_FILE);
  result.path = file;
  const unreadable = (message: string): any => {
    result.findings.push(finding('state-unreadable', 'grants.jsonl', message, 'a grants file of at most 1000 lines of at most 2 KiB, one closed-key JSON object each'));
    for (const entry of result.entries) { entry.state = 'void'; entry.reason = 'state-unreadable'; }
    result.grants = [];
    return result;
  };
  let text: string;
  try {
    const stat = fsImpl.statSync(file);
    result.exists = true;
    result.mtime = new Date(stat.mtimeMs ?? stat.mtime).toISOString();
    if (stat.size > LINES_MAX * (LINE_MAX_BYTES + 2)) return unreadable(`the grants file is larger than ${LINES_MAX} lines of ${LINE_MAX_BYTES} bytes`);
    text = String(fsImpl.readFileSync(file, 'utf8'));
  } catch (error: any) {
    if (error?.code === 'ENOENT' && !result.exists) return result; // no file: no grants, no error
    return unreadable('the grants file could not be read');
  }

  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let problem: string | null = lines.length > LINES_MAX ? `line ${LINES_MAX + 1} is past the ${LINES_MAX}-line limit` : null;
  const seen = new Set<string>();
  for (let i = 0; i < Math.min(lines.length, LINES_MAX) && problem === null; i++) {
    const raw = lines[i].trim();
    const number = i + 1;
    if (Buffer.byteLength(lines[i]) > LINE_MAX_BYTES) { problem = `line ${number} is longer than ${LINE_MAX_BYTES} bytes`; break; }
    if (raw === '' || raw.startsWith('#')) continue;
    let grant: any;
    try { grant = duplicateKeys(raw).length ? undefined : JSON.parse(raw); } catch { grant = undefined; }
    const why = grant === undefined ? 'not valid JSON' : lineProblem(grant);
    if (why) { problem = `line ${number} is not a valid grant (${why})`; break; }
    const key = duplicateKey(grant);
    const what = grant.grant === 'fetch' ? 'source' : grant.grant === 'trust' ? '(grant, package, version, contentDigest, capabilityDigest, policy)' : '(grant, package, version, contentDigest)';
    if (seen.has(key)) { problem = `line ${number} repeats the ${what} of an earlier line`; break; }
    seen.add(key);
    result.entries.push({ line: number, raw, state: 'valid', ...grant });
  }
  const root = projectRoot !== undefined ? projectRoot
    : detectedProjectRoot({ homeDir: typeof env.HOME === 'string' && path.isAbsolute(env.HOME) ? env.HOME : os.homedir(), fsImpl });
  const misplaced = badLocation(realOf(fsImpl, file), root, tmpDir, fsImpl);
  if (problem !== null && !misplaced) return unreadable(problem);
  if (misplaced) {
    for (const entry of result.entries) { entry.state = 'ignored'; entry.reason = 'grants-file-location'; }
    result.findings.push(finding('grant-invalid', 'grants.jsonl', 'the grants file lies inside the project root, a dispatch worktree or the system temp directory, so every grant in it is ignored',
      'a grants file outside the project and the temp directory (set XDG_CONFIG_HOME to a path in your own home)', 'grants-file-location'));
    return result;
  }
  result.grants = result.entries;
  return result;
}

module.exports = { readGrants, detectedProjectRoot, duplicateKey, GRANTS_FILE, LINE_MAX_BYTES, LINES_MAX };
