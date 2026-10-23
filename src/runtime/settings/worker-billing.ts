'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * The person-written billing record (`workers.billing`, global-only): which headless workers the
 * owner states are `free` or `metered`. It lets a capped dispatch (`--billing-cap free`) treat a
 * worker the registry lists as `unknown` as free, and it can only narrow a worker the registry
 * lists as `free`. It lives with the settings it reads so dispatch needs no settings internals.
 */

type Billing = 'free' | 'metered' | 'unknown';
type RecordEntry = { billing: 'free' | 'metered'; asserted: string; basis?: string };
type BillingRecord = { state: 'absent' | 'set' | 'invalid'; reason: string | null; workers: Record<string, RecordEntry> };

const none = (state: BillingRecord['state'], reason: string | null = null): BillingRecord => ({ state, reason, workers: {} });

/**
 * Read fresh on every call (never memoised: a copied env defeats the resolver cache), from the user
 * layer only: a project file never decides it. Absent is no config home or no decided value. Invalid
 * is a resolution in the invalid state, any invalid candidate, an id that is not in `workerIds`
 * (reason `unknown-worker:<id>`) or any thrown error: the caller then counts no worker as free.
 */
function readWorkerBilling(env: any = process.env, { workerIds = [] }: { workerIds?: string[] } = {}): BillingRecord {
  try {
    const { loadSettings } = require('./resolve.ts');
    const resolution = loadSettings({ global: true, env: { ...env } }).get('workers.billing', 'global');
    const bad = resolution.candidates.find((c: any) => c.status === 'invalid');
    if (bad || resolution.state === 'invalid') return none('invalid', (bad && bad.reason) || 'invalid');
    if (resolution.origin?.via === 'no-config-home') return none('absent');
    const value = resolution.value;
    if (value === null || value === undefined) return none('absent');
    for (const id of Object.keys(value)) {
      if (!workerIds.includes(id)) return none('invalid', `unknown-worker:${id}`);
    }
    return { state: 'set', reason: null, workers: structuredClone(value) };
  } catch {
    return none('invalid', 'unreadable');
  }
}

/**
 * The billing a capped dispatch judges for one worker. The record lifts a registry `unknown` to
 * `free`, narrows a registry `free` to `metered`, and never lifts a registry `metered`. Anything
 * else (no record, an invalid one, no entry, an entry that changes nothing) is the registry's own
 * value. An invalid record is the caller's to refuse before asking.
 */
function effectiveBilling(descriptorBilling: unknown, harnessId: string, record: BillingRecord | null): { value: Billing; source: 'registry' | 'user-record'; asserted?: string } {
  const base: Billing = descriptorBilling === 'free' || descriptorBilling === 'metered' ? descriptorBilling : 'unknown';
  const entry = record && record.state === 'set' && Object.hasOwn(record.workers, harnessId) ? record.workers[harnessId] : null;
  if (entry && entry.billing !== base && (entry.billing === 'metered' || base === 'unknown')) {
    return { value: entry.billing, source: 'user-record', asserted: entry.asserted };
  }
  return { value: base, source: 'registry' };
}

module.exports = { readWorkerBilling, effectiveBilling };
