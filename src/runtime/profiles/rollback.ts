'use strict';

const fs = require('node:fs');
const path = require('node:path');

export interface RollbackState {
  active: boolean;
  reason: string | null;
  triggeredAt: string | null; // ISO string
  origin: 'env' | 'sentinel' | 'circuit-breaker' | 'none';
  targetProfile: 'baseline';
}

export interface TripRollbackOptions {
  reason: string;
  projectRoot?: string;
  fsImpl?: any;
}

function resolveSentinelPath(projectRoot?: string): string {
  const root = projectRoot ? path.resolve(projectRoot) : process.cwd();
  return path.join(root, '.doflow', 'state', 'rollback.json');
}

function resolveCircuitBreakerPath(projectRoot?: string): string {
  const root = projectRoot ? path.resolve(projectRoot) : process.cwd();
  return path.join(root, '.doflow', 'state', 'circuit-breaker.json');
}

/**
 * Checks whether rollback mode is active.
 * Checked at process start and before every major subsystem dispatch.
 * Sub-5ms evaluation latency. Never throws.
 */
function checkRollbackState(options?: {
  projectRoot?: string;
  env?: Record<string, string | undefined>;
  fsImpl?: any;
}): RollbackState {
  try {
    const env = options?.env || process.env;

    // 1. Tier 1: Ephemeral Env Fast-Path (0ms, 0 I/O)
    if (env.DOFLOW_ROLLOUT_PROFILE === 'baseline') {
      return {
        active: true,
        reason: 'DOFLOW_ROLLOUT_PROFILE=baseline',
        triggeredAt: null,
        origin: 'env',
        targetProfile: 'baseline',
      };
    }

    const fsImpl = options?.fsImpl || fs;
    const sentinelPath = resolveSentinelPath(options?.projectRoot);

    // 2. Tier 2: Sentinel State Fast-Path (.doflow/state/rollback.json)
    // Read it directly: existsSync reports false for an unreadable path (EACCES), which would hide a
    // tripped rollback. Only a sentinel that is absent means no rollback; any other read error fails closed.
    let raw: string | null = null;
    try {
      raw = fsImpl.readFileSync(sentinelPath, 'utf8');
    } catch (error: any) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
    if (raw !== null) {
      let data: any;
      try {
        data = JSON.parse(raw);
      } catch {
        // Corrupt sentinel fails closed to active rollback
        return {
          active: true,
          reason: 'unparseable-rollback-sentinel',
          triggeredAt: null,
          origin: 'sentinel',
          targetProfile: 'baseline',
        };
      }
      if (data && data.active !== false) {
        return {
          active: true,
          reason: data.reason || 'manual-sentinel',
          triggeredAt: data.triggeredAt || null,
          origin: data.origin === 'circuit-breaker' ? 'circuit-breaker' : 'sentinel',
          targetProfile: 'baseline',
        };
      }
    }

    return {
      active: false,
      reason: null,
      triggeredAt: null,
      origin: 'none',
      targetProfile: 'baseline',
    };
  } catch {
    // The rollback state could not be read: fail closed, as for a corrupt sentinel.
    return {
      active: true,
      reason: 'rollback-state-unavailable',
      triggeredAt: null,
      origin: 'sentinel',
      targetProfile: 'baseline',
    };
  }
}

/**
 * Trips instant rollback by writing the sentinel .doflow/state/rollback.json.
 * Does NOT touch any git-tracked files or require git commits.
 */
function tripRollback(options: TripRollbackOptions): { ok: boolean; path: string } {
  const sentinelPath = resolveSentinelPath(options.projectRoot);
  const fsImpl = options.fsImpl || fs;
  try {
    const dir = path.dirname(sentinelPath);
    fsImpl.mkdirSync(dir, { recursive: true });

    const payload = {
      schema: 1,
      active: true,
      reason: options.reason || 'manual-rollback',
      triggeredAt: new Date().toISOString(),
      origin: 'sentinel',
      targetProfile: 'baseline',
    };

    const tmpPath = `${sentinelPath}.${process.pid}.${Date.now()}.tmp`;
    fsImpl.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
    try {
      fsImpl.renameSync(tmpPath, sentinelPath);
    } catch {
      fsImpl.writeFileSync(sentinelPath, JSON.stringify(payload, null, 2), 'utf8');
      try { fsImpl.unlinkSync(tmpPath); } catch {}
    }

    return { ok: true, path: sentinelPath };
  } catch {
    return { ok: false, path: sentinelPath };
  }
}

