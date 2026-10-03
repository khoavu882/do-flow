'use strict';

/**
 * The machine-local report body (IC-005, DEC-014). A report's text can hold a crash trace, a log or
 * pasted output, so it never enters the repository: the body is masked with the body profile (IC-012),
 * cut to at most 1 MiB and written once under the same per-machine home the failure store uses,
 * `<XDG_CONFIG_HOME or $HOME/.config>/doflow/reports/<projectKey>/<FU-id>.txt`, folder 0700 and file
 * 0600. The project event carries only a reference, the size and a masked 2 KB excerpt.
 *
 * `projectKey` is the first 12 hex characters of the SHA-256 of the IC-001 root's real path, so two
 * clones of one project on one machine keep separate bodies, and a body is found again from any
 * worktree that shares the root.
 *
 * The cut is by bytes and backs off to a UTF-8 boundary. Nothing here touches the network.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { maskBody } = require('../mask');

/** A `--file` or `--stdin` source is read for at most this many bytes; the rest could not be kept anyway. */
const MAX_READ_BYTES = 16 * 1024 * 1024;
/** The most a stored body holds, marker line included. */
const MAX_BODY_BYTES = 1024 * 1024;
const TRUNCATED = '[truncated by doflow at 1 MiB]';
/** The most of the masked body the project event carries. */
const EXCERPT_BYTES = 2048;

/** A caller mistake in the report input (exit 2); the verb layer maps it with the other usage errors. */
class ReportInputError extends Error {}

/**
 * The folder holding every project's report bodies, or null when no home resolves. It resolves the
 * base the way IC-011 resolves the failure home (`XDG_CONFIG_HOME` when set, non-empty and absolute,
 * else `$HOME/.config` when `HOME` is absolute) and sits beside it, `doflow/reports`. The rule is
 * repeated here rather than required from the failure module, so the follow-up service still loads in
 * a build or an install where the failure modules cannot be loaded (IC-016).
 */
function reportsHome(env = process.env) {
  const xdg = env.XDG_CONFIG_HOME;
  if (typeof xdg === 'string' && xdg !== '') return path.isAbsolute(xdg) ? path.join(xdg, 'doflow', 'reports') : null;
  const home = env.HOME;
  return typeof home === 'string' && path.isAbsolute(home) ? path.join(home, '.config', 'doflow', 'reports') : null;
}

function projectKey(root, fsImpl = nodeFs) {
  let real = root;
  try { real = fsImpl.realpathSync(root); } catch { /* the root is used as given */ }
  return crypto.createHash('sha256').update(real).digest('hex').slice(0, 12);
}

/** @returns {string|null} the body file of a report of this project, or null when no home resolves */
function bodyPath(root, id, { env = process.env, fsImpl = nodeFs } = {}) {
  const home = reportsHome(env);
  return home === null ? null : path.join(home, projectKey(root, fsImpl), `${id}.txt`);
}

/** The `hasBody` the fold needs (IC-003): a report whose body file is on this machine. */
function bodyChecker(root, { env = process.env, fsImpl = nodeFs } = {}) {
  return (item) => {
    if (item.bodyRef !== `local:${item.id}`) return false;
    const file = bodyPath(root, item.id, { env, fsImpl });
    if (file === null) return false;
    try { return fsImpl.statSync(file).isFile(); } catch { return false; }
  };
}

/** Reads at most `max` bytes from an open descriptor. */
function readCapped(fsImpl, fd, max) {
  const chunks = [];
  let total = 0;
  const chunk = Buffer.allocUnsafe(64 * 1024);
  while (total < max) {
    const n = fsImpl.readSync(fd, chunk, 0, Math.min(chunk.length, max - total), null);
    if (n === 0) break;
    chunks.push(Buffer.from(chunk.subarray(0, n)));
    total += n;
  }
  return Buffer.concat(chunks);
}

/**
 * The raw report text from exactly one of `--file`, `--stdin` or `--text`. A file is read as text, at
 * most 16 MiB; a binary one (a NUL byte) is refused.
 * @param {{file?: string, stdin?: boolean, text?: string}} source
 * @returns {string}
 */
