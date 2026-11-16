'use strict';
// manifest.js — port of sync.sh's write_manifest/read_manifest.
// PARITY: schema {script_version,last_operation,last_run,source_path,source_commit,last_backup_id,
// tools:{tool:{installed,last_updated}}}; atomic write via tmp file + rename (never partial-write
// the manifest, matching sync.sh's `mktemp` + `mv`).
//
// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): authored as `.ts`, run directly by Node
// native type-stripping — no build step, no runtime dependency. Body stays CommonJS so a `.js`
// caller's `require('../install/manifest.ts')` keeps working while the tree is still `.js`.
const fs = require('node:fs');
const path = require('node:path');
const { sourceCommit: gitSourceCommit } = require('../helper/git.ts');

const MANIFEST_FILE_NAME = '.install-manifest.json';

function canonicalManifestPath(scopeRoot: string): string {
  return path.join(path.resolve(scopeRoot), '.doflow', MANIFEST_FILE_NAME);
}

/** Atomic same-directory write of the manifest document. */
function atomicWrite(file: string, manifest: object, date: Date): void {
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
}

interface WriteManifestInput {
  scopeRoot: string;
  scriptVersion: string;
  operation: string;
  repoRoot: string;
  backupId?: string;
  tools: string[];
  date: Date;
  dryRun?: boolean;
  sourceCommit?: string;
}

/**
 * `sourceCommit` lets a caller (bin/doflow.js) pass an already-resolved commit instead of this
 * module spawning its own `git rev-parse`; omit it to resolve here (e.g. tests calling this module
 * directly). The record names the tools it lists as installed and nothing else: doflow.lock holds
 * each harness's MCP selection and the neutral ledger holds ownership.
 */
function writeManifest({ scopeRoot, scriptVersion, operation, repoRoot, backupId = '', tools, date, dryRun = false, sourceCommit }: WriteManifestInput): string {
  if (!scopeRoot) throw new Error('scopeRoot is required for lifecycle metadata');
  const file = canonicalManifestPath(scopeRoot);
  if (dryRun) return file;

  // Preserve per-tool last_updated for tools NOT part of this operation (matches sync.sh's
  // incremental jq merge, which only touches the tools passed to write_manifest).
  let existingTools: Record<string, any> = {};
  if (fs.existsSync(file)) {
    try { existingTools = JSON.parse(fs.readFileSync(file, 'utf8')).tools || {}; } catch { /* start fresh */ }
  }
  const ts = date.toISOString().replace(/\.\d+Z$/, 'Z');
  const toolsOut: Record<string, any> = { ...existingTools };
  for (const t of tools) toolsOut[t] = { installed: true, last_updated: ts };

  const manifest: any = {
    script_version: scriptVersion,
    last_operation: operation,
    last_run: ts,
    source_path: repoRoot,
    source_commit: sourceCommit ?? gitSourceCommit(repoRoot),
    last_backup_id: backupId,
    tools: toolsOut,
  };

  atomicWrite(file, manifest, date);
  return file;
}

/**
 * After a removal: stop listing `tools` as installed. Nothing else in the record changes except the
 * operation and time, and a missing or unreadable manifest is left alone (nothing lists them).
 * Returns whether the file was rewritten.
 */
function forgetManifestTools({ scopeRoot, tools, date = new Date() }: { scopeRoot: string; tools: string[]; date?: Date }): boolean {
  const file = canonicalManifestPath(scopeRoot);
  if (!fs.existsSync(file)) return false;
  let manifest: any;
  try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  const listed = tools.filter((tool) => manifest?.tools && Object.hasOwn(manifest.tools, tool));
  if (!listed.length) return false;
  for (const tool of listed) delete manifest.tools[tool];
  manifest.last_operation = 'remove';
  manifest.last_run = date.toISOString().replace(/\.\d+Z$/, 'Z');
  atomicWrite(file, manifest, date);
  return true;
}

/** null if no manifest yet. */
function readManifestFile(file: string): any {
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
    };
  } catch {
    return {
      operation: 'error', lastRun: 'error', sourceCommit: 'error', backupId: 'error',
      tools: {}, scriptVersion: 'error',
    };
  }
}

/** Read only the canonical scope-neutral manifest used by lifecycle commands. */
function readInstallManifest({ scopeRoot }: { scopeRoot: string }): any {
  if (!scopeRoot) throw new Error('scopeRoot is required');
  return readManifestFile(canonicalManifestPath(scopeRoot));
}

module.exports = {
  MANIFEST_FILE_NAME, canonicalManifestPath, writeManifest, forgetManifestTools, readInstallManifest,
};
