#!/usr/bin/env node
'use strict';
// doflow — DoFlow config installer CLI (replaces bin/sync.sh). Installer-only.
// Built incrementally with a parity gate (test/cli-parity.sh) vs sync.sh.
// Phase A: arg parsing + mappings/targets + `install` (dry-run preview + real copy).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readMappings } = require('../src/mappings');
const { resolveTargets, toolDirs } = require('../src/targets');
const { planFiles, installTool, copyFilePreservingMeta, assertWithinRoot } = require('../src/copy');
const { mergeMarkedSection } = require('../src/claude-md-merge');
const { resolveContext, printContext } = require('../src/context');
const { createBackup, restoreBackup, listBackups, pruneBackups } = require('../src/backup');
const { writeManifest, readManifest } = require('../src/manifest');
const { confirm, promptLine } = require('../src/prompt');
const { diffFiles } = require('../src/diff');
const { sourceCommit } = require('../src/git');
const { rewriteHookPathsForProjectScope } = require('../src/settings-scope');
const { parseToml } = require('../src/codex-config');
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
const { planLifecycle, applyLifecycle, removeLifecycle } = require('../src/lifecycle');
const { stateRoot, readLedger, defaultLedger } = require('../src/state');

const SCRIPT_DIR = __dirname; // bin/
const REPO_ROOT = path.dirname(SCRIPT_DIR);
const MAPPINGS_FILE = path.join(SCRIPT_DIR, 'mappings.conf');
const MCP_JSON_SRC = path.join(REPO_ROOT, 'core', '.mcp.json');
const CODEX_CONFIG_SRC = path.join(REPO_ROOT, 'core', 'harnesses', 'codex', 'config', 'config.toml');
const CODEX_HOOKS_SRC = path.join(REPO_ROOT, 'core', 'harnesses', 'codex', 'hooks', 'hooks.json');
const CODEX_AGENTS_SRC = path.join(REPO_ROOT, 'core', 'harnesses', 'codex', 'agents');
const CODEX_HOOK_SCRIPTS_SRC = path.join(REPO_ROOT, 'core', 'harnesses', 'codex', 'hooks');
const pkg = require('../package.json');

/** PARITY: sync.sh's validate_env() hard-exits before any work if --no-backup lacks --force —
 * "skip all backup protection" must be an explicit, deliberate choice, never a default combo. */
function assertNoBackupRequiresForce(o) {
  if (o.noBackup && !o.force) {
    console.error('doflow: --no-backup skips all backup protection and requires --force');
    process.exit(1);
  }
}

/** PARITY: sync.sh's validate_env() also hard-exits up front if mappings.conf isn't found next to
 * the script — without this, a missing/relocated mappings.conf surfaced as a raw ENOENT stack
 * trace out of readMappings() instead of a clean, actionable message. */
function assertMappingsFileExists() {
  if (!fs.existsSync(MAPPINGS_FILE)) {
    console.error(`doflow: mappings.conf not found: ${MAPPINGS_FILE}`);
    console.error('doflow: run from within the claude-code-agent-workflow repo (or reinstall doflow)');
    process.exit(1);
  }
}

