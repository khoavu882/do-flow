'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * The 2.0 settings files, read as deprecated sources (086 IC-008, FR-010). The rules are the 2.0
 * ones, copied from `advice/config.ts` (parseUserSetting, parseProjectSetting, readJson),
 * `storage/roots.ts` (readSetting + existsSync) and `failure/home.ts` (the sentinel `isFile`), so an
 * old file gives the result it gave in 2.0. Two departures, both in the safe direction: a JSON parse
 * error names its offset only, never the file text (IC-002, `jsonFailure`); a path that is not a
 * regular file is never opened, so a FIFO cannot block a read (2.0 would have waited on it).
 *
 * `../settings/resolve.ts` requires this module only after a `stat` hit on a legacy path, so a
 * machine with no old files never compiles it. Nothing here writes, and nothing returns file text.
 */

const nodeFs = require('node:fs');
const { jsonFailure } = require('./files.ts');

const PROJECT_NOTE = 'a project cannot enable the decision model or choose its endpoint';
const USER_KEYS = new Set(['schema', 'enabled', 'provider', 'endpoint', 'model']);
const PROJECT_KEYS = ['schema', 'enabled', 'model', 'endpoint', 'provider'];
/** The decision-model.json fields that carry a setting, in file order. */
const FIELDS = ['enabled', 'provider', 'endpoint', 'model'];

type Code = 'unparseable' | 'unreadable' | 'not-file' | 'schema' | 'type' | 'enum' | 'url' | 'cross-key';
interface Fault { error: string; code: Code }
interface LegacyNote { code: 'scope' | 'unknown-key'; field: string | null; text: string }
interface DecisionRead {
  status: 'absent' | 'ok' | 'invalid';
  code: Code | null;
  offset: number | null;
  /** today's error text (a parse error as `not valid JSON[ at offset N]`), never file text */
  reason: string | null;
  /** the setting fields present in a valid file, by field name */
  fields: Map<string, unknown>;
  notes: LegacyNote[];
}
/** What the user file is checked against: the provider default and list, and each provider's default endpoint. */
interface Providers { defaultProvider: unknown; ids: readonly string[]; defaultEndpoint(id: string): unknown }

function isObject(value: any): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 2.0 `parseUserSetting` (advice/config.ts): the whole file is valid or none of it is. */
function parseUserSetting(value: any, providers: Providers): Fault | { notes: LegacyNote[] } {
  if (!isObject(value)) return { error: 'user setting must be a JSON object', code: 'unparseable' };
  if (value.schema !== 1) return { error: 'user setting schema must be 1', code: 'schema' };
  if (typeof value.enabled !== 'boolean') return { error: 'user setting enabled must be a boolean', code: 'type' };

  const providerId = value.provider === undefined ? providers.defaultProvider : value.provider;
  if (typeof providerId !== 'string' || !providers.ids.includes(providerId)) {
    return { error: `user setting provider '${providerId}' is not in advice.json providers`, code: 'enum' };
  }
  let endpoint: unknown;
  if (value.endpoint !== undefined) {
    if (typeof value.endpoint !== 'string' || !value.endpoint.trim()) return { error: 'user setting endpoint must be a URL string', code: 'url' };
    try { new URL(value.endpoint); } catch { return { error: 'user setting endpoint must be a URL string', code: 'url' }; }
    endpoint = value.endpoint;
  } else {
    endpoint = providers.defaultEndpoint(providerId);
  }
  if (typeof endpoint !== 'string' || !endpoint) return { error: `providers.${providerId}.defaultEndpoint is missing`, code: 'enum' };

  if (value.model !== undefined && (typeof value.model !== 'string' || !value.model.trim())) {
    return { error: 'user setting model must be a non-empty string', code: 'type' };
  }
  if (value.enabled && (typeof value.model !== 'string' || !value.model.trim())) {
    return { error: 'user setting model is required when enabled is true', code: 'cross-key' };
  }
  const notes: LegacyNote[] = Object.keys(value)
    .filter((key) => !USER_KEYS.has(key))
    .map((key) => ({ code: 'unknown-key', field: null, text: `unknown user key '${key}' ignored` }));
  return { notes };
}

