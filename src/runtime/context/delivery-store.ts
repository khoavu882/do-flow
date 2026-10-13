'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const fs = require('node:fs');
const path = require('node:path');
const { boundedAcquire, updateTaskState } = require('../task-state.ts');
const { taskStoreDir } = require('../task-scope.ts');

const MAX_DELIVERIES = 5;
const ACTUAL_UNMEASURED = 'no harness reports token usage to an external CLI; profile tokenTelemetry unverified';

function assertValidDeliveryEntry(entry: any): void {
  if (!entry || typeof entry !== 'object') throw new Error('Delivery entry must be an object');
  if (!entry.tokens || !entry.tokens.estimated) throw new Error('Delivery entry requires tokens.estimated');
  if (typeof entry.tokens.estimated.value !== 'number' || entry.tokens.estimated.basis !== 'estimated:bytes/4') {
    throw new Error('Delivery entry tokens.estimated must use estimated:bytes/4');
  }
  if (entry.tokens.actual?.basis?.startsWith('estimated:')) {
    throw new Error('Delivery entry tokens.actual cannot use an estimated basis');
  }
  for (const expansion of entry.expansions || []) {
    if (typeof expansion.reason !== 'string' || expansion.reason.trim() === '') {
      throw new Error('Delivery expansion reason must not be empty');
    }
  }
}

function makeTokenRecord(bytes: number): any {
  return {
    estimated: { value: Math.ceil(bytes / 4), basis: 'estimated:bytes/4' },
    actual: { unmeasured: ACTUAL_UNMEASURED },
  };
}

function createDeliveryEntry({ pack, form, harness = null, sources = {}, expansions = [], retention = null }: any): any {
  const items = pack.deliveryAllItems || pack.deliveryItems || [];
  const digests = Object.fromEntries(items.map((item: any) => [item.id, item.digest]));
  const mandatoryIds = items.filter((item: any) => item.cls === 'mandatory').map((item: any) => item.id);
  const harnessId = harness || 'unstated';
  const bytes = Number(pack.size?.totalBytes || 0);
  const entry = {
    key: `${pack.delivery.packDigest}.${form}.${harnessId}`,
    packDigest: pack.delivery.packDigest,
    form,
    harness,
    firstAt: new Date().toISOString(),
    mode: pack.mode || 'full',
    budget: { maxBytes: pack.budget.maxBytes, source: pack.budget.source },
    since: pack.delivery.since || null,
    deltaRefused: pack.delivery.deltaRefused || null,
    retention: retention || { status: 'unknown', basis: 'contextProfile.retention is unverified' },
    items: digests,
    mandatoryIds,
    sources,
    pointers: pack.pointers || [],
    bytes,
    tokens: makeTokenRecord(bytes),
    omissions: (pack.deliveryOmissions || []).map((item: any) => ({ ...item })),
    expansions: [...expansions],
  };
  assertValidDeliveryEntry(entry);
  return entry;
}

function readDeliveryEntry({ projectRoot, taskId, slug = null, packDigest, fsImpl = fs }: any): any | null {
  const dir = taskStoreDir({ projectRoot, store: 'delivery', taskId, slug });
  const file = path.join(dir, `${taskId}.json`);
  try {
    const disk = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    return (Array.isArray(disk.deliveries) ? disk.deliveries : []).find((entry: any) => entry.packDigest === packDigest) || null;
  } catch {
    return null;
  }
}

/** Persist a delivery under the same bounded lock used by task state. */
function recordDelivery({ projectRoot, taskId, slug = null, entry, fsImpl = fs, acquire = boundedAcquire, supersedesKey = null }: any): any {
  assertValidDeliveryEntry(entry);
  if (typeof taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId) || taskId.includes('..')) {
    throw new Error(`Invalid task id '${taskId}'`);
  }
  const dir = taskStoreDir({ projectRoot, store: 'delivery', taskId, slug });
  const file = path.join(dir, `${taskId}.json`);
  updateTaskState({
    fsImpl,
    file,
    acquire: (impl: any, target: string) => acquire(impl, target, { retries: 3, waitMs: 5 }),
    build(disk: any) {
      const deliveries = Array.isArray(disk?.deliveries) ? disk.deliveries : [];
      if (deliveries.some((existing: any) => existing.key === entry.key)) {
        return { taskId, deliveries };
      }
      const current = supersedesKey ? deliveries.filter((existing: any) => existing.key !== supersedesKey) : deliveries;
      return { taskId, deliveries: [...current, entry].slice(-MAX_DELIVERIES) };
    },
  });
  return { key: entry.key, recorded: true, reason: null };
}

module.exports = { ACTUAL_UNMEASURED, assertValidDeliveryEntry, createDeliveryEntry, makeTokenRecord, readDeliveryEntry, recordDelivery };
