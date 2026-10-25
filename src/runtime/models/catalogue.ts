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
        return JSON.parse(raw);
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
      return JSON.parse(raw);
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

async function syncHarness(
  harnessId: string,
  options: { timeoutMs?: number; execFileImpl?: any; env?: any; fsImpl?: any; homeDir?: string; projectRoot?: string } = {}
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

  return await probe(options);
}

async function syncAllHarnesses(
  options: { projectRoot?: string; timeoutMs?: number; execFileImpl?: any; env?: any; fsImpl?: any; homeDir?: string } = {}
): Promise<ObservedCatalogue> {
  const results: Record<string, SyncHarnessResult> = {};
  for (const id of HARNESS_IDS) {
    results[id] = await syncHarness(id, options);
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
};
