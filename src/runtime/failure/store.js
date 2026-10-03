'use strict';

/**
 * The failure store reader and settlement writer (IC-013, IC-014, IC-015). The capture writers append
 * IC-011 lines; this module folds them into entries when they are asked for, so a count is always
 * derived from the retained events and only a settlement is stored separately (DEC-019).
 *
 *   - `fp` is computed here, never by a writer: the first 16 hex characters of SHA-256 over
 *     `source \n command \n kind \n message \n frame` (an absent frame is the empty string). The
 *     version is not part of it, so the same bug in two releases is one entry.
 *   - The latest settlement per `fp` applies. A `fixed` entry that is seen again is `regressed`.
 *   - A line that does not parse, or is not an IC-011 line, is skipped and counted.
 *   - Reading never writes. Rotation is the `failure` verb's own step before it reads (see cli.js).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { failureHome, captureSwitch, eventsPath } = require('./home');

const ROTATED = /^events-\d{8}T\d{6}Z-\d+\.jsonl$/;
const SETTLEMENTS = 'settlements.jsonl';
const SOURCES = new Set(['cli', 'dispatcher', 'hook']);
const SETTLE_AS = ['noise', 'fixed', 'imported'];
const STATUSES = ['new', 'regressed', 'noise', 'fixed', 'imported'];
const SHOWN_BY_DEFAULT = new Set(['new', 'regressed']);
const PROJECTS_KEPT = 5;

const settlementsPath = (home) => path.join(home, SETTLEMENTS);

/** @param {{source: string, command: string, kind: string, message: string, frame: string|null}} event */
function fingerprint(event) {
  const text = [event.source, event.command, event.kind, event.message, event.frame || ''].join('\n');
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** One IC-011 line, or null. Only the fields a fold reads are checked. */
function asEvent(value) {
  if (!value || typeof value !== 'object' || value.v !== 1) return null;
  const text = (x) => typeof x === 'string';
  if (!text(value.at) || !SOURCES.has(value.source) || !text(value.command) || !text(value.kind)) return null;
  return {
    at: value.at,
    source: value.source,
    command: value.command,
    harness: text(value.harness) ? value.harness : 'none',
    version: text(value.version) ? value.version : 'unknown',
    project: text(value.project) ? value.project : '',
    kind: value.kind,
    message: text(value.message) ? value.message : '',
    frame: text(value.frame) ? value.frame : null,
    exit: Number.isInteger(value.exit) ? value.exit : null,
  };
}

/** Parses a JSON-lines file into `{rows, skipped}`; a missing file is empty. */
function readLines(file, accept) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { rows: [], skipped: 0 }; }
  const rows = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let row = null;
    try { row = accept(JSON.parse(line)); } catch { row = null; }
    if (row) rows.push(row); else skipped += 1;
  }
  return { rows, skipped };
}

/**
 * Every retained event: rotated files oldest first, then the live file (IC-015).
 * @param {string} home
 * @returns {{events: Object[], skippedLines: number}}
 */
function readEvents(home) {
  let rotated = [];
  try { rotated = fs.readdirSync(home).filter((name) => ROTATED.test(name)).sort(); } catch { /* no folder yet */ }
  const events = [];
  let skippedLines = 0;
  for (const file of [...rotated.map((name) => path.join(home, name)), eventsPath(home)]) {
    const read = readLines(file, asEvent);
    events.push(...read.rows);
    skippedLines += read.skipped;
  }
  return { events, skippedLines };
}

function asSettlement(value) {
  if (!value || typeof value !== 'object' || value.v !== 1) return null;
  if (typeof value.at !== 'string' || !/^[0-9a-f]{16}$/.test(value.fp) || !SETTLE_AS.includes(value.as)) return null;
  return { at: value.at, fp: value.fp, as: value.as, reason: typeof value.reason === 'string' ? value.reason : null, followup: typeof value.followup === 'string' ? value.followup : null };
}

/** @returns {{settlements: Object[], skippedLines: number}} in file order, which is time order */
function readSettlements(home) {
  const read = readLines(settlementsPath(home), asSettlement);
  return { settlements: read.rows, skippedLines: read.skipped };
}

/** The IC-013 status of an entry from its latest settlement and the events seen after it. */
function statusOf(settlement, sinceSettlement) {
  if (!settlement) return 'new';
  if (settlement.as === 'fixed') return sinceSettlement > 0 ? 'regressed' : 'fixed';
  return settlement.as;
}

