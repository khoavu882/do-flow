'use strict';

const { shippedWorkerIds, knownWorkerIds } = require('../../registry/worker-ids.ts');
const { loadRegistry } = require('../../registry/index.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

type ActiveWorkers = {
  state: 'unset' | 'set' | 'invalid';
  workers: string[];
  inSession: boolean;
  dangling: string[];
  origin: { layer: string; source: string | null };
  reason: string | null;
  narrowedFrom: string[] | null;
};

/** IC-009: resolve the usable workers and in-session permission from workers.enabled. */
function activeWorkers({ registry, view, env = process.env, projectRoot = null }: any = {}): ActiveWorkers {
  const reg = registry || loadRegistry({ repoRoot: REPO_ROOT });
  const known = knownWorkerIds({ registry: reg, view }).ids;
  let res: any;
  try {
    const { loadSettings } = require('../settings/resolve.ts');
    res = loadSettings({ projectRoot, env: { ...env } }).get('workers.enabled', 'project');
  } catch {
    return {
      state: 'invalid', workers: [], inSession: false, dangling: [],
      origin: { layer: 'default', source: null }, reason: 'unreadable', narrowedFrom: null,
    };
  }

  const origin = { layer: res.origin.layer, source: res.origin.source };
  if (res.state === 'invalid') {
    const candidate = res.candidates.find((item: any) =>
      item.status === 'invalid' && item.layer === origin.layer && item.source === origin.source);
    return {
      state: 'invalid', workers: [], inSession: false, dangling: [],
      origin, reason: candidate?.reason || 'invalid', narrowedFrom: null,
    };
  }
  if (origin.layer === 'default') {
    return {
      state: 'unset', workers: shippedWorkerIds(reg), inSession: true, dangling: [],
      origin, reason: null, narrowedFrom: null,
    };
  }

  const value = res.value as string[];
  const ids = value.filter((id) => id !== 'primary');
  const user = origin.layer === 'project' || origin.layer === 'local'
    ? res.candidates.find((item: any) => item.layer === 'user' && item.value !== null && item.status === 'overridden')
    : null;
  return {
    state: 'set',
    workers: ids.filter((id) => known.includes(id)),
    inSession: value.at(-1) === 'primary',
    dangling: ids.filter((id) => !known.includes(id)),
    origin,
    reason: null,
    narrowedFrom: user ? [...user.value] : null,
  };
}

/** IC-009: refuse a worker outside the resolved usable set. */
function workerGate(active: ActiveWorkers, id: string) {
  if (active.workers.includes(id)) return null;
  return {
    reason: active.state === 'invalid' ? 'workers-enabled-invalid' : 'worker-disabled',
    harness: id,
    enabled: [...active.workers],
    origin: active.origin,
  };
}

/** IC-009: refuse in-session work when primary is absent or the list is invalid. */
function inSessionGate(active: ActiveWorkers) {
  if (active.inSession) return null;
  if (active.state === 'invalid') {
    return {
      reason: 'workers-enabled-invalid',
      text: 'workers-enabled-invalid: workers.enabled is invalid, do not run in-session',
    };
  }
  return {
    reason: 'no-enabled-worker',
    text: 'no-enabled-worker: primary not enabled, do not run in-session',
  };
}

module.exports = { activeWorkers, workerGate, inSessionGate };
