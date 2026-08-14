#!/usr/bin/env node
'use strict';
// doflow — DoFlow config installer CLI. Installs/updates/removes Claude, Codex, and Gemini
// framework content via the registry/lifecycle path (src/registry, src/adapters/, src/lifecycle).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveTargets, toolDirs } = require('../src/targets');
const { resolveContext, printContext } = require('../src/context');
const { createBackup, restoreBackup, listBackups, pruneBackups } = require('../src/backup');
const { writeManifest, readManifest } = require('../src/manifest');
const { confirm, promptLine } = require('../src/prompt');
const { sourceCommit } = require('../src/git');
const { chmodHooksExecutable } = require('../src/settings-scope');
const { readCodexMcpCatalog, resolveCodexMcpSelection } = require('../src/codex-mcp');
const {
  readAllServers, filterServerDefs, writeProjectMcpJson, mergeGlobalMcpServers,
  resolveMcpSelection, promptMcpCheckbox,
} = require('../src/mcp');
const { execFileSync } = require('node:child_process');
const { loadRegistry } = require('../src/registry');
const { createAdapterRegistry } = require('../src/adapters');
const claudeAdapter = require('../src/adapters/claude');
const codexAdapter = require('../src/adapters/codex');
const { createGeminiAdapter } = require('../src/adapters/gemini');
const { applyLifecycle, removeLifecycle, applyMcpIndex } = require('../src/lifecycle');
const { readLedger } = require('../src/state');
const { codexScope, registryLifecycleView, printRegistryLifecycle, LIFECYCLE_HARNESSES, assertSafeRegistryPlan } = require('../src/lifecycle-view');
const { commandText, planToolLifecycle, executeToolLifecycle } = require('../src/tool-lifecycle');
const { handleCapabilitiesCommand, handleDoctorCommand, handleReadinessCommand, handleEvidenceCommand } = require('../src/runtime/cli');

const SCRIPT_DIR = __dirname; // bin/
const REPO_ROOT = path.dirname(SCRIPT_DIR);
const pkg = require('../package.json');

/** "skip all backup protection" must be an explicit, deliberate choice, never a default combo. */
function assertNoBackupRequiresForce(o) {
  if (o.noBackup && !o.force) {
    console.error('doflow: --no-backup skips all backup protection and requires --force');
    process.exit(1);
  }
}

function parseArgs(argv) {
  const o = { cmd: null, positional: [], targets: [], mcp: null, dryRun: false, force: false,
    noBackup: false, prune: 0, global: false, json: false, help: false, version: false,
    tools: null, action: 'status' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '-v': case '--version': o.version = true; break;
      case '-n': case '--dry-run': o.dryRun = true; break;
      case '-f': case '--force': o.force = true; break;
      case '-g': case '--global': o.global = true; break;
      case '--no-backup': o.noBackup = true; break;
      case '--json': o.json = true; break;
      case '--check': o.check = true; break;
      case '-t': case '--target': {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('-')) { console.error(`doflow: ${a} requires a value`); process.exit(1); }
        o.targets = val.split(',').map((s) => s.trim()).filter(Boolean); i++; break;
      }
      case '--mcp': {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('-')) { console.error(`doflow: ${a} requires a value`); process.exit(1); }
        o.mcp = val.split(',').map((s) => s.trim()).filter(Boolean); i++; break;
      }
      case '--tool': {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('-')) { console.error(`doflow: ${a} requires a value`); process.exit(1); }
        o.tools = val.split(',').map((s) => s.trim()).filter(Boolean); i++; break;
      }
      case '--action': {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('-')) { console.error(`doflow: ${a} requires a value`); process.exit(1); }
        o.action = val; i++; break;
      }
      case '--task-class': {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('-')) { console.error(`doflow: ${a} requires a value`); process.exit(1); }
        o.taskClass = val; i++; break;
      }
      case '--task-id': {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('-')) { console.error(`doflow: ${a} requires a value`); process.exit(1); }
        o.taskId = val; i++; break;
      }
      case '--prune': {
        const val = argv[i + 1];
        if (val === undefined || val.startsWith('-')) { console.error(`doflow: ${a} requires a number`); process.exit(1); }
        o.prune = parseInt(val, 10) || 0; i++; break;
      }
      default:
        if (a.startsWith('-')) { console.error(`doflow: unknown flag '${a}'`); process.exit(1); }
        else if (!o.cmd) o.cmd = a;
        else o.positional.push(a);
    }
  }
  return o;
}

