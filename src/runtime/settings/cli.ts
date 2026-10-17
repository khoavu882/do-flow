'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const path = require('node:path');
const fs = require('node:fs');
const { configHome } = require('../config-home.ts');
const { finishRuntime, usageError } = require('../cli-result.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { loadSettingsRegistry, REGISTRY_FILE } = require('./registry.ts');
const { loadSettings } = require('./resolve.ts');

const SECRET_URL_USERINFO = /\/\/[^/\s]*@/g;

/** A URL with credentials removed, using the platform URL parser before a conservative fallback. */
function maskUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!url.username && !url.password) return value;
    return `${url.protocol}//***@${url.host}${url.pathname}${url.search}${url.hash}`;
  } catch {
    return value.replace(SECRET_URL_USERINFO, '//***@');
  }
}

function safeValue(value: any, meta: any): any {
  return meta?.type === 'url' && typeof value === 'string' ? maskUrl(value) : value;
}

function safeResolution(resolution: any): any {
  const meta = resolution?.meta || {};
  return {
    ...resolution,
    value: safeValue(resolution.value, meta),
    origin: resolution.origin ? { ...resolution.origin } : resolution.origin,
    candidates: (resolution.candidates || []).map((candidate: any) => ({
      ...candidate,
      value: safeValue(candidate.value, meta),
      display: meta.type === 'url' && typeof candidate.display === 'string'
        ? maskUrl(candidate.display) : candidate.display,
    })),
    meta: { ...meta, default: safeValue(meta.default, meta) },
  };
}

function safeReport(report: any): any {
  const keys: Record<string, any> = {};
  for (const [key, value] of Object.entries(report.keys || {})) {
    if (value && typeof value === 'object' && !('key' in value)
      && 'project' in value && 'global' in value) {
      keys[key] = { project: safeResolution((value as any).project), global: safeResolution((value as any).global) };
    } else {
      keys[key] = safeResolution(value);
    }
  }
  return { ...report, keys };
}

/** The settings-only part of doctor output; values are omitted, while present files and faults remain. */
function settingsReport(view: any): any {
  const report = view.report();
  return {
    schema: 1,
    scope: report.scope,
    configHome: report.configHome,
    project: report.project,
    files: report.files,
    errors: report.errors,
    notes: report.notes,
  };
}

function buildSettingsReport({ repoRoot = REPO_ROOT, projectRoot = process.cwd(), global = false,
  env = process.env, fsImpl = fs }: any = {}): any {
  const loaded = loadSettingsRegistry({ repoRoot, fsImpl });
  if (!loaded.ok) {
    const home = configHome(env);
    return {
      schema: 1,
      scope: global ? 'global' : 'project',
      configHome: { dir: home.dir, ignored: [...home.ignored] },
      project: { root: global ? null : path.resolve(projectRoot), layersFrom: null, checkout: null },
      files: [],
      errors: [{ key: null, layer: 'default', source: path.join(repoRoot, REGISTRY_FILE), legacy: false,
        code: 'settings-registry-invalid', reason: loaded.detail, offset: null }],
      notes: [],
    };
  }
  try {
    const view = loadSettings({ projectRoot, global, env, fsImpl, registry: loaded.registry });
    return settingsReport(view);
  } catch (error: any) {
    const home = configHome(env);
    return {
      schema: 1,
      scope: global ? 'global' : 'project',
      configHome: { dir: home.dir, ignored: [...home.ignored] },
      project: { root: global ? null : path.resolve(projectRoot), layersFrom: null, checkout: null },
      files: [],
      errors: [{ key: null, layer: 'default', source: path.join(repoRoot, REGISTRY_FILE), legacy: false,
        code: 'settings-unavailable', reason: error?.message || String(error), offset: null }],
      notes: [],
    };
  }
}

function settingValue(value: any, meta: any): string {
  const safe = safeValue(value, meta);
  if (safe === null || safe === undefined) return '(none)';
  if (typeof safe === 'string') return JSON.stringify(safe);
  return JSON.stringify(safe);
}

function originLabel(resolution: any): string {
  const { origin } = resolution;
  const source = origin.source || (origin.via === 'no-config-home' ? 'no config home' : REGISTRY_FILE);
  return `${origin.layer}: ${source}`;
}

function printResolution(key: string, resolution: any, showOrigin: boolean, suffix = ''): void {
  if (key === 'failure.capture' && resolution.origin?.via === 'no-config-home') {
    console.log('failure.capture = "off"  (no config home: capture skipped)');
  } else {
    const origin = showOrigin ? `  (${originLabel(resolution)})` : '';
    console.log(`${key}${suffix} = ${settingValue(resolution.value, resolution.meta)}${origin}`);
  }
  if (!showOrigin) return;
  for (const candidate of resolution.candidates || []) {
    const display = typeof candidate.display === 'string' && candidate.display !== '' ? candidate.display : '(none)';
    const reason = candidate.reason ? `: ${candidate.reason}` : '';
    console.log(`    ${candidate.layer} ${candidate.source}: ${display} — ${candidate.status}${reason}`);
  }
}

