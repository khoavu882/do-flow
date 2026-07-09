'use strict';
// prompt.js — port of sync.sh's confirm(): y/N prompt, auto-confirmed under --force.
const fs = require('node:fs');

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
    bytesRead = fs.readSync(0, buf, 0, buf.length, null);
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
    bytesRead = fs.readSync(0, buf, 0, buf.length, null);
  } catch {
    return '';
  }
  return buf.toString('utf8', 0, bytesRead).trim();
}

module.exports = { confirm, promptLine };
