'use strict';

// 093 V.1, IC-021: loader, validator and doctor view for core/registry/transcripts.json, the data that
// says where each harness keeps its transcripts. Like advice.json it stays outside REGISTRY_FILES: a bad
// file turns the transcript feature off (`config-invalid`), it must not fail every install command.

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

const TRANSCRIPTS_FILE = 'core/registry/transcripts.json';
const HARNESSES_FILE = 'core/registry/harnesses.json';
const STALE_DAYS = 90;
const DAY_MS = 86400000;
const STATUSES = ['supported', 'events-only', 'unknown'];
const FORMATS = ['jsonl', 'sqlite', 'jsonl+json'];
const APPEND_ONLY = ['yes', 'no', 'unknown'];
const JOINS = ['session-id', 'cwd', 'none'];
const OSES = ['darwin', 'linux', 'win32'];
const PLACEHOLDERS = new Set(['sessionId', 'cwdEncoded']);
const ENTRY_KEYS = ['harness', 'reader', 'status', 'locations', 'format', 'appendOnly', 'join', 'requiredKeys', 'evidence', 'verifiedOn', 'versions'];

function isObject(value: any): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: any): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0);
}

/** True for a real calendar date written YYYY-MM-DD. */
function isDate(value: any): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const at = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().slice(0, 10) === value;
}

function validateLocation(location: any, where: string, errors: string[]): void {
  if (!isObject(location)) { errors.push(`${where} must be an object`); return; }
  if (!OSES.includes(location.os)) errors.push(`${where}.os must be one of ${OSES.join(', ')}`);
  if (!(typeof location.base === 'string' && /^(home|xdg-data|env:[A-Z_][A-Z0-9_]*)$/.test(location.base))) {
    errors.push(`${where}.base must be home, xdg-data or env:<NAME>`);
  }
  if (!isStringArray(location.segments)) errors.push(`${where}.segments must be an array of non-empty strings`);
  if (typeof location.glob !== 'string' || !location.glob) {
    errors.push(`${where}.glob must be a non-empty string`);
  } else {
    for (const [, name] of location.glob.matchAll(/\{([^}]*)\}/g)) {
      if (!PLACEHOLDERS.has(name)) errors.push(`${where}.glob has an unknown placeholder {${name}}`);
    }
  }
  // R28: a Windows location stays unverified until someone measures it, and only Windows may say so.
  if (location.os === 'win32') {
    if (location.status !== 'unknown') errors.push(`${where} is win32, so its status must be "unknown"`);
  } else if (location.status !== undefined) {
    errors.push(`${where}.status is only allowed on a win32 location`);
  }
}

function validateEntry(entry: any, index: number, errors: string[]): void {
  const label = isObject(entry) && typeof entry.harness === 'string' ? entry.harness : `entries[${index}]`;
  if (!isObject(entry)) { errors.push(`${label} must be an object`); return; }
  for (const key of ENTRY_KEYS) {
    if (!Object.hasOwn(entry, key)) errors.push(`${label}.${key} is missing`);
  }
  if (typeof entry.harness !== 'string' || !entry.harness) errors.push(`${label}.harness must be a non-empty string`);
  if (Object.hasOwn(entry, 'reader') && entry.reader !== null && (typeof entry.reader !== 'string' || !entry.reader)) {
    errors.push(`${label}.reader must be a module id or null`);
  }
  if (Object.hasOwn(entry, 'status') && !STATUSES.includes(entry.status)) errors.push(`${label}.status must be one of ${STATUSES.join(', ')}`);
  // A reader exists exactly when the harness is supported (IC-021: OpenCode moves only with its reader).
  if (STATUSES.includes(entry.status) && entry.reader !== undefined) {
    if (entry.status === 'supported' && entry.reader === null) errors.push(`${label}.reader must be set when status is supported`);
    if (entry.status !== 'supported' && entry.reader !== null) errors.push(`${label}.reader must be null unless status is supported`);
  }
  if (Object.hasOwn(entry, 'locations')) {
    if (!Array.isArray(entry.locations) || entry.locations.length === 0) errors.push(`${label}.locations must be a non-empty array`);
    else entry.locations.forEach((location: any, i: number) => validateLocation(location, `${label}.locations[${i}]`, errors));
  }
  if (Object.hasOwn(entry, 'format') && !FORMATS.includes(entry.format)) errors.push(`${label}.format must be one of ${FORMATS.join(', ')}`);
  if (Object.hasOwn(entry, 'appendOnly') && !APPEND_ONLY.includes(entry.appendOnly)) errors.push(`${label}.appendOnly must be one of ${APPEND_ONLY.join(', ')}`);
  if (Object.hasOwn(entry, 'join') && !JOINS.includes(entry.join)) errors.push(`${label}.join must be one of ${JOINS.join(', ')}`);
  if (Object.hasOwn(entry, 'requiredKeys') && !isStringArray(entry.requiredKeys)) errors.push(`${label}.requiredKeys must be an array of non-empty strings`);
  if (Object.hasOwn(entry, 'evidence') && (!isStringArray(entry.evidence) || entry.evidence.length === 0)) errors.push(`${label}.evidence must be a non-empty array of strings`);
  if (Object.hasOwn(entry, 'verifiedOn') && !isDate(entry.verifiedOn)) errors.push(`${label}.verifiedOn must be a YYYY-MM-DD date`);
  if (Object.hasOwn(entry, 'versions') && entry.versions !== null && (typeof entry.versions !== 'string' || !entry.versions)) {
    errors.push(`${label}.versions must be a version range or null`);
  }
}

