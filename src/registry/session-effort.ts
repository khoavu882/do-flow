'use strict';

// 178 design §3.1 (IC-001): the static checks of a harness's top-level `sessionEffort` key, which says how DoFlow
// reads the effort of that harness's own running session. A source is `env` (one variable the session sets, O-8 (b))
// or, since 180 IC-180-E2, `hook-state` (the level a hook stored for the session that `sessionIdEnv` names; the entry
// names no file and no location, the runtime's store owns both). Pure: no I/O, no runtime require.
// `validateRegistry` (index.ts) calls it beside `validatePrimaryProbe` with the harness's `worker.effort` status.

const { ENV_NAME_RE: VARIABLE_RE } = require('./model-parts.ts');

const STATUSES = Object.freeze(['supported', 'unknown']);
const MODES = Object.freeze(['subscription', 'api-key']);
const MARKER_VALUE_RE = /^[\x20-\x7e]{1,32}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TEXT_MAX = 240;
const SOURCES_MAX = 8;
const ENTRY_MAX_BYTES = 2048;
const FIELDS = new Set(['status', 'reason', 'verification', 'evidence', 'verifiedOn', 'marker', 'sources', 'note']);
const SOURCE_FIELDS: Readonly<Record<string, Set<string>>> = Object.freeze({
  env: new Set(['kind', 'name', 'modes']),
  'hook-state': new Set(['kind', 'sessionIdEnv', 'modes']),
});

const isObject = (value: any): boolean => value !== null && typeof value === 'object' && !Array.isArray(value);
const oneLine = (value: any): boolean => typeof value === 'string' && value.trim() !== '' && !/[\r\n]/.test(value) && value.length <= TEXT_MAX;

function checkMarker(marker: any, fail: (message: string) => void): void {
  if (!isObject(marker)) { fail('marker must be an object {env, equals}'); return; }
  for (const key of Object.keys(marker)) if (key !== 'env' && key !== 'equals') fail(`marker has unknown field '${key}'`);
  if (typeof marker.env !== 'string' || !VARIABLE_RE.test(marker.env)) fail(`marker.env must match ${VARIABLE_RE}`);
  if (typeof marker.equals !== 'string' || !MARKER_VALUE_RE.test(marker.equals)) fail('marker.equals must be 1 to 32 printable ASCII characters');
}

function checkSources(sources: any, markerEnv: unknown, fail: (message: string) => void): void {
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > SOURCES_MAX) { fail(`sources must be 1 to ${SOURCES_MAX} entries`); return; }
  const names = new Set<string>();
  let hookStates = 0;
  sources.forEach((source: any, index: number) => {
    const at = `sources[${index}]`;
    if (!isObject(source)) { fail(`${at} must be an object`); return; }
    const fields = Object.hasOwn(SOURCE_FIELDS, source.kind) ? SOURCE_FIELDS[source.kind] : SOURCE_FIELDS.env;
    for (const key of Object.keys(source)) if (!fields.has(key)) fail(`${at} has unknown field '${key}'`);
    if (!Object.hasOwn(SOURCE_FIELDS, source.kind)) fail(`${at} kind must be env or hook-state`);
    if (source.kind === 'hook-state' && ++hookStates === 2) fail('sources hold at most one hook-state source');
    // The variable a source reads: an env source's value, or the session id a hook-state level is keyed by.
    const field = source.kind === 'hook-state' ? 'sessionIdEnv' : 'name';
    const name = source[field];
    if (typeof name !== 'string' || !VARIABLE_RE.test(name)) fail(`${at} ${field} must match ${VARIABLE_RE}`);
    else {
      if (name === markerEnv) fail(`${at} ${field} must not be the marker's own variable`);
      if (names.has(name)) fail('sources names must be distinct');
      names.add(name);
    }
    const modes = source.modes;
    if (!Array.isArray(modes) || modes.length < 1 || modes.length > MODES.length || modes.some((mode: any) => !MODES.includes(mode)) || new Set(modes).size !== modes.length) {
      fail(`${at} modes must be 1 to ${MODES.length} distinct of ${MODES.join(', ')}`);
    }
  });
}

/** Design §3.1: one refusal per rule of the table. `effortStatus` is the harness's `worker.effort.status` (cross-entry rule). */
function validateSessionEffort(
  entry: any, at: string, errors: string[], { effortStatus }: { effortStatus?: string } = {},
): void {
  const fail = (message: string) => { errors.push(`${at} sessionEffort: ${message}`); };
  if (!isObject(entry)) { fail('must be an object'); return; }
  for (const key of Object.keys(entry)) if (!FIELDS.has(key)) fail(`has unknown field '${key}'`);
  if (!STATUSES.includes(entry.status)) { fail('status must be supported or unknown'); return; }
  const bytes = Buffer.byteLength(JSON.stringify(entry));
  if (bytes > ENTRY_MAX_BYTES) fail(`entry is ${bytes} bytes serialized; the limit is ${ENTRY_MAX_BYTES}`);
  if (typeof entry.verification !== 'string' || !entry.verification.trim()) fail('requires a verification instruction');
  if (Object.hasOwn(entry, 'evidence') && (!Array.isArray(entry.evidence) || entry.evidence.some((item: any) => typeof item !== 'string'))) fail('evidence must be an array of strings');
  if (Object.hasOwn(entry, 'verifiedOn') && (typeof entry.verifiedOn !== 'string' || !DATE_RE.test(entry.verifiedOn))) fail('verifiedOn must be an ISO date (YYYY-MM-DD)');
  if (Object.hasOwn(entry, 'note') && !oneLine(entry.note)) fail(`note must be a string of at most ${TEXT_MAX} characters`);

  if (entry.status === 'unknown') {
    if (!Object.hasOwn(entry, 'reason')) fail('status unknown requires a reason');
    else if (!oneLine(entry.reason)) fail(`reason must be a non-empty line of at most ${TEXT_MAX} characters`);
    for (const key of ['marker', 'sources']) if (Object.hasOwn(entry, key)) fail(`status unknown forbids '${key}'`);
    return;
  }
  if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) fail('evidence must not be empty when status is supported');
  if (!Object.hasOwn(entry, 'verifiedOn')) fail('status supported requires verifiedOn');
  if (!Object.hasOwn(entry, 'marker')) fail('status supported requires a marker');
  else checkMarker(entry.marker, fail);
  checkSources(entry.sources, entry.marker?.env, fail);
  if (effortStatus !== 'supported') fail("status supported requires worker 'effort' to be supported");
}

module.exports = { validateSessionEffort };
