'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const path = require('node:path');
const fs = require('node:fs');
const { loadStorageRegistry } = require('./registry.ts');
const { resolveRoots, createPruneSettingsResolver } = require('./roots.ts');
const { runPass } = require('./engine.ts');
const { upkeepAfterVerb } = require('./upkeep.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

function handleStorageCommand({ action = 'report', json = false, global = false, projectRoot = '.', env = process.env, fsImpl = fs }: any = {}) {
  if (!['report', 'prune', 'upkeep'].includes(action)) {
    console.error(`doflow storage: unknown action '${action}' (expected report, prune, or upkeep)`);
    process.exitCode = 2;
    return;
  }
  if (action === 'upkeep') {
    // IC-018: prints nothing and exits 0 even when the registry is unavailable; upkeep fails closed.
    upkeepAfterVerb({ projectRoot: global ? null : path.resolve(projectRoot), env, fsImpl });
    return;
  }
  let registry;
  try { registry = loadStorageRegistry({ repoRoot: REPO_ROOT, fsImpl }); }
  catch (error: any) {
    console.error(`doflow storage: storage registry unavailable${error.message ? `: ${error.message}` : ''}`);
    process.exitCode = 2;
    return;
  }
  const roots = resolveRoots({ registry, projectRoot: global ? null : path.resolve(projectRoot), global, env });
  const resolvePruneSetting = createPruneSettingsResolver({ roots, fsImpl });
  const projectSetting = resolvePruneSetting('project-state');
  const userSetting = resolvePruneSetting('user-state');
  let deprecationNotes: any[] = [];
  try {
    const { loadSettingsRegistry } = require('../settings/registry.ts');
    const loaded = loadSettingsRegistry({ repoRoot: REPO_ROOT, fsImpl });
    if (loaded.ok) {
      const { loadSettings } = require('../settings/resolve.ts');
      const view = loadSettings({ projectRoot: global ? null : path.resolve(projectRoot), global, env,
        fsImpl, registry: loaded.registry });
      view.get('storage.prune', global ? 'global' : 'project');
      deprecationNotes = view.notes.filter((note: any) => note.code === 'deprecated' && note.key === 'storage.prune');
    }
  } catch { /* a settings fault does not change storage's fail-closed report */ }
  const setting = Object.fromEntries(Object.keys(roots).map(rootId => [rootId, resolvePruneSetting(rootId)]));
  const mode = action === 'prune' ? 'prune' : 'report';
  const result = runPass({ registry, roots, mode, setting, now: Date.now(), env, fsImpl });
  const removed = result.stores.reduce((sum: any, row: any) => sum + row.removed, 0);
  const entries = `entr${removed === 1 ? 'y' : 'ies'}`;
  if (action === 'prune' && Object.values(setting).every(value => value.setting === 'off')) {
    const decision = projectSetting.decidedBy || userSetting.decidedBy || path.join(roots['config-home'], registry.settings.optOutFile);
    // IC-013: an explicitly set DOFLOW_RETENTION_HOURS still removes settled lifecycle events.
    console.log(removed === 0 ? `storage: pruning is off (${decision}); nothing removed`
      : `storage: pruning is off (${decision}); DOFLOW_RETENTION_HOURS still applied to lifecycle events: removed ${removed} ${entries}`);
    for (const note of deprecationNotes) console.log(`note: ${note.text}`);
    return;
  }
  if (json) {
    console.log(JSON.stringify({
      setting: { project: projectSetting.setting, user: userSetting.setting,
        decidedBy: { project: projectSetting.decidedBy, user: userSetting.decidedBy } },
      ...result,
    }, null, 2));
    return;
  }
  console.log(`Settings: project ${projectSetting.setting}${projectSetting.decidedBy ? ` (${projectSetting.decidedBy})` : ' (default)'}; user ${userSetting.setting}${userSetting.decidedBy ? ` (${userSetting.decidedBy})` : ' (default)'}`);
  for (const note of deprecationNotes) console.log(`note: ${note.text}`);
  for (const row of result.stores) {
    const names = row.selected.slice(0, 20).map((entry: any) => entry.name);
    const more = row.selected.length > 20 ? `\n    ... and ${row.selected.length - 20} more` : '';
    console.log(`${row.id}\n  Location: ${row.location || '(not configured)'}\n  Entries: ${row.entries}; size: ${row.bytes} bytes\n  Bound: ${row.bound}\n  Would remove: ${row.selected.length}${names.length ? `\n    ${names.join('\n    ')}` : ''}${more}`);
  }
  if (action === 'prune') console.log(`storage: removed ${removed} ${entries}`);
}

module.exports = { handleStorageCommand };
