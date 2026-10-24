'use strict';

// A.3 (IC-005 and IC-007): read-only resolution of the main session's declared and observed model.

const fs = require('node:fs');
const path = require('node:path');
const { cwdHash, stateDir } = require('./identity.ts');
const { loadSettings } = require('../settings/resolve.ts');
const { validateValue } = require('../settings/files.ts');
const { loadRegistry } = require('../../registry/index.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

type Env = Record<string, string | undefined>;

interface Observation {
  model: string;
  event: string;
  observedAt: string;
  sessions: number;
}

interface ReadObservationsOptions {
  root: string | null;
  projectRoot: string;
  harness: string;
  now: number;
  maxAgeMs?: number | null;
}

function isObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameModel(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** IC-005: read valid main-session model observations for one project and harness. */
function readObservations({ root, projectRoot, harness, now, maxAgeMs = null }: ReadObservationsOptions): any[] {
  if (!root) return [];
  const dir = path.join(root, 'primary', cwdHash(projectRoot), harness);
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return []; }
  const observations: any[] = [];

  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      if (!fs.lstatSync(file).isFile()) continue;
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!isObject(value)) continue;
      const keys = Object.keys(value).sort();
      if (keys.join(',') !== 'event,harness,model,observedAt,schema,session') continue;
      if (value.schema !== 1 || value.harness !== harness) continue;
      if (typeof value.model !== 'string' || validateValue({ type: 'model-id' }, value.model)) continue;
      if (typeof value.event !== 'string' || value.event.length === 0) continue;
      if (typeof value.observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value.observedAt)) continue;
      const observedAt = Date.parse(value.observedAt);
      if (!Number.isFinite(observedAt) || observedAt > now) continue;
      if (typeof value.session !== 'string' || !/^[0-9a-f]{16}$/.test(value.session)) continue;
      if (maxAgeMs !== null && now - observedAt > maxAgeMs) continue;
      observations.push({ model: value.model, event: value.event, observedAt: value.observedAt, session: value.session, time: observedAt });
    } catch {
      // Malformed, unreadable, and non-file entries do not count as observations.
    }
  }
  return observations;
}

/** IC-007: resolve the primary harness and model using settings and read-only hook observations. */
function resolvePrimary({
  env,
  projectRoot = process.cwd(),
  registry,
  models,
  storage,
  now = Date.now,
  observationsRoot,
}: {
  env?: Env;
  projectRoot?: string;
  registry?: any;
  models?: any;
  storage?: any;
  now?: () => number;
  observationsRoot?: string | null;
} = {}): any {
  const runtimeEnv = env ?? {};
  const role = (runtimeEnv.DOFLOW_SESSION_ROLE || '').replace(/[A-Z]/g, (c) => c.toLowerCase());
  const nullDeclared = { harness: null, model: null, origin: { harness: null, model: null } };
  const result = (state: string, fields: any = {}) => ({
    state,
    harness: null,
    model: null,
    family: 'unknown',
    declared: null,
    observed: null,
    probe: 'none',
    warnings: [],
    reason: null,
    ...fields,
  });

  if (role !== '' && role !== 'main') return result('not-primary', { reason: 'worker-role' });

  const settings = loadSettings({ projectRoot, env: runtimeEnv });
  const harnessSetting = settings.get('primary.harness');
  const modelSetting = settings.get('primary.model');
  const contradictionSetting = settings.get('primary.onContradiction');
  const harness = harnessSetting.value;
  const declaredModel = modelSetting.value;
  const declared = harness === 'unknown' ? null : {
    harness,
    model: declaredModel,
    origin: { harness: harnessSetting.origin.layer, model: declaredModel === null ? null : modelSetting.origin.layer },
  };
  const warnings: string[] = [];
  if (harness === 'unknown') {
    if (declaredModel !== null) warnings.push('primary-model-without-harness');
    return result('unknown', { declared: null, warnings });
  }

  const { REPO_ROOT: repoRoot } = require('../../helper/repo-root.ts');
  const registryValue = registry ?? loadRegistry({ repoRoot });
  const harnessEntry = (registryValue.harnesses || []).find((entry: any) => entry?.id === harness);
  const probe = harnessEntry?.primaryProbe?.model === 'payload' ? 'payload' : 'none';
  if (probe === 'none') return result('declared-only', { harness, model: declaredModel, declared, probe, warnings });

  let loadedModels = models;
  if (!loadedModels) loadedModels = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core/registry/models.json'), 'utf8'));
  let loadedStorage = storage;
  if (!loadedStorage) loadedStorage = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core/registry/storage.json'), 'utf8'));
  const store = (loadedStorage.stores || []).find((entry: any) => entry?.id === 'model-observations');
  const maxAgeDays = store?.bound?.maxAgeDays;
  const maxAgeMs = Number.isFinite(maxAgeDays) ? maxAgeDays * 24 * 60 * 60 * 1000 : null;
  const root = observationsRoot === undefined ? stateDir(runtimeEnv) : observationsRoot;
  const observations = readObservations({ root, projectRoot, harness, now: now(), maxAgeMs });
  if (observations.length === 0) {
    return result('unconfirmed', { harness, model: declaredModel, declared, probe, warnings, reason: 'no-observation' });
  }

  const groups = new Map<string, any[]>();
  for (const observation of observations) {
    const key = observation.model.trim().toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(observation);
  }
  if (groups.size > 1) {
    return result('unconfirmed', { harness, model: declaredModel, declared, probe, warnings, reason: 'ambiguous-sessions' });
  }

  const group = [...groups.values()][0];
  group.sort((a, b) => b.time - a.time);
  const newest = group[0];
  const observed: Observation = {
    model: newest.model,
    event: newest.event,
    observedAt: newest.observedAt,
    sessions: group.length,
  };
  const observedRecord = { ...observed, session: newest.session };
  if (declaredModel === null || sameModel(declaredModel, newest.model)) {
    const provider = (loadedModels.providers || []).find((entry: any) => entry?.id === harness);
    const families = Array.isArray(provider?.families) ? provider.families.filter((family: any) => family !== 'unknown') : [];
    const family = families.length === 1 && provider.families.length === 1 ? families[0] : 'unknown';
    return result('confirmed', { harness, model: newest.model, family, declared, observed: observedRecord, probe, warnings });
  }

  warnings.push(`primary-contradicted: declared ${declaredModel}, observed ${newest.model}`);
  const refused = contradictionSetting.value === 'refuse';
  return result(refused ? 'refused' : 'contradicted', {
    harness,
    model: newest.model,
    declared,
    observed: observedRecord,
    probe,
    warnings,
    reason: refused ? 'primary-contradicted' : null,
  });
}

module.exports = { readObservations, resolvePrimary };