/** 2.0 `parseProjectSetting`: a project may only disable and choose a model; the rest is noted, never applied. */
function parseProjectSetting(value: any): Fault | { notes: LegacyNote[] } {
  if (!isObject(value)) return { error: 'project setting must be a JSON object', code: 'unparseable' };
  if (value.schema !== 1) return { error: 'project setting schema must be 1', code: 'schema' };
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') return { error: 'project setting enabled must be a boolean', code: 'type' };
  if (value.model !== undefined && (typeof value.model !== 'string' || !value.model.trim())) return { error: 'project setting model must be a non-empty string', code: 'type' };

  const notes: LegacyNote[] = [];
  if (value.enabled === true) notes.push({ code: 'scope', field: 'enabled', text: `project key 'enabled' ignored: ${PROJECT_NOTE}` });
  for (const key of ['endpoint', 'provider']) {
    if (Object.hasOwn(value, key)) notes.push({ code: 'scope', field: key, text: `project key '${key}' ignored: ${PROJECT_NOTE}` });
  }
  for (const key of Object.keys(value)) {
    if (!PROJECT_KEYS.includes(key)) notes.push({ code: 'unknown-key', field: null, text: `unknown project key '${key}' ignored` });
  }
  return { notes };
}

function failed(code: Code, reason: string, offset: number | null = null): DecisionRead {
  return { status: 'invalid', code, offset, reason, fields: new Map(), notes: [] };
}

/**
 * `<config home>/doflow/decision-model.json` (flavour `user`) or `.doflow/decision-model.json`
 * (`project`). A missing file is absent; any other fault is the whole file invalid with today's text.
 * A valid file yields the fields it holds: a project's `enabled: true`, `endpoint` and `provider` are
 * yielded too (the resolver's scope rules ignore them) with today's notes.
 */
function readDecisionModel(file: string, flavour: 'user' | 'project', providers: Providers | null, fsImpl: any = nodeFs): DecisionRead {
  try {
    if (!fsImpl.statSync(file).isFile()) return failed('not-file', 'is not a regular file');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { status: 'absent', code: null, offset: null, reason: null, fields: new Map(), notes: [] };
    return failed('unreadable', String(error?.message ?? 'cannot be read'));
  }
  let text: string;
  try { text = fsImpl.readFileSync(file, 'utf8'); }
  catch (error: any) { return failed('unreadable', String(error?.message ?? 'cannot be read')); }
  let value: any;
  try { value = JSON.parse(text); }
  catch (error: any) {
    const failure = jsonFailure(error, text);
    return failed('unparseable', failure.reason, failure.offset);
  }
  const parsed = flavour === 'user'
    ? parseUserSetting(value, providers ?? { defaultProvider: undefined, ids: [], defaultEndpoint: () => null })
    : parseProjectSetting(value);
  if ('error' in parsed) return failed(parsed.code, parsed.error);
  const fields = new Map<string, unknown>();
  for (const field of FIELDS) if (Object.hasOwn(value, field)) fields.set(field, value[field]);
  return { status: 'ok', code: null, offset: null, reason: null, fields, notes: parsed.notes };
}

/**
 * The `prune` file (2.0 `readSetting` behind `existsSync`): absent → null; otherwise its first line,
 * trimmed, any case, `on` or `off`; anything else, an empty file or a path that cannot be read as a
 * file is `off`.
 */
function readLineOnOff(file: string, fsImpl: any = nodeFs): 'on' | 'off' | null {
  let stat: any;
  try { stat = fsImpl.statSync(file); } catch { return null; }
  if (!stat.isFile()) return 'off';
  try {
    const first = String(fsImpl.readFileSync(file, 'utf8')).split(/\r?\n/, 1)[0].trim().toLowerCase();
    return first === 'on' || first === 'off' ? first : 'off';
  } catch { return 'off'; }
}

/** A sentinel file (`failures/off`): present when the path is a regular file; its content is never read. */
function readSentinel(file: string, fsImpl: any = nodeFs): boolean {
  try { return fsImpl.statSync(file).isFile(); } catch { return false; }
}

module.exports = { PROJECT_NOTE, readDecisionModel, readLineOnOff, readSentinel };
