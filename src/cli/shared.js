'use strict';
// Shared plumbing for the CLI command handlers (src/cli/commands/*) and their dispatch
// (src/cli/index.js, src/cli/runtime-commands.js). This module owns the facts every command
// needs: where the package root and the entrypoint directory are, the package version, the ONE
// adapter-registry factory, and the helpers more than one command uses (scope resolution, MCP
// selection, backup-table printing). Nothing here is harness-specific — native quirks belong in
// src/adapters/<id>/.
const os = require('node:os');
const path = require('node:path');
const { REPO_ROOT } = require('../helper/repo-root');
const { doflowPaths } = require('../install/paths');
const { readInstallManifest } = require('../install/manifest');
const { DEFAULT_BACKUP_RETENTION, formatBytes } = require('../install/backup');
const { stateRoot, readLedger } = require('../state');
const { readLock } = require('../state/lockfile');
const { acquireRunLock, RunLockTimeoutError, RunLockError, RunLockLostError } = require('../state/run-lock');
const { createAdapterRegistry } = require('../adapters');
const { declaredHarnessPaths } = require('../helper/harness-paths');
const claudeAdapter = require('../adapters/claude');
const codexAdapter = require('../adapters/codex');
const { createGeminiAdapter } = require('../adapters/gemini');
const { createOpenCodeAdapter } = require('../adapters/opencode');
const { createPiAdapter } = require('../adapters/pi');
const { createCopilotAdapter } = require('../adapters/copilot');
const { createKiroAdapter } = require('../adapters/kiro');
const { createAntigravityAdapter } = require('../adapters/antigravity');

// The directory of the `doflow` entrypoint. Derived from the shared package root rather than
// __dirname so its value survives this code physically moving between directories: manifests,
// backups and the source-commit lookup all record this exact path (<repo>/bin).
const SCRIPT_DIR = path.join(REPO_ROOT, 'bin');

// Tolerant because the projected runtime under `.doflow/runtime/` ships bin/, src/ and
// core/registry/ but no package.json — see the `runtime.*` assets in core/registry/assets.json.
// A hard require here would make every Node-backed verb fail in an install, which is the exact
// defect that projection exists to fix. Only version reporting depends on this.
function loadPkg() {
  try { return require('../../package.json'); } catch { return { version: '0.0.0-installed', name: '@khoavu882/doflow' }; }
}
const pkg = loadPkg();

/**
 * The one adapter registry construction, used by install/update/remove/reconcile. There used to
 * be three inline copies of the same construction (one per mutating command); a fourth variant
 * once grew in src/lifecycle/view.js and silently fell behind (fixed in 96006da) — which is why
 * the registry guard pins every declared harness into each call site by parsing them.
 * Build one here rather than copying the object literal again. Stage 3: each adapter factory
 * receives its harness's declared native paths from core/registry/harnesses.json, so the CLI
 * consumes exactly what the loader validates.
 */
function buildAdapterRegistry() {
  const declared = declaredHarnessPaths();
  return createAdapterRegistry({
    claude: claudeAdapter.createClaudeAdapter({ declaredPaths: declared.claude }),
    codex: codexAdapter.createCodexAdapter({ declaredPaths: declared.codex }),
    gemini: createGeminiAdapter({ declaredPaths: declared.gemini }),
    opencode: createOpenCodeAdapter({ declaredPaths: declared.opencode }),
    pi: createPiAdapter({ declaredPaths: declared.pi }),
    copilot: createCopilotAdapter({ declaredPaths: declared.copilot }),
    kiro: createKiroAdapter({ declaredPaths: declared.kiro }),
    antigravity: createAntigravityAdapter({ declaredPaths: declared.antigravity }),
  });
}

/** Resolve {global, projectRoot} scope options for src/install/targets.js#toolDirs from parsed args. */
function scopeOf(o) {
  return { global: o.global, projectRoot: o.positional[0] || '.' };
}

function installPaths(scope) {
  const scopeRoot = scope.global ? os.homedir() : path.resolve(scope.projectRoot);
  return doflowPaths({ scopeRoot });
}

/** Takes the scope's run lock for a mutating command, or returns null under --dry-run. A run that
 * cannot take it prints the one reason line and exits 1 before it has read or changed anything. */
function holdRunLock(o, scope, command) {
  if (o.dryRun) return null;
  try {
    return acquireRunLock({ scopeRoot: installPaths(scope).scopeRoot, scope: scope.global ? 'global' : 'project', command });
  } catch (err) {
    if (!(err instanceof RunLockTimeoutError || err instanceof RunLockError)) throw err;
    console.error(err.message);
    process.exit(1);
  }
}

/** After the confirm prompt: renews the hold, and exits 1 before the first write if another run
 * took the lock over while the prompt waited. */
function checkpointRunLock(hold) {
  if (!hold) return;
  try {
    hold.checkpoint();
  } catch (err) {
    if (!(err instanceof RunLockLostError)) throw err;
    console.error(err.message);
    process.exit(1);
  }
}

/** Surface a reconciled-away MCP server rather than dropping it silently: the user picked it once,
 * so its disappearance from their config should be explained, not discovered. */
