'use strict';

const { isQualifiedId } = require('../helper/package-ids.ts');
/** IC-002 and 106 IC-005: maximum worker ids in an enabled list or dispatch ladder. */
const LADDER_MAX = 8;
const WORKER_ID_MAX = 32;
const BUILTIN_WORKER_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const RESERVED_WORKER_IDS = Object.freeze(['primary', 'auto', 'subagent', 'sequential', 'manual', 'held', 'none', 'unknown']);


/** IC-001: validate worker id shape without checking catalogue membership. */
function workerIdFault(id: unknown): { code: 'type' | 'reserved'; reason: string } | null {
  if (typeof id === 'string' && RESERVED_WORKER_IDS.includes(id)) return { code: 'reserved', reason: 'worker id is reserved' };
  if (typeof id === 'string' && (BUILTIN_WORKER_ID_RE.test(id) || isQualifiedId(id))) return null;
  return { code: 'type', reason: 'worker id must be a lowercase built-in or qualified id' };
}

type RetiredId = { id: string; replacement: string };

/** IC-001, 127 IC-005: classify worker shape and membership independently; a retired registry id is `retired`, not `dangling`. */
function classifyWorkerId(id: unknown, known: readonly string[], retired: readonly RetiredId[] = []): 'ok' | 'malformed' | 'reserved' | 'retired' | 'dangling' {
  const fault = workerIdFault(id);
  if (fault?.code === 'type') return 'malformed';
  if (fault?.code === 'reserved') return 'reserved';
  if (known.includes(id as string)) return 'ok';
  return retired.some((entry) => entry.id === id) ? 'retired' : 'dangling';
}

/** 127 IC-005: the one advisory line for a retired id a setting names. */
function retiredAdvisory(key: string, entry: RetiredId): string {
  return `${key}: '${entry.id}' is retired; use '${entry.replacement}'`;
}

/** IC-001: return built-in harness ids that carry a worker object, in registry order. */
function shippedWorkerIds(registry: any): string[] {
  return (registry.harnesses || []).filter((h: any) => h.worker && typeof h.worker === 'object').map((h: any) => h.id);
}

/** IC-001 and IC-019: read worker membership from the catalogue seam. */
function knownWorkerIds({ registry, view }: any = {}): { ids: string[] } {
  const { workerCatalogue } = require('../runtime/worker/catalogue.ts');
  return { ids: workerCatalogue({ registry, view }).map((entry: any) => entry.id) };
}

module.exports = { LADDER_MAX, WORKER_ID_MAX, BUILTIN_WORKER_ID_RE, RESERVED_WORKER_IDS, isQualifiedId, workerIdFault, classifyWorkerId, retiredAdvisory, shippedWorkerIds, knownWorkerIds };
