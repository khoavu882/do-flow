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
const { stateRoot, readLedger } = require('../state');
const { readLock } = require('../state/lockfile');
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

/** What each planned harness that takes MCP servers will hold, as doflow.lock records it. */
function plannedMcpSelections(view) {
  return Object.fromEntries(view.plan.targets.filter((target) => !target.skipped && Array.isArray(target.mcpSelected))
    .map((target) => [target.harness, target.mcpSelected]));
}

function printBackupTable(rows, backupRoot) {
  if (rows.length === 0) { console.log(`[INFO] No backups found in ${backupRoot}`); return; }
  console.log(`\n${'BACKUP ID'.padEnd(42)} ${'OPERATION'.padEnd(14)} ${'TYPE'.padEnd(9)} TIMESTAMP`);
  console.log('─'.repeat(85));
  for (const r of rows) console.log(`${r.id.padEnd(42)} ${r.operation.padEnd(14)} ${r.type.padEnd(9)} ${r.timestamp}`);
  console.log(`\n${rows.length} backup(s) in ${backupRoot}\n`);
}

module.exports = {
  REPO_ROOT, SCRIPT_DIR, pkg, buildAdapterRegistry, scopeOf, installPaths,
  reportRetiredMcp, scopeSelectionState, printMcpSelection, plannedMcpSelections, printBackupTable,
};
