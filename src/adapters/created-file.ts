'use strict';

// Shared by the adapters whose instruction file (and opencode.json) is a file DoFlow may have
// created: the ledger row records `origin: { created: 'file' }` when the file was absent before the
// install, so a removal that leaves nothing but whitespace can delete exactly the files DoFlow made
// and keep every file that existed beforehand. Same record Pi's mcp.json rows carry (pi/mcp.ts).
const fs = require('node:fs');

/** Whitespace is not content: a file holding only whitespace carries none of the user's text. */
function isBlank(text: any): boolean { return typeof text === 'string' && text.trim() === ''; }

function ownedRow(ledger: any, harness: string, ownershipIdentity: string, target: string): any {
  return (ledger?.resources || []).find((row: any) => row.harness === harness
    && row.ownershipIdentity === ownershipIdentity && row.target === target);
}

/** Whether the ledger row for `ownershipIdentity` at `target` says DoFlow created that file. */
function createdByDoFlow(ledger: any, harness: string, ownershipIdentity: string, target: string): boolean {
  return ownedRow(ledger, harness, ownershipIdentity, target)?.origin?.created === 'file';
}

/** The origin to record on the row verify emits. A row already in the ledger passes its origin on
 * (absent for rows an older version wrote, which are never guessed at). With no row, `before` is
 * the file as plan read it: `null` means absent, so this install creates it. `undefined` means the
 * caller has no pre-apply read (a status verify), and nothing is recorded. */
function creationOrigin({ ledger, harness, ownershipIdentity, target, before }: any): { created: 'file' } | undefined {
  const row = ownedRow(ledger, harness, ownershipIdentity, target);
  if (row) return row.origin;
  return before === null ? { created: 'file' } : undefined;
}

/** Delete `target` unless it is a symlink (the link is the user's, not DoFlow's). */
function removeCreatedFile(target: string, fsImpl: any = fs): boolean {
  try {
    if (fsImpl.lstatSync(target).isSymbolicLink()) return false;
    fsImpl.rmSync(target);
    return true;
  } catch { return false; }
}

module.exports = { isBlank, createdByDoFlow, creationOrigin, removeCreatedFile };