/** The registry ids of core/registry/harnesses.json, read as plain data. */
function readHarnessIds(repoRoot: string, fsImpl: any = fs): string[] {
  const parsed = JSON.parse(fsImpl.readFileSync(path.join(path.resolve(repoRoot), HARNESSES_FILE), 'utf8'));
  return parsed.harnesses.map((harness: any) => harness.id);
}

/**
 * Checks the registry's shape and the id guard: the entry ids and `harnessIds` are the same set, with no
 * exception (row 127 retired Gemini CLI, so there is no Gemini entry and no allowance for one).
 */
function validateTranscriptRegistry(registry: any, { harnessIds }: { harnessIds: string[] }): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!isObject(registry)) return { ok: false, errors: ['registry must be an object'] };
  if (registry.version !== 1) errors.push('version must be 1');
  if (!Array.isArray(registry.entries)) {
    errors.push('entries must be an array');
    return { ok: false, errors };
  }
  registry.entries.forEach((entry: any, i: number) => validateEntry(entry, i, errors));
  const seen = new Set<string>();
  for (const entry of registry.entries) {
    if (!isObject(entry) || typeof entry.harness !== 'string') continue;
    if (seen.has(entry.harness)) errors.push(`${entry.harness} is a duplicate entry`);
    seen.add(entry.harness);
    if (!harnessIds.includes(entry.harness)) errors.push(`${entry.harness} is not a harnesses.json id`);
  }
  for (const id of harnessIds) {
    if (!seen.has(id)) errors.push(`${id} has no entry (every harnesses.json id needs one)`);
  }
  return { ok: errors.length === 0, errors };
}

function loadTranscriptRegistry({ repoRoot = REPO_ROOT, file, fsImpl = fs }: any = {}): { ok: boolean; registry?: any; reason?: string; detail?: string } {
  const root = path.resolve(repoRoot);
  const target = file || path.join(root, TRANSCRIPTS_FILE);
  let registry: any;
  let harnessIds: string[];
  try {
    registry = JSON.parse(fsImpl.readFileSync(target, 'utf8'));
    harnessIds = readHarnessIds(root, fsImpl);
  } catch (error: any) {
    return { ok: false, reason: 'config-invalid', detail: `${target}: ${error.message}` };
  }
  const validation = validateTranscriptRegistry(registry, { harnessIds });
  if (!validation.ok) return { ok: false, reason: 'config-invalid', detail: validation.errors.join('; ') };
  return { ok: true, registry };
}

/** Entries whose `verifiedOn` is more than STALE_DAYS before `now`. */
function staleEntries(registry: any, now: Date = new Date()): Array<{ harness: string; verifiedOn: string; ageDays: number }> {
  const out: Array<{ harness: string; verifiedOn: string; ageDays: number }> = [];
  for (const entry of registry.entries) {
    const ageDays = Math.floor((now.getTime() - new Date(`${entry.verifiedOn}T00:00:00Z`).getTime()) / DAY_MS);
    if (ageDays > STALE_DAYS) out.push({ harness: entry.harness, verifiedOn: entry.verifiedOn, ageDays });
  }
  return out;
}

/**
 * The doctor's `transcripts` row: `ok`, `stale` (a `verifiedOn` older than 90 days) or `drift` (the file or
 * the id guard is invalid, so the transcript feature is off). Read-only; never a finding, so the exit code
 * does not change. A `format-unrecognized` seen at run time joins this row when V.4's readers exist.
 */
function transcriptsDoctorView({ repoRoot = REPO_ROOT, file, fsImpl = fs, now = new Date() }: any = {}): any {
  const loaded = loadTranscriptRegistry({ repoRoot, file, fsImpl });
  if (!loaded.ok) return { state: 'drift', entries: 0, stale: [], errors: (loaded.detail as string).split('; ') };
  const stale = staleEntries(loaded.registry, now);
  return { state: stale.length ? 'stale' : 'ok', entries: loaded.registry.entries.length, stale, errors: [] };
}

module.exports = { loadTranscriptRegistry, validateTranscriptRegistry, staleEntries, transcriptsDoctorView, STALE_DAYS, TRANSCRIPTS_FILE };
