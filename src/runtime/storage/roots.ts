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

function readSetting(file: string, fsImpl: any): string {
  try {
    const first = fsImpl.readFileSync(file, 'utf8').split(/\r?\n/, 1)[0].trim().toLowerCase();
    return first === 'on' || first === 'off' ? first : 'off';
  } catch { return 'off'; }
}

/** Reads IC-014 and reports exactly which present file made the decision, if any. */
function readPruneSetting({ registry, roots, rootId, fsImpl = fs }: any = {}): { setting: string; decidedBy: string | null } {
  const projectFile = roots['project-doflow'] ? path.join(roots['project-doflow'], registry.settings.optOutFile) : null;
  const userFile = roots['config-home'] ? path.join(roots['config-home'], registry.settings.optOutFile) : null;
  const usesProject = rootId === 'project-doflow' || rootId === 'project-state';
  if (usesProject && projectFile && fsImpl.existsSync(projectFile)) return { setting: readSetting(projectFile, fsImpl), decidedBy: projectFile };
  if (userFile && fsImpl.existsSync(userFile)) return { setting: readSetting(userFile, fsImpl), decidedBy: userFile };
  return { setting: 'on', decidedBy: null };
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

module.exports = { resolveRoots, readPruneSetting, resolveStorePath };