/** Resolve {global, projectRoot} scope options for src/targets.js#toolDirs from parsed args. */
function scopeOf(o) {
  return { global: o.global, projectRoot: o.positional[0] || '.' };
}

const HELP = `doflow — DoFlow config installer

Usage: doflow <command> [path] [options]

Commands:
  install [path]       Install configs to target tools (use --dry-run to preview)
  update               Incremental update of changed files only
  status               Show resolved context + installed state from manifest (--json for scripting)
  rollback [id]        Restore from a backup (interactive pick if id omitted)
  remove [path]        Remove only lifecycle-owned native resources
  list-backups         List available backups
  self-update          git pull + reinstall
  tools                Inspect or manage registered external tools
  capabilities         Show registered abstract capabilities and resolved providers
  doctor               System health and capability smoke check diagnostics
  readiness            Evaluate task readiness contract (--task-class, --task-id)
  evidence             Inspect recorded task evidence items (--task-id)

Scope (mutually exclusive — global wins if both given):
  -g, --global         Install to \$HOME/.{claude,codex,gemini}
  [path]               Project-scoped install root (default: '.', i.e. cwd); e.g.
                       'doflow install ../my-app' -> ../my-app/.claude/, .codex/, .gemini/
                       (rollback's one positional slot is the backup id instead — its scope is
                       always -g or cwd, no custom project path)

Options:
  -t, --target <list>  Comma-separated: claude,codex,gemini (default: all)
      --mcp <list>     Comma-separated MCP server names to install (default: all; omit to be
                       prompted interactively on a real terminal). Remembered for later 'update'
                       runs. Applies to Claude and Codex when targeted.
  -n, --dry-run        Preview without writing
  -f, --force          Skip confirmation prompts
      --no-backup      Skip backup (requires --force; ignored by rollback's safety snapshot)
      --prune <N>      Keep only N most recent backups
      --json           Machine-readable output (status)

External tools:
      --tool <list>    Comma-separated: rtk,graphify (required outside an interactive terminal)
      --action <name>  status (default), install, update, or uninstall
                       --force is intentionally unavailable: every mutation is separately confirmed
  -h, --help           Show help
  -v, --version        Show version`;

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
  const selected = resolveMcpSelection({ cmd, requested: o.mcp, allServers, manifestServers, interactive, promptFn: promptMcpCheckbox });
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
    interactive: !o.dryRun && !o.force && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY), promptFn: promptMcpCheckbox })) : [];
  const mcpIds = mcp?.selected ?? (codexCatalog ? codexMcpSelection : undefined);
  // One lifecycle view across every requested target — computed unconditionally (not only under
  // --dry-run) so its safety gate and its plan are the exact same object the real apply below uses.
  const lifecycleView = registryLifecycleView({ registry, repoRoot: REPO_ROOT, scope, dirs, targets, mcpIds });
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
    console.error('[INFO]  Aborted.');
    return;
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
      adapters: createAdapterRegistry({ claude: claudeAdapter, codex: codexAdapter, gemini: createGeminiAdapter() }),
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

  if (o.prune > 0) {
    const pruned = pruneBackups(backupRoot, o.prune);
    if (pruned.length) console.error(`[INFO]  Pruned ${pruned.length} old backup(s)`);
  }

  console.log('[OK] Installation complete!');
}

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
    allServers: codexCatalog.allServers, manifestServers: existingManifest?.mcpServers ?? null, interactive: false, promptFn: promptMcpCheckbox })) : [];
  const mcpIds = mcp?.selected ?? (codexCatalog ? codexMcpSelection : undefined);
  // One lifecycle view across every requested target — computed unconditionally (not only under
  // --dry-run) so its safety gate and its plan are the exact same object the real apply below uses.
  const lifecycleView = registryLifecycleView({ registry, repoRoot: REPO_ROOT, scope, dirs, targets, mcpIds });
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
    console.error('[INFO]  Aborted.');
    return;
  }

  let bid = '';
  // Nothing outside dirs[tool] needs backing up for an MCP-only change — ~/.claude.json /
  // <project>/.mcp.json are outside the tool dir by design (see src/mcp.js), so a backup is only
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
      adapters: createAdapterRegistry({ claude: claudeAdapter, codex: codexAdapter, gemini: createGeminiAdapter() }),
      stateRoot: lifecycleView.stateRoot, ledger: lifecycleView.ledger });
    for (const target of lifecycleView.plan.targets) {
      if (target.skipped || !target.changes.length) continue;
      const owned = result.ledger.resources.filter((resource) => resource.harness === target.harness).length;
      console.log(`[INFO] ${target.harness}: lifecycle verified (${owned} owned resource(s))`);
    }
  }
  if (targets.includes('claude')) chmodHooksExecutable(dirs.claude);

  writeManifest({ claudeDir: dirs.claude, scriptVersion: pkg.version, operation: 'update', repoRoot: SCRIPT_DIR, sourceCommit: commit, backupId: bid, tools: targets, date: new Date(), mcpServers: mcpIds });

  if (o.prune > 0) {
    const pruned = pruneBackups(backupRoot, o.prune);
    if (pruned.length) console.error(`[INFO]  Pruned ${pruned.length} old backup(s)`);
  }

  console.log('[OK] Update complete!');
}

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
  const view = registryLifecycleView({ registry, repoRoot: REPO_ROOT, scope, dirs, targets: lifecycleTargets, mcpIds: [], operation: 'remove' });
  if (!view.plan.safe) { assertSafeRegistryPlan(view); return; }
  if (o.dryRun) {
    printRegistryLifecycle(view, '[DRY]');
    console.log('[DRY] Remove plan complete — no changes written');
    return;
  }
  if (!confirm(`Remove DoFlow-owned native resources for: ${lifecycleTargets.join(', ')}? User-owned files are preserved.`, o.force)) {
    console.error('[INFO]  Aborted.');
    return;
  }
  const result = removeLifecycle({ registry: view.registry,
    adapters: createAdapterRegistry({ claude: claudeAdapter, codex: codexAdapter, gemini: createGeminiAdapter() }),
    scope: codexScope(scope), scopeRoot: scope.global ? os.homedir() : path.resolve(scope.projectRoot),
    targets: lifecycleTargets, mcpIds: [], stateRoot: view.stateRoot, ledger: view.ledger,
    context: view.plan.targets[0].adapterInput.context });
  console.log(`[OK] Removed ${result.ledger.resources.length === 0 ? 'all' : 'eligible'} native resource(s) for ${lifecycleTargets.join(', ')}; ${result.ledger.resources.length} owned record(s) remain.`);
}

