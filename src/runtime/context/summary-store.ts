'use strict';

// Scoped compact summaries and grants (078 IC-010, IC-012, IC-013 in process; DEC-002, DEC-012).
// Run directly by Node native type-stripping.
//
// The TypeScript twin of `policies/summary-store.sh`: the same layout, record format, rename
// claims, 65536-byte bounded reads and grant-fits rule, so a summary written by either side is
// claimed by the other. Layout under stateDir() (`${XDG_CONFIG_HOME:-$HOME/.config}/doflow/session-env`):
//   summaries/<worktreeKey>/<run>/<lineage>/summary.md            one pending summary per scope
//   summaries/<worktreeKey>/<run>/<lineage>/.summary.XXXXXX       write temporary
//   summaries/<worktreeKey>/<run>/<lineage>/.claimed.<unitId>     claim temporary
//   grants/<run>/<lineage>/<summaryId>.md                         grant addressed to a recipient
//   grants/<run>/<lineage>/.grant.XXXXXX                          grant write temporary
//   grants/<run>/<lineage>/.claimed.<unitId>.<summaryId>          claim temporary
// Records are read as bytes (latin1 strings, one character per byte), as the bash store does under
// LC_ALL=C, so byte counts match it on any input, valid UTF-8 or not.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ID_PATTERN, cwdHash, stateDir } = require('./identity.ts');

type Env = Record<string, string | undefined>;

const SUMMARY_ID_PATTERN = /^s-[0-9]{8}T[0-9]{6}Z-[A-Za-z0-9]{6}$/;
/** A unit id (L.<run>.<lineage>.<attempt> or a harness session id) is one path segment. */
const UNIT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AT_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const ATTEMPT_PATTERN = /^[1-9][0-9]{0,3}$/;
const MAX_BYTES_PATTERN = /^[1-9][0-9]{0,9}$/;
const READ_BOUND = 65536;
const DEFAULT_GRANT_MAX_BYTES = 16384;
const SUFFIX_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** IC-013 exits: not found, legacy or already granted 1, usage 2, over budget 3. */
const GRANT_EXIT = {
  'summary-not-found': 1,
  'summary-legacy': 1,
  'grant-exists': 1,
  usage: 2,
  'over-budget': 3,
} as const;
type GrantErrorCode = keyof typeof GRANT_EXIT;

class SummaryStoreError extends Error {
  code: GrantErrorCode;
  exitCode: number;
  constructor(code: GrantErrorCode, message: string) {
    super(message);
    this.name = 'SummaryStoreError';
    this.code = code;
    this.exitCode = GRANT_EXIT[code];
  }
}

function idOk(value: string | undefined): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function regularFile(file: string): boolean {
  try {
    return fs.lstatSync(file).isFile();
  } catch {
    return false;
  }
}

