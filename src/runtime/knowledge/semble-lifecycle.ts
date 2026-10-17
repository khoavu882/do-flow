'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { SEMBLE_VERSION, SEMBLE_LIMITS, semanticStatePaths, fault, digest, safeDirectories, regularBytes,
  inspectModel, validateInventory, readSource, checkSources, inspectArtifacts, acquireSemanticLock,
  cleanupTemporary, executeBridge, readCompleted, scanTree, resolveSembleInterpreter, checkSembleVersion } = require('./semble-provider.ts');

/** Explicit operations only. A failed mutation deliberately keeps its in-progress marker. */
async function runSembleLifecycle(options: any): Promise<any> {
  const started = Date.now(); const limits = { ...SEMBLE_LIMITS, ...options.limits };
  const { inventory, action } = options; let release: any; let staging: string | undefined;
  let added = 0; let changed = 0; let deleted = 0; let changedBytes = 0;
  const checkDeadline = () => { if (Date.now() - started > limits.lifecycleMs) throw fault('lifecycle-timeout'); };
  try {
    if (action !== 'build' && action !== 'refresh') throw fault('invalid-index-action');
    validateInventory(inventory, limits); const model = inspectModel(options.modelPath, limits);
    const python = options.python || resolveSembleInterpreter().python; checkSembleVersion(python); // preflight: before any lock or mutation
    const paths = semanticStatePaths(inventory); release = await acquireSemanticLock(paths); cleanupTemporary(paths);
    let previous: any = null;
    if (action === 'refresh') {
      previous = readCompleted(paths, inventory, model, limits, true);
      const oldInventory = { ...inventory, files: previous.files };
      const artifacts = inspectArtifacts(paths.index, oldInventory, paths, model, limits);
      if (artifacts.artifactIdentity !== previous.artifactIdentity) throw fault('incompatible-refresh-index');
    }
    const old = new Map((previous?.files || []).map((entry: any) => [entry.path, entry]));
    const current = new Set(inventory.files.map((entry: any) => entry.path));
    for (const entry of inventory.files) {
      const prior: any = old.get(entry.path);
      if (!prior) { added++; changedBytes += entry.sizeBytes; }
      else if (prior.fileHash !== entry.fileHash) { changed++; changedBytes += entry.sizeBytes; }
    }
    deleted = [...old.keys()].filter((file: any) => !current.has(file)).length;
    if (action === 'refresh' && (added + changed + deleted > limits.changedFiles || changedBytes > limits.changedBytes)) throw fault('refresh-limit');
    checkSources(inventory, limits); checkDeadline();
    staging = fs.mkdtempSync(path.join(paths.state, 'staging-'));
    const sourceStage = path.join(staging, 'source'); fs.mkdirSync(sourceStage);
    // Stage verified ordinary copies before invalidating or modifying the stable mirror.
    for (const entry of inventory.files) {
      checkDeadline();
      if (old.has(entry.path) && (old.get(entry.path) as any).fileHash === entry.fileHash) continue;
      const dest = path.join(sourceStage, entry.path); safeDirectories(sourceStage, path.dirname(dest), true);
      fs.writeFileSync(dest, readSource(inventory, entry, limits), { flag: 'wx' });
    }
    checkSources(inventory, limits); checkDeadline();
    fs.writeFileSync(paths.marker, JSON.stringify({ schemaVersion: 1, action, startedAt: new Date().toISOString() }), { flag: 'w' });
    if (action === 'build') {
      // A repair build explicitly discards incompatible cache; never let from_path silently reuse it.
      for (const dir of [paths.mirror, paths.cache]) if (fs.existsSync(dir)) { scanTree(dir, limits.artifactBytes); fs.rmSync(dir, { recursive: true }); }
    }
    safeDirectories(paths.state, paths.mirror, true); safeDirectories(paths.state, paths.cache, true);
    for (const file of old.keys() as any) if (!current.has(file)) fs.unlinkSync(path.join(paths.mirror, file));
    for (const entry of inventory.files) {
      checkDeadline(); const staged = path.join(sourceStage, entry.path);
      if (!fs.existsSync(staged)) continue;
      const dest = path.join(paths.mirror, entry.path); safeDirectories(paths.mirror, path.dirname(dest), true);
      let previousMtime = 0; try { previousMtime = fs.lstatSync(dest).mtimeMs; } catch {}
      fs.renameSync(staged, dest);
      // A hash change must be newer than both the prior copy and saved provider time, even on coarse filesystems.
      const seconds = Math.max(Date.now() / 1000, previousMtime / 1000 + 2, (previous?.providerTime || 0) + 2);
      fs.utimesSync(dest, seconds, seconds);
    }
    const temp = path.join(staging, 'provider'); fs.mkdirSync(temp);
    const savePath = path.join(staging, 'index');
    const result = await executeBridge({ action, mirror: paths.mirror, modelPath: model.path, savePath, indexPath: paths.index,
      allowedWriteRoots: [staging, paths.cache] }, { ...options, python, limits: { ...limits, lifecycleMs: Math.max(1, limits.lifecycleMs - (Date.now() - started)) } }, paths, temp);
    if (!result.ok) throw fault(result.reason || 'provider-error', 'UNKNOWN', typeof result.cause === 'string' ? result.cause : undefined);
    if (!result.runtimeIdentity || typeof result.runtimeIdentity !== 'object') throw fault('provider-runtime-identity-unavailable');
    const artifacts = inspectArtifacts(savePath, inventory, paths, model, limits);
    checkSources(inventory, limits); checkDeadline();
    if (inspectModel(options.modelPath, limits).identity !== model.identity) throw fault('model-changed', 'STALE');
    const generation = crypto.randomUUID();
    safeDirectories(paths.state, path.dirname(paths.index), true);
    const backup = path.join(staging, 'previous-index');
    if (fs.existsSync(paths.index)) fs.renameSync(paths.index, backup);
    fs.renameSync(savePath, paths.index);
    const metadata = JSON.parse(regularBytes(path.join(paths.index, 'metadata.json'), limits.artifactBytes).toString('utf8'));
    const manifest = { schemaVersion: 1, complete: true, providerVersion: SEMBLE_VERSION, runtimeIdentity: result.runtimeIdentity, root: inventory.root,
      scopeIgnoreDigest: inventory.scopeIgnoreDigest, corpusIdentity: inventory.identity, model, generation,
      providerTime: metadata.time, artifactIdentity: artifacts.artifactIdentity,
      files: inventory.files.map((entry: any) => ({ path: entry.path, sizeBytes: entry.sizeBytes, fileHash: entry.fileHash })) };
    const pending = path.join(staging, 'manifest.json'); fs.writeFileSync(pending, JSON.stringify(manifest));
    checkSources(inventory, limits); checkDeadline();
    fs.renameSync(pending, paths.manifest); // Completion metadata is always the last published artifact.
    fs.unlinkSync(paths.marker);
    return { ok: true, action, complete: true, freshness: 'FRESH', generation, added, changed, deleted, skipped: 0,
      bytes: changedBytes, elapsedMs: Date.now() - started, chunks: artifacts.chunks, artifactBytes: artifacts.artifactBytes };
  } catch (error: any) {
    const reason = error.reason || 'lifecycle-error';
    return { ok: false, action, complete: false, freshness: error.freshness || 'UNKNOWN', reason, ...(typeof error.cause === 'string' ? { cause: error.cause } : {}),
      added, changed, deleted, skipped: inventory?.skipped?.length || 0, bytes: changedBytes, elapsedMs: Date.now() - started,
      repair: 'Run an explicit bounded build with a verified local model after correcting the cause.' };
  } finally { try { if (staging) fs.rmSync(staging, { recursive: true, force: true }); } catch {} try { if (release) release(); } catch {} }
}
module.exports = { runSembleLifecycle };