/**
 * Folds events and settlements into IC-013 entries, newest `lastSeen` first.
 * @param {Object[]} events
 * @param {Object[]} settlements
 * @returns {Object[]}
 */
function foldEntries(events, settlements) {
  const latest = new Map();
  for (const s of settlements) latest.set(s.fp, s);
  const groups = new Map();
  for (const event of events) {
    const fp = fingerprint(event);
    if (!groups.has(fp)) groups.set(fp, []);
    groups.get(fp).push(event);
  }
  const entries = [];
  for (const [fp, group] of groups) {
    const ordered = group.map((event, index) => ({ event, index })).sort((a, b) => (a.event.at < b.event.at ? -1 : a.event.at > b.event.at ? 1 : a.index - b.index)).map((x) => x.event);
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const settlement = latest.get(fp) || null;
    const since = settlement ? ordered.filter((e) => e.at > settlement.at).length : ordered.length;
    const projects = [];
    for (let i = ordered.length - 1; i >= 0 && projects.length < PROJECTS_KEPT; i--) {
      if (ordered[i].project && !projects.includes(ordered[i].project)) projects.push(ordered[i].project);
    }
    entries.push({
      fp,
      status: statusOf(settlement, since),
      count: ordered.length,
      sinceSettlement: since,
      firstSeen: first.at,
      lastSeen: last.at,
      firstVersion: first.version,
      lastVersion: last.version,
      source: first.source,
      command: first.command,
      kind: first.kind,
      message: first.message,
      frame: first.frame,
      projects,
      harnesses: [...new Set(ordered.map((e) => e.harness))].sort(),
      exitCodes: [...new Set(ordered.map((e) => e.exit).filter((x) => x !== null))].sort((a, b) => a - b),
      settlement: settlement && { as: settlement.as, at: settlement.at, reason: settlement.reason, followup: settlement.followup },
    });
  }
  return entries.sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : a.fp < b.fp ? -1 : 1));
}

/** The shape a listing shows (IC-019). */
function listedEntry(entry) {
  return {
    fp: entry.fp, status: entry.status, count: entry.count, command: entry.command, kind: entry.kind,
    message: entry.message, lastSeen: entry.lastSeen, lastVersion: entry.lastVersion,
  };
}

/**
 * Reads the store and folds it. With no resolvable failure home nothing is read.
 * @param {Object} [options]
 * @param {Object} [options.env] defaults to process.env
 * @returns {{home: string|null, capture: 'on'|'off', entries: Object[], counts: Object, skippedLines: number}}
 */
function loadEntries({ env = process.env } = {}) {
  const home = failureHome(env);
  const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
  // With no failure home nothing is captured, whatever the switch says.
  if (!home) return { home: null, capture: 'off', entries: [], counts, skippedLines: 0 };
  const { events, skippedLines: eventSkips } = readEvents(home);
  const { settlements, skippedLines: settlementSkips } = readSettlements(home);
  const entries = foldEntries(events, settlements);
  for (const entry of entries) counts[entry.status] += 1;
  return { home, capture: captureSwitch(home, env).effective, entries, counts, skippedLines: eventSkips + settlementSkips };
}

/**
 * Appends one settlement line (IC-013). Only `failure --action settle` calls this.
 * @param {string} home
 * @param {{fp: string, as: string, reason?: string|null, followup?: string|null, now?: Date}} settlement
 */
function appendSettlement(home, { fp, as, reason = null, followup = null, now = new Date() }) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const line = JSON.stringify({ v: 1, at: now.toISOString(), fp, as, reason, followup });
  fs.appendFileSync(settlementsPath(home), `${line}\n`, { flag: 'a', mode: 0o600 });
}

const DOFLOW_PACKAGE = '@khoavu882/doflow';

/** Whether `root` is the DoFlow repository itself: its `package.json` is named `@khoavu882/doflow`. */
function isDoflowRepo(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name === DOFLOW_PACKAGE; } catch { return false; }
}

module.exports = {
  isDoflowRepo, fingerprint, readEvents, readSettlements, foldEntries, listedEntry, loadEntries, appendSettlement,
  settlementsPath, SETTLE_AS, STATUSES, SHOWN_BY_DEFAULT,
};
