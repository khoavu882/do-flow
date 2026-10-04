'use strict';

/**
 * The Node failure writer (IC-011, IC-014, IC-015, DEC-019, DEC-020). Records one line per internal
 * error in the machine-wide `events.jsonl`. Capture is a side channel and must never be noticed by
 * the command it observes:
 *   - it writes no byte to stdout or stderr and never throws;
 *   - it is synchronous and takes no lock (one append of one line);
 *   - while capture is off it opens no file and creates no folder.
 * Only the normalised, masked message is stored, never the raw message, argv, stdin or environment.
 *
 * Rotation by rename at 1 MiB is done here and by the `failure` verb only; the bash writers append.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root');
const { normaliseMessage, maskLine } = require('../mask');
const { isProgrammingError, errorKind } = require('./classifier');
const { failureHome, captureIsOff, eventsPath } = require('./home');

const MAX_LINE_BYTES = 2048;
const MAX_RAW_MESSAGE = 4096;
const ROTATE_AT_BYTES = 1048576;
const KEEP_ROTATED = 4;
const PARTIAL_KEEP_MS = 60 * 60 * 1000;
const ROTATED = /^events-\d{8}T\d{6}Z-\d+\.jsonl$/;
const COMMAND_NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** Errors already recorded in this process, so one error caught at two points counts once. */
const recorded = new WeakSet();

let cachedVersion = null;
/** The package version; the projected runtime ships no package.json, so a tolerant read. */
function packageVersion() {
  if (cachedVersion === null) {
    try { cachedVersion = String(require('../../../package.json').version); } catch { cachedVersion = 'unknown'; }
  }
  return cachedVersion;
}

function harnessName(env) {
  const raw = env.DOFLOW_AGENT;
  return typeof raw === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(raw) ? raw : 'none';
}

/** The absolute, non-root homes to compare a working directory with: HOME as given, its real path, and `os.homedir()`. */
function homeCandidates(env) {
  const out = [];
  const add = (value) => {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return;
    const home = value.replace(/\/+$/, '');
    if (home.length > 1 && !out.includes(home)) out.push(home);
  };
  add(env.HOME);
  if (typeof env.HOME === 'string' && path.isAbsolute(env.HOME)) { try { add(fs.realpathSync(env.HOME)); } catch { /* HOME does not exist */ } }
  try { add(os.homedir()); add(fs.realpathSync(os.homedir())); } catch { /* no home known to the system */ }
  return out;
}

/**
 * The working directory as stored: the home prefix written as `~` whichever way home is spelled (a
 * symlinked HOME makes `process.cwd()` the physical path), masked like any other free text. A
 * directory under no known home, when `HOME` itself is not usable, is stored as its folder name only,
 * so an absolute path with a user name in it never reaches the file.
 */
function projectName(env) {
  let cwd;
  try { cwd = process.cwd(); } catch { return ''; }
  const home = homeCandidates(env).find((h) => cwd === h || cwd.startsWith(`${h}/`));
  if (home) return maskLine(`~${cwd.slice(home.length)}`, { home: null }).text.slice(0, 200);
  const homeGiven = typeof env.HOME === 'string' && path.isAbsolute(env.HOME);
  if (!homeGiven) return maskLine(path.basename(cwd), { home: null }).text.slice(0, 200);
  return maskLine(cwd, { home: env.HOME }).text.slice(0, 200);
}

function commandName(command) {
  return typeof command === 'string' && COMMAND_NAME.test(command) ? command : 'unknown';
}

/**
 * The first stack frame inside DoFlow's own files as `<relative path>:<function>`, no line number
 * (IC-011). Null when no frame is inside the package, which is also what keeps a frame from a
 * dependency or a user's own file out of the record.
 * @param {*} error
 * @returns {string|null}
 */
