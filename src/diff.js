'use strict';
// diff.js — port of sync.sh's diff_files: changed-file discovery between source and destination.
// PARITY: "changed" = dst missing, or (mtime mismatch | sha256 mismatch with --checksum). sync.sh
// batches stat/sha256sum calls for performance (avoiding per-file subshells in bash); Node's
// fs.statSync/crypto calls have no such subshell cost, so a direct per-file loop is equivalent
// in outcome without needing bash's batching trick.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { resolveFilePairs } = require('./copy');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * @param {{repoRoot:string, mappings:{src:string,dst:string}[], dstRoot:string, checksum?:boolean}} p
 * @returns {{srcAbs:string,dstAbs:string}[]} pairs whose destination is missing or out of date
 */
function diffFiles({ repoRoot, mappings, dstRoot, checksum = false }) {
  const pairs = resolveFilePairs(repoRoot, mappings, dstRoot);
  const changed = [];
  for (const pair of pairs) {
    if (!fs.existsSync(pair.dstAbs)) { changed.push(pair); continue; }
    if (checksum) {
      if (sha256(pair.srcAbs) !== sha256(pair.dstAbs)) changed.push(pair);
    } else {
      // PARITY: sync.sh's _batch_mtime uses `stat --format=%Y` — whole seconds, not sub-second
      // precision. Comparing at ms/ns granularity would never match after an independent copy
      // (utimesSync's own precision, filesystem timestamp resolution), reporting everything as
      // changed forever.
      const srcMtime = Math.floor(fs.statSync(pair.srcAbs).mtimeMs / 1000);
      const dstMtime = Math.floor(fs.statSync(pair.dstAbs).mtimeMs / 1000);
      if (srcMtime !== dstMtime) changed.push(pair);
    }
  }
  return changed;
}

module.exports = { diffFiles };
