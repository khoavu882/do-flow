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
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root');
const { normaliseMessage, maskLine } = require('../mask');
const { isProgrammingError, errorKind } = require('./classifier');
const { failureHome, captureIsOff, eventsPath } = require('./home');

const MAX_LINE_BYTES = 2048;
const ROTATE_AT_BYTES = 1048576;
const KEEP_ROTATED = 4;
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

/** The working directory with the home prefix written as `~`, masked like any other free text. */
function projectName(env) {
  let cwd;
  try { cwd = process.cwd(); } catch { return ''; }
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

/**
 * Rotation (IC-015): at 1 MiB the live file is renamed to `events-<UTC time>-<pid>.jsonl`, and the
 * rotated files beyond the newest four are deleted. A failed rename or delete is ignored, so a
 * process that lost the race simply appends to whatever is there.
 * @param {string} home the failure home
 * @returns {boolean} whether this call renamed the file
 */
function rotateIfDue(home) {
  let renamed = false;
  try {
    if (fs.statSync(eventsPath(home)).size < ROTATE_AT_BYTES) return false;
    fs.renameSync(eventsPath(home), path.join(home, `events-${stamp(new Date())}-${process.pid}.jsonl`));
    renamed = true;
  } catch { return false; }
  try {
    const rotated = fs.readdirSync(home).filter((name) => ROTATED.test(name)).sort();
    for (const name of rotated.slice(0, Math.max(0, rotated.length - KEEP_ROTATED))) {
      try { fs.unlinkSync(path.join(home, name)); } catch { /* ignored */ }
    }
  } catch { /* ignored */ }
  return renamed;
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
    fs.appendFileSync(eventsPath(home), line, { flag: 'a', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
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
      message: normaliseMessage(error.message, { home: env.HOME }),
      frame: doflowFrame(error),
      exit: context.exit,
    }, env);
  } catch {
    return false;
  }
}

module.exports = { captureFailure, captureError, rotateIfDue, doflowFrame, MAX_LINE_BYTES, ROTATE_AT_BYTES, KEEP_ROTATED };
