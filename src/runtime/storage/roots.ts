'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const fs = require('node:fs');
const path = require('node:path');
const { configHome } = require('../config-home.ts');

function absolute(value: any): string | null { return typeof value === 'string' && path.isAbsolute(value) ? value : null; }

/** Resolves IC-001's five physical roots; -g/global deliberately omits project roots. */
function resolveRoots({ registry, projectRoot, global = false, env = process.env }: any = {}): Record<string, string | null> {
  // No home variable means no home base and no config home: nothing falls back to the account home (DD-7).
  const home = absolute(env.HOME);
  const xdgBase = configHome(env).base;
  const project = global ? null : absolute(projectRoot);
  const bases: Record<string, string | null> = { project, home, 'xdg-config': xdgBase };
  return Object.fromEntries(Object.entries(registry.roots).map(([id, root]: [string, any]) => {
    const base = bases[root.base];
    return [id, base ? path.join(base, ...root.segments) : null];
  }));
}

/** Creates one IC-014 resolver for all roots in a command; a project view can also read global scope. */
function createPruneSettingsResolver({ roots, fsImpl = fs, onView }: any = {}): (rootId: string) => { setting: string; decidedBy: string | null } {
  const resolverEnv: Record<string, string> = {};
  if (roots['config-home']) resolverEnv.XDG_CONFIG_HOME = path.dirname(roots['config-home']);
  let view: any = null;
  let loadedView = false;
  return (rootId: string) => {
    if (!loadedView) {
      loadedView = true;
      try {
        let settingsRegistry;
        if (fsImpl !== fs) {
          const { loadSettingsRegistry } = require('../settings/registry.ts');
          const loaded = loadSettingsRegistry({ fsImpl });
          if (!loaded.ok) throw new Error(loaded.detail);
          settingsRegistry = loaded.registry;
        }
        const { loadSettings } = require('../settings/resolve.ts');
        const projectRoot = roots['project-doflow'] ? path.dirname(roots['project-doflow']) : null;
        view = loadSettings({ projectRoot, env: resolverEnv, fsImpl, ...(settingsRegistry ? { registry: settingsRegistry } : {}) });
      } catch {
        // A settings registry fault fails closed for every root, as it did for each old call.
        view = null;
      }
      if (typeof onView === 'function') onView(view);
    }
    if (!view) return { setting: 'off', decidedBy: null };
    try {
      const usesProject = rootId === 'project-doflow' || rootId === 'project-state';
      const resolved = view.get('storage.prune', usesProject ? 'project' : 'global');
      return {
        setting: resolved.value === 'on' ? 'on' : 'off',
        decidedBy: resolved.origin.layer === 'default' ? null : resolved.origin.source,
      };
    } catch {
      return { setting: 'off', decidedBy: null };
    }
  };
}

/** Reads IC-014 and reports exactly which present file made the decision, if any. */
function readPruneSetting({ roots, rootId, fsImpl = fs }: any = {}): { setting: string; decidedBy: string | null } {
  const usesProject = rootId === 'project-doflow' || rootId === 'project-state';
  const global = !usesProject;
  const projectRoot = !global && roots['project-doflow'] ? path.dirname(roots['project-doflow']) : null;
  const resolverEnv: Record<string, string> = {};
  if (roots['config-home']) resolverEnv.XDG_CONFIG_HOME = path.dirname(roots['config-home']);
  try {
    let settingsRegistry;
    if (fsImpl !== fs) {
      const { loadSettingsRegistry } = require('../settings/registry.ts');
      const loaded = loadSettingsRegistry({ fsImpl });
      if (!loaded.ok) throw new Error(loaded.detail);
      settingsRegistry = loaded.registry;
    }
    const { loadSettings } = require('../settings/resolve.ts');
    const view = loadSettings({ projectRoot, global, env: resolverEnv, fsImpl, ...(settingsRegistry ? { registry: settingsRegistry } : {}) });
    const resolved = view.get('storage.prune', global ? 'global' : 'project');
    return {
      setting: resolved.value === 'on' ? 'on' : 'off',
      decidedBy: resolved.origin.layer === 'default' ? null : resolved.origin.source,
    };
  } catch {
    return { setting: 'off', decidedBy: null };
  }
}

function linked(file: string, fsImpl: any): boolean {
  try { return fsImpl.lstatSync(file).isSymbolicLink(); } catch { return false; }
}

/**
 * Returns the physical directory for a declared store, or null when a DoFlow-owned component is a
 * link. The engine treats null as a refuse-to-touch result, never as a path to repair.
 */
function resolveStorePath({ store, roots, fsImpl = fs }: any = {}): string | null {
  const root = roots[store.root];
  if (!root) return null;
  if (linked(root, fsImpl)) return null;
  const rootParent = path.dirname(root);
  if (path.basename(rootParent) === '.doflow' && linked(rootParent, fsImpl)) return null;
  let current = root;
  for (const segment of store.path ? store.path.split('/') : []) {
    current = path.join(current, segment);
    if (linked(current, fsImpl)) return null;
  }
  return current;
}

module.exports = { resolveRoots, readPruneSetting, createPruneSettingsResolver, resolveStorePath };