function readReportText({ file, stdin, text }, { fsImpl = nodeFs } = {}) {
  const given = [file !== undefined, Boolean(stdin), text !== undefined].filter(Boolean).length;
  if (given !== 1) throw new ReportInputError('give the report body with exactly one of --file <path>, --stdin or --text "<body>" (--file and --stdin also take text that starts with -)');
  if (text !== undefined) return String(text);
  let bytes;
  if (stdin) {
    try { bytes = readCapped(fsImpl, 0, MAX_READ_BYTES); } catch (error) { throw new ReportInputError(`cannot read the report from stdin: ${error.message}`); }
  } else {
    const target = path.resolve(file);
    let fd;
    try {
      if (!fsImpl.statSync(target).isFile()) throw new ReportInputError(`--file ${file} is not a regular file`);
      fd = fsImpl.openSync(target, 'r');
      bytes = readCapped(fsImpl, fd, MAX_READ_BYTES);
    } catch (error) {
      if (error instanceof ReportInputError) throw error;
      throw new ReportInputError(`cannot read --file ${file}: ${error.code || error.message}`);
    } finally {
      if (fd !== undefined) { try { fsImpl.closeSync(fd); } catch { /* read already done */ } }
    }
  }
  if (bytes.includes(0)) throw new ReportInputError('the report body is binary (it holds a NUL byte); give a text file or paste the text');
  return bytes.toString('utf8');
}

/** The length of the longest prefix of `buffer` of at most `limit` bytes that ends on a UTF-8 boundary. */
function boundary(buffer, limit) {
  let end = Math.min(limit, buffer.length);
  if (end === buffer.length) return end;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return end;
}

/**
 * Masks a report body with the body profile and keeps at most 1 MiB of it. A longer body is cut at a
 * UTF-8 boundary and ends with the marker line, so the stored text is never over the limit.
 * @returns {{buffer: Buffer, masked: number, truncated: boolean}}
 */
function prepareBody(raw) {
  const { text, masked } = maskBody(raw);
  const whole = Buffer.from(text, 'utf8');
  if (whole.length <= MAX_BODY_BYTES) return { buffer: whole, masked, truncated: false };
  const marker = Buffer.from(`\n${TRUNCATED}`, 'utf8');
  const kept = whole.subarray(0, boundary(whole, MAX_BODY_BYTES - marker.length));
  return { buffer: Buffer.concat([kept, marker]), masked, truncated: true };
}

/**
 * The first 2048 bytes of a stored body, cut at a UTF-8 boundary and, when a line end lies inside
 * the limit, at that line end (DEC-014).
 * @param {Buffer} body
 * @returns {string}
 */
function excerptOf(body) {
  if (body.length <= EXCERPT_BYTES) return body.toString('utf8').replace(/\s+$/, '');
  const head = body.subarray(0, boundary(body, EXCERPT_BYTES));
  const lineEnd = head.lastIndexOf(0x0a);
  return (lineEnd > 0 ? head.subarray(0, lineEnd) : head).toString('utf8').replace(/\s+$/, '');
}

/**
 * Writes the body once: exclusive create, file 0600, folders 0700, never inside the repository.
 * @returns {{ok: true, file: string}|{ok: false, reason: 'no-home'|'exists'|'error', message?: string}}
 */
function writeBody(root, id, buffer, { env = process.env, fsImpl = nodeFs } = {}) {
  const file = bodyPath(root, id, { env, fsImpl });
  if (file === null) return { ok: false, reason: 'no-home' };
  const folder = path.dirname(file);
  try {
    fsImpl.mkdirSync(folder, { recursive: true, mode: 0o700 });
    // `mkdir -p` applies the mode under the umask; the two folders that are ours are set outright.
    fsImpl.chmodSync(folder, 0o700);
    fsImpl.chmodSync(path.dirname(folder), 0o700);
    fsImpl.writeFileSync(file, buffer, { flag: 'wx', mode: 0o600 });
    return { ok: true, file };
  } catch (error) {
    return error.code === 'EEXIST' ? { ok: false, reason: 'exists' } : { ok: false, reason: 'error', message: error.code || error.message };
  }
}

/** Removes a body this process just wrote, when the event that names it could not be written. */
function removeBody(file, fsImpl = nodeFs) {
  try { fsImpl.rmSync(file, { force: true }); } catch { /* the failure being reported stands */ }
}

module.exports = {
  readReportText, prepareBody, excerptOf, writeBody, removeBody, bodyChecker, bodyPath, reportsHome, projectKey,
  ReportInputError, MAX_READ_BYTES, MAX_BODY_BYTES, EXCERPT_BYTES, TRUNCATED,
};
