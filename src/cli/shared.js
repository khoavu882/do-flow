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
const { readManifest } = require('../install/manifest');
const {
  readAllServers, filterServerDefs, writeProjectMcpJson, mergeGlobalMcpServers,
  resolveMcpSelection, promptMcpCheckbox,
} = require('../install/mcp');
const { createAdapterRegistry } = require('../adapters');
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
 * test/guards/registry.test.js pins every declared harness into each call site by parsing them.
 * Build one here rather than copying the object literal again.
 */
function buildAdapterRegistry() {
  return createAdapterRegistry({
    claude: claudeAdapter, codex: codexAdapter, gemini: createGeminiAdapter(),
    opencode: createOpenCodeAdapter(), pi: createPiAdapter(), copilot: createCopilotAdapter(),
    kiro: createKiroAdapter(), antigravity: createAntigravityAdapter(),
  });
}

/** Resolve {global, projectRoot} scope options for src/install/targets.js#toolDirs from parsed args. */
function scopeOf(o) {
  return { global: o.global, projectRoot: o.positional[0] || '.' };
}

/** Surface a reconciled-away MCP server rather than dropping it silently: the user picked it once,
 * so its disappearance from their config should be explained, not discovered. */
function reportRetiredMcp(retired) {
  console.error(`[WARN]  Dropping MCP server(s) no longer in the registry: ${retired.join(', ')}`);
  console.error('        They were removed from DoFlow; your saved selection is being reconciled.');
}

/**
 * Resolve (but don't yet apply) the MCP server selection for a 'claude' target, plus a closure to
 * apply it. Called once per invocation, before any dry-run/confirm branching, so an interactive
 * prompt (install only, real TTY, no --force/--dry-run) fires at most once and its result can be
 * reused for both the dry-run preview and the real write.
 * @returns {{allServers:string[], selected:string[], changed:boolean, destDescription:string, apply:()=>void}|null}
 *          null if the registry declares no MCP servers (nothing to resolve).
 */
function resolveMcpForTool({ o, dirs, scope, cmd, registry }) {
  const allServers = readAllServers(registry);
  if (!allServers.length) return null;
  const manifestServers = readManifest(dirs.claude)?.mcpServers ?? null;
  const interactive = cmd === 'install' && !o.dryRun && !o.force && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
  const selected = resolveMcpSelection({ cmd, requested: o.mcp, allServers, manifestServers, interactive, promptFn: promptMcpCheckbox, onStale: reportRetiredMcp });
  const baseline = manifestServers ?? allServers;
  const changed = [...baseline].sort().join(',') !== [...selected].sort().join(',');
  const projectRoot = path.dirname(dirs.claude); // == os.homedir() when scope.global, by construction
  const destDescription = scope.global ? '~/.claude.json (mcpServers)' : path.join(projectRoot, '.mcp.json');
  const apply = () => {
    const serverDefs = filterServerDefs(registry, allServers, selected);
    if (scope.global) mergeGlobalMcpServers(os.homedir(), allServers, serverDefs);
    else writeProjectMcpJson(projectRoot, allServers, serverDefs);
  };
  return { allServers, selected, changed, destDescription, apply };
}

function printBackupTable(rows, backupRoot) {
  if (rows.length === 0) { console.log(`[INFO] No backups found in ${backupRoot}`); return; }
  console.log(`\n${'BACKUP ID'.padEnd(42)} ${'OPERATION'.padEnd(14)} ${'TYPE'.padEnd(9)} TIMESTAMP`);
  console.log('─'.repeat(85));
  for (const r of rows) console.log(`${r.id.padEnd(42)} ${r.operation.padEnd(14)} ${r.type.padEnd(9)} ${r.timestamp}`);
  console.log(`\n${rows.length} backup(s) in ${backupRoot}\n`);
}

module.exports = {
  REPO_ROOT, SCRIPT_DIR, pkg, buildAdapterRegistry, scopeOf,
  reportRetiredMcp, resolveMcpForTool, printBackupTable,
};
