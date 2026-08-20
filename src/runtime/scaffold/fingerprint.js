'use strict';

/**
 * Fingerprinting — the mechanism behind property 4 of the scaffold generator ("human edits
 * survive"). Every generated file carries a hash of its own body in its header; `compose()` writes
 * that header, `inspectExisting()` reads it back and says whether the body still matches what it
 * claims, so edit detection needs no side ledger that could itself drift from the tree it
 * describes.
 */

const crypto = require('node:crypto');

/** Marker naming the hash of everything below it. Present in every generated file so edit
 * detection needs no side ledger that could itself drift from the tree it describes. */
const FINGERPRINT_MARKER = 'doflow-scaffold-fingerprint';
const FINGERPRINT_RE = new RegExp(`${FINGERPRINT_MARKER} sha256:([0-9a-f]{64})`);

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Wraps a body in its provenance header and fingerprint.
 *
 * The fingerprint covers the body only, so the header can gain a line without every existing file
 * reading as human-edited; and it lives in the file rather than in a side ledger, so a scaffold
 * copied, moved or committed on its own still carries the evidence needed to protect it.
 */
function compose(emitter, headerLines, body) {
  const fingerprint = sha256(body);
  const header = [
    ...headerLines.map((l) => emitter.line(l)),
    emitter.line(`${FINGERPRINT_MARKER} sha256:${fingerprint}`),
  ].join('\n');
  return `${header}\n${body}`;
}

/** The hash a file claims for its own body, and the body it actually has. */
function inspectExisting(text) {
  const match = text.match(FINGERPRINT_RE);
  if (!match) return { claimed: null, actual: null, body: null };
  const cut = text.indexOf('\n', text.indexOf(match[0]));
  if (cut === -1) return { claimed: match[1], actual: null, body: null };
  const body = text.slice(cut + 1);
  return { claimed: match[1], actual: sha256(body), body };
}

module.exports = {
  FINGERPRINT_MARKER,
  FINGERPRINT_RE,
  sha256,
  compose,
  inspectExisting,
};
