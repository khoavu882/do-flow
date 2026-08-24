'use strict';
// `doflow install` — plan the full lifecycle across the requested targets, back up, apply, and
// pin what was chosen in doflow.lock. Supports --dry-run previews and MCP selection.
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
const { applyLifecycle, applyMcpIndex } = require('../../lifecycle');
const {
  codexScope, registryLifecycleView, printRegistryLifecycle, assertSafeRegistryPlan,
  lockDocument, recordLock,
} = require('../../lifecycle/view');
const {
  REPO_ROOT, SCRIPT_DIR, pkg, scopeOf, reportRetiredMcp, resolveMcpForTool, buildAdapterRegistry,
} = require('../shared');

function cmdInstall(o) {
  const targets = resolveTargets(o.targets);
  const scope = scopeOf(o);
  const dirs = toolDirs(scope);
  const backupRoot = path.join(dirs.claude, 'backups');
  // Resolved once per invocation and threaded into resolveContext/createBackup/writeManifest below
  // — those three used to each spawn their own `git rev-parse` for the identical value.
  const commit = sourceCommit(SCRIPT_DIR);

  printContext(resolveContext({ repoRoot: REPO_ROOT, targets, dirs, sourceCommit: commit, ...scope }));

  const registry = loadRegistry({ repoRoot: REPO_ROOT });
  const existingManifest = readManifest(dirs.claude);
  const mcp = targets.includes('claude') ? resolveMcpForTool({ o, dirs, scope, cmd: 'install', registry }) : null;
  const codexCatalog = targets.includes('codex') ? readCodexMcpCatalog(registry) : null;
  const codexMcpSelection = codexCatalog ? (mcp?.selected ?? resolveCodexMcpSelection({ cmd: 'install', requested: o.mcp,
    allServers: codexCatalog.allServers, manifestServers: existingManifest?.mcpServers ?? null,
    interactive: !o.dryRun && !o.force && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY), promptFn: promptMcpCheckbox, onStale: reportRetiredMcp })) : [];
  const mcpIds = mcp?.selected ?? (codexCatalog ? codexMcpSelection : undefined);
  // Safe-by-default surfaced, not silent: a first-ever non-interactive install now selects zero
  // MCP servers. Anyone scripting installs must opt in explicitly; interactive users never see
  // this because the checkbox is the discovery path.
  if (!o.mcp && !existingManifest?.mcpServers && !o.dryRun &&
      !process.stdin.isTTY && (targets.includes('claude') || codexCatalog)) {
    console.log('[INFO] MCP: none selected by default in non-interactive mode — pass --mcp all or --mcp <names> to include servers.');
  }
  // One lifecycle view across every requested target — computed unconditionally (not only under
  // --dry-run) so its safety gate and its plan are the exact same object the real apply below uses.
  const lifecycleView = registryLifecycleView({ registry, repoRoot: REPO_ROOT, scope, dirs, targets, mcpIds, force: o.force, permissions: o.permissions === true, statusline: o.statusline === true });
  if (!lifecycleView.plan.safe) { assertSafeRegistryPlan(lifecycleView); return; }

  if (o.dryRun) {
    console.log(`[INFO] Install targets: ${targets.join(' ')}`);
    if (mcp) console.log(`[DRY]  MCP servers -> ${mcp.destDescription} (${mcp.selected.join(', ') || 'none'})`);
    printRegistryLifecycle(lifecycleView, '[DRY]');
    if (!o.noBackup) console.log(`[DRY]  Would create backup: ${backupRoot}/install_<timestamp>`);
    console.log(`[DRY]  Would write manifest: ${path.join(dirs.claude, '.install-manifest.json')}`);
    console.log('[DRY] Dry run complete — no changes written');
    return;
  }

  if (!confirm(`Install configs to: ${targets.join(' ')}?`, o.force)) {
    // Exit 1, not 0: a declined prompt is a decision, and it must not share an exit code with a
    // completed run. With no stdin the prompt auto-declines, so `doflow install <path>` in a script
    // or CI step printed "Aborted.", wrote zero files, and reported success. It also silently
    // corrupted a set of install-timing measurements during the D.4 sweep, which is how it surfaced.
    console.error('[INFO]  Aborted.');
    process.exit(1);
  }

  let bid = '';
  if (!o.noBackup) {
    bid = createBackup({ operation: 'install', tools: targets, dirs, backupRoot, repoRoot: SCRIPT_DIR, sourceCommit: commit, date: new Date() });
    console.error(`[INFO]  Backup created: ${bid}`);
  } else {
    console.error('[WARN]  Skipping backup (--no-backup)');
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
  } else {
    // MCP_INDEX.md is generated, not a tracked resource, so it never appears in plan.changes and
    // applyLifecycle — which owns the only call that writes it — is skipped entirely when nothing
    // else changed. Without this branch the index is rewritten only as a side effect of some
    // unrelated asset changing, so a change to the renderer, to a server's `doc`/`shortFlag`, or
    // to the resolved selection silently does nothing whenever the rest of the tree is current.
    applyMcpIndex({ scopeRoot: lifecycleView.plan.scopeRoot, selectedMcp: lifecycleView.plan.mcp, mode: 'apply' });
  }

  if (targets.includes('claude')) {
    // A npm-packaged tarball does not reliably preserve the executable bit on arbitrary files
    // (unlike git checkouts, which usually do) — copy-tree's mode-preserving copy only carries
    // over whatever bit the source file actually has on this machine, so this runs after
    // applyLifecycle (once the hook scripts are actually on disk) as a final, unconditional +x.
    chmodHooksExecutable(dirs.claude);
    if (mcp) {
      mcp.apply();
      console.log(`[INFO]   MCP servers -> ${mcp.destDescription} (${mcp.selected.join(', ') || 'none'})`);
    }
  }

  writeManifest({ claudeDir: dirs.claude, scriptVersion: pkg.version, operation: 'install', repoRoot: SCRIPT_DIR, sourceCommit: commit, backupId: bid, tools: targets, date: new Date(), mcpServers: mcpIds });

  // Pin what this install CHOSE. The ledger owns ownership; the lock owns selection — together
  // they make the next update's delta a reviewable fact instead of a surprise.
  const lockResult = recordLock(
    scope.global ? { scope: 'global', homeDir: os.homedir() } : { scope: 'project', projectRoot: path.resolve(scope.projectRoot) },
    lockDocument({
      registry, scope: codexScope(scope), scopeRoot: scope.global ? os.homedir() : path.resolve(scope.projectRoot), targets,
      mcpSelections: { claude: mcp?.selected ?? [], codex: codexCatalog ? codexMcpSelection : [] },
    }),
  );
  console.log(`[INFO] doflow.lock: ${lockResult.summary}`);

  if (o.prune > 0) {
    const pruned = pruneBackups(backupRoot, o.prune);
    if (pruned.length) console.error(`[INFO]  Pruned ${pruned.length} old backup(s)`);
  }

  console.log('[OK] Installation complete!');
}

module.exports = cmdInstall;
