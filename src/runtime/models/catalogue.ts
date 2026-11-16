'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { configHome } = require('../config-home.ts');

export type DetectedMode = 'subscription' | 'api-key' | 'unverified';
export type DerivedBilling = 'free' | 'metered' | 'unknown';

export interface OfferedModel {
  id: string;
  displayName?: string;
  family?: string;
  /** The columns a harness's listing carries (169 §6.2); each is stored only when the listing had it. */
  provider?: string;
  contextTokens?: number;
  maxOutputTokens?: number;
  reasoning?: boolean;
  effortLevels?: string[];
  imageInput?: boolean;
}

/** How the harness's own model list was last read: `listed`, `none-recorded` (the registry records no
 * listing command, so `offeredModels` is empty by design), or `failed` (not logged in, offline, timed out;
 * `stale` is true when `offeredModels` is then the previous list kept). */
export interface ModelListState {
  status: 'listed' | 'none-recorded' | 'failed';
  reason?: string;
  stale?: boolean;
  /** Ids in the harness's output that were not usable model ids and were left out. */
  dropped?: number;
  /** True when the list was cut at the most ids the catalogue keeps. */
  capped?: boolean;
  /** The `modelList.columns` targets the listing had a header for. */
  columns?: string[];
  /** Rows with the wrong cell count and cells that did not convert, left out of their models. */
  columnFaults?: number;
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

/** Login fields an entry written before row 172 carries; the login answer is in the `harness-login` store now. */
const REMOVED_LOGIN_KEYS = ['loginState', 'reloginHint', 'loginCheck'];

/**
 * An entry with no `modelList` was written before the harness's own list was read: its `offeredModels` came from a
 * table that no longer exists. Read it as "no list" so nothing suggests, checks against or shows those names. The
 * removed login keys are dropped, so no reader takes an old probe's guess for a login answer.
 */
function withoutRemovedFields(parsed: any): any {
  if (!parsed || typeof parsed !== 'object' || !parsed.harnesses || typeof parsed.harnesses !== 'object') return parsed;
  for (const entry of Object.values<any>(parsed.harnesses)) {
    if (entry && typeof entry === 'object') for (const key of REMOVED_LOGIN_KEYS) delete entry[key];
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
        return withoutRemovedFields(JSON.parse(raw));
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
      return withoutRemovedFields(JSON.parse(raw));
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

/**
 * Puts `entries` (harness id to synced entry) into the catalogue: under the state-file lock the repo uses for its small
 * state files, the file is read again and only these harnesses are replaced, so two syncs running together each keep
 * the other's entry. Returns the catalogue as written. The slow part (probing a CLI) belongs outside this call.
 */
function mergeCatalogueEntries(
  entries: Record<string, SyncHarnessResult>,
  projectRoot?: string,
  options: { fsImpl?: any; homeDir?: string; env?: any } = {}
): ObservedCatalogue {
  const { acquireLock } = require('../task-state.ts');
  const fsImpl = options.fsImpl || fs;
  const root = projectRoot ? path.resolve(projectRoot) : resolveProjectRoot(undefined, fsImpl);
  const targetPath = root ? getProjectCataloguePath(root) : getUserCataloguePath(options.homeDir, options.env);
  fsImpl.mkdirSync(path.dirname(targetPath), { recursive: true });
  const release = acquireLock(fsImpl, targetPath);
  try {
    const current: ObservedCatalogue = readCatalogue(projectRoot, options) || { version: 1, syncedAt: '', harnesses: {} };
    const merged: ObservedCatalogue = { ...current, version: 1, syncedAt: new Date().toISOString(), harnesses: { ...current.harnesses, ...entries } };
    writeCatalogue(merged, projectRoot, options);
    return merged;
  } finally {
    release();
  }
}

/** Adapts a callback-style `execFile` (the listing's test seam) to the promise form `listHarnessModels` runs. */
function listExecFrom(runner: any): any {
  return (file: string, args: string[], opts: any) => new Promise((resolve, reject) => {
    const done = (err: any, stdout: any) => (err ? reject(err) : resolve(String(stdout ?? '')));
    const proc = runner(file, args, { timeout: opts?.timeout }, done);
    if (proc && typeof proc.then === 'function') proc.then((res: any) => resolve(String(res?.stdout ?? '')), reject);
  });
}

/** Every worker the registry knows: the built-in harnesses, then the active package workers (the same source the worker
 * verbs read). `view` is the package view; without one it is read for `env` and `projectRoot`. */
function workerEntries({ registry, env, projectRoot, view }: any = {}): any[] {
  const { workerCatalogue } = require('../worker/catalogue.ts');
  let packages = view;
  if (!packages) {
    try { packages = require('../packages/view.ts').packageView({ env, ...(projectRoot ? { projectRoot } : {}) }); } catch { packages = undefined; }
  }
  return workerCatalogue({ registry, view: packages });
}

const workerIds = (options: any = {}): string[] => workerEntries(options).map((entry: any) => entry.id);

/** The worker block for `harnessId`, from an injected registry or the shipped one, built-in or package. */
function workerDescriptor(harnessId: string, options: any = {}): any {
  return workerEntries(options).find((entry: any) => entry.id === harnessId)?.worker ?? null;
}

type SyncOptions = {
  execFileImpl?: any; listExecImpl?: any; env?: any; fsImpl?: any; homeDir?: string;
  projectRoot?: string; registry?: any; previous?: ObservedHarness | null;
  /** The package view the worker list is read from (a test seam; default: read for `env` and `projectRoot`). */
  view?: any;
};

/** Fills `offeredModels` from the harness's own listing command. A failed listing keeps the previous list, marked stale. */
async function withListing(result: SyncHarnessResult, options: SyncOptions): Promise<SyncHarnessResult> {
  const { listHarnessModels } = require('./list-models.ts');
  const execImpl = options.listExecImpl ?? (options.execFileImpl ? listExecFrom(options.execFileImpl) : undefined);
  const listing = await listHarnessModels({ descriptor: workerDescriptor(result.harnessId, options), execImpl });
  if (listing.status === 'listed') return { ...result, offeredModels: listing.models, modelList: { status: 'listed', ...(listing.dropped ? { dropped: listing.dropped } : {}), ...(listing.capped ? { capped: true } : {}), ...(listing.columns ? { columns: listing.columns } : {}), ...(listing.columnFaults ? { columnFaults: listing.columnFaults } : {}) } };
  if (listing.status === 'none-recorded') return { ...result, offeredModels: [], modelList: { status: 'none-recorded', reason: listing.reason } };
  // A list from before this field existed came from the removed hard-coded table, so it is not kept.
  const kept = options.previous?.modelList && options.previous.modelList.status !== 'none-recorded' ? (options.previous.offeredModels ?? []) : [];
  return { ...result, offeredModels: kept, modelList: { status: 'failed', reason: listing.reason, ...(kept.length ? { stale: true } : {}) } };
}

const VERSION_MS = 3000;
const VERSION_BYTES = 4096;

function parseVersion(text: string): string | null {
  const match = text.match(/\b\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.]+)?\b/);
  return match ? match[0] : null;
}

/** `detectedMode` and `derivedBilling` from a logged-in answer's billing; `mixed`, null or no answer reads unverified. */
function billingOf(answer: any): { detectedMode: DetectedMode; derivedBilling: DerivedBilling } {
  const billing = answer?.state === 'logged-in' && answer.billing && typeof answer.billing === 'object' ? answer.billing : null;
  if (!billing || !['subscription', 'api-key'].includes(billing.mode)) return { detectedMode: 'unverified', derivedBilling: 'unknown' };
  return { detectedMode: billing.mode, derivedBilling: ['free', 'metered'].includes(billing.billing) ? billing.billing : 'unknown' };
}

/**
 * One path for built-in and package workers (172 D10): the binary is found on PATH, `cli.versionArgv` gives the
 * version, the declared login recipe runs and its answer is recorded in the `harness-login` store, and the harness's
 * own listing command fills the models. A harness not on PATH starts no process for its version or login, and its
 * recipe's answer is recorded as unknown `not-installed`.
 */
async function syncHarness(
  harnessId: string,
  options: SyncOptions = {}
): Promise<SyncHarnessResult> {
  const env = options.env ?? process.env;
  const cwd = options.projectRoot ?? process.cwd();
  const worker = workerDescriptor(harnessId, options);
  const binary = typeof worker?.cli?.binary === 'string' ? worker.cli.binary : harnessId;
  const { findOnPath } = require('../worker/readiness.ts');
  const found: string | null = worker ? findOnPath(binary, env, process.platform, cwd) : null;
  let version: string | null = null;
  let answer: any = null;
  if (found) {
    const { spawnBounded } = require('../worker/process-tree.ts');
    const argv = worker.cli?.versionArgv;
    if (Array.isArray(argv)) {
      const res = await spawnBounded({ binary: found, argv, cwd, env, timeoutMs: VERSION_MS, maxStdout: VERSION_BYTES });
      if (res.status === 'exited' && res.code === 0) version = parseVersion(String(res.stdout ?? ''));
    }
  }
  if (worker?.loginProbe?.status === 'supported') {
    const { checkLogin, recipeDigest, loginAnswerOf } = require('../worker/login.ts');
    const store = require('../worker/login-store.ts');
    // Not on PATH, `checkLogin` answers unknown `not-installed` and starts no process; recording it replaces an older answer.
    const recipe = { ...(await checkLogin({ harness: harnessId, worker, env, cwd, binaryPath: found ?? undefined })), digest: recipeDigest(worker) };
    try { store.recordRecipeAnswer(env, harnessId, recipe, recipe.digest); } catch { /* the next check writes it */ }
    // Billing follows the answer the shared precedence gives, so a run's recorded expiry still holds over this check.
    answer = loginAnswerOf({ harness: harnessId, worker, record: { recipe, run: store.readLoginStore(env).harnesses[harnessId]?.run ?? null } });
  }
  return await withListing({
    harnessId,
    binary,
    installed: found !== null,
    version,
    ...billingOf(answer),
    offeredModels: [],
    lastSyncedAt: new Date().toISOString(),
  }, options);
}

async function syncAllHarnesses(
  options: SyncOptions = {}
): Promise<ObservedCatalogue> {
  const results: Record<string, SyncHarnessResult> = {};
  const before = readCatalogue(options.projectRoot, options);
  for (const id of workerIds(options)) {
    results[id] = await syncHarness(id, { ...options, previous: before?.harnesses?.[id] ?? null });
  }

  return mergeCatalogueEntries(results, options.projectRoot, options);
}

module.exports = {
  getProjectCataloguePath,
  getUserCataloguePath,
  readCatalogue,
  writeCatalogue,
  mergeCatalogueEntries,
  syncHarness,
  syncAllHarnesses,
  workerDescriptor,
  workerEntries,
  workerIds,
};
