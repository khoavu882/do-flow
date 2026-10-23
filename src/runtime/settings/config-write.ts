'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * `doflow config schema|validate|set|unset` (119 IC-007, IC-008, IC-009; D-2). One read, validate and
 * write path over the settings registry, the resolver and the atomic `writeLayer`. A value is never
 * judged by a copy of the fold's rules: the layer document as it would be after the write is served to
 * `loadSettings` in place of the file, and the key's candidate for that layer is read back, so scope
 * (rule 1), the value rules and narrowing (rule 3) are the resolver's own verdicts.
 *
 * Checks run in this order and the first failing one is reported per key: locked (`invariant.*`),
 * unknown-key, security (a `securityRelevant` key is written by a person in the file, never by this
 * verb), scope, the value rules (type, enum, range, items, length), not-narrower. Nothing is written,
 * and no directory is created, until every check passes.
 */

const path = require('node:path');
const nodeFs = require('node:fs');
const { configHome } = require('../config-home.ts');
const { finishRuntime, usageError } = require('../cli-result.ts');
const { validateValue, readLayerFile } = require('./files.ts');
const { loadSettings, clearSettingsCache } = require('./resolve.ts');
const { projectLayerSource } = require('./project-layers.ts');
const { writeLayer } = require('./write.ts');
const { REF_META } = require('./refs.ts');
const { maskUrl } = require('./shared.ts');
const { loadProtocols, presetIds } = require('../review/protocols.ts');

const LAYERS = ['user', 'project', 'local'];
const LAYER_FILE: Record<string, string> = { user: 'settings.json', project: 'settings.json', local: 'settings.local.json' };
/** The codes whose entry carries the key's `allowed` values (IC-009). */
const VALUE_CODES = new Set(['type', 'enum', 'range', 'items', 'length', 'url']);

interface Entry { key: string; layer: string | null; ok: false; code: string; message: string; allowed: unknown }
interface Parsed { ok: boolean; value: unknown }

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function allowedOf(registry: any, key: string): unknown {
  const spec = registry.keys.get(key);
  if (!spec) return null;
  if (spec.type === 'enum' || (spec.type === 'string-list' && spec.valuesRef)) return registry.enumValues(key);
  if (spec.type === 'integer') return { min: spec.min ?? null, max: spec.max ?? null };
  return null;
}

function entryOf(registry: any, key: string, layer: string | null, code: string, message: string): Entry {
  return { key, layer, ok: false, code, message, allowed: VALUE_CODES.has(code) ? allowedOf(registry, key) : null };
}

function parseValue(text: string): Parsed {
  try { return { ok: true, value: JSON.parse(text) }; } catch { return { ok: false, value: null }; }
}

const NOT_JSON = 'the value is not JSON; quote a string, for example \'"on"\'';

/** The checks that need only the key: locked, unknown-key and, for a write, security. */
function keyEntry(registry: any, key: string, layer: string | null, writes: boolean): Entry | null {
  if (key.startsWith('invariant.')) {
    return entryOf(registry, key, layer, 'locked', `invariant ${key.slice('invariant.'.length)} is locked in core/registry/protocols.json and is never a setting`);
  }
  const spec = registry.keys.get(key);
  if (!spec) return entryOf(registry, key, layer, 'unknown-key', `${key} is not a registered setting`);
  if (writes && spec.securityRelevant) {
    return entryOf(registry, key, layer, 'security', `${key} is security-relevant: a person writes it in the settings file; config set and unset never do`);
  }
  return null;
}

/** `fsImpl` with one file's bytes replaced; everything else is read from `base`. */
function servedFs(file: string, bytes: Buffer, base: any): any {
  const asRead = (p: string, options?: any): any => {
    const encoding = typeof options === 'string' ? options : options?.encoding;
    return encoding ? bytes.toString(encoding) : bytes;
  };
  return {
    statSync: (p: string) => (p === file ? { isFile: () => true, size: bytes.length } : base.statSync(p)),
    lstatSync: (p: string) => (p === file ? { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false, size: bytes.length } : base.lstatSync(p)),
    readFileSync: (p: string, options?: any) => (p === file ? asRead(p, options) : base.readFileSync(p, options)),
    accessSync: (p: string, mode?: number) => (p === file ? undefined : base.accessSync(p, mode)),
    realpathSync: (p: string) => base.realpathSync(p),
  };
}