function parseArgs(argv) {
  const o = { cmd: null, positional: [], targets: [], mcp: null, dryRun: false, force: false,
    noBackup: false, prune: 0, checksum: false, global: false, json: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '-v': case '--version': o.version = true; break;
      case '-n': case '--dry-run': o.dryRun = true; break;
      case '-f': case '--force': o.force = true; break;
      case '-g': case '--global': o.global = true; break;
      case '--no-backup': o.noBackup = true; break;
      case '--checksum': o.checksum = true; break;
      case '--json': o.json = true; break;
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

const HELP = `doflow — DoFlow config installer (replaces sync.sh)

Usage: doflow <command> [path] [options]

Commands:
  install [path]       Install configs to target tools (use --dry-run to preview)
  update               Incremental update of changed files only
  status               Show resolved context + installed state from manifest (--json for scripting)
  rollback [id]        Restore from a backup (interactive pick if id omitted)
  remove [path]        Remove only lifecycle-owned native resources
  list-backups         List available backups
  self-update          git pull + reinstall

Scope (mutually exclusive — global wins if both given):
  -g, --global         Install to \$HOME/.{claude,codex,gemini} (matches sync.sh)
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
      --checksum       Use sha256 diff (update)
      --json           Machine-readable output (status)
  -h, --help           Show help
  -v, --version        Show version`;

/**
 * Resolve (but don't yet apply) the MCP server selection for a 'claude' target, plus a closure to
 * apply it. Called once per invocation, before any dry-run/confirm branching, so an interactive
 * prompt (install only, real TTY, no --force/--dry-run) fires at most once and its result can be
 * reused for both the dry-run preview and the real write.
 * @returns {{allServers:string[], selected:string[], changed:boolean, destDescription:string, apply:()=>void}|null}
 *          null if core/.mcp.json doesn't exist (nothing to resolve).
 */
function resolveMcpForTool({ o, dirs, scope, cmd }) {
  if (!fs.existsSync(MCP_JSON_SRC)) return null;
  const allServers = readAllServers(MCP_JSON_SRC);
  const manifestServers = readManifest(dirs.claude)?.mcpServers ?? null;
  const interactive = cmd === 'install' && !o.dryRun && !o.force && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
  const selected = resolveMcpSelection({ cmd, requested: o.mcp, allServers, manifestServers, interactive, promptFn: promptMcpCheckbox });
  const baseline = manifestServers ?? allServers;
  const changed = [...baseline].sort().join(',') !== [...selected].sort().join(',');
  const projectRoot = path.dirname(dirs.claude); // == os.homedir() when scope.global, by construction
  const destDescription = scope.global ? '~/.claude.json (mcpServers)' : path.join(projectRoot, '.mcp.json');
  const apply = () => {
    const serverDefs = filterServerDefs(MCP_JSON_SRC, allServers, selected);
    if (scope.global) mergeGlobalMcpServers(os.homedir(), allServers, serverDefs);
    else writeProjectMcpJson(projectRoot, allServers, serverDefs);
  };
  return { allServers, selected, changed, destDescription, apply };
}

/** The generic copier predates Codex-native reconciliation.  These surfaces must be planned
 * through their ownership-aware adapters, never copied wholesale. */
function mappingsFor(tool) {
  const mappings = readMappings(MAPPINGS_FILE, tool);
  if (tool !== 'codex') return mappings;
  return mappings.filter(({ src }) => ![
    'core/harnesses/codex/config/config.toml', 'core/harnesses/codex/hooks/hooks.json', 'core/harnesses/codex/hooks/',
  ].includes(src));
}

function codexScope(scope) { return scope.global ? 'global' : 'project'; }

function codexConfigResources() {
  const parsed = parseToml(fs.readFileSync(CODEX_CONFIG_SRC, 'utf8'));
  return [...parsed.entries.entries()].map(([identity, entry]) => ({
    target: 'codex', kind: 'configuration-entry', identity, value: entry.value,
    sourceVersion: pkg.version, selection: true,
  }));
}

/** Registry/lifecycle is introduced as a read-only companion to the legacy installer.  It makes
 * the capability and neutral-ledger view observable without changing the proven copy/backup
 * mutation path until every native adapter has CLI-level parity. */
function registryLifecycleView({ scope, dirs, targets, mcpIds, operation }) {
  const registry = loadRegistry({ repoRoot: REPO_ROOT });
  const lifecycleScope = codexScope(scope);
  const scopeRoot = scope.global ? os.homedir() : path.resolve(scope.projectRoot);
  const neutralStateRoot = stateRoot({ scope: lifecycleScope, projectRoot: scopeRoot, homeDir: scopeRoot });
  const ledger = readLedger(neutralStateRoot) ?? defaultLedger({ scope: lifecycleScope, scopeRoot });
  const adapters = createAdapterRegistry({ claude: claudeAdapter, codex: codexAdapter, gemini: createGeminiAdapter() });
  const plan = planLifecycle({ registry, adapters, scope: lifecycleScope, scopeRoot, targets, mcpIds, ledger, context: {
    repoRoot: REPO_ROOT, projectRoot: scopeRoot, homeDir: os.homedir(), sourceVersion: pkg.version,
    codexConfigResources: codexConfigResources(), codexAgentsSourceDir: CODEX_AGENTS_SRC,
    codexHooksSourceFile: CODEX_HOOKS_SRC, codexHooksSourceDir: CODEX_HOOK_SCRIPTS_SRC, operation,
  } });
  return { registry, stateRoot: neutralStateRoot, ledger, plan };
}

function printRegistryLifecycle(view, prefix = '[PLAN]') {
  console.log(`${prefix} Registry lifecycle: ${view.plan.changes.length} native change(s), ${view.plan.conflicts.length} conflict(s), ${view.plan.prerequisites.length} prerequisite(s)`);
  for (const target of view.plan.targets) {
    console.log(`${prefix}   ${target.harness}: ${target.changes.length} change(s)${target.conflicts.length ? `; conflicts: ${target.conflicts.join('; ')}` : ''}`);
    const hookChange = target.changes.find((change) => change.nativeComponent === 'hooks');
    if (hookChange?.nativePlan?.trust?.required) {
      console.log(`${prefix}   ${target.harness} hooks trust: ${hookChange.nativePlan.trust.status} (review required in Codex)`);
    }
  }
  console.log(`${prefix} Neutral state: ${view.stateRoot}${readLedger(view.stateRoot) ? ' (existing ledger)' : ' (not yet created)'}`);
}

/** Harnesses whose native resources are reconciled through the registry/lifecycle path (all of
 * them, as of this wiring). Kept as an explicit list — rather than reusing VALID from
 * src/targets.js — so a future non-lifecycle target doesn't silently gain lifecycle behavior. */
const LIFECYCLE_HARNESSES = ['claude', 'codex', 'gemini'];

function assertSafeRegistryPlan(view) {
  if (view.plan.safe) return;
  for (const conflict of view.plan.conflicts) console.error(`[ERROR] ${conflict.harness} lifecycle refused: ${conflict.reason}`);
  for (const prerequisite of view.plan.prerequisites) console.error(`[ERROR] ${prerequisite.harness} lifecycle prerequisite: ${prerequisite.prerequisite}`);
  process.exitCode = 1;
}

/** PARITY: sync.sh runs `chmod +x` (relative — adds ugo+x, preserves existing bits), not an
 * absolute mode — a hook file copied in at 664/775 must stay that way, only gaining +x. */
function chmodHooksExecutable(claudeDir) {
  const hooksDir = path.join(claudeDir, 'hooks');
  if (!fs.existsSync(hooksDir)) return;
  for (const f of fs.readdirSync(hooksDir)) {
    if (!f.endsWith('.sh')) continue;
    const p = path.join(hooksDir, f);
    const currentMode = fs.statSync(p).mode & 0o777;
    fs.chmodSync(p, currentMode | 0o111);
  }
}

/**
 * Rewrite a project-scoped settings.json's hook paths, then restore the mtime it had right after
 * install/update's own mtime-preserving copy (copyFilePreservingMeta) set it to match source.
 * Without this, the content rewrite's own fs.writeFileSync bumps the mtime to "now", so every
 * later `doflow update` sees a permanent mtime mismatch and reports this one file as changed
 * forever, even with zero real drift — diffFiles (src/diff.js) has no other way to know the
 * rewrite is the *only* difference from source and is already accounted for.
 * @returns {boolean} whether the file was rewritten (same contract as rewriteHookPathsForProjectScope)
 */
function rewriteProjectSettingsPreservingMtime(settingsPath) {
  const preRewriteStat = fs.existsSync(settingsPath) ? fs.statSync(settingsPath) : null;
  const rewritten = rewriteHookPathsForProjectScope(settingsPath);
  if (rewritten && preRewriteStat) {
    fs.utimesSync(settingsPath, Math.floor(preRewriteStat.atimeMs / 1000), Math.floor(preRewriteStat.mtimeMs / 1000));
  }
  return rewritten;
}

function cmdInstall(o) {
  const targets = resolveTargets(o.targets);
  const scope = scopeOf(o);
  const dirs = toolDirs(scope);
  const backupRoot = path.join(dirs.claude, 'backups');
  // Resolved once per invocation and threaded into resolveContext/createBackup/writeManifest below
  // — those three used to each spawn their own `git rev-parse` for the identical value.
  const commit = sourceCommit(SCRIPT_DIR);

  printContext(resolveContext({ repoRoot: REPO_ROOT, mappingsFile: MAPPINGS_FILE, targets, dirs, sourceCommit: commit, ...scope }));

  const existingManifest = readManifest(dirs.claude);
  const mcp = targets.includes('claude') ? resolveMcpForTool({ o, dirs, scope, cmd: 'install' }) : null;
  const codexCatalog = targets.includes('codex') ? readCodexMcpCatalog(MCP_JSON_SRC) : null;
  const codexMcpSelection = codexCatalog ? (mcp?.selected ?? resolveCodexMcpSelection({ cmd: 'install', requested: o.mcp,
    allServers: codexCatalog.allServers, manifestServers: existingManifest?.mcpServers ?? null,
    interactive: !o.dryRun && !o.force && Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY), promptFn: promptMcpCheckbox })) : [];
  const mcpIds = mcp?.selected ?? (codexCatalog ? codexMcpSelection : undefined);
  // One lifecycle view across every requested target — computed unconditionally (not only under
  // --dry-run) so its safety gate and its plan are the exact same object the real apply below uses.
  const lifecycleView = registryLifecycleView({ scope, dirs, targets, mcpIds });
  if (!lifecycleView.plan.safe) { assertSafeRegistryPlan(lifecycleView); return; }

  if (o.dryRun) {
    console.log(`[INFO] Install targets: ${targets.join(' ')}`);
    for (const tool of targets) {
      for (const f of planFiles(REPO_ROOT, mappingsFor(tool), tool)) {
        console.log(`[DRY]  ${f}`);
      }
    }
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
    // PARITY: sync.sh records $SCRIPT_DIR (bin/), not the repo root, as source_path — same value
    // it passes to `git -C` (works identically from a subdirectory of the repo).
    bid = createBackup({ operation: 'install', tools: targets, dirs, backupRoot, repoRoot: SCRIPT_DIR, sourceCommit: commit, date: new Date() });
    console.error(`[INFO]  Backup created: ${bid}`);
  } else {
    console.error('[WARN]  Skipping backup (--no-backup)');
  }

  for (const tool of targets) {
    fs.mkdirSync(dirs[tool], { recursive: true });
    const n = installTool(REPO_ROOT, mappingsFor(tool), dirs[tool]);
    console.log(`[INFO] ${tool}: synced ${n} mapping(s) -> ${dirs[tool]}`);
    if (tool === 'claude') {
      chmodHooksExecutable(dirs.claude);
      // core/harnesses/claude/settings/settings.json ships with ~/.claude/hooks/... paths, only correct for a global
      // install. A project-scoped install's hooks live at <project>/.claude/hooks/, so rewrite
      // to Claude Code's documented ${CLAUDE_PROJECT_DIR} placeholder — otherwise every hook
      // would silently point at the wrong (or a stale/absent) location.
      if (!scope.global && rewriteProjectSettingsPreservingMtime(path.join(dirs.claude, 'settings.json'))) {
        console.log('[INFO]   settings.json hook paths rewritten for project scope (${CLAUDE_PROJECT_DIR})');
      }
      if (mcp) {
        mcp.apply();
        console.log(`[INFO]   MCP servers -> ${mcp.destDescription} (${mcp.selected.join(', ') || 'none'})`);
      }
    }
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

  writeManifest({ claudeDir: dirs.claude, scriptVersion: pkg.version, operation: 'install', repoRoot: SCRIPT_DIR, sourceCommit: commit, backupId: bid, tools: targets, date: new Date(), mcpServers: mcpIds });

  if (o.prune > 0) {
    const pruned = pruneBackups(backupRoot, o.prune);
    if (pruned.length) console.error(`[INFO]  Pruned ${pruned.length} old backup(s)`);
  }

  console.log('[OK] Installation complete!');
}

/**
 * Resolve all merge-managed instruction files for `update` and peek whether they would change.
 * They are excluded from diffFiles/allChanged (see src/diff.js) because a merge target never mirrors its
 * source byte-for-byte, so whole-file mtime/checksum comparison is the wrong model for it — this
 * gives it the same idempotency-checked peek `install` gets via installTool, so both commands
 * apply identical merge semantics with no first-run-only special case.
 *
 * Mirrors the two safety properties every other mapping gets via resolveFilePairs/installTool
 * (src/copy.js), which this path bypasses by not going through either: a missing source file is
 * skipped gracefully instead of throwing a raw ENOENT, and the resolved destination is checked
 * with assertWithinRoot before anything reads or writes it.
 * @returns {{tool:string, srcAbs:string, dstAbs:string, willChange:boolean}[]}
 */
function resolveManagedInstructionUpdates(targets, dirs) {
  const updates = [];
  for (const tool of targets) {
    for (const mapping of readMappings(MAPPINGS_FILE, tool)) {
      if (mapping.dst !== 'CLAUDE.md' && mapping.dst !== 'AGENTS.md') continue;
      const srcAbs = path.join(REPO_ROOT, mapping.src);
      if (!fs.existsSync(srcAbs)) continue;
      const dstAbs = path.join(dirs[tool], mapping.dst);
      assertWithinRoot(dirs[tool], dstAbs, mapping.dst);
      updates.push({ tool, srcAbs, dstAbs, willChange: mergeMarkedSection(srcAbs, dstAbs, { dryRun: true }).changed });
    }
  }
  return updates;
}

function cmdUpdate(o) {
  const targets = resolveTargets(o.targets);
  const scope = scopeOf(o);
  const dirs = toolDirs(scope);
  const backupRoot = path.join(dirs.claude, 'backups');
  const commit = sourceCommit(SCRIPT_DIR);
  printContext(resolveContext({ repoRoot: REPO_ROOT, mappingsFile: MAPPINGS_FILE, targets, dirs, sourceCommit: commit, ...scope }));

  const perTool = {};
  let allChanged = [];
  for (const tool of targets) {
    const changed = diffFiles({ repoRoot: REPO_ROOT, mappings: mappingsFor(tool), dstRoot: dirs[tool], checksum: o.checksum });
    if (changed.length) { perTool[tool] = changed; allChanged = allChanged.concat(changed); }
  }

  const managedInstructions = resolveManagedInstructionUpdates(targets, dirs);
  const changedManagedInstructions = managedInstructions.filter((instruction) => instruction.willChange);
  const totalChanged = allChanged.length + changedManagedInstructions.length;

  // Never interactive here (resolveMcpForTool only prompts for cmd:'install') — update reuses the
  // manifest-remembered selection, or applies an explicit --mcp override, without re-prompting.
  const existingManifest = readManifest(dirs.claude);
  const mcp = targets.includes('claude') ? resolveMcpForTool({ o, dirs, scope, cmd: 'update' }) : null;
  const mcpChanged = Boolean(mcp && mcp.changed);
  const codexCatalog = targets.includes('codex') ? readCodexMcpCatalog(MCP_JSON_SRC) : null;
  const codexMcpSelection = codexCatalog ? (mcp?.selected ?? resolveCodexMcpSelection({ cmd: 'update', requested: o.mcp,
    allServers: codexCatalog.allServers, manifestServers: existingManifest?.mcpServers ?? null, interactive: false, promptFn: promptMcpCheckbox })) : [];
  const mcpIds = mcp?.selected ?? (codexCatalog ? codexMcpSelection : undefined);
  // One lifecycle view across every requested target — computed unconditionally (not only under
  // --dry-run) so its safety gate and its plan are the exact same object the real apply below uses.
  const lifecycleView = registryLifecycleView({ scope, dirs, targets, mcpIds });
  if (!lifecycleView.plan.safe) { assertSafeRegistryPlan(lifecycleView); return; }
  const lifecycleChanged = Boolean(lifecycleView.plan.changes.length);

  if (totalChanged === 0 && !mcpChanged && !lifecycleChanged) {
    console.log('[OK] Already up to date — no changes detected');
    return;
  }

  console.log(`[INFO] Found ${totalChanged} changed file(s)${mcpChanged ? ' + MCP server selection change' : ''}${lifecycleChanged ? ` + ${lifecycleView.plan.changes.length} native change(s)` : ''}`);

  if (o.dryRun) {
    for (const { srcAbs, dstAbs } of allChanged) console.log(`[DRY]  ${srcAbs} -> ${dstAbs}`);
    for (const instruction of changedManagedInstructions) {
      console.log(`[DRY]  ${instruction.srcAbs} -> ${instruction.dstAbs}  (merge: marked section)`);
    }
    if (mcpChanged) console.log(`[DRY]  MCP servers -> ${mcp.destDescription} (${mcp.selected.join(', ') || 'none'})`);
    printRegistryLifecycle(lifecycleView, '[DRY]');
    if (!o.noBackup && (totalChanged > 0 || lifecycleChanged)) console.log(`[DRY]  Would create partial backup: ${backupRoot}/update_<timestamp>`);
    console.log(`[DRY]  Would write manifest: ${path.join(dirs.claude, '.install-manifest.json')}`);
    console.log('[DRY] Dry run complete');
    return;
  }

  if (!confirm(`Update ${totalChanged} changed file(s)${mcpChanged ? ' + MCP server selection' : ''}${lifecycleChanged ? ' + native resources' : ''} in: ${targets.join(' ')}?`, o.force)) {
    console.error('[INFO]  Aborted.');
    return;
  }

  let bid = '';
  // Nothing outside dirs[tool] (which is what partialFiles/backup covers) needs backing up for an
  // MCP-only change — ~/.claude.json / <project>/.mcp.json are outside the tool dir by design (see
  // src/mcp.js), so a backup is only meaningful when actual mapped files changed.
  if (!o.noBackup && (totalChanged > 0 || lifecycleChanged)) {
    const existingDstFiles = allChanged.map((c) => c.dstAbs).filter((f) => fs.existsSync(f));
    for (const instruction of changedManagedInstructions) {
      if (fs.existsSync(instruction.dstAbs)) existingDstFiles.push(instruction.dstAbs);
    }
    bid = createBackup({ operation: 'update', tools: targets, dirs, backupRoot, repoRoot: SCRIPT_DIR, sourceCommit: commit, partialFiles: existingDstFiles, date: new Date() });
    console.error(`[INFO]  Backup created: ${bid}`);
  }

  for (const tool of targets) {
    const items = perTool[tool] || [];
    for (const { srcAbs, dstAbs } of items) copyFilePreservingMeta(srcAbs, dstAbs);
    let count = items.length;
    for (const instruction of changedManagedInstructions) {
      if (instruction.tool !== tool) continue;
      mergeMarkedSection(instruction.srcAbs, instruction.dstAbs);
      count += 1;
    }
    if (count > 0) console.log(`[INFO] ${tool}: synced ${count} changed item(s) -> ${dirs[tool]}`);
  }
  // If settings.json was just re-synced from source (which always has ~/.claude/... paths), a
  // project-scoped install's ${CLAUDE_PROJECT_DIR} rewrite would otherwise get silently reverted
  // on every update. Idempotent — a no-op once already rewritten.
  if (!scope.global && perTool.claude) rewriteProjectSettingsPreservingMtime(path.join(dirs.claude, 'settings.json'));
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
  const view = registryLifecycleView({ scope, dirs, targets: lifecycleTargets, mcpIds: [], operation: 'remove' });
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
  const ctx = resolveContext({ repoRoot: REPO_ROOT, mappingsFile: MAPPINGS_FILE, targets, dirs, sourceCommit: sourceCommit(SCRIPT_DIR), ...scope });
  const manifest = readManifest(dirs.claude);
  let registryView = null;
  try {
    registryView = registryLifecycleView({ scope, dirs, targets,
      mcpIds: manifest?.mcpServers ?? undefined });
    ctx.registry = {
      directory: registryView.registry.directory,
      versions: registryView.registry.versions,
      stateRoot: registryView.stateRoot,
      ledgerPresent: Boolean(readLedger(registryView.stateRoot)),
      plan: { changes: registryView.plan.changes.length, conflicts: registryView.plan.conflicts, prerequisites: registryView.plan.prerequisites },
    };
    if (targets.includes('codex')) {
      const resources = registryView.ledger.resources.filter((resource) => resource.harness === 'codex');
      ctx.codex = {
        status: registryView.plan.conflicts.length ? 'conflict-or-invalid' : (registryView.plan.changes.length ? 'drift-or-pending-change' : 'verified'),
        resources,
        hooksTrust: { required: true, trusted: false, status: 'review-required' },
        errors: registryView.plan.conflicts.map((conflict) => conflict.reason),
      };
    }
    if (targets.includes('claude')) {
      const resources = registryView.ledger.resources.filter((resource) => resource.harness === 'claude');
      ctx.claude = {
        status: registryView.plan.conflicts.length ? 'conflict-or-invalid' : (registryView.plan.changes.length ? 'drift-or-pending-change' : 'verified'),
        resources,
        errors: registryView.plan.conflicts.map((conflict) => conflict.reason),
      };
    }
    if (targets.includes('gemini')) {
      const resources = registryView.ledger.resources.filter((resource) => resource.harness === 'gemini');
      ctx.gemini = {
        status: registryView.plan.conflicts.length ? 'conflict-or-invalid' : (registryView.plan.changes.length ? 'drift-or-pending-change' : 'verified'),
        resources,
        errors: registryView.plan.conflicts.map((conflict) => conflict.reason),
      };
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
  printContext(resolveContext({ repoRoot: REPO_ROOT, mappingsFile: MAPPINGS_FILE, targets, dirs, sourceCommit: commit, global: o.global, projectRoot: '.' }));

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
  // Mirrors sync.sh: self-update always runs install with --checksum afterward (a git pull can
  // refresh mtimes without changing content, so mtime-based diff would false-positive).
  console.log(`[INFO] Running install with --checksum (required after ${pulled ? 'a git pull' : 'checking for updates'})...`);
  cmdInstall({ ...o, checksum: true });
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.version) { console.log(pkg.version); return; }
  if (o.help || !o.cmd) { console.log(HELP); return; }
  // PARITY: sync.sh's validate_env() runs this check once before dispatch, for every operation
  // (including --dry-run and --help-adjacent ones like --status) — not just the two commands
  // that actually take a backup.
  assertMappingsFileExists();
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