function cmdStatus(o) {
  const targets = resolveTargets(o.targets);
  const scope = scopeOf(o);
  const dirs = toolDirs(scope);
  const ctx = resolveContext({ repoRoot: REPO_ROOT, targets, dirs, sourceCommit: sourceCommit(SCRIPT_DIR), ...scope });
  const manifest = readManifest(dirs.claude);
  let registryView = null;
  try {
    const registry = loadRegistry({ repoRoot: REPO_ROOT });
    registryView = registryLifecycleView({ registry, repoRoot: REPO_ROOT, scope, dirs, targets,
      mcpIds: manifest?.mcpServers ?? undefined });
    ctx.registry = {
      directory: registryView.registry.directory,
      versions: registryView.registry.versions,
      stateRoot: registryView.stateRoot,
      ledgerPresent: Boolean(readLedger(registryView.stateRoot)),
      plan: { changes: registryView.plan.changes.length, conflicts: registryView.plan.conflicts, prerequisites: registryView.plan.prerequisites },
    };
    // Per-harness status must derive from that harness's own plan target, not the flattened
    // registryView.plan.changes/conflicts across every target — otherwise, e.g., Codex having
    // pending changes when it isn't installed yet would make Claude's line falsely report
    // 'drift-or-pending-change' even though Claude itself has nothing pending.
    const harnessPlan = (harness) => registryView.plan.targets.find((target) => target.harness === harness);
    const harnessStatus = (harness) => {
      const target = harnessPlan(harness);
      if (!target) return { status: 'verified', resources: [], errors: [] };
      return {
        status: target.conflicts.length ? 'conflict-or-invalid' : (target.changes.length ? 'drift-or-pending-change' : 'verified'),
        resources: registryView.ledger.resources.filter((resource) => resource.harness === harness),
        errors: target.conflicts,
      };
    };
    if (targets.includes('codex')) {
      ctx.codex = { ...harnessStatus('codex'), hooksTrust: { required: true, trusted: false, status: 'review-required' } };
    }
    if (targets.includes('claude')) {
      ctx.claude = harnessStatus('claude');
    }
    if (targets.includes('gemini')) {
      ctx.gemini = harnessStatus('gemini');
    }
  } catch (error) {
    // Status must remain usable for an existing installation even if a local registry is invalid.
    ctx.registry = { status: 'invalid', error: error.message };
  }

  if (o.json) {
    console.log(JSON.stringify({ context: ctx, manifest, codex: ctx.codex ?? null }, null, 2));
    return;
  }

  printContext(ctx);
  if (!manifest) {
    console.log("[WARN] No install manifest found — run 'doflow install' to get started");
    return;
  }

  console.log('\nInstall Status');
  console.log(`  Last operation:       ${manifest.operation}`);
  console.log(`  Last run:             ${manifest.lastRun}`);
  console.log(`  Source commit:        ${manifest.sourceCommit}`);
  console.log(`  Last backup ID:       ${manifest.backupId}`);
  console.log(`  Script version:       ${manifest.scriptVersion}`);
  console.log(`  MCP servers:          ${manifest.mcpServers ? manifest.mcpServers.join(', ') || 'none' : 'all (default)'}`);
  if (ctx.codex) {
    console.log(`  Codex verification:   ${ctx.codex.status}`);
    console.log(`  Codex resources:      ${ctx.codex.resources.length} manifest-owned`);
    console.log(`  Codex hook trust:     ${ctx.codex.hooksTrust?.status ?? 'not configured'}${ctx.codex.hooksTrust?.required ? ' (review required)' : ''}`);
    if (ctx.codex.errors.length) console.log(`  Codex issues:         ${ctx.codex.errors.join('; ')}`);
    console.log('  Codex capability gaps: no Claude-only event emulation is installed; review docs/capability-map.md#codex-capability-detail');
  }
  if (ctx.claude) {
    console.log(`  Claude verification:  ${ctx.claude.status}`);
    console.log(`  Claude resources:     ${ctx.claude.resources.length} manifest-owned`);
    if (ctx.claude.errors.length) console.log(`  Claude issues:        ${ctx.claude.errors.join('; ')}`);
  }
  if (ctx.gemini) {
    console.log(`  Gemini verification:  ${ctx.gemini.status}`);
    console.log(`  Gemini resources:     ${ctx.gemini.resources.length} manifest-owned`);
    if (ctx.gemini.errors.length) console.log(`  Gemini issues:        ${ctx.gemini.errors.join('; ')}`);
  }
  if (ctx.registry) {
    console.log(`  Registry lifecycle:   ${ctx.registry.status === 'invalid' ? ctx.registry.error : `${ctx.registry.plan.changes} pending, ${ctx.registry.plan.conflicts.length} conflict(s)`}`);
    if (ctx.registry.status !== 'invalid') console.log(`  Neutral state:         ${ctx.registry.stateRoot}${ctx.registry.ledgerPresent ? ' (ledger present)' : ' (not yet created)'}`);
  }
  console.log('\n  TOOL         STATUS         LAST UPDATED');
  for (const tool of ['claude', 'codex', 'gemini']) {
    const t = manifest.tools[tool];
    const status = t?.installed ? 'installed' : 'not installed';
    console.log(`  ${tool.padEnd(12)} ${status.padEnd(14)} ${t?.last_updated ?? 'never'}`);
  }
}