/**
 * Resets rollback mode by removing the sentinel file.
 */
function resetRollback(options?: { projectRoot?: string; fsImpl?: any }): { ok: boolean } {
  const sentinelPath = resolveSentinelPath(options?.projectRoot);
  const cbPath = resolveCircuitBreakerPath(options?.projectRoot);
  const fsImpl = options?.fsImpl || fs;

  // A file already gone is the goal; any other failure leaves rollback mode on and is reported.
  let ok = true;
  for (const file of [sentinelPath, cbPath]) {
    try {
      fsImpl.unlinkSync(file);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') ok = false;
    }
  }

  return { ok };
}

/**
 * Records a provider failure (Ollama, Semble, Graphify) and trips the
 * circuit breaker if consecutive failures exceed the threshold (default: 3).
 */
function recordProviderFailure(
  providerId: string,
  error: Error | string,
  options?: { projectRoot?: string; fsImpl?: any; threshold?: number }
): { tripped: boolean; failureCount: number } {
  const fsImpl = options?.fsImpl || fs;
  const cbPath = resolveCircuitBreakerPath(options?.projectRoot);
  const threshold = options?.threshold ?? 3;
  const errorMsg = typeof error === 'string' ? error : error?.message || 'unknown error';

  let cbData: Record<string, { failureCount: number; lastError: string; lastFailureAt: string }> = {};
  try {
    if (fsImpl.existsSync(cbPath)) {
      cbData = JSON.parse(fsImpl.readFileSync(cbPath, 'utf8')) || {};
    }
  } catch {
    cbData = {};
  }

  const currentCount = (cbData[providerId]?.failureCount || 0) + 1;
  cbData[providerId] = {
    failureCount: currentCount,
    lastError: errorMsg,
    lastFailureAt: new Date().toISOString(),
  };

  try {
    const dir = path.dirname(cbPath);
    fsImpl.mkdirSync(dir, { recursive: true });
    fsImpl.writeFileSync(cbPath, JSON.stringify(cbData, null, 2), 'utf8');
  } catch {}

  if (currentCount >= threshold) {
    // Trip circuit-breaker rollback sentinel
    const sentinelPath = resolveSentinelPath(options?.projectRoot);
    try {
      const dir = path.dirname(sentinelPath);
      fsImpl.mkdirSync(dir, { recursive: true });
      const payload = {
        schema: 1,
        active: true,
        reason: `Provider '${providerId}' failed ${currentCount} consecutive times: ${errorMsg}`,
        triggeredAt: new Date().toISOString(),
        origin: 'circuit-breaker',
        targetProfile: 'baseline',
      };
      fsImpl.writeFileSync(sentinelPath, JSON.stringify(payload, null, 2), 'utf8');
    } catch {}

    return { tripped: true, failureCount: currentCount };
  }

  return { tripped: false, failureCount: currentCount };
}

/**
 * Records provider success to reset consecutive failure count.
 */
function recordProviderSuccess(
  providerId: string,
  options?: { projectRoot?: string; fsImpl?: any }
): { failureCount: number } {
  const fsImpl = options?.fsImpl || fs;
  const cbPath = resolveCircuitBreakerPath(options?.projectRoot);

  try {
    if (fsImpl.existsSync(cbPath)) {
      const cbData = JSON.parse(fsImpl.readFileSync(cbPath, 'utf8')) || {};
      if (cbData[providerId]) {
        cbData[providerId].failureCount = 0;
        fsImpl.writeFileSync(cbPath, JSON.stringify(cbData, null, 2), 'utf8');
      }
    }
  } catch {}

  return { failureCount: 0 };
}

module.exports = {
  checkRollbackState,
  tripRollback,
  resetRollback,
  recordProviderFailure,
  recordProviderSuccess,
};
