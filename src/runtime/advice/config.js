'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveRoots } = require('../storage/roots');

const SETTING_FILE = 'decision-model.json';
const PROJECT_NOTE = 'a project cannot enable the decision model or choose its endpoint';
const KNOWN_KEYS = new Set(['schema', 'enabled', 'provider', 'endpoint', 'model']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function offResult(reason, decidedBy, notes = [], setting = {}) {
  return {
    state: 'off', reason,
    provider: setting.provider ?? null,
    endpoint: setting.endpoint ?? null,
    model: setting.model ?? null,
    decidedBy,
    modelFrom: setting.model ? setting.modelFrom ?? null : null,
    notes,
  };
}

function readJson(file, fsImpl) {
  if (!file) return { exists: false };
  try {
    return { exists: true, value: JSON.parse(fsImpl.readFileSync(file, 'utf8')) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false };
    return { exists: true, error };
  }
}

function parseUserSetting(value, adviceRegistry) {
  if (!isObject(value)) return { error: 'user setting must be a JSON object' };
  if (value.schema !== 1) return { error: 'user setting schema must be 1' };
  if (typeof value.enabled !== 'boolean') return { error: 'user setting enabled must be a boolean' };

  const providers = Array.isArray(adviceRegistry?.providers) ? adviceRegistry.providers : [];
  const providerId = value.provider === undefined ? 'ollama' : value.provider;
  const provider = providers.find((item) => item?.id === providerId);
  if (typeof providerId !== 'string' || !provider) return { error: `user setting provider '${providerId}' is not in advice.json providers` };

  let endpoint = provider.defaultEndpoint;
  if (value.endpoint !== undefined) {
    if (typeof value.endpoint !== 'string' || !value.endpoint.trim()) return { error: 'user setting endpoint must be a URL string' };
    try { new URL(value.endpoint); } catch { return { error: 'user setting endpoint must be a URL string' }; }
    endpoint = value.endpoint;
  }
  if (typeof endpoint !== 'string' || !endpoint) return { error: `providers.${providerId}.defaultEndpoint is missing` };

  if (value.model !== undefined && (typeof value.model !== 'string' || !value.model.trim())) {
    return { error: 'user setting model must be a non-empty string' };
  }
  if (value.enabled && (typeof value.model !== 'string' || !value.model.trim())) {
    return { error: 'user setting model is required when enabled is true' };
  }

  const notes = Object.keys(value)
    .filter((key) => !KNOWN_KEYS.has(key))
    .map((key) => `unknown user key '${key}' ignored`);
  return {
    value: { enabled: value.enabled, provider: providerId, endpoint, model: value.model ?? null },
    notes,
  };
}

function parseProjectSetting(value) {
  if (!isObject(value)) return { error: 'project setting must be a JSON object' };
  if (value.schema !== 1) return { error: 'project setting schema must be 1' };
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') return { error: 'project setting enabled must be a boolean' };
  if (value.model !== undefined && (typeof value.model !== 'string' || !value.model.trim())) return { error: 'project setting model must be a non-empty string' };

  const notes = [];
  if (value.enabled === true) notes.push(`project key 'enabled' ignored: ${PROJECT_NOTE}`);
  for (const key of ['endpoint', 'provider']) {
    if (Object.hasOwn(value, key)) notes.push(`project key '${key}' ignored: ${PROJECT_NOTE}`);
  }
  for (const key of Object.keys(value)) {
    if (!['schema', 'enabled', 'model', 'endpoint', 'provider'].includes(key)) notes.push(`unknown project key '${key}' ignored`);
  }
  return { value: { disabled: value.enabled === false, model: value.model ?? null }, notes };
}

function resolveSetting({
  adviceRegistry,
  roots,
  storageRegistry,
  projectRoot,
  global = false,
  env = process.env,
  fsImpl = fs,
} = {}) {
  const notes = [];
  let resolvedRoots = roots;
  try {
    if (!resolvedRoots) resolvedRoots = resolveRoots({ registry: storageRegistry, projectRoot, global, env });
  } catch (error) {
    return offResult('config-invalid', { user: null, project: null }, [`storage roots could not be resolved: ${error.message}`]);
  }
  const userFile = resolvedRoots?.['config-home'] ? path.join(resolvedRoots['config-home'], SETTING_FILE) : null;
  const projectFile = resolvedRoots?.['project-doflow'] ? path.join(resolvedRoots['project-doflow'], SETTING_FILE) : null;
  const decidedBy = { user: null, project: null };
  const userRead = readJson(userFile, fsImpl);
  if (!userRead.exists) return offResult('not-configured', decidedBy, notes);
  if (userRead.error) {
    return offResult('config-invalid', { user: userFile, project: null }, [`user setting at ${userFile} could not be read: ${userRead.error.message}`]);
  }
  const user = parseUserSetting(userRead.value, adviceRegistry);
  if (user.error) return offResult('config-invalid', { user: userFile, project: null }, [`${user.error} (${userFile})`]);
  decidedBy.user = userFile;
  notes.push(...user.notes);

  const base = { ...user.value, modelFrom: user.value.model ? 'user' : null };
  if (!user.value.enabled) return offResult('user-disabled', decidedBy, notes, base);

  const projectRead = readJson(projectFile, fsImpl);
  if (projectRead.exists) {
    if (projectRead.error) {
      notes.push(`project setting at ${projectFile} ignored: ${projectRead.error.message}`);
    } else {
      const project = parseProjectSetting(projectRead.value);
      if (project.error) {
        notes.push(`project setting at ${projectFile} ignored: ${project.error}`);
      } else {
        notes.push(...project.notes);
        if (project.value.disabled) {
          decidedBy.project = projectFile;
          return offResult('project-disabled', decidedBy, notes, base);
        }
        if (project.value.model) {
          decidedBy.project = projectFile;
          return {
            state: 'on', reason: null, provider: base.provider, endpoint: base.endpoint,
            model: project.value.model, decidedBy, modelFrom: 'project', notes,
          };
        }
      }
    }
  }
  return {
    state: 'on', reason: null, provider: base.provider, endpoint: base.endpoint,
    model: base.model, decidedBy, modelFrom: base.modelFrom, notes,
  };
}

function writeSetting({ file, setting, level = 'user', force = false, fsImpl = fs } = {}) {
  if (typeof file !== 'string' || !file || !isObject(setting)) {
    return { ok: false, reason: 'config-invalid', detail: 'file and setting object are required' };
  }
  const directory = path.dirname(file);
  let existing = {};
  try {
    if (fsImpl.existsSync(file)) {
      try {
        const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
        if (!isObject(parsed)) throw new Error('setting must be a JSON object');
        existing = parsed;
      } catch (error) {
        if (!force) return { ok: false, reason: 'config-invalid', detail: `${file}: ${error.message}` };
      }
    }

    const preserved = Object.fromEntries(Object.entries(existing).filter(([key]) => !KNOWN_KEYS.has(key)));
    const retainedUserFields = level === 'user' && setting.enabled === false
      ? Object.fromEntries(['provider', 'endpoint', 'model'].filter((key) => existing[key] !== undefined).map((key) => [key, existing[key]]))
      : {};
    const output = { ...preserved, ...retainedUserFields, ...setting };
    fsImpl.mkdirSync(directory, { recursive: true });
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const temporary = path.join(directory, `.${path.basename(file)}.${suffix}.tmp`);
    try {
      fsImpl.writeFileSync(temporary, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      fsImpl.renameSync(temporary, file);
    } finally {
      try { if (fsImpl.existsSync(temporary)) fsImpl.unlinkSync(temporary); } catch { /* keep the primary result */ }
    }
    return { ok: true, file, setting: output };
  } catch (error) {
    return { ok: false, reason: 'config-invalid', detail: `${file}: ${error.message}` };
  }
}

module.exports = { resolveSetting, writeSetting };
