'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * The settings key registry and its load-time checks (086 IC-001, DD-1, DD-5, DD-6;
 * data-model §1). `core/registry/settings.json` declares every key DoFlow reads from a settings file:
 * type, values, default, which layer may set it, how layers combine, fail-safe and bindings. This
 * module loads it once per process and refuses a registry that breaks any rule below, naming the key.
 * A bad registry is an install fault: the loader fails, never falls back to a default.
 *
 * The checks that need no I/O live in `validateSettingsRegistry` (pure, takes the registry text
 * already parsed). `loadSettingsRegistry` adds the file read and, on request, the checks that reach
 * other files: `verifyRefs` resolves every `valuesRef`/`orderRef`/`tiersRef`/`defaultRef` against the
 * registry that owns it (refs.ts), `checkConsumers` confirms each `consumers` path exists. A key with
 * an `orderRef` carries its `order` on the loaded spec; `tiersRef` similarly supplies non-enumerable
 * `tiers` (IC-002). Both resolve on first read and return null when unavailable, as `enumValues` does.
 * Both verification options default to off so the hot path pays for one small file read; the
 * registry test and the settings guard turn them on.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { REF_META, createRefs } = require('./refs.ts');
const { jsonFailure, validateValue } = require('./files.ts');

const REGISTRY_FILE = 'core/registry/settings.json';