interface Where { file: string }
/** The layer file for a layer, or the usage message when this machine or folder has none. */
function layerFile(layer: string, env: any, projectRoot: string, fsImpl: any): Where | { error: string } {
  if (layer === 'user') {
    const home = configHome(env);
    if (!home.dir) return { error: 'no config home resolves; set an absolute HOME or XDG_CONFIG_HOME' };
    return { file: path.join(home.dir, LAYER_FILE.user) };
  }
  const source = projectLayerSource(projectRoot, fsImpl);
  if (!source.layersFrom) return { error: `${projectRoot} has no usable project settings folder (.doflow)` };
  return { file: path.join(source.layersFrom, LAYER_FILE[layer]) };
}

/**
 * The layer-dependent verdict for `value` at `layer` in `file`: the existing document plus the value,
 * served to the resolver as that file, and the key's candidate read back. Null when the write is fine.
 */
function layerEntry(registry: any, key: string, layer: string, file: string, parsed: Parsed,
  { env, projectRoot, fsImpl }: any): Entry | null {
  const read = readLayerFile(file, { registry, fsImpl, includeDocument: true });
  if (read.status === 'invalid') {
    return entryOf(registry, key, layer, 'layer-invalid', `${file} ${read.reason}; fix or remove it first`);
  }
  const document: Record<string, unknown> = read.status === 'ok' ? { ...read.document } : {};
  document.schema = 1;
  document[key] = parsed.ok ? parsed.value : null;
  const view = loadSettings({ projectRoot, env, fsImpl: servedFs(file, Buffer.from(JSON.stringify(document)), fsImpl), registry });
  const candidate = view.get(key).candidates.find((c: any) => c.layer === layer && c.source === file && !c.legacy);
  if (!candidate) throw new Error(`the resolver did not read ${file}`);
  if (candidate.status === 'ignored-scope') return entryOf(registry, key, layer, 'scope', `${key} cannot be set at the ${layer} layer (${candidate.reason})`);
  if (!parsed.ok) return entryOf(registry, key, layer, 'type', NOT_JSON);
  if (candidate.status === 'invalid') return entryOf(registry, key, layer, candidate.code, candidate.reason);
  if (candidate.status === 'not-narrower') return entryOf(registry, key, layer, 'not-narrower', `${candidate.reason} (the value is wider than the layers below)`);
  return null;
}

function refuse(action: string, errors: Entry[], json: boolean): number {
  if (json) console.log(JSON.stringify({ ok: false, errors }, null, 2));
  else for (const error of errors) console.error(`config ${action}: ${error.key}: ${error.code}: ${error.message}`);
  return finishRuntime(1);
}

function done(json: boolean, payload: any, text: string[]): number {
  if (json) console.log(JSON.stringify(payload, null, 2));
  else for (const line of text) console.log(line);
  return finishRuntime(0);
}

// ── schema ────────────────────────────────────────────────────────────────────────────────────────

function defaultOf(registry: any, key: string): unknown {
  const spec = registry.keys.get(key);
  if (Object.hasOwn(spec, 'default')) return spec.default;
  const deps: Record<string, unknown> = {};
  for (const dep of REF_META[spec.defaultRef]?.dependsOn ?? []) deps[dep] = defaultOf(registry, dep);
  return registry.resolveRef(spec.defaultRef, deps);
}

function presetSummary(preset: any): string {
  const seats = preset.seats.length;
  const rounds = preset.rounds.default;
  return `${seats} seat${seats === 1 ? '' : 's'}, ${rounds} round${rounds === 1 ? '' : 's'}, synthesizer ${preset.synthesizer}, decider ${preset.decider}`;
}

function buildSchema(registry: any, protocols: any): any {
  const keys = [...registry.keys].map(([key, spec]: [string, any]) => {
    const fallback = defaultOf(registry, key);
    return {
      key, type: spec.type, values: registry.enumValues(key), order: spec.order ?? null,
      min: spec.min ?? null, max: spec.max ?? null, maxItems: spec.maxItems ?? null, maxLength: spec.maxLength ?? null,
      default: spec.type === 'url' && typeof fallback === 'string' ? maskUrl(fallback) : fallback,
      scope: spec.scope, combine: spec.combine, description: spec.description,
      securityRelevant: spec.securityRelevant, writable: !spec.securityRelevant, locked: false,
    };
  });
  const invariants = protocols.invariants.map((inv: any) => ({
    key: `invariant.${inv.id}`, locked: true, writable: false, statement: inv.statement, enforcedBy: inv.enforcedBy,
  }));
  const presets = ['review', 'debate'].flatMap((kind) => presetIds(protocols, kind)).map((id: string) => {
    const preset = protocols.presets[id];
    return {
      id, kind: preset.kind, ...(preset.kind === 'review' ? { depth: preset.depth } : {}),
      seats: preset.seats.length, rounds: preset.rounds.default, summary: presetSummary(preset),
    };
  });
  return { schema: 1, keys, invariants, presets };
}