function reportRetiredMcp(retired) {
  console.error(`[WARN]  Dropping MCP server(s) no longer in the registry: ${retired.join(', ')}`);
  console.error('        They were removed from DoFlow; your saved selection is being reconciled.');
}

/** The scope's doflow.lock, ledger and 1.18.0 manifest MCP list, as the MCP selection functions in
 * src/install/mcp.js read them. */
function scopeSelectionState(scope) {
  const scopeRoot = scope.global ? os.homedir() : path.resolve(scope.projectRoot);
  return {
    lock: readLock(scope.global ? { scope: 'global', homeDir: scopeRoot } : { scope: 'project', projectRoot: scopeRoot }),
    ledger: readLedger(stateRoot({ scope: scope.global ? 'global' : 'project', projectRoot: scopeRoot, homeDir: scopeRoot })),
    manifestServers: readInstallManifest({ scopeRoot })?.mcpServers ?? null,
  };
}

const MCP_SOURCE_WORDS = Object.freeze({ flag: '--mcp', prompt: 'prompt', recorded: 'recorded', kept: 'kept', manifest: 'remembered', default: 'default' });

/** The one line a run names its MCP selections in, from what the plan resolved for each harness:
 * harnesses with the same servers and source share a group, groups follow target order. Prints
 * nothing when no target takes MCP servers, except that an explicit --mcp is said to do nothing. */
function printMcpSelection(view, sources, { requested, prefix = '[INFO]' } = {}) {
  const groups = [];
  for (const target of view.plan.targets) {
    if (target.skipped || !Array.isArray(target.mcpSelected) || !(target.harness in sources)) continue;
    const ids = target.mcpSelected.join(', ') || 'none';
    const source = MCP_SOURCE_WORDS[sources[target.harness]];
    const group = groups.find((item) => item.ids === ids && item.source === source);
    if (group) group.harnesses.push(target.harness);
    else groups.push({ harnesses: [target.harness], ids, source });
  }
  if (groups.length) {
    console.log(`${prefix} MCP selection: ${groups.map((group) => `${group.harnesses.join(', ')}: ${group.ids} (${group.source})`).join('; ')}`);
  } else if (requested) {
    console.log(`${prefix} MCP: no targeted harness takes MCP servers; --mcp has no effect.`);
  }
}

/** Says which MCP entries a run with no native change recorded as DoFlow's (lifecycle
 * recordMcpOwnership), or, under --dry-run, would record. */
function printRecordedMcpOwnership(recorded, { dryRun = false } = {}) {
  for (const [harness, ids] of Object.entries(recorded)) {
    const what = `${ids.length} MCP ${ids.length === 1 ? 'entry' : 'entries'} (${ids.join(', ')})`;
    console.log(dryRun ? `[DRY]  ${harness}: would record DoFlow's ownership of ${what}` : `[INFO] ${harness}: recorded DoFlow's ownership of ${what}`);
  }
}

/** What each planned harness that takes MCP servers will hold, as doflow.lock records it. */
function plannedMcpSelections(view) {
  return Object.fromEntries(view.plan.targets.filter((target) => !target.skipped && Array.isArray(target.mcpSelected))
    .map((target) => [target.harness, target.mcpSelected]));
}

/** Total size of some rows, noting when any of them could not be measured. */
function rowsSize(rows) {
  const total = formatBytes(rows.reduce((sum, r) => sum + (r.bytes ?? 0), 0));
  return rows.some((r) => r.bytes === null) ? `${total} (some sizes unknown)` : total;
}

function printBackupTable(rows, rootLabel) {
  if (rows.length === 0) { console.log(`[INFO] No backups found in ${rootLabel}`); return; }
  const header = `${'BACKUP ID'.padEnd(42)} ${'OPERATION'.padEnd(14)} ${'TYPE'.padEnd(9)} ${'ORIGIN'.padEnd(9)} ${'SIZE'.padEnd(11)} TIMESTAMP`;
  console.log(`\n${header}`);
  console.log('─'.repeat(header.length));
  for (const r of rows) {
    const when = r.complete === false ? '- (incomplete: no manifest)' : r.timestamp;
    console.log(`${r.id.padEnd(42)} ${r.operation.padEnd(14)} ${r.type.padEnd(9)} ${r.origin.padEnd(9)} ${formatBytes(r.bytes).padEnd(11)} ${when}`);
  }
  console.log(`\n${rows.length} backup(s) in ${rootLabel}`);
  const current = rows.filter((r) => r.origin === 'current');
  const legacy = rows.filter((r) => r.origin === 'legacy');
  if (current.length) {
    console.log(`current: ${current.length} backup(s), ${rowsSize(current)}; install and update keep the newest ${DEFAULT_BACKUP_RETENTION} (--prune N)`);
  }
  if (legacy.length) {
    console.log(`legacy: ${legacy.length} backup(s), ${rowsSize(legacy)} in ${[...new Set(legacy.map((r) => r.backupRoot))].join(', ')}; read-only, never pruned`);
  }
  console.log('');
}

module.exports = {
  REPO_ROOT, SCRIPT_DIR, pkg, buildAdapterRegistry, scopeOf, installPaths, holdRunLock, checkpointRunLock,
  reportRetiredMcp, scopeSelectionState, printMcpSelection, printRecordedMcpOwnership, plannedMcpSelections, printBackupTable,
};