function selectExternalTools(registry, o) {
  let requested = o.tools;
  if (!requested) {
    const interactive = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
    if (!interactive) throw new Error("doflow tools: --tool is required when stdin is not an interactive terminal");
    const answer = promptLine('Select tools (rtk, graphify; comma-separated): ');
    requested = answer.split(',').map((item) => item.trim()).filter(Boolean);
  }
  if (!requested.length) throw new Error('doflow tools: select at least one tool');
  const available = new Set(registry.externalTools.map((tool) => tool.id));
  const unknown = [...new Set(requested)].filter((id) => !available.has(id));
  if (unknown.length) throw new Error(`doflow tools: unknown tool id(s): ${unknown.join(', ')}; expected: ${[...available].join(', ')}`);
  const wanted = new Set(requested);
  return registry.externalTools.filter((tool) => wanted.has(tool.id));
}

function toolJsonResults(plan, execution = null) {
  const executed = new Map((execution?.results || []).map((result) => [result.tool, result]));
  return plan.tools.map((item) => ({
    tool: item.tool.id,
    state: item.state,
    inspections: item.inspections,
    prerequisites: item.prerequisites.map((prerequisite) => ({ name: prerequisite.name, available: prerequisite.available })),
    action: item.action,
    result: executed.get(item.tool.id) ?? (item.action.applicable
      ? { tool: item.tool.id, status: 'not-attempted', command: [...item.action.command] }
      : { tool: item.tool.id, status: 'skipped', reason: item.action.reason }),
  }));
}

