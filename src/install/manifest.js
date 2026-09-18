'use strict';
// manifest.js — port of sync.sh's write_manifest/read_manifest.
// PARITY: schema {script_version,last_operation,last_run,source_path,source_commit,last_backup_id,
// tools:{tool:{installed,last_updated}}}; atomic write via tmp file + rename (never partial-write
// the manifest, matching sync.sh's `mktemp` + `mv`).
const fs = require('node:fs');
const path = require('node:path');
const { sourceCommit: gitSourceCommit } = require('../helper/git');

// Explicit migration bridge: pre-registry installations stored this record beneath .claude.
// Lifecycle commands use the scope-neutral .doflow location; only the neutral-state importer
// calls the legacy reader below.
const LEGACY_MANIFEST_FILE_NAME = '.install-manifest.json';
const MANIFEST_FILE_NAME = LEGACY_MANIFEST_FILE_NAME;

function manifestPath(claudeDir) {
  return path.join(claudeDir, MANIFEST_FILE_NAME);
}

function canonicalManifestPath(scopeRoot) {
  return path.join(path.resolve(scopeRoot), '.doflow', MANIFEST_FILE_NAME);
}

/**
 * @param {{scopeRoot?:string, claudeDir?:string, scriptVersion:string, operation:string, repoRoot:string,
 *           backupId?:string, tools:string[], date:Date, dryRun?:boolean, sourceCommit?:string,
 *           mcpServers?:string[]}} p
 *           `sourceCommit` lets a caller (bin/doflow.js) pass an already-resolved commit instead
 *           of this module spawning its own `git rev-parse`; omit it to resolve here (e.g. tests
 *           calling this module directly). `mcpServers`, when provided, persists the resolved MCP
 *           server selection so a later `update` (which never re-prompts) can reuse it instead of
 *           silently reverting to "all servers" — omit it to leave any existing value untouched.
 *           `managedResources` is the optional ownership ledger for fine-grained Codex resources.
 *           Each record uses {target,scope,kind,identity,sourceVersion,fingerprint,selection,
 *           recoveryPoint}. Omit it to preserve a ledger written by a newer lifecycle command.
 */
function writeManifest({ scopeRoot, claudeDir, scriptVersion, operation, repoRoot, backupId = '', tools, date, dryRun = false, sourceCommit, mcpServers, managedResources }) {
  if (!scopeRoot && !claudeDir) throw new Error('scopeRoot is required for lifecycle metadata');
  const file = scopeRoot ? canonicalManifestPath(scopeRoot) : manifestPath(claudeDir);
  if (dryRun) return file;

  // Preserve per-tool last_updated for tools NOT part of this operation (matches sync.sh's
  // incremental jq merge, which only touches the tools passed to write_manifest).
  let existingTools = {};
  let existingMcpServers;
  let existingManagedResources;
  const existingFile = file;
  if (existingFile && fs.existsSync(existingFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(existingFile, 'utf8'));
      existingTools = existing.tools || {};
      existingMcpServers = existing.mcp_servers;
      // `managedResources` is accepted as a short-lived compatibility alias for manifests
      // written by pre-release lifecycle work. New writes use the established snake_case
      // top-level convention, while resource field names stay camelCase as specified by the
      // ownership contract.
      existingManagedResources = existing.managed_resources ?? existing.managedResources;
    } catch { /* start fresh */ }
  }
  const ts = date.toISOString().replace(/\.\d+Z$/, 'Z');
  const toolsOut = { ...existingTools };
  for (const t of tools) toolsOut[t] = { installed: true, last_updated: ts };

  const manifest = {
    script_version: scriptVersion,
    last_operation: operation,
    last_run: ts,
    source_path: repoRoot,
    source_commit: sourceCommit ?? gitSourceCommit(repoRoot),
    last_backup_id: backupId,
    tools: toolsOut,
    mcp_servers: mcpServers ?? existingMcpServers,
  };
  const resources = managedResources ?? existingManagedResources;
  if (resources !== undefined) manifest.managed_resources = resources;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Security: the temp file must live next to `file` itself, not a shared os.tmpdir() — a
  // world-writable /tmp plus a PID+timestamp-derived (i.e. guessable) name is a symlink-race
  // waiting to happen (plant a symlink at the predicted path, the write clobbers its target).
  // 'wx' (O_CREAT|O_EXCL) refuses to open through an existing symlink or file at all, and being
  // on the same filesystem as `file` makes the final rename a guaranteed atomic same-fs op
  // (os.tmpdir() offered no such guarantee — e.g. containers where /tmp is a separate tmpfs mount).
  const tmp = path.join(path.dirname(file), `.install-manifest-${process.pid}-${date.getTime()}.json.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(tmp, file); // atomic on the same filesystem, matches sync.sh's mktemp + mv
  return file;
}

/** @returns {{operation:string,lastRun:string,sourceCommit:string,backupId:string,managedResources:object[]}|null} null if no manifest yet */
function readManifestFile(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      operation: m.last_operation ?? 'none',
      lastRun: m.last_run ?? 'none',
      sourceCommit: m.source_commit ?? 'none',
      backupId: m.last_backup_id ?? 'none',
      tools: m.tools ?? {},
      scriptVersion: m.script_version ?? 'none',
      mcpServers: m.mcp_servers ?? null,
      // Older manifests have no ownership ledger. Returning an empty list gives lifecycle
      // callers a migration-safe baseline without changing their legacy install state.
      managedResources: Array.isArray(m.managed_resources)
        ? m.managed_resources
        : (Array.isArray(m.managedResources) ? m.managedResources : []),
    };
  } catch {
    return {
      operation: 'error', lastRun: 'error', sourceCommit: 'error', backupId: 'error',
      tools: {}, scriptVersion: 'error', mcpServers: null, managedResources: [],
    };
  }
}

/** Read only the canonical scope-neutral manifest used by lifecycle commands. */
function readInstallManifest({ scopeRoot }) {
  if (!scopeRoot) throw new Error('scopeRoot is required');
  return readManifestFile(canonicalManifestPath(scopeRoot));
}

/** Read only the legacy path; neutral-state migration uses this deliberately. */
function readManifest(claudeDir) {
  return readManifestFile(manifestPath(claudeDir));
}

module.exports = {
  LEGACY_MANIFEST_FILE_NAME, MANIFEST_FILE_NAME, manifestPath, canonicalManifestPath,
  writeManifest, readManifest, readInstallManifest,
};