function doflowFrame(error) {
  let stack;
  try { stack = typeof error.stack === 'string' ? error.stack : ''; } catch { return null; }
  const root = REPO_ROOT + path.sep;
  for (const line of stack.split('\n')) {
    const match = /^\s*at (?:async )?(?:(.+?) \()?(.+?):\d+:\d+\)?$/.exec(line);
    if (!match) continue;
    const file = match[2].replace(/^file:\/\//, '');
    if (!file.startsWith(root) || file.includes(`${path.sep}node_modules${path.sep}`)) continue;
    const fn = (match[1] || '').replace(/^new /, '').split('.').pop().replace(/\s.*$/, '') || '<anonymous>';
    return `${path.relative(REPO_ROOT, file).split(path.sep).join('/')}:${fn}`;
  }
  return null;
}

/** One line at or under MAX_LINE_BYTES including the newline: shorten `message`, then `project`. */
function buildLine(record) {
  const bytes = (r) => Buffer.byteLength(JSON.stringify(r), 'utf8') + 1;
  const out = { ...record };
  for (const field of ['message', 'project']) {
    while (bytes(out) > MAX_LINE_BYTES && out[field].length > 0) {
      out[field] = out[field].slice(0, Math.max(0, out[field].length - Math.max(8, bytes(out) - MAX_LINE_BYTES)));
    }
  }
  return bytes(out) > MAX_LINE_BYTES ? null : `${JSON.stringify(out)}\n`;
}

const stamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

/** Rotated files with their size and modification time, oldest last-modified first (names alone tie inside one second). */
function rotatedFiles(home) {
  return fs.readdirSync(home).filter((name) => ROTATED.test(name)).map((name) => {
    let size = 0;
    let mtime = 0;
    try { const st = fs.statSync(path.join(home, name)); size = st.size; mtime = st.mtimeMs; } catch { /* gone */ }
    return { name, size, mtime };
  }).sort((a, b) => a.mtime - b.mtime || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Removes rotated files beyond the newest four full ones, and partial ones (see rotateIfDue) once
 * they are an hour old. A partial file never counts toward the four, so it cannot push a real one out.
 */
function prune(home, now = Date.now()) {
  const files = rotatedFiles(home);
  const full = files.filter((f) => f.size >= ROTATE_AT_BYTES);
  const doomed = [
    ...full.slice(0, Math.max(0, full.length - KEEP_ROTATED)),
    ...files.filter((f) => f.size < ROTATE_AT_BYTES && now - f.mtime > PARTIAL_KEEP_MS),
  ];
  for (const f of doomed) {
    try { fs.unlinkSync(path.join(home, f.name)); } catch { /* ignored */ }
  }
}

/**
 * Rotation (IC-015): at 1 MiB the live file is renamed to `events-<UTC time>-<pid>.jsonl`, and the
 * rotated files beyond the newest four are deleted. A failed rename or delete is ignored, so a
 * process that lost the race simply appends to whatever is there.
 *
 * A process that measured the old live file may rename the fresh one another writer just created
 * (it holds less than 1 MiB). That file is linked back as the live file when nobody has recreated it
 * (same inode, so a writer still holding it loses nothing); when the live file exists again it stays
 * as a small rotated file, which readers read like any other and which is never counted toward the
 * four kept, so a real rotated file is never pushed out by one. Nothing is ever copied or deleted
 * here except by prune, so no line is lost to the race.
 * @param {string} home the failure home
 * @returns {boolean} whether this call rotated a full file
 */
function rotateIfDue(home) {
  const live = eventsPath(home);
  try {
    if (fs.statSync(live).size < ROTATE_AT_BYTES) return false;
  } catch { return false; }
  // The name carries the second and the pid, so a process that rotates twice inside one second would
  // rename onto its own earlier file and destroy it: take the next free second instead.
  let rotated = path.join(home, `events-${stamp(new Date())}-${process.pid}.jsonl`);
  for (let i = 1; i < 120 && fs.existsSync(rotated); i++) {
    rotated = path.join(home, `events-${stamp(new Date(Date.now() + i * 1000))}-${process.pid}.jsonl`);
  }
  try {
    fs.renameSync(live, rotated);
  } catch { return false; }
  let size = 0;
  try { size = fs.statSync(rotated).size; } catch { return false; }
  if (size < ROTATE_AT_BYTES) {
    try { fs.linkSync(rotated, live); fs.unlinkSync(rotated); } catch { /* the live file exists again: the small file stays */ }
    return false;
  }
  try { prune(home); } catch { /* ignored */ }
  return true;
}

/**
 * Appends one line to `file` only when it is absent or a regular file. A FIFO, a device or a symlink
 * there is skipped silently: opening a FIFO for writing blocks until something reads it, which would
 * hang the command capture is meant to observe. `O_NONBLOCK` fails such an open at once and the
 * descriptor is checked before the write, so a file swapped in after any earlier check is still safe.
 * @returns {boolean} whether the line was written
 */
function appendRegular(file, line) {
  const c = fs.constants;
  let fd;
  try {
    fd = fs.openSync(file, c.O_WRONLY | c.O_APPEND | c.O_CREAT | (c.O_NOFOLLOW || 0) | (c.O_NONBLOCK || 0), 0o600);
    if (!fs.fstatSync(fd).isFile()) return false;
    fs.writeSync(fd, line);
    return true;
  } catch { return false; } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* nothing more to do */ } }
  }
}

