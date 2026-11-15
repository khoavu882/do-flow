'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PROBES, HARNESS_IDS } = require('../worker/probes/index.ts');
const { configHome } = require('../config-home.ts');

export type LoginState = 'logged-in' | 'logged-out' | 'unsupported' | 'error';
export type DetectedMode = 'subscription' | 'api-key' | 'unverified';
export type DerivedBilling = 'free' | 'metered' | 'unknown';

export interface OfferedModel {
  id: string;
  displayName?: string;
  family?: string;
}

/** How the harness's own model list was last read: `listed`, `none-recorded` (the registry records no
 * listing command, so `offeredModels` is empty by design), or `failed` (not logged in, offline, timed out;
 * `stale` is true when `offeredModels` is then the previous list kept). */
export interface ModelListState {
  status: 'listed' | 'none-recorded' | 'failed';
  reason?: string;
  stale?: boolean;
}

export interface HarnessQuota {
  status: 'ok' | 'exceeded' | 'unknown';
  message?: string;
}

export interface SyncHarnessResult {
  harnessId: string;
  binary: string;
  installed: boolean;
  version: string | null;
  loginState: LoginState;
  reloginHint: string | null;
  detectedMode: DetectedMode;
  derivedBilling: DerivedBilling;
  offeredModels: Array<OfferedModel>;
  modelList?: ModelListState;
  quota?: HarnessQuota;
  lastSyncedAt: string;
}

export type ObservedHarness = SyncHarnessResult;

export interface ObservedCatalogue {
  version: number;
  syncedAt: string;
  harnesses: Record<string, ObservedHarness>;
}

function getProjectCataloguePath(projectRoot: string): string {
  return path.join(projectRoot, '.doflow', 'state', 'models', 'catalogue.json');
}

function getUserCataloguePath(homeDir?: string, env: any = process.env): string {
  if (homeDir) {
    return path.join(homeDir, '.config', 'doflow', 'state', 'models-observed.json');
  }
  const { dir } = configHome(env);
  const baseDir = dir || path.join(os.homedir(), '.config', 'doflow');
  return path.join(baseDir, 'state', 'models-observed.json');
}

function resolveProjectRoot(projectRoot?: string, fsImpl: any = fs): string | null {
  if (projectRoot) return path.resolve(projectRoot);
  try {
    const { projectRoot: findRoot } = require('../lifecycle/root.ts');
    const root = findRoot(process.cwd());
    if (root && fsImpl.existsSync(path.join(root, '.doflow'))) return root;
  } catch {
    // fallback
  }
  if (fsImpl.existsSync(path.join(process.cwd(), '.doflow'))) {
    return process.cwd();
  }
  return null;
}

/**
 * An entry with no `modelList` was written before the harness's own list was read: its `offeredModels` came from a
 * table that no longer exists. Read it as "no list" so nothing suggests, checks against or shows those names.
 */
function withoutRemovedLists(parsed: any): any {
  if (!parsed || typeof parsed !== 'object' || !parsed.harnesses || typeof parsed.harnesses !== 'object') return parsed;
  for (const entry of Object.values<any>(parsed.harnesses)) {
    if (entry && typeof entry === 'object' && !(entry.modelList && typeof entry.modelList === 'object')) {
      entry.offeredModels = [];
      entry.modelList = { status: 'none-recorded', reason: 'this catalogue entry predates reading the harness\'s own model list; run `doflow models --action sync`' };
    }
  }
  return parsed;
}

function readCatalogue(
  projectRoot?: string,
  options: { fsImpl?: any; homeDir?: string; env?: any } = {}
): ObservedCatalogue | null {
  const fsImpl = options.fsImpl || fs;
  const root = projectRoot ? path.resolve(projectRoot) : resolveProjectRoot(undefined, fsImpl);

  if (root) {
    const projPath = getProjectCataloguePath(root);
    if (fsImpl.existsSync(projPath)) {
      try {
        const raw = fsImpl.readFileSync(projPath, 'utf8');
        return withoutRemovedLists(JSON.parse(raw));
      } catch (err: any) {
        if (err instanceof SyntaxError) {
          const corrupt = `${projPath}.corrupt-${Date.now()}`;
          try {
            fsImpl.renameSync(projPath, corrupt);
          } catch {
            // best-effort
          }
          return null;
        }
        return null;
      }
    }
  }

  // Fallback to user cache
  const userPath = getUserCataloguePath(options.homeDir, options.env);
  if (fsImpl.existsSync(userPath)) {
    try {
      const raw = fsImpl.readFileSync(userPath, 'utf8');
      return withoutRemovedLists(JSON.parse(raw));
    } catch (err: any) {
      if (err instanceof SyntaxError) {
        const corrupt = `${userPath}.corrupt-${Date.now()}`;
        try {
          fsImpl.renameSync(userPath, corrupt);
        } catch {
          // best-effort
        }
        return null;
      }
      return null;
    }
  }

  return null;
}

