'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * Reading one settings layer file (`settings.json` / `settings.local.json`; 086 IC-002, data-model §2)
 * and the value encodings that file uses. A leaf module: it takes the registry as an argument and
 * imports nothing from it.
 *
 * Nothing here ever returns file text. `JSON.parse` quotes the first bytes of the input in its
 * "Unexpected token" messages (Node 24 and 26 both do), so a parse failure is reported as a code and a
 * byte offset only, and `error.message` is never forwarded. `jsonFailure` is the shared helper for any
 * other reader that parses a user's JSON (the legacy decision-model reads move onto it in C.4).
 */

const nodeFs = require('node:fs');

/** A file larger than this is a layer fault, not a read (data-model §2). */
const MAX_BYTES = 65536;
const BOM = '\uFEFF';

interface ValueFault { code: 'type' | 'enum' | 'range' | 'url' | 'items' | 'length'; reason: string }
interface Entry { raw: unknown; value: unknown | null; error: ValueFault | null }
interface Note { code: 'unknown-key' | 'nested' | 'schema-missing'; key: string | null; source: string; text: string }
type LayerCode = 'unparseable' | 'schema' | 'too-large' | 'not-file' | 'unreadable';
interface LayerRead {
  status: 'absent' | 'ok' | 'invalid';
  code: LayerCode | null;
  /** Byte offset from the start of the file of a JSON syntax error, else null. */
  offset: number | null;
  /** A fixed phrase, never file text. */
  reason: string | null;
  values: Map<string, Entry>;
  notes: Note[];
  /** Parsed document for a writer that requested it; absent on ordinary reads. */
  document?: Record<string, unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The error text of a failed `JSON.parse` reduced to a byte offset into `text`. V8 states a position as
 * `... in JSON at position N` at the END of the message; the "Unexpected token" form quotes input, so
 * only the anchored tail is trusted. `Unexpected end of JSON input` means the end of the text.
 * @param text the string that was parsed (after any BOM was removed)
 * @param bomBytes bytes removed before `text`, added to the result so the offset is a file offset
 */
function jsonFailure(error: any, text: string, bomBytes = 0): { offset: number | null; reason: string } {
  const message = String(error?.message ?? '');
  let index: number | null = null;
  if (message === 'Unexpected end of JSON input') index = text.length;
  else {
    const m = / in JSON at position (\d+)(?: \(line \d+ column \d+\))?$/.exec(message);
    if (m) index = Math.min(Number(m[1]), text.length);
  }
  if (index === null) return { offset: null, reason: 'not valid JSON' };
  const offset = Buffer.byteLength(text.slice(0, index), 'utf8') + bomBytes;
  return { offset, reason: `not valid JSON at offset ${offset}` };
}

const WORKER_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
/** The two billing values a person may record (the registry's `unknown` is not a claim). */
const RECORDED_BILLING = ['free', 'metered'];
const BILLING_ENTRY_FIELDS = ['billing', 'asserted', 'basis'];
const BILLING_MAX_ENTRIES = 16;
const BILLING_BASIS_MAX = 120;

/** `YYYY-MM-DD` naming a real calendar date. */
function isCalendarDate(value: unknown): boolean {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const at = new Date(Date.UTC(year, month - 1, day));
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day;
}

/**
 * The `workers.billing` record: an object of 1..16 entries keyed by worker id, each exactly
 * `{billing, asserted[, basis]}`. The first fault wins and invalidates the whole key; a reason
 * names the entry (when its id is well formed) and the field, never the value.
 */
function validateWorkerBilling(value: unknown): ValueFault | null {
  if (!isObject(value)) return { code: 'type', reason: 'must be an object keyed by worker id' };
  const ids = Object.keys(value);
  if (ids.length < 1 || ids.length > BILLING_MAX_ENTRIES) return { code: 'range', reason: `must hold 1 to ${BILLING_MAX_ENTRIES} worker entries` };
  for (const id of ids) {
    if (!WORKER_ID_RE.test(id)) return { code: 'type', reason: 'has an entry key that is not a worker id (lowercase letters, digits and hyphens)' };
    const entry = value[id];
    const at = `entry '${id}'`;
    if (!isObject(entry)) return { code: 'type', reason: `${at} must be an object` };
    if (Object.keys(entry).some((field) => !BILLING_ENTRY_FIELDS.includes(field))) return { code: 'type', reason: `${at} has a field other than billing, asserted and basis` };
    if (typeof entry.billing !== 'string') return { code: 'type', reason: `${at} field 'billing' must be a string` };
    if (!RECORDED_BILLING.includes(entry.billing)) return { code: 'enum', reason: `${at} field 'billing' must be one of: ${RECORDED_BILLING.join(', ')}` };
    if (!isCalendarDate(entry.asserted)) return { code: 'range', reason: `${at} field 'asserted' must be a real YYYY-MM-DD date` };
    if (Object.hasOwn(entry, 'basis')) {
      const basis = entry.basis;
      if (typeof basis !== 'string') return { code: 'type', reason: `${at} field 'basis' must be a string` };
      if (/[\r\n\u0085\u2028\u2029]/.test(basis) || basis.length < 1 || basis.length > BILLING_BASIS_MAX) return { code: 'range', reason: `${at} field 'basis' must be one line of 1 to ${BILLING_BASIS_MAX} characters` };
    }
  }
  return null;
}

/**
 * Whether a JSON value is acceptable for a key (data-model §2 encodings). The reason never echoes the
 * value. `enumValues` is the allowed list for an enum key, or for a string-list key with a `valuesRef`.
 */
function validateValue(spec: any, value: unknown, enumValues: readonly string[] | null = null): ValueFault | null {
  switch (spec.type) {
    case 'boolean':
      return typeof value === 'boolean' ? null : { code: 'type', reason: 'must be true or false' };
    case 'enum':
      if (typeof value !== 'string') return { code: 'type', reason: 'must be a string' };
      if (!enumValues) return { code: 'enum', reason: 'has no allowed values available' };
      return enumValues.includes(value) ? null : { code: 'enum', reason: `must be one of: ${enumValues.join(', ')}` };
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) return { code: 'type', reason: 'must be a whole number' };
      if (value < (spec.min ?? Number.MIN_SAFE_INTEGER)) return { code: 'range', reason: `must be at least ${spec.min}` };
      return value > (spec.max ?? Number.MAX_SAFE_INTEGER) ? { code: 'range', reason: `must be at most ${spec.max}` } : null;
    case 'string-list': {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) return { code: 'type', reason: 'must be a list of non-empty strings' };
      if (value.length > spec.maxItems) return { code: 'items', reason: `must hold at most ${spec.maxItems} items` };
      if (new Set(value).size !== value.length) return { code: 'items', reason: 'must not repeat an item' };
      if (value.some((item) => item.length > spec.maxLength)) return { code: 'length', reason: `each item must be at most ${spec.maxLength} characters` };
      if (!spec.valuesRef || value.length === 0) return null;
      if (!enumValues) return { code: 'enum', reason: 'has no allowed values available' };
      return value.every((item) => enumValues.includes(item)) ? null : { code: 'enum', reason: `each item must be one of: ${enumValues.join(', ')}` };
    }
    case 'string':
      return typeof value === 'string' && value.trim() ? null : { code: 'type', reason: 'must be a non-empty string' };
    case 'url':
      if (typeof value !== 'string' || !value.trim()) return { code: 'type', reason: 'must be a URL string' };
      try { new URL(value); return null; } catch { return { code: 'url', reason: 'must be a URL string' }; }
    case 'worker-billing':
      return validateWorkerBilling(value);
    default:
      return { code: 'type', reason: 'has an unknown type' };
  }
}