const KEY_RE = /^[a-z][a-z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;
const TYPES = ['boolean', 'enum', 'integer', 'model-id', 'string', 'string-list', 'url', 'worker-billing', 'worker-list', 'worker-models'];
const SCOPES = ['global-only', 'project-only', 'narrow-only', 'project-overridable'];
const COMBINES = ['override', 'narrowest', 'union', 'subset'];
const PARSES = ['positive-int', 'off-words', 'verbatim'];
const DIRECTIONS = ['any', 'narrow'];
const LEGACY_LAYERS = ['user', 'project'];
const LEGACY_KINDS = ['decision-model', 'line-onoff', 'sentinel'];
const VIEWS = ['project', 'global'];
const SHELL_READS = [null, 'lexical-v1'];
const TOP_FIELDS = ['version', 'description', 'keys'];
const SPEC_FIELDS = [
  'type', 'values', 'valuesRef', 'tiersRef', 'min', 'max', 'maxItems', 'maxLength', 'order', 'orderRef', 'default', 'defaultRef', 'scope', 'combine', 'views',
  'securityRelevant', 'failSafe', 'requires', 'env', 'flag', 'shellRead', 'needsConfigHome', 'legacy',
  'consumers', 'description',
];
const REQUIRED_FIELDS = [
  'type', 'scope', 'combine', 'securityRelevant', 'env', 'flag', 'shellRead', 'needsConfigHome',
  'legacy', 'consumers', 'description',
];
/** The two bindings that existed before the registry keep their names (DD-4). */
const EXISTING_ENV: Readonly<Record<string, string>> = Object.freeze({
  'storage.retentionHours': 'DOFLOW_RETENTION_HOURS',
  'failure.capture': 'DOFLOW_FAILURE_CAPTURE',
});

type Errors = string[];
interface RefsView {
  meta: Readonly<Record<string, { kind: string; dependsOn: string[] }>>;
  /** Present when refs are to be resolved against their source files. */
  resolve?: (name: string, deps?: Record<string, unknown>) => unknown;
}
interface ValidateOptions { consumerExists?: (relativePath: string) => boolean }

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function has(object: object, field: string): boolean {
  return Object.hasOwn(object, field);
}

/** `DOFLOW_<KEY_UPPER_SNAKE>`: dots become underscores and a camelCase hump gets one. */
function derivedEnvName(key: string): string {
  return `DOFLOW_${key.replace(/\./g, '_').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;
}

function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}

function relativeInside(p: unknown): boolean {
  return typeof p === 'string' && p.length > 0 && !path.isAbsolute(p) && !p.includes('\\') && !p.split('/').some((part) => part === '..' || part === '');
}

/**
 * Check a parsed registry. Every message starts with the key it is about (or `registry` for the
 * top level), so a failure names its cause. Never throws.
 */
function validateSettingsRegistry(raw: unknown, refs: RefsView = { meta: REF_META }, options: ValidateOptions = {}): { ok: boolean; errors: Errors } {
  const errors: Errors = [];
  if (!isObject(raw)) return { ok: false, errors: ['registry must be a JSON object'] };

  for (const field of Object.keys(raw)) {
    if (!TOP_FIELDS.includes(field)) errors.push(`registry has unknown field '${field}'`);
  }
  if (raw.version !== 1) errors.push('registry version must be 1');
  if (typeof raw.description !== 'string' || !raw.description.trim()) errors.push('registry description must be a non-empty string');
  if (!isObject(raw.keys) || Object.keys(raw.keys).length === 0) {
    errors.push('registry keys must be a non-empty object');
    return { ok: false, errors };
  }
  const specs: Record<string, any> = raw.keys;
  const names = Object.keys(specs);
  const refMeta = (name: unknown): { kind: string; dependsOn: string[] } | null =>
    typeof name === 'string' && has(refs.meta, name) ? refs.meta[name] : null;

  // Enum values and list membership: literal enum values, or the resolved ref when refs are resolved.
  const enumLists = new Map<string, string[] | null>();
  for (const name of names) {
    const spec = specs[name];
    if (!isObject(spec) || !['enum', 'string-list', 'worker-list', 'worker-models'].includes(spec.type)) continue;
    let list: string[] | null = null;
    if (spec.type === 'enum' && Array.isArray(spec.values) && spec.values.every((v: unknown) => typeof v === 'string')) list = spec.values;
    else if (typeof spec.valuesRef === 'string' && refs.resolve && refMeta(spec.valuesRef)?.kind === 'values') {
      try {
        const resolved = refs.resolve(spec.valuesRef);
        if (Array.isArray(resolved) && resolved.length > 0 && resolved.every((v) => typeof v === 'string')) list = resolved;
        else errors.push(`${name} valuesRef '${spec.valuesRef}' did not resolve to a non-empty list of strings`);
      } catch (error: any) {
        errors.push(`${name} valuesRef '${spec.valuesRef}' does not resolve: ${error.message}`);
      }
    }
    enumLists.set(name, list);
  }

  for (const name of names) validateKey(name, specs[name]);
  validateAcrossKeys();
  return { ok: errors.length === 0, errors };

  function validateKey(name: string, spec: any): void {
    const err = (message: string): void => { errors.push(`${name} ${message}`); };
    if (!KEY_RE.test(name)) err('is not a valid key name (lowercase namespace, a dot, then a camelCase name)');
    if (!isObject(spec)) { err('must be an object'); return; }
    for (const field of Object.keys(spec)) if (!SPEC_FIELDS.includes(field)) err(`has unknown field '${field}'`);
    for (const field of REQUIRED_FIELDS) if (!has(spec, field)) err(`is missing '${field}'`);
    if (!TYPES.includes(spec.type)) { err(`type must be one of ${TYPES.join(', ')}`); return; }

    const type: string = spec.type;
    const list = enumLists.get(name) ?? null;
    /** A fault text for a value of this key, or null. A list-bound key whose list is unresolved checks only the rest. */
    const faultOf = (value: unknown): string | null => {
      if (type === 'enum' && list === null) return typeof value === 'string' ? null : 'must be a string';
      if (type === 'string-list' && list === null) return validateValue({ ...spec, valuesRef: undefined }, value)?.reason ?? null;
      return validateValue(spec, value, list)?.reason ?? null;
    };

    // values / valuesRef / min
    if (type === 'enum') {
      const hasValues = has(spec, 'values');
      const hasRef = has(spec, 'valuesRef');
      if (hasValues === hasRef) err("enum needs exactly one of 'values' or 'valuesRef'");
      if (hasValues && !(Array.isArray(spec.values) && spec.values.length > 0
          && spec.values.every((v: unknown) => typeof v === 'string' && v) && new Set(spec.values).size === spec.values.length)) {
        err("values must be a non-empty list of distinct non-empty strings");
      }
      if (hasRef && refMeta(spec.valuesRef)?.kind !== 'values') err(`valuesRef '${String(spec.valuesRef)}' is not a known values ref`);
    } else if (type === 'string-list' || type === 'worker-list' || type === 'worker-models') {
      if (has(spec, 'values')) err(`'values' is not allowed for a ${type} key (use 'valuesRef')`);
      if (has(spec, 'valuesRef') && refMeta(spec.valuesRef)?.kind !== 'values') err(`valuesRef '${String(spec.valuesRef)}' is not a known values ref`);
    } else {
      if (has(spec, 'values')) err("'values' is only for enum keys");
      if (has(spec, 'valuesRef')) err("'valuesRef' is only for enum, string-list, worker-list and worker-models keys");
    }
    // IC-002: worker model tiers are declared by a values ref, never copied into the setting.
    if (type === 'worker-models') {
      if (!has(spec, 'tiersRef')) err("a worker-models key needs 'tiersRef'");
      else if (refMeta(spec.tiersRef)?.kind !== 'values') err(`tiersRef '${String(spec.tiersRef)}' is not a known values ref`);
      else if (refs.resolve) {
        try {
          const tiers = refs.resolve(spec.tiersRef);
          if (!Array.isArray(tiers) || tiers.length === 0 || tiers.some((tier: unknown) => typeof tier !== 'string')
              || new Set(tiers).size !== tiers.length) {
            err(`tiersRef '${spec.tiersRef}' did not resolve to a non-empty list of strings`);
          }
        } catch (error: any) {
          err(`tiersRef '${spec.tiersRef}' does not resolve: ${error.message}`);
        }
      }
    } else if (has(spec, 'tiersRef')) err("'tiersRef' is only for worker-models keys");
    if (has(spec, 'min')) {
      if (type !== 'integer') err("'min' is only for integer keys");
      else if (!Number.isSafeInteger(spec.min)) err('min must be an integer');
    }
    if (has(spec, 'max')) {
      if (type !== 'integer') err("'max' is only for integer keys");
      else if (!Number.isSafeInteger(spec.max)) err('max must be an integer');
      else if (Number.isSafeInteger(spec.min) && spec.max < spec.min) err('max must not be below min');
    }
    for (const bound of ['maxItems', 'maxLength']) {
      if (type !== 'string-list') { if (has(spec, bound)) err(`'${bound}' is only for string-list keys`); }
      else if (!has(spec, bound) || !Number.isSafeInteger(spec[bound]) || spec[bound] < 1) err(`${bound} must be a positive integer`);
    }

    // scope / combine / order
    if (!SCOPES.includes(spec.scope)) err(`scope must be one of ${SCOPES.join(', ')}`);
    if (!COMBINES.includes(spec.combine)) err(`combine must be one of ${COMBINES.join(', ')}`);
    const free = type === 'string' || type === 'url' || type === 'model-id';
    // IC-002: keyed worker records have no order; only an override is defined.
    const record = type === 'worker-billing';
    const models = type === 'worker-models';
    const keyed = record || models;
    // string-list is a set of items: no order ranks two lists, only a union is defined.
    const multi = type === 'string-list';
    // IC-002: worker lists narrow by membership, preserving the order below.
    const workerList = type === 'worker-list';
    if (spec.scope === 'narrow-only' && (free || keyed || multi)) err(`a ${type} key cannot be narrow-only: no order says which value is narrower`);
    if (keyed && spec.combine !== 'override') err(`a ${type} key must combine by 'override'`);
    if (multi !== (spec.combine === 'union')) err(multi ? "a string-list key must combine by 'union'" : "combine 'union' is only for string-list keys");
    if (workerList !== (spec.combine === 'subset')) err(workerList ? "a worker-list key must combine by 'subset'" : "combine 'subset' is only for worker-list keys");
    const needsOrder = (spec.scope === 'narrow-only' && spec.combine !== 'subset') || spec.combine === 'narrowest';
    const ordered = has(spec, 'order') || has(spec, 'orderRef');
    if (has(spec, 'orderRef')) {
      if (has(spec, 'order')) err("needs at most one of 'order' or 'orderRef'");
      if (type !== 'enum' || !has(spec, 'valuesRef')) err("'orderRef' is only for enum keys with a 'valuesRef'");
      else if (refMeta(spec.orderRef)?.kind !== 'order') err(`orderRef '${String(spec.orderRef)}' is not a known order ref`);
      else if (refs.resolve) {
        try {
          const order = refs.resolve(spec.orderRef);
          if (!Array.isArray(order) || new Set(order).size !== order.length || (list && !sameList(order, list))) {
            err(`orderRef '${spec.orderRef}' must resolve to every allowed value exactly once`);
          }
        } catch (error: any) {
          err(`orderRef '${spec.orderRef}' does not resolve: ${error.message}`);
        }
      }
    } else if (has(spec, 'order')) {
      const order = spec.order;
      if (free || keyed || multi || workerList) err(`order is refused for a ${type} key`);
      else if (order === 'ascending' || order === 'descending') {
        if (type !== 'integer') err("'ascending'/'descending' order is only for integer keys");
      } else if (!Array.isArray(order) || order.length === 0 || new Set(order).size !== order.length) {
        err("order must be 'ascending', 'descending' or a non-empty list of distinct values, narrowest first");
      } else {
        const bad = order.find((value: unknown) => faultOf(value) !== null);
        if (bad !== undefined) err('order holds a value that is not valid for this key');
        else if (type === 'boolean' && !sameList(order, [false, true])) err('order must list both false and true');
        else if (type === 'enum' && list && !sameList(order, list)) err('order must list every allowed value exactly once');
      }
    }
    if (needsOrder && !ordered) {
      err(spec.scope === 'narrow-only' ? "scope 'narrow-only' requires an 'order'" : "combine 'narrowest' requires an 'order'");
    }

    // default / defaultRef
    const hasDefault = has(spec, 'default');
    const hasDefaultRef = has(spec, 'defaultRef');
    if (hasDefault === hasDefaultRef) err("needs exactly one of 'default' or 'defaultRef'");
    if (keyed && (!hasDefault || spec.default !== null)) err(`a ${type} key must default to null`);
    if (hasDefault && !(spec.default === null && (free || keyed || type === 'integer'))) {
      const fault = faultOf(spec.default);
      if (fault) err(`default is not valid: ${fault}`);
    }
    if (hasDefaultRef && refMeta(spec.defaultRef)?.kind !== 'default') err(`defaultRef '${String(spec.defaultRef)}' is not a known default ref`);

    // views
    if (has(spec, 'views') && !(Array.isArray(spec.views) && (sameList(spec.views, ['project']) || (spec.views.length === 2 && spec.views[0] === 'project' && spec.views[1] === 'global')))) {
      err("views must be ['project'] or ['project', 'global']");
    }

    // securityRelevant / failSafe
    if (has(spec, 'securityRelevant') && typeof spec.securityRelevant !== 'boolean') err('securityRelevant must be true or false');
    if (has(spec, 'failSafe')) {
      const safe = spec.failSafe;
      if (isObject(safe)) {
        const fields = Object.keys(safe);
        if (!(fields.length === 1 && ((fields[0] === 'gate' && typeof safe.gate === 'string') || (fields[0] === 'state' && safe.state === 'invalid')))) {
          err("failSafe object must be {gate: <key>} or {state: 'invalid'}");
        }
      } else {
        const fault = Array.isArray(safe) || safe === null ? 'must be a value' : faultOf(safe);
        if (fault) err(`failSafe is not valid: ${fault}`);
      }
    }
    if (keyed && !(isObject(spec.failSafe) && sameList(Object.keys(spec.failSafe), ['state']) && spec.failSafe.state === 'invalid')) {
      err(`a ${type} key needs failSafe {state: 'invalid'}`);
    }
    if (spec.securityRelevant === true) {
      const safe = spec.failSafe;
      // Records and worker lists use the consumer's invalid path as their fail-safe (IC-003).
      // A project-only key's candidates never widen (resolve.ts canWiden), so no fail-safe value is ever
      // taken; the consumer's invalid path voids it (worker/launch.ts dropDatabases), so the state form is allowed.
      const stateSafe = (keyed || workerList || spec.scope === 'project-only') && isObject(safe) && safe.state === 'invalid';
      if (!stateSafe && (!has(spec, 'failSafe') || (isObject(safe) && !has(safe, 'gate')))) err('is securityRelevant and needs a failSafe value or {gate}');
    }

    // A cross-key rule (resolve.ts requires) or a missing config home takes `value = spec.failSafe`; the state form
    // is not a value, so it would resolve to the object {state: 'invalid'} with state ok (119 closure N-3).
    // IC-003: billing retains its exemption; worker-models exempts only needsConfigHome, not requires.
    if (!record && isObject(spec.failSafe) && spec.failSafe.state === 'invalid'
      && ((Array.isArray(spec.requires) && spec.requires.length > 0) || (!models && spec.needsConfigHome === true))) {
      err("failSafe {state: 'invalid'} cannot be combined with 'requires' or 'needsConfigHome' (they resolve to the failSafe as a value)");
    }

    // requires
    if (has(spec, 'requires')) {
      if (!Array.isArray(spec.requires)) err('requires must be a list');
      else spec.requires.forEach((rule: any, index: number) => {
        const where = `requires[${index}]`;
        if (!isObject(rule) || !sameList(Object.keys(rule), ['when', 'key', 'view'])) { err(`${where} must be {when, key, view}`); return; }
        const fault = faultOf(rule.when);
        if (fault) err(`${where}.when is not valid: ${fault}`);
        if (typeof rule.key !== 'string') err(`${where}.key must be a key name`);
        if (!VIEWS.includes(rule.view)) err(`${where}.view must be one of ${VIEWS.join(', ')}`);
      });
    }

    // env / flag / shellRead / needsConfigHome
    if (spec.scope === 'project-only' && spec.env !== null) err('project-only: env must be null');
    if (has(spec, 'env') && spec.env !== null) {
      const env = spec.env;
      if (!isObject(env) || !sameList(Object.keys(env), ['name', 'parse', 'direction'])) err('env must be null or {name, parse, direction}');
      else {
        if (typeof env.name !== 'string' || !/^DOFLOW_[A-Z0-9_]+$/.test(env.name)) err('env.name must match DOFLOW_[A-Z0-9_]+');
        else if (env.name !== derivedEnvName(name) && EXISTING_ENV[name] !== env.name) err(`env.name must be ${derivedEnvName(name)}`);
        if (!PARSES.includes(env.parse)) err(`env.parse must be one of ${PARSES.join(', ')}`);
        else if (env.parse === 'positive-int' && type !== 'integer') err('env.parse positive-int needs an integer key');
        else if (env.parse === 'off-words' && !(type === 'enum' && list?.includes('off'))) err("env.parse off-words needs an enum key with the value 'off'");
        else if (env.parse === 'verbatim' && !(['enum', 'string', 'model-id'].includes(type) && env.direction === 'any')) err("env.parse verbatim needs an enum, string or model-id key with direction 'any'");
        if (!DIRECTIONS.includes(env.direction)) err(`env.direction must be one of ${DIRECTIONS.join(', ')}`);
        else if (env.direction === 'any' && (spec.securityRelevant === true || spec.scope === 'global-only')) {
          err("env.direction must be 'narrow': an environment variable may only narrow a security-relevant or global-only key");
        } else if (env.direction === 'narrow' && !ordered) err("env.direction 'narrow' needs an 'order'");
      }
    }
    if (has(spec, 'flag') && spec.flag !== null) err("flag must be null in v1 (a declared flag must be absent from the CLI flag tables; '--set' and '--setting' are reserved)");
    if (has(spec, 'shellRead') && !SHELL_READS.includes(spec.shellRead)) err("shellRead must be null or 'lexical-v1'");
    if (spec.shellRead === 'lexical-v1' && name !== 'failure.capture') err("shellRead 'lexical-v1' is only allowed for 'failure.capture'");
    if (has(spec, 'needsConfigHome') && typeof spec.needsConfigHome !== 'boolean') err('needsConfigHome must be true or false');

    // legacy
    if (!Array.isArray(spec.legacy)) err('legacy must be a list');
    else spec.legacy.forEach((entry: any, index: number) => {
      const where = `legacy[${index}]`;
      if (!isObject(entry)) { err(`${where} must be an object`); return; }
      for (const field of Object.keys(entry)) if (!['layer', 'kind', 'path', 'field', 'value'].includes(field)) err(`${where} has unknown field '${field}'`);
      if (!LEGACY_LAYERS.includes(entry.layer)) err(`${where}.layer must be one of ${LEGACY_LAYERS.join(', ')}`);
      if (!LEGACY_KINDS.includes(entry.kind)) err(`${where}.kind must be one of ${LEGACY_KINDS.join(', ')}`);
      if (!relativeInside(entry.path)) err(`${where}.path must be a relative path inside its root (no '..')`);
      if ((entry.kind === 'decision-model') !== (typeof entry.field === 'string' && entry.field !== '')) err(`${where}.field is required for, and only for, decision-model`);
      if ((entry.kind === 'sentinel') !== has(entry, 'value')) err(`${where}.value is required for, and only for, sentinel`);
    });

    // consumers / description
    if (!Array.isArray(spec.consumers) || spec.consumers.length === 0) err('consumers must be a non-empty list of paths');
    else for (const consumer of spec.consumers) {
      if (!relativeInside(consumer)) err(`consumers entry is not a relative path inside the tree`);
      else if (options.consumerExists && !options.consumerExists(consumer)) err(`consumer '${consumer}' does not exist`);
    }
    if (typeof spec.description !== 'string' || !spec.description.trim() || /[\r\n]/.test(spec.description)) err('description must be one non-empty line');
  }

  function validateAcrossKeys(): void {
    const envOwner = new Map<string, string>();
    for (const name of names) {
      const spec = specs[name];
      if (!isObject(spec)) continue;
      const err = (message: string): void => { errors.push(`${name} ${message}`); };

      const failSafe = spec.failSafe;
      if (isObject(failSafe) && typeof failSafe.gate === 'string') {
        const target = isObject(specs[failSafe.gate]) ? specs[failSafe.gate] : null;
        if (failSafe.gate === name) err('failSafe gate names the key itself');
        else if (!target) err(`failSafe gate '${failSafe.gate}' is not a registered key`);
        else if (!has(target, 'failSafe') || isObject(target.failSafe) || Array.isArray(target.failSafe)) {
          err(`failSafe gate '${failSafe.gate}' needs a plain failSafe value of its own`);
        }
      }
      if (Array.isArray(spec.requires)) {
        for (const rule of spec.requires) {
          if (isObject(rule) && typeof rule.key === 'string' && !has(specs, rule.key)) err(`requires names '${rule.key}', which is not a registered key`);
        }
      }
      if (isObject(spec.env) && typeof spec.env.name === 'string') {
        const owner = envOwner.get(spec.env.name);
        if (owner) err(`env.name ${spec.env.name} is already bound by ${owner}`);
        else envOwner.set(spec.env.name, name);
      }
    }

    // A default that points at a ref depending on another key's default must not loop back.
    const stateOf = new Map<string, 'visiting' | 'done'>();
    let cyclic = false;
    const visit = (name: string, trail: string[]): void => {
      const state = stateOf.get(name);
      if (state === 'done') return;
      if (state === 'visiting') {
        cyclic = true;
        errors.push(`${name} defaultRef forms a cycle: ${[...trail.slice(trail.indexOf(name)), name].join(' -> ')}`);
        return;
      }
      const spec = specs[name];
      stateOf.set(name, 'visiting');
      const meta = isObject(spec) ? refMeta(spec.defaultRef) : null;
      for (const dep of meta?.dependsOn ?? []) {
        if (!has(specs, dep)) errors.push(`${name} defaultRef '${spec.defaultRef}' depends on '${dep}', which is not a registered key`);
        else visit(dep, [...trail, name]);
      }
      stateOf.set(name, 'done');
    };
    for (const name of names) visit(name, []);

    // Resolve every defaultRef and hold the value to the key's own rules.
    if (!refs.resolve || cyclic) return;
    const memo = new Map<string, unknown>();
    const defaultOf = (name: string): unknown => {
      if (memo.has(name)) return memo.get(name);
      const spec = specs[name];
      let value: unknown;
      if (!isObject(spec)) value = undefined;
      else if (has(spec, 'default')) value = spec.default;
      else if (refMeta(spec.defaultRef)?.kind === 'default') {
        const deps: Record<string, unknown> = {};
        for (const dep of refMeta(spec.defaultRef)!.dependsOn) deps[dep] = has(specs, dep) ? defaultOf(dep) : undefined;
        value = refs.resolve!(spec.defaultRef, deps);
      }
      memo.set(name, value);
      return value;
    };
    for (const name of names) {
      const spec = specs[name];
      if (!isObject(spec) || !has(spec, 'defaultRef') || refMeta(spec.defaultRef)?.kind !== 'default' || !TYPES.includes(spec.type)) continue;
      try {
        const fault = validateValue(spec, defaultOf(name), enumLists.get(name) ?? null);
        if (fault) errors.push(`${name} defaultRef '${spec.defaultRef}' resolves to an invalid value: ${fault.reason}`);
      } catch (error: any) {
        errors.push(`${name} defaultRef '${spec.defaultRef}' does not resolve: ${error.message}`);
      }
    }
  }
}

interface SettingsRegistry {
  version: 1;
  keys: Map<string, any>;
  /** The allowed values of an enum key, or of a string-list key with a valuesRef (its list or its resolved ref); null when unavailable or not list-bound. */
  enumValues(key: string): string[] | null;
  /** The value of a named ref, lazily read from advice.json or storage.json. Throws when unreadable. */
  resolveRef(name: string, deps?: Record<string, unknown>): unknown;
}
type LoadResult = { ok: true; registry: SettingsRegistry } | { ok: false; reason: 'settings-registry-invalid'; detail: string; errors: string[] };

interface LoadOptions { repoRoot?: string; fsImpl?: any; verifyRefs?: boolean; checkConsumers?: boolean }

const cache = new Map<string, LoadResult>();

function failure(errors: string[]): LoadResult {
  return { ok: false, reason: 'settings-registry-invalid', detail: errors.join('; '), errors };
}

/**
 * Load `core/registry/settings.json`. Cached per process for the default file system; a caller that
 * passes `fsImpl` always reads fresh. The result is plain data and never carries file text.
 */
function loadSettingsRegistry({ repoRoot = REPO_ROOT, fsImpl, verifyRefs = false, checkConsumers = false }: LoadOptions = {}): LoadResult {
  const cacheKey = fsImpl ? null : `${repoRoot}\0${verifyRefs}\0${checkConsumers}`;
  if (cacheKey && cache.has(cacheKey)) return cache.get(cacheKey)!;
  const fsUse = fsImpl || nodeFs;

  const done = (result: LoadResult): LoadResult => { if (cacheKey) cache.set(cacheKey, result); return result; };

  let text: string;
  try { text = fsUse.readFileSync(path.join(repoRoot, REGISTRY_FILE), 'utf8'); }
  catch { return done(failure([`${REGISTRY_FILE} could not be read`])); }
  let raw: any;
  try { raw = JSON.parse(text); }
  catch (error: any) { return done(failure([`${REGISTRY_FILE} is ${jsonFailure(error, text).reason}`])); }

  const refs = createRefs({ repoRoot, fsImpl: fsUse });
  const checked = validateSettingsRegistry(
    raw,
    { meta: REF_META, resolve: verifyRefs ? refs.resolve : undefined },
    { consumerExists: checkConsumers ? (p: string) => fsUse.existsSync(path.join(repoRoot, p)) : undefined },
  );
  if (!checked.ok) return done(failure(checked.errors));

  const keys = new Map<string, any>(Object.entries(raw.keys).map(([name, spec]: [string, any]) => {
    if (typeof spec.orderRef === 'string') {
      let order: string[] | null | undefined;
      Object.defineProperty(spec, 'order', {
        enumerable: true,
        get() {
          if (order === undefined) {
            try { order = refs.resolve(spec.orderRef) as string[]; } catch { order = null; }
          }
          return order;
        },
      });
    }
    // IC-002: resolve tiers lazily without adding a serialized field to the declared spec.
    if (typeof spec.tiersRef === 'string') {
      let tiers: string[] | null | undefined;
      Object.defineProperty(spec, 'tiers', {
        enumerable: false,
        get() {
          if (tiers === undefined) {
            try { tiers = refs.resolve(spec.tiersRef) as string[]; } catch { tiers = null; }
          }
          return tiers;
        },
      });
    }
    return [name, Object.freeze(spec)];
  }));
  const lists = new Map<string, string[] | null>();
  const registry: SettingsRegistry = {
    version: 1,
    keys,
    enumValues(key) {
      if (lists.has(key)) return lists.get(key)!;
      const spec = keys.get(key);
      let list: string[] | null = null;
      if (spec?.type === 'enum' || (['string-list', 'worker-list', 'worker-models'].includes(spec?.type) && spec.valuesRef)) {
        if (Array.isArray(spec.values)) list = spec.values;
        else {
          try { list = refs.resolve(spec.valuesRef) as string[]; } catch { list = null; }
        }
        // A value with no rank is never valid: a narrow-only fold could not compare it.
        if (typeof spec.orderRef === 'string' && spec.order === null) list = null;
      }
      lists.set(key, list);
      return list;
    },
    resolveRef: (name, deps) => refs.resolve(name, deps),
  };
  return done({ ok: true, registry });
}

module.exports = { REGISTRY_FILE, derivedEnvName, validateSettingsRegistry, loadSettingsRegistry };