function cmdTools(o) {
  if (o.force) throw new Error("doflow tools: --force is not supported; each lifecycle command requires its own confirmation");
  if (!['status', 'install', 'update', 'uninstall'].includes(o.action)) {
    throw new Error(`doflow tools: unsupported action '${o.action}'; expected: status, install, update, uninstall`);
  }
  const registry = loadRegistry({ repoRoot: REPO_ROOT });
  const tools = selectExternalTools(registry, o);
  const plan = planToolLifecycle({ registry: { ...registry, externalTools: tools }, action: o.action });

  if (o.dryRun) {
    if (!o.json) {
      console.log(`[DRY] External-tool ${o.action} plan:`);
      for (const item of plan.tools) {
        if (item.action.applicable) console.log(`[DRY]  ${item.tool.id}: ${commandText(item.action.command)}`);
        else console.log(`[DRY]  ${item.tool.id}: skipped (${item.action.reason})`);
      }
      console.log('[DRY] Dry run complete — no lifecycle commands executed');
    }
    if (o.json) console.log(JSON.stringify({ action: o.action, dryRun: true, results: toolJsonResults(plan) }, null, 2));
    return;
  }

  if (o.action === 'status') {
    if (o.json) {
      console.log(JSON.stringify({ action: o.action, dryRun: false, results: toolJsonResults(plan) }, null, 2));
      return;
    }
    for (const item of plan.tools) {
      console.log(`${item.tool.displayName}: ${item.state}${item.action.reason ? ` (${item.action.reason})` : ''}`);
    }
    return;
  }

  const execution = executeToolLifecycle({
    plan,
    displayCommand: (command, tool) => console.error(`[INFO]  ${tool.displayName}: ${commandText(command)}`),
    confirmCommand: (command, tool, action) => confirm(`Run ${tool.displayName} ${action}: ${commandText(command)}?`, false),
  });
  // Keep processing independent tools so the user receives every outcome, but make a confirmed
  // command failure visible to scripts and CI through the process result as well as the report.
  const hasFailures = execution.results.some((result) => result.status === 'failed');
  if (o.json) {
    console.log(JSON.stringify({ action: o.action, dryRun: false, results: toolJsonResults(plan, execution) }, null, 2));
    if (hasFailures) process.exitCode = 1;
    return;
  }
  for (const result of execution.results) {
    console.log(`${result.tool}: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
  }
  if (hasFailures) process.exitCode = 1;
}

function printBackupTable(rows, backupRoot) {
  if (rows.length === 0) { console.log(`[INFO] No backups found in ${backupRoot}`); return; }
  console.log(`\n${'BACKUP ID'.padEnd(42)} ${'OPERATION'.padEnd(14)} ${'TYPE'.padEnd(9)} TIMESTAMP`);
  console.log('─'.repeat(85));
  for (const r of rows) console.log(`${r.id.padEnd(42)} ${r.operation.padEnd(14)} ${r.type.padEnd(9)} ${r.timestamp}`);
  console.log(`\n${rows.length} backup(s) in ${backupRoot}\n`);
}

function cmdListBackups(o) {
  // rollback/list-backups don't take a project-path positional (their one positional slot is the
  // backup id for rollback) — scope is -g/--global vs default project rooted at cwd.
  const dirs = toolDirs({ global: o.global, projectRoot: '.' });
  const backupRoot = path.join(dirs.claude, 'backups');
  printBackupTable(listBackups(backupRoot), backupRoot);
}

function cmdRollback(o) {
  const targets = resolveTargets(o.targets);
  const dirs = toolDirs({ global: o.global, projectRoot: '.' });
  const backupRoot = path.join(dirs.claude, 'backups');
  const commit = sourceCommit(SCRIPT_DIR);
  printContext(resolveContext({ repoRoot: REPO_ROOT, targets, dirs, sourceCommit: commit, global: o.global, projectRoot: '.' }));

  let bid = o.positional[0] || '';
  if (!bid) {
    printBackupTable(listBackups(backupRoot), backupRoot);
    bid = promptLine('Enter backup ID to restore (or press Enter to cancel): ');
    if (!bid) { console.error('[INFO]  Aborted.'); return; }
  }

  // PARITY-with-UX: install/update skip the confirm prompt entirely under --dry-run (nothing
  // destructive happens, so there's nothing to confirm) — rollback used to prompt regardless of
  // --dry-run, which meant a non-interactive `doflow rollback <id> --dry-run` (no --force) would
  // block on stdin instead of just previewing. Match install/update's convention here.
  if (!o.dryRun && !confirm(`Restore from '${bid}'? This overwrites your current config.`, o.force)) {
    console.error('[INFO]  Aborted.');
    return;
  }

  // sync.sh always takes a pre-rollback safety snapshot, regardless of --no-backup — rollback is
  // destructive enough that skipping this specific backup isn't offered.
  console.error('[INFO]  Creating pre-rollback safety snapshot...');
  createBackup({ operation: 'pre-rollback', tools: targets, dirs, backupRoot, repoRoot: SCRIPT_DIR, sourceCommit: commit, date: new Date(), dryRun: o.dryRun });

  // Restore only the tools the snapshot just covered — restoring a tool the safety snapshot
  // didn't include would leave that tool's overwrite with no way back.
  const targetDirs = Object.fromEntries(targets.map((t) => [t, dirs[t]]));
  try {
    restoreBackup({ bid, backupRoot, dirs: targetDirs, dryRun: o.dryRun });
  } catch (e) {
    console.error(`[ERROR] ${e.message}`);
    console.error('[ERROR] Use --list-backups to see available backups');
    process.exit(1);
  }

  writeManifest({ claudeDir: dirs.claude, scriptVersion: pkg.version, operation: 'rollback', repoRoot: SCRIPT_DIR, sourceCommit: commit, backupId: bid, tools: targets, date: new Date(), dryRun: o.dryRun });

  console.log(o.dryRun ? '[DRY] Dry run complete' : `[OK] Rollback to '${bid}' complete!`);
}

function cmdSelfUpdate(o) {
  console.log('[INFO] Self-update: checking for upstream changes...');
  let pulled = false;
  let fetchOk = false;
  try {
    execFileSync('git', ['-C', REPO_ROOT, 'fetch', '--depth=1', 'origin'], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10000 });
    fetchOk = true;
  } catch {
    console.error('[WARN]  git fetch failed (offline or no remote configured) — installing from current HEAD');
  }
  if (fetchOk) {
    try {
      execFileSync('git', ['-C', REPO_ROOT, 'pull', '--ff-only'], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10000 });
      pulled = true;
      const commit = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--short', 'HEAD']).toString().trim();
      console.log(`[INFO] Updated to commit: ${commit}`);
    } catch {
      console.error('[WARN]  Fast-forward not possible — using current local state');
    }
  }
  console.log(`[INFO] Running install (after ${pulled ? 'a git pull' : 'checking for updates'})...`);
  cmdInstall(o);
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.version) { console.log(pkg.version); return; }
  if (o.help || !o.cmd) { console.log(HELP); return; }
  assertNoBackupRequiresForce(o);
  try {
    switch (o.cmd) {
      case 'install': return cmdInstall(o);
      case 'update': return cmdUpdate(o);
      case 'remove': return cmdRemove(o);
      case 'status': return cmdStatus(o);
      case 'rollback': return cmdRollback(o);
      case 'list-backups': return cmdListBackups(o);
      case 'self-update': return cmdSelfUpdate(o);
      case 'tools': return cmdTools(o);
      case 'capabilities': return handleCapabilitiesCommand({ json: o.json, check: o.check, repoRoot: REPO_ROOT });
      case 'doctor': return handleDoctorCommand({ json: o.json, repoRoot: REPO_ROOT });
      case 'readiness': return handleReadinessCommand({ taskClass: o.taskClass || 'feature', taskId: o.taskId || 'default', json: o.json, repoRoot: REPO_ROOT });
      case 'evidence': return handleEvidenceCommand({ taskId: o.taskId || 'default', json: o.json, repoRoot: REPO_ROOT });
      default: console.error(`doflow: unknown command '${o.cmd}'`); process.exit(1);
    }
  } catch (error) {
    // A lifecycle apply/remove can throw mid-mutation (fs error, TOCTOU ownership mismatch on a
    // multi-harness run) — surface a clean, actionable message instead of a raw stack trace, and
    // point at the recovery record applyLifecycle already wrote before rethrowing.
    console.error(`[ERROR] ${error.message}`);
    console.error('[ERROR] Some native resources may be partially applied — check .doflow/state/recovery/ (or ~/.doflow/state/recovery/ for -g) for the latest record before retrying.');
    process.exit(1);
  }
}
main();