function handleSchema({ json, registry, repoRoot, fsImpl }: any): number {
  let schema: any;
  try {
    const protocols = loadProtocols({ repoRoot, fsImpl });
    if (!protocols.ok) throw new Error(protocols.errors.join('; '));
    schema = buildSchema(registry, protocols.registry);
  } catch (error: any) {
    const detail = error?.message || String(error);
    if (json) console.log(JSON.stringify({ ok: false, status: 'ERROR', exitCode: 2, error: 'settings-registry-invalid', detail }, null, 2));
    else console.error(`doflow config: settings schema unavailable: ${detail}`);
    return finishRuntime(2);
  }
  const text = [
    ...schema.keys.map((k: any) => `${k.key} ${k.type} default=${JSON.stringify(k.default)} scope=${k.scope} writable=${k.writable}`),
    ...schema.invariants.map((i: any) => `${i.key} locked: ${i.statement}`),
    ...schema.presets.map((p: any) => `preset ${p.id} ${p.kind} ${p.summary}`),
  ];
  return done(json, schema, text);
}

// ── validate, set, unset ──────────────────────────────────────────────────────────────────────────

function handleChange({ action, key, valueText, layer, json, registry, projectRoot, env, fsImpl }: any): number {
  const writes = action !== 'validate';
  const root = path.resolve(projectRoot);
  const keyFault = keyEntry(registry, key, layer ?? null, writes || layer !== undefined);
  if (keyFault) return refuse(action, [keyFault], json);

  const parsed: Parsed = action === 'unset' ? { ok: true, value: null } : parseValue(valueText);
  const spec = registry.keys.get(key);
  if (layer === undefined) {
    if (!parsed.ok) return refuse(action, [entryOf(registry, key, null, 'type', NOT_JSON)], json);
    const fault = validateValue(spec, parsed.value, registry.enumValues(key));
    if (fault) return refuse(action, [entryOf(registry, key, null, fault.code, fault.reason)], json);
    return done(json, { ok: true, errors: [] }, [`${key}: valid`]);
  }

  const where = layerFile(layer, env, root, fsImpl);
  if ('error' in where) return usageError('config', where.error, json);
  const { file } = where;

  if (action === 'unset') {
    const read = readLayerFile(file, { registry, fsImpl, includeDocument: true });
    if (read.status === 'invalid') return refuse(action, [entryOf(registry, key, layer, 'layer-invalid', `${file} ${read.reason}; fix or remove it first`)], json);
    if (read.status === 'absent' || !isObject(read.document) || !Object.hasOwn(read.document, key)) {
      return done(json, { ok: true, key, layer, file, changed: false, errors: [] }, [`${key} is not set  (${layer}: ${file})`]);
    }
    const removed = writeLayer({ file, unset: [key], fsImpl });
    if (!removed.ok) return refuse(action, [entryOf(registry, key, layer, 'write-failed', removed.detail)], json);
    clearSettingsCache();
    return done(json, { ok: true, key, layer, file, changed: true, errors: [] }, [`${key} unset  (${layer}: ${file})`]);
  }

  const fault = layerEntry(registry, key, layer, file, parsed, { env, projectRoot: root, fsImpl });
  if (fault) return refuse(action, [fault], json);
  if (action === 'validate') return done(json, { ok: true, errors: [] }, [`${key}: valid  (${layer}: ${file})`]);

  const written = writeLayer({ file, set: { [key]: parsed.value }, fsImpl });
  if (!written.ok) return refuse(action, [entryOf(registry, key, layer, 'write-failed', written.detail)], json);
  clearSettingsCache();
  const resolution = loadSettings({ projectRoot: root, env, fsImpl, registry }).get(key);
  const origin = { ...resolution.origin };
  const shown = JSON.stringify(resolution.value);
  const text = [`${key} = ${shown}  (${origin.layer}: ${origin.source})`];
  if (origin.source !== file) text.push(`written: ${layer}: ${file}`);
  return done(json, { ok: true, key, layer, file, value: resolution.value, origin, errors: [] }, text);
}

function handleConfigAction(options: any): number {
  const { action, fsImpl = nodeFs } = options;
  if (action === 'schema') return handleSchema({ ...options, fsImpl });
  return handleChange({ ...options, fsImpl });
}

module.exports = { handleConfigAction, buildSchema, keyEntry, layerFile, layerEntry, LAYERS };
