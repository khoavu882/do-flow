'use strict';

// A.3 (IC-005 and IC-007): read-only resolution of the main session's declared and observed model.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cwdHash, stateDir, ID_PATTERN, ATTEMPT_PATTERN } = require('./identity.ts');
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

/** IC-005: the common observation shape, without a reader's lifetime policy. */
function parseObservation(value: any, harness: string): { model: string; event: string; observedAt: string; session: string } | null {
  if (!isObject(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'event,harness,model,observedAt,schema,session') return null;
  if (value.schema !== 1 || value.harness !== harness) return null;
  if (typeof value.model !== 'string' || validateValue({ type: 'model-id' }, value.model)) return null;
  if (typeof value.event !== 'string' || value.event.length === 0) return null;
  if (typeof value.observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value.observedAt)) return null;
  if (!Number.isFinite(Date.parse(value.observedAt))) return null;
  if (typeof value.session !== 'string' || !/^[0-9a-f]{16}$/.test(value.session)) return null;
  return { model: value.model, event: value.event, observedAt: value.observedAt, session: value.session };
}

/** IC-005: read valid main-session model observations for one project and harness. A file that
 * cannot be read or parsed adds one to `counts.unreadable` when `counts` is given. */
function readObservations({ root, projectRoot, harness, now, maxAgeMs = null, counts }: ReadObservationsOptions & { counts?: { unreadable: number } }): any[] {
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
      const value = parseObservation(JSON.parse(fs.readFileSync(file, 'utf8')), harness);
      if (!value) { if (counts) counts.unreadable += 1; continue; }
      const observedAt = Date.parse(value.observedAt);
      if (observedAt > now) continue;
      if (maxAgeMs !== null && now - observedAt > maxAgeMs) continue;
      observations.push({ ...value, time: observedAt });
    } catch {
      // Malformed, unreadable, and non-file entries do not count as observations.
      if (counts) counts.unreadable += 1;
    }
  }
  return observations;
}

/** The `model-observations` store's age bound in milliseconds, or null when it declares none. */
function observationMaxAgeMs(storage: any): number | null {
  const store = (storage.stores || []).find((entry: any) => entry?.id === 'model-observations');
  const maxAgeDays = store?.bound?.maxAgeDays;
  return Number.isFinite(maxAgeDays) ? maxAgeDays * 24 * 60 * 60 * 1000 : null;
}

/** IC-013 / IC-005: read one worker's observation; the storage store owns its lifetime. */
function readWorkerObservation({ root, identity, harness, fsImpl = fs }: any): { model: string; event: string; observedAt: string; session: string } | null {
  try {
    if (typeof root !== 'string' || !isObject(identity)) return null;
    if (typeof identity.run !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,55}$/.test(identity.run)) return null;
    if (typeof identity.lineage !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,55}$/.test(identity.lineage)) return null;
    if (typeof identity.attempt !== 'string' || !/^[1-9][0-9]{0,3}$/.test(identity.attempt)) return null;
    const file = path.join(root, 'worker-model', `L.${identity.run}.${identity.lineage}.${identity.attempt}.json`);
    if (!fsImpl.lstatSync(file).isFile()) return null;
    return parseObservation(JSON.parse(fsImpl.readFileSync(file, 'utf8')), harness);
  } catch {
    return null;
  }
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
  const maxAgeMs = observationMaxAgeMs(loadedStorage);
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

const SESSION_DIR_LIMIT = 2000;
const SESSION_DIR = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/; // the session-dirs store's match
const HARNESS_DIR = /^[a-z0-9][a-z0-9-]*$/; // observe-model.sh's harness check

const keyOf = (id: string): string => crypto.createHash('sha256').update(id).digest('hex').slice(0, 16);
const isoOrNull = (value: unknown): string | null => (typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null);

/** `L.<run>.<lineage>.<attempt>` (identity.ts), split; null for any other name. */
function launchedUnit(name: string): { run: string; lineage: string; attempt: string } | null {
  const parts = name.split('.');
  if (parts.length !== 4 || parts[0] !== 'L') return null;
  const [, run, lineage, attempt] = parts;
  return ID_PATTERN.test(run) && ID_PATTERN.test(lineage) && ATTEMPT_PATTERN.test(attempt) ? { run, lineage, attempt } : null;
}

/** One checkout's HEAD commit time as UTC ISO, from `git log -1 --format=%cI HEAD`; null when git cannot say. */
function headCommittedAt(top: string, exec: any, env: Env): string | null {
  try {
    const res = exec('git', ['-C', top, 'log', '-1', '--format=%cI', 'HEAD'], { encoding: 'utf8', timeout: 10000, env: { ...env, GIT_OPTIONAL_LOCKS: '0' } });
    if (!res || res.error || res.status !== 0) return null;
    const at = Date.parse(String(res.stdout || '').trim());
    return Number.isFinite(at) ? new Date(at).toISOString() : null;
  } catch {
    return null;
  }
}

/**
 * IC-018 a: the project's checkouts and the hook records of the sessions that worked in them.
 * Checkouts come from `listCheckouts` (sandboxes left out); records are the main-session model
 * observations at each checkout top and the `sessions/<id>/git-context.json` files whose `cwd` lies
 * in a checkout (longest prefix; at most SESSION_DIR_LIMIT directories, newest first by mtime). An
 * observation and a session directory with the same session key are one entry. No path, pid or raw
 * session id is returned, and nothing is written: no lock, no mkdir, no upkeep.
 * @returns {{ok: false, error: 'cannot-list-checkouts'} | {ok: true, body: Object}}
 */
