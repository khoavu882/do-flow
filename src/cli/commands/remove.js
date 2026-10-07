'use strict';
// `doflow remove` — remove only lifecycle-owned native resources; user-owned files are preserved
// and what remains standing (shared destinations) is reported, not implied.
const os = require('node:os');
const path = require('node:path');
const { resolveTargets, toolDirs } = require('../../install/targets');
const { confirm } = require('../../helper/prompt');
const { loadRegistry } = require('../../registry');
const { removeLifecycle, retentionSummary } = require('../../lifecycle');
const {
  codexScope, registryLifecycleView, printRegistryLifecycle, LIFECYCLE_HARNESSES,
  assertSafeRegistryPlan, lockDocument, recordLock,
} = require('../../lifecycle/view');
const { recordedMcpSelections } = require('../../install/mcp');
const { REPO_ROOT, scopeOf, scopeSelectionState, buildAdapterRegistry } = require('../shared');

function cmdRemove(o) {
  const targets = resolveTargets(o.targets);
  const scope = scopeOf(o);
  const dirs = toolDirs(scope);
  const lifecycleTargets = targets.filter((t) => LIFECYCLE_HARNESSES.includes(t));
  if (!lifecycleTargets.length) {
    console.log('[INFO] No lifecycle-owned native resources selected; legacy compatibility assets are never broadly removed.');
    return;
  }
  const registry = loadRegistry({ repoRoot: REPO_ROOT });
  // Read before the removal rewrites the ledger: an entry DoFlow wrote before it kept MCP rows is
  // removed only while it still equals DoFlow's own rendering.
  const { lock, ledger, manifestServers } = scopeSelectionState(scope);
  // No selection: every removed harness's MCP selection is none, so it removes what it owns. The
  // harnesses that stay keep their recorded servers in the MCP index.
  const { adoptable: mcpAdoptable, retainedMcpIds } = recordedMcpSelections({ registry, lock, ledger, targets: lifecycleTargets, manifestServers });
  const view = registryLifecycleView({ registry, repoRoot: REPO_ROOT, scope, dirs, targets: lifecycleTargets, mcpAdoptable, retainedMcpIds, operation: 'remove',
    permissions: o.permissions === true, statusline: o.statusline === true });
  if (!view.plan.safe) { assertSafeRegistryPlan(view); return; }
  if (o.dryRun) {
    printRegistryLifecycle(view, '[DRY]');
    console.log('[DRY] Remove plan complete — no changes written');
    return;
  }
  if (!confirm(`Remove DoFlow-owned native resources for: ${lifecycleTargets.join(', ')}? User-owned files are preserved.`, o.force)) {
    // Exit 1, not 0: a declined prompt is a decision, and it must not share an exit code with a
    // completed run. With no stdin the prompt auto-declines, so `doflow install <path>` in a script
    // or CI step printed "Aborted.", wrote zero files, and reported success. It also silently
    // corrupted a set of install-timing measurements during the D.4 sweep, which is how it surfaced.
    console.error('[INFO]  Aborted.');
    process.exit(1);
  }
  const result = removeLifecycle({ registry: view.registry,
    adapters: buildAdapterRegistry(),
    scope: codexScope(scope), scopeRoot: scope.global ? os.homedir() : path.resolve(scope.projectRoot),
    targets: lifecycleTargets, mcpAdoptable, retainedMcpIds, stateRoot: view.stateRoot, ledger: view.ledger,
    context: view.plan.targets[0].adapterInput.context });
  // Shared destinations (one .doflow/scripts tree for claude/codex/gemini, one .agents for
  // gemini/copilot) mean a removal can legitimately leave files standing. Saying only "removed"
  // would be half the truth, so what was kept and who still claims it is printed, not implied.
  for (const line of retentionSummary(result.retained)) console.log(`[INFO] ${line}`);
  console.log(`[OK] Removed ${result.ledger.resources.length === 0 ? 'all' : 'eligible'} native resource(s) for ${lifecycleTargets.join(', ')}; ${result.ledger.resources.length} owned record(s) remain.`);

  // Re-pin what still stands: every harness the ledger still holds keeps its pin and its recorded
  // selection, a removed harness with nothing left leaves the lock, and the lock goes only when no
  // harness remains. Shared destinations are handled naturally — their claims belong to whichever
  // harness still holds them in the ledger.
  const next = lockDocument({ registry, scope: codexScope(scope), scopeRoot: scope.global ? os.homedir() : path.resolve(scope.projectRoot),
    previous: lock, ledger: result.ledger });
  const removalLock = recordLock(scope.global ? { scope: 'global', homeDir: os.homedir() } : { scope: 'project', projectRoot: path.resolve(scope.projectRoot) }, next);
  if (lock || next) console.log(`[INFO] doflow.lock: ${removalLock.summary}`);
}

module.exports = cmdRemove;