function invalid(code: LayerCode, reason: string, offset: number | null = null, notes: Note[] = []): LayerRead {
  return { status: 'invalid', code, offset, reason, values: new Map(), notes };
}

/**
 * Read one layer file. Never throws, never creates a file or folder, never blocks on a FIFO.
 * A missing file (including a dangling link) is `absent`; anything else that cannot be used is an
 * invalid layer with a code (data-model §2): not-file, unreadable, too-large, unparseable, schema.
 * @param registry `{ keys: Map<string, KeySpec>, enumValues(key): string[] | null }`
 */
function readLayerFile(file: string, { registry, fsImpl = nodeFs, includeDocument = false }: { registry: any; fsImpl?: any; includeDocument?: boolean }): LayerRead {
  let stat: any;
  try { stat = fsImpl.statSync(file); }
  catch (error: any) {
    if (error?.code === 'ENOENT') return { status: 'absent', code: null, offset: null, reason: null, values: new Map(), notes: [] };
    return invalid('unreadable', 'cannot be read');
  }
  if (!stat.isFile()) return invalid('not-file', 'is not a regular file');
  if (stat.size > MAX_BYTES) return invalid('too-large', `is larger than ${MAX_BYTES} bytes`);

  let buffer: Buffer;
  try { buffer = fsImpl.readFileSync(file); }
  catch { return invalid('unreadable', 'cannot be read'); }
  if (buffer.length > MAX_BYTES) return invalid('too-large', `is larger than ${MAX_BYTES} bytes`);

  let text = buffer.toString('utf8');
  let bomBytes = 0;
  if (text.startsWith(BOM)) { text = text.slice(1); bomBytes = 3; }

  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch (error: any) {
    const failure = jsonFailure(error, text, bomBytes);
    return invalid('unparseable', failure.reason, failure.offset);
  }
  if (!isObject(parsed)) return invalid('unparseable', 'must be a JSON object');

  const notes: Note[] = [];
  if (!Object.hasOwn(parsed, 'schema')) {
    notes.push({ code: 'schema-missing', key: null, source: file, text: 'has no "schema"; read as schema 1' });
  } else if (parsed.schema !== 1) {
    return invalid('schema', 'schema must be 1');
  }

  const values = new Map<string, Entry>();
  for (const [key, raw] of Object.entries(parsed)) {
    if (key === 'schema') continue;
    const spec = registry.keys.get(key);
    if (!spec) {
      const shown = JSON.stringify(key.length > 80 ? `${key.slice(0, 80)}...` : key);
      if (isObject(raw) || Array.isArray(raw)) {
        notes.push({ code: 'nested', key, source: file, text: `${shown} is a nested object; use dotted keys (not applied)` });
      } else {
        notes.push({ code: 'unknown-key', key, source: file, text: `${shown} is not a DoFlow setting (ignored)` });
      }
      continue;
    }
    const error = validateValue(spec, raw, registry.enumValues(key));
    values.set(key, { raw, value: error ? null : raw, error });
  }
  return { status: 'ok', code: null, offset: null, reason: null, values, notes,
    ...(includeDocument ? { document: parsed as Record<string, unknown> } : {}) };
}

module.exports = { MAX_BYTES, jsonFailure, validateValue, readLayerFile };