/**
 * Appends one failure line. Every failure to do so is swallowed.
 * @param {{source: string, command: string, kind: string, message?: string, frame?: string|null, exit?: number|null}} fields
 *   `message` must already be normalised (see captureError).
 * @param {Object} [env] defaults to process.env
 * @returns {boolean} whether a line was written
 */
function captureFailure(fields, env = process.env) {
  try {
    const home = failureHome(env);
    if (!home || captureIsOff(home, env)) return false;
    const line = buildLine({
      v: 1,
      at: new Date().toISOString(),
      source: fields.source,
      command: commandName(fields.command),
      harness: harnessName(env),
      version: packageVersion(),
      project: projectName(env),
      kind: String(fields.kind).slice(0, 80),
      message: typeof fields.message === 'string' ? fields.message : '',
      frame: typeof fields.frame === 'string' ? fields.frame : null,
      exit: Number.isInteger(fields.exit) ? fields.exit : null,
    });
    if (line === null) return false;
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    rotateIfDue(home);
    return appendRegular(eventsPath(home), line);
  } catch {
    return false;
  }
}

/** The error's message cut to 4096 characters before any masking, so no input makes the rules do unbounded work. */
function rawMessage(error) {
  try {
    const message = error.message;
    return typeof message === 'string' ? message.slice(0, MAX_RAW_MESSAGE) : '';
  } catch { return ''; }
}

/**
 * Records a caught error when it is a programming error (IC-010). The caller keeps doing whatever it
 * did before: this returns a boolean and nothing else changes.
 * @param {*} error
 * @param {{command?: string, exit?: number|null, uncaught?: boolean}} [context]
 *   `uncaught` marks an error that escaped every handler (kind `uncaught:<kind>`).
 * @param {Object} [env]
 * @returns {boolean} whether a line was written
 */
function captureError(error, context = {}, env = process.env) {
  try {
    if (!isProgrammingError(error) || recorded.has(error)) return false;
    recorded.add(error);
    const kind = errorKind(error);
    return captureFailure({
      source: 'cli',
      command: context.command,
      kind: context.uncaught ? `uncaught:${kind}` : kind,
      message: normaliseMessage(rawMessage(error), { home: env.HOME }),
      frame: doflowFrame(error),
      exit: context.exit,
    }, env);
  } catch {
    return false;
  }
}

module.exports = { appendRegular, captureFailure, captureError, rotateIfDue, doflowFrame, MAX_LINE_BYTES, ROTATE_AT_BYTES, KEEP_ROTATED };
