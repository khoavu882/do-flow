'use strict';
// prompt.js — port of sync.sh's confirm(): y/N prompt, auto-confirmed under --force.
const fs = require('node:fs');

/**
 * fs.readSync(0, ...) is documented as blocking, but that only holds if fd 0's O_NONBLOCK flag is
 * clear. On a real TTY that flag can end up set (observed after raw-mode use elsewhere in the
 * process, e.g. mcp.js's checkbox prompt) — a read attempted before the user has typed anything
 * then throws EAGAIN instead of waiting for a keypress. That's "not ready yet", not "no stdin
 * available": retry after a brief synchronous sleep rather than failing the prompt closed. Only
 * done when stdin is actually a TTY (a human might still type) and bounded by a deadline (a fd
 * that will genuinely never produce data must still fail closed, not hang forever).
 * @returns {number} bytes read
 */
function readSyncBlocking(fd, buf) {
  const deadline = Date.now() + 5 * 60 * 1000;
  for (;;) {
    try {
      return fs.readSync(fd, buf, 0, buf.length, null);
    } catch (e) {
      if (!process.stdin.isTTY || e.code !== 'EAGAIN' || Date.now() > deadline) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
}

/** @returns {boolean} true if confirmed (via --force or an explicit y/Y reply) */
function confirm(message, force) {
  if (force) {
    console.error(`[INFO]  ${message} [auto-confirmed via --force]`);
    return true;
  }
  process.stdout.write(`${message} [y/N] `);
  const buf = Buffer.alloc(256);
  let bytesRead = 0;
  try {
    bytesRead = readSyncBlocking(0, buf);
  } catch {
    return false; // no stdin available (e.g. piped/non-interactive) — matches bash `read` failing closed
  }
  const reply = buf.toString('utf8', 0, bytesRead).trim();
  return /^[Yy]$/.test(reply);
}

/** Free-text stdin read (e.g. "which backup id?"), matching sync.sh's `read -r reply`. */
function promptLine(message) {
  process.stdout.write(message);
  const buf = Buffer.alloc(1024);
  let bytesRead = 0;
  try {
    bytesRead = readSyncBlocking(0, buf);
  } catch {
    return '';
  }
  return buf.toString('utf8', 0, bytesRead).trim();
}

module.exports = { confirm, promptLine, readSyncBlocking };
