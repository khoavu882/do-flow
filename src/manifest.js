'use strict';
// manifest.js — port of sync.sh's write_manifest/read_manifest.
// PARITY: schema {script_version,last_operation,last_run,source_path,source_commit,last_backup_id,
// tools:{tool:{installed,last_updated}}}; atomic write via tmp file + rename (never partial-write
// the manifest, matching sync.sh's `mktemp` + `mv`).
const fs = require('node:fs');
const path = require('node:path');
const { sourceCommit: gitSourceCommit } = require('./git');

const MANIFEST_FILE_NAME = '.install-manifest.json';

function manifestPath(claudeDir) {
  return path.join(claudeDir, MANIFEST_FILE_NAME);
}

/**
 * @param {{claudeDir:string, scriptVersion:string, operation:string, repoRoot:string,
 *           backupId?:string, tools:string[], date:Date, dryRun?:boolean, sourceCommit?:string,
 *           mcpServers?:string[]}} p
 *           `sourceCommit` lets a caller (bin/doflow.js) pass an already-resolved commit instead
 *           of this module spawning its own `git rev-parse`; omit it to resolve here (e.g. tests
 *           calling this module directly). `mcpServers`, when provided, persists the resolved MCP
 *           server selection so a later `update` (which never re-prompts) can reuse it instead of
 *           silently reverting to "all servers" — omit it to leave any existing value untouched.
 */
function writeManifest({ claudeDir, scriptVersion, operation, repoRoot, backupId = '', tools, date, dryRun = false, sourceCommit, mcpServers }) {
  const file = manifestPath(claudeDir);
  if (dryRun) return file;

  // Preserve per-tool last_updated for tools NOT part of this operation (matches sync.sh's
  // incremental jq merge, which only touches the tools passed to write_manifest).
  let existingTools = {};
  let existingMcpServers;
  if (fs.existsSync(file)) {
    try {
      const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
      existingTools = existing.tools || {};
      existingMcpServers = existing.mcp_servers;
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

/** @returns {{operation:string,lastRun:string,sourceCommit:string,backupId:string}|null} null if no manifest yet */
function readManifest(claudeDir) {
  const file = manifestPath(claudeDir);
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
    };
  } catch {
    return { operation: 'error', lastRun: 'error', sourceCommit: 'error', backupId: 'error', tools: {}, scriptVersion: 'error', mcpServers: null };
  }
}

module.exports = { MANIFEST_FILE_NAME, manifestPath, writeManifest, readManifest };
