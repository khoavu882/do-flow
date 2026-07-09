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
const { planFiles, installTool, copyFilePreservingMeta } = require('../src/copy');
const { resolveContext, printContext } = require('../src/context');
const { createBackup, restoreBackup, listBackups, pruneBackups } = require('../src/backup');
const { writeManifest, readManifest } = require('../src/manifest');
const { confirm, promptLine } = require('../src/prompt');
const { diffFiles } = require('../src/diff');
const { sourceCommit } = require('../src/git');
const { rewriteHookPathsForProjectScope } = require('../src/settings-scope');
const {
  readAllServers, filterServerDefs, writeProjectMcpJson, mergeGlobalMcpServers,
  resolveMcpSelection, promptMcpCheckbox,
} = require('../src/mcp');
const { execFileSync } = require('node:child_process');

const SCRIPT_DIR = __dirname; // bin/
const REPO_ROOT = path.dirname(SCRIPT_DIR);
const MAPPINGS_FILE = path.join(SCRIPT_DIR, 'mappings.conf');
const MCP_JSON_SRC = path.join(REPO_ROOT, 'core', '.mcp.json');
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
                       runs. Only applies when 'claude' is a target.
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

function cmdInstall(o) {
  const targets = resolveTargets(o.targets);
  const scope = scopeOf(o);
  const dirs = toolDirs(scope);
  const backupRoot = path.join(dirs.claude, 'backups');
  // Resolved once per invocation and threaded into resolveContext/createBackup/writeManifest below
  // — those three used to each spawn their own `git rev-parse` for the identical value.
  const commit = sourceCommit(SCRIPT_DIR);

  printContext(resolveContext({ repoRoot: REPO_ROOT, mappingsFile: MAPPINGS_FILE, targets, dirs, sourceCommit: commit, ...scope }));

  const mcp = targets.includes('claude') ? resolveMcpForTool({ o, dirs, scope, cmd: 'install' }) : null;

  if (o.dryRun) {
    console.log(`[INFO] Install targets: ${targets.join(' ')}`);
    for (const tool of targets) {
      for (const f of planFiles(REPO_ROOT, readMappings(MAPPINGS_FILE, tool), tool)) {
        console.log(`[DRY]  ${f}`);
      }
    }
    if (mcp) console.log(`[DRY]  MCP servers -> ${mcp.destDescription} (${mcp.selected.join(', ') || 'none'})`);
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
    const n = installTool(REPO_ROOT, readMappings(MAPPINGS_FILE, tool), dirs[tool]);
    console.log(`[INFO] ${tool}: synced ${n} mapping(s) -> ${dirs[tool]}`);
    if (tool === 'claude') {
      chmodHooksExecutable(dirs.claude);
      // core/settings.json ships with ~/.claude/hooks/... paths, only correct for a global
      // install. A project-scoped install's hooks live at <project>/.claude/hooks/, so rewrite
      // to Claude Code's documented ${CLAUDE_PROJECT_DIR} placeholder — otherwise every hook
      // would silently point at the wrong (or a stale/absent) location.
      if (!scope.global && rewriteHookPathsForProjectScope(path.join(dirs.claude, 'settings.json'))) {
        console.log('[INFO]   settings.json hook paths rewritten for project scope (${CLAUDE_PROJECT_DIR})');
      }
      if (mcp) {
        mcp.apply();
        console.log(`[INFO]   MCP servers -> ${mcp.destDescription} (${mcp.selected.join(', ') || 'none'})`);
      }
    }
  }

  writeManifest({ claudeDir: dirs.claude, scriptVersion: pkg.version, operation: 'install', repoRoot: SCRIPT_DIR, sourceCommit: commit, backupId: bid, tools: targets, date: new Date(), mcpServers: mcp ? mcp.selected : undefined });

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
  printContext(resolveContext({ repoRoot: REPO_ROOT, mappingsFile: MAPPINGS_FILE, targets, dirs, sourceCommit: commit, ...scope }));

  const perTool = {};
  let allChanged = [];
  for (const tool of targets) {
    const changed = diffFiles({ repoRoot: REPO_ROOT, mappings: readMappings(MAPPINGS_FILE, tool), dstRoot: dirs[tool], checksum: o.checksum });
    if (changed.length) { perTool[tool] = changed; allChanged = allChanged.concat(changed); }
  }

  // Never interactive here (resolveMcpForTool only prompts for cmd:'install') — update reuses the
  // manifest-remembered selection, or applies an explicit --mcp override, without re-prompting.
  const mcp = targets.includes('claude') ? resolveMcpForTool({ o, dirs, scope, cmd: 'update' }) : null;
  const mcpChanged = Boolean(mcp && mcp.changed);

  if (allChanged.length === 0 && !mcpChanged) {
    console.log('[OK] Already up to date — no changes detected');
    return;
  }

  console.log(`[INFO] Found ${allChanged.length} changed file(s)${mcpChanged ? ' + MCP server selection change' : ''}`);

  if (o.dryRun) {
    for (const { srcAbs, dstAbs } of allChanged) console.log(`[DRY]  ${srcAbs} -> ${dstAbs}`);
    if (mcpChanged) console.log(`[DRY]  MCP servers -> ${mcp.destDescription} (${mcp.selected.join(', ') || 'none'})`);
    if (!o.noBackup && allChanged.length > 0) console.log(`[DRY]  Would create partial backup: ${backupRoot}/update_<timestamp>`);
    console.log(`[DRY]  Would write manifest: ${path.join(dirs.claude, '.install-manifest.json')}`);
    console.log('[DRY] Dry run complete');
    return;
  }

  if (!confirm(`Update ${allChanged.length} changed file(s)${mcpChanged ? ' + MCP server selection' : ''} in: ${targets.join(' ')}?`, o.force)) {
    console.error('[INFO]  Aborted.');
    return;
  }

  let bid = '';
  // Nothing outside dirs[tool] (which is what partialFiles/backup covers) needs backing up for an
  // MCP-only change — ~/.claude.json / <project>/.mcp.json are outside the tool dir by design (see
  // src/mcp.js), so a backup is only meaningful when actual mapped files changed.
  if (!o.noBackup && allChanged.length > 0) {
    const existingDstFiles = allChanged.map((c) => c.dstAbs).filter((f) => fs.existsSync(f));
    bid = createBackup({ operation: 'update', tools: targets, dirs, backupRoot, repoRoot: SCRIPT_DIR, sourceCommit: commit, partialFiles: existingDstFiles, date: new Date() });
    console.error(`[INFO]  Backup created: ${bid}`);
  }

  for (const tool of Object.keys(perTool)) {
    for (const { srcAbs, dstAbs } of perTool[tool]) copyFilePreservingMeta(srcAbs, dstAbs);
    console.log(`[INFO] ${tool}: synced ${perTool[tool].length} changed item(s) -> ${dirs[tool]}`);
  }
  // If settings.json was just re-synced from source (which always has ~/.claude/... paths), a
  // project-scoped install's ${CLAUDE_PROJECT_DIR} rewrite would otherwise get silently reverted
  // on every update. Idempotent — a no-op once already rewritten.
  if (!scope.global && perTool.claude) rewriteHookPathsForProjectScope(path.join(dirs.claude, 'settings.json'));
  if (mcpChanged) {
    mcp.apply();
    console.log(`[INFO] claude: MCP servers -> ${mcp.destDescription} (${mcp.selected.join(', ') || 'none'})`);
  }

  writeManifest({ claudeDir: dirs.claude, scriptVersion: pkg.version, operation: 'update', repoRoot: SCRIPT_DIR, sourceCommit: commit, backupId: bid, tools: targets, date: new Date(), mcpServers: mcp ? mcp.selected : undefined });

  if (o.prune > 0) {
    const pruned = pruneBackups(backupRoot, o.prune);
    if (pruned.length) console.error(`[INFO]  Pruned ${pruned.length} old backup(s)`);
  }

  console.log('[OK] Update complete!');
}

function cmdStatus(o) {
  const targets = resolveTargets(o.targets);
  const scope = scopeOf(o);
  const dirs = toolDirs(scope);
  const ctx = resolveContext({ repoRoot: REPO_ROOT, mappingsFile: MAPPINGS_FILE, targets, dirs, sourceCommit: sourceCommit(SCRIPT_DIR), ...scope });
  const manifest = readManifest(dirs.claude);

  if (o.json) {
    console.log(JSON.stringify({ context: ctx, manifest }, null, 2));
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
  switch (o.cmd) {
    case 'install': return cmdInstall(o);
    case 'update': return cmdUpdate(o);
    case 'status': return cmdStatus(o);
    case 'rollback': return cmdRollback(o);
    case 'list-backups': return cmdListBackups(o);
    case 'self-update': return cmdSelfUpdate(o);
    default: console.error(`doflow: unknown command '${o.cmd}'`); process.exit(1);
  }
}
main();