function writeCatalogue(
  catalogue: ObservedCatalogue,
  projectRoot?: string,
  options: { fsImpl?: any; homeDir?: string; env?: any } = {}
): void {
  const fsImpl = options.fsImpl || fs;
  const root = projectRoot ? path.resolve(projectRoot) : resolveProjectRoot(undefined, fsImpl);
  const targetPath = root ? getProjectCataloguePath(root) : getUserCataloguePath(options.homeDir, options.env);

  const targetDir = path.dirname(targetPath);
  fsImpl.mkdirSync(targetDir, { recursive: true });

  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  fsImpl.writeFileSync(tmpPath, JSON.stringify(catalogue, null, 2), 'utf8');
  fsImpl.renameSync(tmpPath, targetPath);
}

/** Adapts a callback-style `execFile` (the probes' injection point) to the promise form `listHarnessModels` runs. */
function listExecFrom(runner: any): any {
  return (file: string, args: string[], opts: any) => new Promise((resolve, reject) => {
    const done = (err: any, stdout: any) => (err ? reject(err) : resolve(String(stdout ?? '')));
    const proc = runner(file, args, { timeout: opts?.timeout }, done);
    if (proc && typeof proc.then === 'function') proc.then((res: any) => resolve(String(res?.stdout ?? '')), reject);
  });
}

/** The registry worker block for `harnessId`, from an injected registry or the shipped one. */
function workerDescriptor(harnessId: string, registry?: any): any {
  const { loadRegistry } = require('../../registry/index.ts');
  const { REPO_ROOT } = require('../../helper/repo-root.ts');
  const reg = registry || loadRegistry({ repoRoot: REPO_ROOT });
  return (reg.harnesses || []).find((entry: any) => entry.id === harnessId)?.worker ?? null;
}

type SyncOptions = {
  timeoutMs?: number; execFileImpl?: any; listExecImpl?: any; env?: any; fsImpl?: any; homeDir?: string;
  projectRoot?: string; registry?: any; previous?: ObservedHarness | null;
};

/** Fills `offeredModels` from the harness's own listing command. A failed listing keeps the previous list, marked stale. */
async function withListing(result: SyncHarnessResult, options: SyncOptions): Promise<SyncHarnessResult> {
  const { listHarnessModels } = require('./list-models.ts');
  const execImpl = options.listExecImpl ?? (options.execFileImpl ? listExecFrom(options.execFileImpl) : undefined);
  const listing = await listHarnessModels({ descriptor: workerDescriptor(result.harnessId, options.registry), execImpl });
  if (listing.status === 'listed') return { ...result, offeredModels: listing.models, modelList: { status: 'listed' } };
  if (listing.status === 'none-recorded') return { ...result, offeredModels: [], modelList: { status: 'none-recorded', reason: listing.reason } };
  // A list from before this field existed came from the removed hard-coded table, so it is not kept.
  const kept = options.previous?.modelList && options.previous.modelList.status !== 'none-recorded' ? (options.previous.offeredModels ?? []) : [];
  return { ...result, offeredModels: kept, modelList: { status: 'failed', reason: listing.reason, ...(kept.length ? { stale: true } : {}) } };
}

async function syncHarness(
  harnessId: string,
  options: SyncOptions = {}
): Promise<SyncHarnessResult> {
  const probe = PROBES[harnessId];
  if (!probe) {
    return {
      harnessId,
      binary: harnessId,
      installed: false,
      version: null,
      loginState: 'unsupported',
      reloginHint: null,
      detectedMode: 'unverified',
      derivedBilling: 'unknown',
      offeredModels: [],
      lastSyncedAt: new Date().toISOString(),
    };
  }

  return await withListing(await probe(options), options);
}

async function syncAllHarnesses(
  options: SyncOptions = {}
): Promise<ObservedCatalogue> {
  const results: Record<string, SyncHarnessResult> = {};
  const before = readCatalogue(options.projectRoot, options);
  for (const id of HARNESS_IDS) {
    results[id] = await syncHarness(id, { ...options, previous: before?.harnesses?.[id] ?? null });
  }

  const catalogue: ObservedCatalogue = {
    version: 1,
    syncedAt: new Date().toISOString(),
    harnesses: results,
  };

  writeCatalogue(catalogue, options.projectRoot, options);
  return catalogue;
}

module.exports = {
  getProjectCataloguePath,
  getUserCataloguePath,
  readCatalogue,
  writeCatalogue,
  syncHarness,
  syncAllHarnesses,
  workerDescriptor,
};