function printSettingsList(report: any, showOrigin: boolean): void {
  const home = report.configHome;
  const ignored = home.ignored || [];
  console.log(`config home: ${home.dir || 'none'}${ignored.length ? ` | ignored: ${ignored.join(', ')}` : ''}`);
  for (const name of ignored) console.log(`note: ignored relative ${name}`);
  const project = report.project;
  console.log(`project: ${project.root || '(none)'}${project.checkout ? ` (${project.checkout})` : ''}`);

  for (const [key, value] of Object.entries(report.keys || {})) {
    if (key === 'storage.prune' && value && typeof value === 'object'
      && 'project' in (value as any) && 'global' in (value as any)) {
      printResolution(key, (value as any).project, showOrigin, ' [project roots]');
      printResolution(key, (value as any).global, showOrigin, ' [user roots]');
    } else {
      printResolution(key, value, showOrigin, key === 'storage.prune' ? ' [user roots]' : '');
    }
  }
  for (const error of report.errors || []) {
    console.log(`error: ${error.key || 'settings'} (${error.layer}: ${error.source}): ${error.reason}`);
  }
  for (const note of report.notes || []) console.log(`note: ${note.text}`);
}

function securityFault(report: any): boolean {
  const check = (resolution: any): boolean => {
    if (resolution && resolution.meta?.securityRelevant
      && ['fail-safe', 'cross-key'].includes(resolution.origin?.via)) return true;
    if (resolution && typeof resolution === 'object' && 'project' in resolution && 'global' in resolution) {
      return check(resolution.project) || check(resolution.global);
    }
    return false;
  };
  return Object.values(report.keys || {}).some(check);
}

function configArguments(positional: any): { project: string | null; error: string | null } {
  const args = Array.isArray(positional) ? [...positional] : [];
  if (args[0] === 'set') return { project: null, error: 'config set is not supported; config is read-only' };
  if (args[0] === 'list') args.shift();
  if (args.length > 1) return { project: null, error: 'expected config [list] [project path]' };
  return { project: args[0] || null, error: null };
}

function handleConfigCommand({ json = false, global = false, showOrigin = false, positional = [],
  projectRoot, repoRoot = REPO_ROOT, env = process.env, fsImpl = fs }: any = {}): number {
  const args = configArguments(positional);
  if (args.error) return usageError('config', args.error, json);
  const loaded = loadSettingsRegistry({ repoRoot, fsImpl });
  if (!loaded.ok) {
    const detail = loaded.detail || 'settings registry is invalid';
    if (json) console.log(JSON.stringify({ ok: false, status: 'ERROR', exitCode: 2,
      error: 'settings-registry-invalid', detail }, null, 2));
    else console.error(`doflow config: settings registry unavailable: ${detail}`);
    return finishRuntime(2);
  }

  try {
    const root = global ? null : path.resolve(args.project || projectRoot || process.cwd());
    const view = loadSettings({ projectRoot: root, global, env, fsImpl, registry: loaded.registry });
    const report = safeReport(view.report());
    if (json) console.log(JSON.stringify(report, null, 2));
    else printSettingsList(report, showOrigin);
    return finishRuntime(securityFault(report) ? 1 : 0);
  } catch (error: any) {
    const detail = error?.message || String(error);
    if (json) console.log(JSON.stringify({ ok: false, status: 'ERROR', exitCode: 2,
      error: 'settings-registry-invalid', detail }, null, 2));
    else console.error(`doflow config: settings registry unavailable: ${detail}`);
    return finishRuntime(2);
  }
}

function printSettingsReport(report: any): void {
  console.log('\n[Settings]');
  console.log(`  config home: ${report.configHome.dir || 'none'}`);
  for (const name of report.configHome.ignored || []) {
    console.log(`  ignored relative ${name} (ignored)`);
  }
  if (report.project.root) {
    console.log(`  project: ${report.project.root}${report.project.checkout ? ` (${report.project.checkout})` : ''}`);
  }
  const present = (report.files || []).filter((file: any) => file.status !== 'absent');
  if (!present.length) console.log('  files: none');
  for (const file of present) {
    const deprecated = file.kind === 'legacy' ? ' (deprecated)' : '';
    console.log(`  ${file.layer} ${file.path}: ${file.status}${deprecated}`);
  }
  for (const note of report.notes || []) console.log(`  note: ${note.text}`);
  for (const error of report.errors || []) {
    console.log(`  error: ${error.key || 'settings'} (${error.layer}: ${error.source}): ${error.reason}`);
  }
}

module.exports = {
  maskUrl,
  safeReport,
  settingsReport,
  buildSettingsReport,
  printSettingsReport,
  handleConfigCommand,
};
