'use strict';
// `doflow update` — incremental refresh: diff the pinned/selected state against what is on disk
// and apply only what changed. Never re-prompts for MCP (reuses the manifest-remembered selection).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveTargets, toolDirs } = require('../../install/targets');
const { resolveContext, printContext } = require('../../install/context');
const { createBackup, pruneBackups } = require('../../install/backup');
const { writeManifest, readManifest } = require('../../install/manifest');
const { confirm } = require('../../helper/prompt');
const { sourceCommit } = require('../../helper/git');
const { chmodHooksExecutable } = require('../../helper/settings-scope');
const { readCodexMcpCatalog, resolveCodexMcpSelection } = require('../../adapters/codex/mcp');
const { promptMcpCheckbox } = require('../../install/mcp');
const { loadRegistry } = require('../../registry');
const { applyLifecycle } = require('../../lifecycle');
const {
  codexScope, registryLifecycleView, printRegistryLifecycle, assertSafeRegistryPlan,
  lockDocument, recordLock,
} = require('../../lifecycle/view');
const {
  REPO_ROOT, SCRIPT_DIR, pkg, scopeOf, reportRetiredMcp, resolveMcpForTool, buildAdapterRegistry,
} = require('../shared');

function cmdUpdate(o) {
  const targets = resolveTargets(o.targets);
  const scope = scopeOf(o);
  const dirs = toolDirs(scope);
  const backupRoot = path.join(dirs.claude, 'backups');
  const commit = sourceCommit(SCRIPT_DIR);
  printContext(resolveContext({ repoRoot: REPO_ROOT, targets, dirs, sourceCommit: commit, ...scope }));

  // Never interactive here (resolveMcpForTool only prompts for cmd:'install') — update reuses the
  // manifest-remembered selection, or applies an explicit --mcp override, without re-prompting.
  const registry = loadRegistry({ repoRoot: REPO_ROOT });
  const existingManifest = readManifest(dirs.claude);
  const mcp = targets.includes('claude') ? resolveMcpForTool({ o, dirs, scope, cmd: 'update', registry }) : null;
  const mcpChanged = Boolean(mcp && mcp.changed);
  const codexCatalog = targets.includes('codex') ? readCodexMcpCatalog(registry) : null;
  const codexMcpSelection = codexCatalog ? (mcp?.selected ?? resolveCodexMcpSelection({ cmd: 'update', requested: o.mcp,
    allServers: codexCatalog.allServers, manifestServers: existingManifest?.mcpServers ?? null, interactive: false, promptFn: promptMcpCheckbox, onStale: reportRetiredMcp })) : [];
  const mcpIds = mcp?.selected ?? (codexCatalog ? codexMcpSelection : undefined);
  // One lifecycle view across every requested target — computed unconditionally (not only under
  // --dry-run) so its safety gate and its plan are the exact same object the real apply below uses.
  const lifecycleView = registryLifecycleView({ registry, repoRoot: REPO_ROOT, scope, dirs, targets, mcpIds, force: o.force, permissions: o.permissions === true, statusline: o.statusline === true });
  if (!lifecycleView.plan.safe) { assertSafeRegistryPlan(lifecycleView); return; }
  const lifecycleChanged = Boolean(lifecycleView.plan.changes.length);

  if (!mcpChanged && !lifecycleChanged) {
    console.log('[OK] Already up to date — no changes detected');
    return;
  }

  console.log(`[INFO] Found${mcpChanged ? ' MCP server selection change' : ''}${mcpChanged && lifecycleChanged ? ' +' : ''}${lifecycleChanged ? ` ${lifecycleView.plan.changes.length} native change(s)` : ''}`);

  if (o.dryRun) {
    if (mcpChanged) console.log(`[DRY]  MCP servers -> ${mcp.destDescription} (${mcp.selected.join(', ') || 'none'})`);
    printRegistryLifecycle(lifecycleView, '[DRY]');
    if (!o.noBackup && lifecycleChanged) console.log(`[DRY]  Would create partial backup: ${backupRoot}/update_<timestamp>`);
    console.log(`[DRY]  Would write manifest: ${path.join(dirs.claude, '.install-manifest.json')}`);
    console.log('[DRY] Dry run complete');
    return;
  }

  if (!confirm(`Update${mcpChanged ? ' MCP server selection' : ''}${mcpChanged && lifecycleChanged ? ' +' : ''}${lifecycleChanged ? ' native resources' : ''} in: ${targets.join(' ')}?`, o.force)) {
    // Exit 1, not 0: a declined prompt is a decision, and it must not share an exit code with a
    // completed run. With no stdin the prompt auto-declines, so `doflow install <path>` in a script
    // or CI step printed "Aborted.", wrote zero files, and reported success. It also silently
    // corrupted a set of install-timing measurements during the D.4 sweep, which is how it surfaced.
    console.error('[INFO]  Aborted.');
    process.exit(1);
  }

  let bid = '';
  // Nothing outside dirs[tool] needs backing up for an MCP-only change — ~/.claude.json /
  // <project>/.mcp.json are outside the tool dir by design (see src/install/mcp.js), so a backup is only
  // meaningful when a native resource is about to change.
  if (!o.noBackup && lifecycleChanged) {
    const existingTargets = lifecycleView.plan.changes.map((change) => change.target).filter((f) => typeof f === 'string' && fs.existsSync(f));
    bid = createBackup({ operation: 'update', tools: targets, dirs, backupRoot, repoRoot: SCRIPT_DIR, sourceCommit: commit, partialFiles: existingTargets, date: new Date() });
    console.error(`[INFO]  Backup created: ${bid}`);
  }

  if (mcpChanged) {
    mcp.apply();
    console.log(`[INFO] claude: MCP servers -> ${mcp.destDescription} (${mcp.selected.join(', ') || 'none'})`);
  }
  if (lifecycleView.plan.changes.length) {
    const result = applyLifecycle({ plan: lifecycleView.plan, registry: lifecycleView.registry,
      adapters: buildAdapterRegistry(),
      stateRoot: lifecycleView.stateRoot, ledger: lifecycleView.ledger });
    for (const target of lifecycleView.plan.targets) {
      if (target.skipped || !target.changes.length) continue;
      const owned = result.ledger.resources.filter((resource) => resource.harness === target.harness).length;
      console.log(`[INFO] ${target.harness}: lifecycle verified (${owned} owned resource(s))`);
    }
  }
  if (targets.includes('claude')) chmodHooksExecutable(dirs.claude);

  writeManifest({ claudeDir: dirs.claude, scriptVersion: pkg.version, operation: 'update', repoRoot: SCRIPT_DIR, sourceCommit: commit, backupId: bid, tools: targets, date: new Date(), mcpServers: mcpIds });

  const updateLock = recordLock(
    scope.global ? { scope: 'global', homeDir: os.homedir() } : { scope: 'project', projectRoot: path.resolve(scope.projectRoot) },
    lockDocument({
      registry, scope: codexScope(scope), scopeRoot: scope.global ? os.homedir() : path.resolve(scope.projectRoot), targets,
      mcpSelections: { claude: mcp?.selected ?? [], codex: codexCatalog ? codexMcpSelection : [] },
    }),
  );
  console.log(`[INFO] doflow.lock: ${updateLock.summary}`);

  if (o.prune > 0) {
    const pruned = pruneBackups(backupRoot, o.prune);
    if (pruned.length) console.error(`[INFO]  Pruned ${pruned.length} old backup(s)`);
  }

  console.log('[OK] Update complete!');
}

module.exports = cmdUpdate;