/** The file's first `limit` bytes (all of it when limit is omitted) as a latin1 string, or null. */
function readBytes(file: string, limit?: number): string | null {
  try {
    if (limit === undefined) return fs.readFileSync(file).toString('latin1');
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(limit);
      let length = 0;
      while (length < limit) {
        const n = fs.readSync(fd, buffer, length, limit - length, null);
        if (n === 0) break;
        length += n;
      }
      return buffer.subarray(0, length).toString('latin1');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function fileSize(file: string): number | null {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

/**
 * emission.jq's parse_record over a byte string: `\r` removed, trailing newlines dropped, fields
 * from the lines between the first two `---` lines (first match wins, leading spaces of a value
 * dropped), body from the first non-empty line after the second `---`, trailing newlines dropped.
 */
function parseRecord(raw: string): { fields: Record<string, string>; body: string } {
  const lines = raw.replace(/\r/g, '').replace(/\n+$/, '').split('\n');
  const fields: Record<string, string> = Object.create(null);
  const body: string[] = [];
  let fences = 0;
  let started = false;
  for (const line of lines) {
    if (fences < 2 && line === '---') { fences += 1; continue; }
    if (fences === 1) {
      const colon = line.indexOf(':');
      if (colon > 0) {
        const key = line.slice(0, colon);
        if (!(key in fields)) fields[key] = line.slice(colon + 1).replace(/^ */, '');
      }
    } else if (fences >= 2 && (started || line !== '')) {
      started = true;
      body.push(line);
    }
  }
  return { fields, body: body.join('\n').replace(/\n+$/, '') };
}

/** The frontmatter fields of a record from its first 65536 bytes (the bash store's bounded head read). */
function readHead(file: string): Record<string, string> {
  const raw = readBytes(file, READ_BOUND);
  return raw === null ? Object.create(null) : parseRecord(raw).fields;
}

/** emission.jq's `known`: `]` removed, then empty when it is "unknown". */
function known(value: string | undefined): string {
  const v = (value ?? '').replace(/\]/g, '');
  return v === 'unknown' ? '' : v;
}

/** render_grant's header line, `]` included, over byte strings. */
function grantHeader(fromLineage: string | undefined, compactedAt: string | undefined, branch: string | undefined): string {
  const at = known(compactedAt);
  const br = known(branch);
  return `[Granted summary from lineage ${fromLineage ?? ''}${at ? `, compacted ${at}` : ''}${br ? ` on branch ${br}` : ''}]`;
}

/** A frontmatter value is one line: an embedded line break would forge a key. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]/g, ' ');
}

function utf8(value: string): string {
  return Buffer.from(value, 'latin1').toString('utf8');
}

/** `mktemp <dir>/<prefix>XXXXXX`: an exclusively created 0600 file with a six-character suffix. */
function makeTemp(dir: string, prefix: string): { file: string; suffix: string } {
  for (let tries = 0; tries < 100; tries++) {
    const bytes = crypto.randomBytes(6);
    let suffix = '';
    for (const b of bytes) suffix += SUFFIX_CHARS[b % SUFFIX_CHARS.length];
    const file = path.join(dir, `${prefix}${suffix}`);
    try {
      fs.closeSync(fs.openSync(file, 'wx', 0o600));
      return { file, suffix };
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`cannot create a temporary file in ${dir}`);
}

function removeQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Best effort, as `rm -f ... || true`.
  }
}

/**
 * `doflow_summary_scope`: summaries/<worktreeKey>/<run>/<lineage> under stateDir(), or null when run
 * or lineage is not an id, the lineage is `solo` (no scope directory) or the worktree is empty.
 */
function summaryScope(worktree: string, run: string, lineage: string, env: Env = process.env): string | null {
  if (!idOk(run) || !idOk(lineage) || lineage === 'solo' || !worktree) return null;
  return path.join(stateDir(env), 'summaries', cwdHash(worktree), run, lineage);
}

interface WriteSummaryOptions {
  worktree: string;
  run: string;
  lineage: string;
  attempt?: string;
  compactedAt: string;
  sessionId?: string;
  trigger?: string;
  branch?: string;
  role?: string;
  body: string;
  env?: Env;
}

/**
 * `doflow_summary_write` (IC-011 step 3): create the scope, write the IC-010 record to a
 * `.summary.XXXXXX` temporary, rename it to summary.md (a newer compaction replaces the pending one).
 * Returns { summaryId, path }, or null with nothing left behind on an invalid argument, an empty
 * body or a failed step.
 */
function writeSummary(options: WriteSummaryOptions): { summaryId: string; path: string } | null {
  const { run, lineage, compactedAt, body, env = process.env } = options;
  const attempt = options.attempt ?? '';
  if (!body) return null;
  if (!AT_PATTERN.test(compactedAt)) return null;
  if (attempt !== '' && !ATTEMPT_PATTERN.test(attempt)) return null;
  const scope = summaryScope(options.worktree, run, lineage, env);
  if (scope === null) return null;
  const session = oneLine(options.sessionId ?? '');
  const trigger = oneLine(options.trigger ?? '');
  const branch = oneLine(options.branch ?? '');
  const role = oneLine(options.role ?? '');
  const worktree = oneLine(options.worktree);
  let tmp = '';
  try {
    fs.mkdirSync(scope, { recursive: true });
    const made = makeTemp(scope, '.summary.');
    tmp = made.file;
    const summaryId = `s-${compactedAt.replace(/[-:]/g, '')}-${made.suffix}`;
    if (!SUMMARY_ID_PATTERN.test(summaryId)) throw new Error('summary id');
    const record = '---\n'
      + `compacted_at: ${compactedAt}\n`
      + `session_id: ${session || 'unknown'}\n`
      + `trigger: ${trigger || 'unknown'}\n`
      + `branch: ${branch || 'unknown'}\n`
      + `role: ${role || 'main'}\n`
      + `summary_id: ${summaryId}\n`
      + `run: ${run}\n`
      + `lineage: ${lineage}\n`
      + `attempt:${attempt ? ` ${attempt}` : ''}\n`
      + `worktree: ${worktree}\n`
      + '---\n\n'
      + `${body}\n`;
    fs.writeFileSync(tmp, record);
    const target = path.join(scope, 'summary.md');
    fs.renameSync(tmp, target);
    return { summaryId, path: target };
  } catch {
    if (tmp) removeQuietly(tmp);
    return null;
  }
}

type OwnSummary = 'none' | 'pending' | 'own-write';

/**
 * `doflow_summary_peek` (IC-012 owner steps 1 and 2): `none` when the scope holds no regular,
 * non-symlink summary.md, `own-write` when its frontmatter session_id is this session's, else
 * `pending`; file is its path when not `none`.
 */
function peekSummary(worktree: string, run: string, lineage: string, sessionId: string, env: Env = process.env): { own: OwnSummary; file: string | null; scope: string | null } {
  const scope = summaryScope(worktree, run, lineage, env);
  if (scope === null) return { own: 'none', file: null, scope: null };
  const file = path.join(scope, 'summary.md');
  if (!regularFile(file)) return { own: 'none', file: null, scope };
  const session = readHead(file).session_id ?? '';
  const own: OwnSummary = sessionId && utf8(session) === sessionId ? 'own-write' : 'pending';
  return { own, file, scope };
}

/**
 * `doflow_summary_claim` (IC-012 owner steps 1 to 3): peek, then rename summary.md to
 * `.claimed.<unitId>`; a summary written after the rename is a new summary.md and survives. The
 * claimed copy is cut to its first 65536 bytes. claimed is set only when this caller claimed it;
 * bytes is the claimed file's full size before the cut. The caller removes the claimed file.
 */
function claimSummary(worktree: string, run: string, lineage: string, unitId: string, sessionId: string, env: Env = process.env): { own: OwnSummary; claimed: string | null; bytes: number } {
  const peek = peekSummary(worktree, run, lineage, sessionId, env);
  if (peek.own !== 'pending' || peek.file === null || peek.scope === null) return { own: peek.own, claimed: null, bytes: 0 };
  if (!UNIT_PATTERN.test(unitId)) return { own: peek.own, claimed: null, bytes: 0 };
  const claimed = path.join(peek.scope, `.claimed.${unitId}`);
  try {
    fs.renameSync(peek.file, claimed);
  } catch {
    return { own: 'none', claimed: null, bytes: 0 };
  }
  const bytes = fileSize(claimed) ?? 0;
  if (bytes > READ_BOUND) {
    try {
      fs.truncateSync(claimed, READ_BOUND);
    } catch {
      removeQuietly(claimed);
      return { own: peek.own, claimed: null, bytes };
    }
  }
  return { own: peek.own, claimed, bytes };
}

type GrantState = 'none' | 'fits' | 'over';

interface GrantPeek {
  grant: GrantState;
  file: string | null;
  id: string | null;
  /** The body's UTF-8 bytes, for the pointer; null when the file is too large to be worth reading. */
  bytes: number | null;
}

/**
 * `doflow_grant_peek` (IC-012 grant steps 1 and 2): the oldest grants/<run>/<lineage>/<summaryId>.md
 * by name among regular, non-symlink files whose name matches the summary id pattern. It fits
 * exactly when the UTF-8 bytes of render_grant's segment "<header>\n<body>" are at most maxBytes.
 */
function peekGrant(run: string, lineage: string, maxBytes: number | string, env: Env = process.env): GrantPeek {
  const none: GrantPeek = { grant: 'none', file: null, id: null, bytes: null };
  if (!idOk(run) || !idOk(lineage)) return none;
  const max = String(maxBytes);
  if (!MAX_BYTES_PATTERN.test(max)) return none;
  const dir = path.join(stateDir(env), 'grants', run, lineage);
  let names: string[];
  try {
    if (!fs.lstatSync(dir).isDirectory()) return none;
    names = fs.readdirSync(dir);
  } catch {
    return none;
  }
  // The glob `s-*.md` in C collation: byte order, which for these ASCII names is code-unit order.
  const candidates = names.filter((n) => n.startsWith('s-') && n.endsWith('.md')).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  let file: string | null = null;
  let id: string | null = null;
  for (const name of candidates) {
    const stem = name.slice(0, -3);
    if (!SUMMARY_ID_PATTERN.test(stem)) continue;
    const f = path.join(dir, name);
    if (!regularFile(f)) continue;
    file = f;
    id = stem;
    break;
  }
  if (file === null) return none;
  const size = fileSize(file);
  // A frontmatter needs far less than 65536 bytes: anything larger than that plus the budget is over.
  if (size === null || size > Number(max) + READ_BOUND) return { grant: 'over', file, id, bytes: null };
  const raw = readBytes(file);
  if (raw === null) return { grant: 'over', file, id, bytes: null };
  const bytes = parseRecord(raw).body.length;
  const head = readHead(file);
  const header = grantHeader(head.from_lineage, head.compacted_at, head.branch);
  return { grant: header.length + 1 + bytes <= Number(max) ? 'fits' : 'over', file, id, bytes };
}

/**
 * `doflow_grant_claim` (IC-012 grant step 3): peek; when the oldest grant fits, rename it to
 * `.claimed.<unitId>.<summaryId>`. An `over` grant stays in place. One grant per call; claimed is
 * set only when this caller claimed it, and the caller removes it after rendering.
 */
function claimGrant(run: string, lineage: string, unitId: string, maxBytes: number | string, env: Env = process.env): GrantPeek & { claimed: string | null } {
  const peek = peekGrant(run, lineage, maxBytes, env);
  if (peek.grant !== 'fits' || peek.file === null || !UNIT_PATTERN.test(unitId)) return { ...peek, claimed: null };
  const claimed = path.join(path.dirname(peek.file), `.claimed.${unitId}.${peek.id}`);
  try {
    fs.renameSync(peek.file, claimed);
  } catch {
    return { ...peek, grant: 'none', claimed: null };
  }
  return { ...peek, claimed };
}

interface GrantOptions {
  /** A summary id, or `pending` for the source scope's current summary.md. */
  summary: string;
  toRun: string;
  toLineage: string;
  /** Default DOFLOW_WORKTREE, else the working directory. */
  fromWorktree?: string;
  /** Default DOFLOW_RUN_ID, else `local`. */
  fromRun?: string;
  /** Default DOFLOW_LINEAGE_ID, else `main`. */
  fromLineage?: string;
  /** Budget for the rendered grant segment; default 16384. */
  maxBytes?: number | string;
  env?: Env;
  now?: Date;
}

/**
 * IC-013 in process: copy one summary's body into grants/<toRun>/<toLineage>/<summaryId>.md,
 * written atomically and refusing when that file exists; the owner's summary is untouched. Every
 * refusal happens before any write and throws a SummaryStoreError whose exitCode is the verb's exit.
 */
function grantSummary(options: GrantOptions): { summaryId: string; path: string; bytes: number } {
  const env = options.env ?? process.env;
  const fromWorktree = options.fromWorktree ?? (env.DOFLOW_WORKTREE || process.cwd());
  const fromRun = options.fromRun ?? (env.DOFLOW_RUN_ID || 'local');
  const fromLineage = options.fromLineage ?? (env.DOFLOW_LINEAGE_ID || 'main');
  const max = String(options.maxBytes ?? DEFAULT_GRANT_MAX_BYTES);
  const wanted = options.summary;

  if (typeof wanted !== 'string' || (wanted !== 'pending' && !SUMMARY_ID_PATTERN.test(wanted))) {
    throw new SummaryStoreError('usage', '--summary must be `pending` or a summary id');
  }
  if (!idOk(options.toRun) || !idOk(options.toLineage)) throw new SummaryStoreError('usage', '--to-run and --to-lineage must be ids');
  if (!MAX_BYTES_PATTERN.test(max)) throw new SummaryStoreError('usage', '--max-bytes must be a positive integer');
  const scope = summaryScope(fromWorktree, fromRun, fromLineage, env);
  if (scope === null) throw new SummaryStoreError('usage', 'the source scope needs a worktree, a run id and a non-solo lineage id');

  const source = path.join(scope, 'summary.md');
  if (!regularFile(source)) throw new SummaryStoreError('summary-not-found', `no pending summary in ${scope}`);
  const head = readHead(source);
  const summaryId = head.summary_id;
  if (summaryId === undefined || !SUMMARY_ID_PATTERN.test(summaryId)) {
    throw new SummaryStoreError('summary-legacy', 'the pending summary has no summary_id and cannot be granted');
  }
  if (wanted !== 'pending' && wanted !== summaryId) throw new SummaryStoreError('summary-not-found', `summary ${wanted} is not pending in ${scope}`);

  // Byte strings throughout, so the header counted here is the one peekGrant() counts on the copy.
  const compactedAt = head.compacted_at ?? 'unknown';
  const branch = head.branch ?? 'unknown';
  const header = grantHeader(fromLineage, compactedAt, branch);
  const size = fileSize(source);
  const raw = size === null || size > Number(max) + READ_BOUND ? null : readBytes(source);
  const body = raw === null ? null : parseRecord(raw).body;
  if (body === '') throw new SummaryStoreError('summary-not-found', 'the pending summary has an empty body');
  if (body === null || header.length + 1 + body.length > Number(max)) {
    throw new SummaryStoreError('over-budget', `the granted summary exceeds the ${max}-byte budget`);
  }

  const dir = path.join(stateDir(env), 'grants', options.toRun, options.toLineage);
  const target = path.join(dir, `${summaryId}.md`);
  if (fs.existsSync(target) || isLink(target)) throw new SummaryStoreError('grant-exists', `grant ${summaryId} already present for ${options.toRun}/${options.toLineage}`);

  const grantedAt = (options.now ?? new Date()).toISOString().replace(/\.[0-9]{3}Z$/, 'Z');
  const record = '---\n'
    + `summary_id: ${summaryId}\n`
    + `granted_at: ${grantedAt}\n`
    + `from_worktree: ${Buffer.from(oneLine(fromWorktree), 'utf8').toString('latin1')}\n`
    + `from_run: ${fromRun}\n`
    + `from_lineage: ${fromLineage}\n`
    + `to_run: ${options.toRun}\n`
    + `to_lineage: ${options.toLineage}\n`
    + `compacted_at: ${compactedAt}\n`
    + `branch: ${branch}\n`
    + `bytes: ${body.length}\n`
    + '---\n\n'
    + `${body}\n`;
  fs.mkdirSync(dir, { recursive: true });
  const { file: tmp } = makeTemp(dir, '.grant.');
  try {
    fs.writeFileSync(tmp, Buffer.from(record, 'latin1'));
    publishNoReplace(tmp, target, summaryId, options.toRun, options.toLineage);
  } finally {
    removeQuietly(tmp);
  }
  return { summaryId, path: target, bytes: body.length };
}

function isLink(file: string): boolean {
  try {
    return fs.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/** A hard link refuses to replace an existing grant; without hard links, re-check and rename. */
function publishNoReplace(tmp: string, target: string, summaryId: string, toRun: string, toLineage: string): void {
  try {
    fs.linkSync(tmp, target);
    return;
  } catch (error: any) {
    if (error?.code === 'EEXIST') throw new SummaryStoreError('grant-exists', `grant ${summaryId} already present for ${toRun}/${toLineage}`);
  }
  if (fs.existsSync(target) || isLink(target)) throw new SummaryStoreError('grant-exists', `grant ${summaryId} already present for ${toRun}/${toLineage}`);
  fs.renameSync(tmp, target);
}

module.exports = {
  DEFAULT_GRANT_MAX_BYTES,
  GRANT_EXIT,
  SUMMARY_ID_PATTERN,
  SummaryStoreError,
  claimGrant,
  claimSummary,
  grantSummary,
  peekGrant,
  peekSummary,
  summaryScope,
  writeSummary,
};
