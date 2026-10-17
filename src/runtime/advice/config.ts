'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const fs = require('node:fs');
const path = require('node:path');
const { resolveRoots } = require('../storage/roots.ts');
const { loadSettings } = require('../settings/resolve.ts');

function offResult(reason: string, decidedBy: any, notes: string[] = [], setting: any = {}): any {
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

function projectLayer(layer: string): boolean {
  return layer === 'project' || layer === 'local';
}

function errorNote(error: any): string {
  if (error.legacy && error.layer === 'user') {
    if (error.code === 'unreadable' || error.code === 'not-file'
      || (error.code === 'unparseable' && error.reason.startsWith('not valid JSON'))) {
      return `user setting at ${error.source} could not be read: ${error.reason}`;
    }
    return `${error.reason} (${error.source})`;
  }
  if (projectLayer(error.layer)) return `project setting at ${error.source} ignored: ${error.reason}`;
  return `user setting at ${error.source} is invalid${error.key ? ` for '${error.key}'` : ''}: ${error.reason}`;
}

function settingNotes(view: any, includeProject: boolean, includeDeprecated = false): string[] {
  const notes = view.notes
    .filter((note: any) => {
      if (note.code !== 'deprecated' || !includeDeprecated) return note.code !== 'deprecated';
      const sourceLayer = view.files.find((file: any) => file.path === note.source)?.layer;
      if (!note.key || !['user', 'project'].includes(sourceLayer)) return false;
      const resolution = view.get(note.key, sourceLayer === 'user' ? 'global' : 'project');
      return resolution.origin.legacy && resolution.origin.source === note.source;
    })
    .filter((note: any) => includeProject || !projectLayer(view.files.find((file: any) => file.path === note.source)?.layer))
    .map((note: any) => note.text);
  const seen = new Set<string>();
  for (const error of view.errors) {
    if (!includeProject && projectLayer(error.layer)) continue;
    const key = error.legacy
      ? `${error.layer}\0${error.source}`
      : `${error.layer}\0${error.source}\0${error.key}\0${error.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    notes.push(errorNote(error));
  }
  return notes;
}

function modelSource(setting: any): string | null {
  if (setting.value === null || setting.value === undefined) return null;
  if (setting.origin.layer === 'user') return 'user';
  return projectLayer(setting.origin.layer) ? 'project' : null;
}

function decidedSource(setting: any, layer: 'user' | 'project'): string | null {
  if (layer === 'user') return setting.origin.layer === 'user' ? setting.origin.source : null;
  return projectLayer(setting.origin.layer) ? setting.origin.source : null;
}

function resolveSetting({
  adviceRegistry,
  roots,
  storageRegistry,
  projectRoot,
  global = false,
  env = process.env,
  fsImpl = fs,
  includeDeprecated = false,
}: any = {}): any {
  let resolvedRoots = roots;
  try {
    if (!resolvedRoots) resolvedRoots = resolveRoots({ registry: storageRegistry, projectRoot, global, env });
  } catch (error: any) {
    return offResult('config-invalid', { user: null, project: null }, [`storage roots could not be resolved: ${error.message}`]);
  }
  const resolverEnv = { ...env };
  if (resolvedRoots?.['config-home']) {
    resolverEnv.XDG_CONFIG_HOME = path.dirname(resolvedRoots['config-home']);
  } else {
    delete resolverEnv.XDG_CONFIG_HOME;
    delete resolverEnv.HOME;
  }
  const resolverProjectRoot = !global && resolvedRoots?.['project-doflow']
    ? path.dirname(resolvedRoots['project-doflow'])
    : null;

  let view: any;
  try {
    view = loadSettings({ projectRoot: resolverProjectRoot, global, env: resolverEnv, fsImpl });
    const enabledGlobal = view.get('advice.enabled', 'global');
    const canReadProject = !global && enabledGlobal.value === true
      && enabledGlobal.state === 'ok' && enabledGlobal.origin.via === null;
    const enabled = canReadProject ? view.get('advice.enabled', 'project') : enabledGlobal;
    const provider = view.get('advice.provider', 'global');
    const endpoint = view.get('advice.endpoint', 'global');
    const modelGlobal = view.get('advice.model', 'global');
    const model = canReadProject && enabled.value === true ? view.get('advice.model', 'project') : modelGlobal;
    const decidedBy = {
      user: decidedSource(enabledGlobal, 'user'),
      project: decidedSource(enabled, 'project') || decidedSource(model, 'project'),
    };
    let reason: string | null = null;
    if (enabled.state === 'invalid' || enabled.origin.via === 'fail-safe' || enabled.origin.via === 'cross-key') {
      reason = 'config-invalid';
    } else if (enabled.value !== true) {
      if (enabled.origin.layer === 'default' || enabled.origin.via === 'no-config-home') reason = 'not-configured';
      else if (projectLayer(enabled.origin.layer)) reason = 'project-disabled';
      else reason = 'user-disabled';
    }

    const notes = settingNotes(view, canReadProject, includeDeprecated);
    if (reason === 'not-configured') return offResult(reason, decidedBy, notes);
    if (reason === 'config-invalid' && (enabledGlobal.state === 'invalid'
      || enabledGlobal.origin.via === 'fail-safe' || enabledGlobal.origin.via === 'cross-key')) {
      return offResult(reason, decidedBy, notes);
    }

    const effectiveModel = reason === 'config-invalid' ? modelGlobal : model;
    const effectiveModelFrom = modelSource(effectiveModel);
    if (reason) {
      return offResult(reason, decidedBy, notes, {
        provider: provider.value,
        endpoint: endpoint.value,
        model: effectiveModel.value,
        modelFrom: effectiveModelFrom,
      });
    }
    return {
      state: 'on', reason: null, provider: provider.value, endpoint: endpoint.value,
      model: effectiveModel.value, decidedBy, modelFrom: effectiveModelFrom, notes,
    };
  } catch (error: any) {
    return offResult('config-invalid', { user: null, project: null }, [`settings resolver could not be loaded: ${error.message}`]);
  }
}

module.exports = { resolveSetting };