function observedSessions({
  env = process.env, cwd = process.cwd(), exec = spawnSync, fsImpl = fs, now = Date.now, storage,
}: { env?: Env; cwd?: string; exec?: any; fsImpl?: any; now?: () => number; storage?: any } = {}): any {
  // Required here, not at the top: `resolve` (and status, doctor) never lists checkouts.
  const { listCheckouts, checkoutContaining } = require('../checkouts.ts');
  const listed = listCheckouts({ cwd, exec, fsImpl });
  if (!listed.ok && listed.reason !== 'not-a-git-repository') return { ok: false, error: 'cannot-list-checkouts' };
  const entries: any[] = listed.ok ? listed.entries : [];
  const checkouts = entries.filter((e) => !e.sandbox).map((e) => ({
    worktreeKey: cwdHash(e.path),
    role: e.path === listed.main ? 'main' : 'linked',
    current: e.path === listed.current,
    branch: e.branch,
    head: e.head === null ? null : e.head.slice(0, 12),
    headCommittedAt: e.head === null ? null : headCommittedAt(e.path, exec, env),
  }));
  const root = stateDir(env);
  const body: any = { v: 1, store: root === null ? 'absent' : 'present', checkouts, sessions: [], truncated: false, unreadable: 0 };
  if (root === null) return { ok: true, body };

  const counts = { unreadable: 0 };
  const sessions = new Map<string, any>();
  const entry = (sessionKey: string, worktreeKey: string) => {
    if (!sessions.has(sessionKey)) {
      sessions.set(sessionKey, {
        sessionKey, worktreeKey, kind: 'hook', harness: null, model: null, modelFirstSeenAt: null,
        startedAt: null, branchAtStart: null, lastHookRecordAt: null, launched: null,
      });
    }
    return sessions.get(sessionKey);
  };

  const loadedStorage = storage ?? JSON.parse(fsImpl.readFileSync(path.join(REPO_ROOT, 'core/registry/storage.json'), 'utf8'));
  const maxAgeMs = observationMaxAgeMs(loadedStorage);
  const nowMs = now();
  for (const top of entries.filter((e) => !e.sandbox).map((e) => e.path)) {
    const worktreeKey = cwdHash(top);
    let harnesses: any[];
    try { harnesses = fsImpl.readdirSync(path.join(root, 'primary', worktreeKey), { withFileTypes: true }); } catch { continue; }
    for (const dirent of harnesses) {
      if (!dirent.isDirectory() || !HARNESS_DIR.test(dirent.name)) continue;
      for (const o of readObservations({ root, projectRoot: top, harness: dirent.name, now: nowMs, maxAgeMs, counts })) {
        const e = entry(o.session, worktreeKey);
        if (e.modelFirstSeenAt !== null && Date.parse(e.modelFirstSeenAt) >= o.time) continue; // the newest observation of a key wins
        Object.assign(e, { harness: dirent.name, model: o.model, modelFirstSeenAt: o.observedAt });
      }
    }
  }

  const sessionsRoot = path.join(root, 'sessions');
  let dirs: Array<{ name: string; mtimeMs: number }> = [];
  try {
    for (const dirent of fsImpl.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!dirent.isDirectory() || !SESSION_DIR.test(dirent.name)) continue;
      try { dirs.push({ name: dirent.name, mtimeMs: fsImpl.lstatSync(path.join(sessionsRoot, dirent.name)).mtimeMs }); } catch { /* gone meanwhile */ }
    }
  } catch { /* no session directories */ }
  dirs.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : 1));
  if (dirs.length > SESSION_DIR_LIMIT) { body.truncated = true; dirs = dirs.slice(0, SESSION_DIR_LIMIT); }
  for (const { name } of dirs) {
    const dir = path.join(sessionsRoot, name);
    const file = path.join(dir, 'git-context.json');
    let context: any;
    try {
      if (!fsImpl.lstatSync(file).isFile()) continue;
    } catch { continue; }
    try { context = JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { counts.unreadable += 1; continue; }
    if (!isObject(context)) { counts.unreadable += 1; continue; }
    const at = checkoutContaining(entries, context.cwd, fsImpl);
    if (!at || at.sandbox) continue; // another project's session, or a sandbox's: never listed
    let newest = -Infinity;
    try {
      for (const child of fsImpl.readdirSync(dir)) {
        try { const st = fsImpl.lstatSync(path.join(dir, child)); if (st.isFile()) newest = Math.max(newest, st.mtimeMs); } catch { /* gone */ }
      }
    } catch { /* unreadable directory: no last record */ }
    const unit = launchedUnit(name);
    const e = entry(keyOf(name), cwdHash(at.path));
    Object.assign(e, {
      worktreeKey: cwdHash(at.path),
      kind: unit ? 'launched' : 'hook',
      startedAt: isoOrNull(context.captured_at),
      branchAtStart: typeof context.branch === 'string' && context.branch !== '' ? context.branch : null,
      lastHookRecordAt: Number.isFinite(newest) ? new Date(newest).toISOString() : null,
      launched: unit,
    });
  }

  const time = (e: any) => Math.max(...[e.lastHookRecordAt, e.startedAt, e.modelFirstSeenAt].map((v) => (v === null ? -Infinity : Date.parse(v))));
  body.sessions = [...sessions.values()].sort((a, b) => time(b) - time(a) || (a.sessionKey < b.sessionKey ? -1 : 1));
  body.unreadable = counts.unreadable;
  return { ok: true, body };
}

module.exports = { readObservations, readWorkerObservation, resolvePrimary, observedSessions };
